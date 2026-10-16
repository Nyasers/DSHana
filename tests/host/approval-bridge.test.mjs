// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/host/approval-bridge.test.mjs — packages/host/src/approval-bridge.ts 单测
//
// 这里锁的是**归属校验通则**的第一半（审批侧）：宿主审批记录自带 parentTaskId，
// 它和我们映射里以为的 taskId 必须一致，否则 fail-closed 拒绝（绝不放行）。
// 契约上 parentTaskId 必填 → 缺失也按不一致处理，宁可拒绝一次，不拿来源不明的审批等结果。
//
// 第二半是绑定侧：绑定的宿主任务已终结时按"无绑定"委托（审批不得挂到已结束的父任务上），
// 以及 requestApproval 在途窗口里的中止/停止收尾（不留既不拒绝也不放行的挂起审批）。
// 组装面用假 ctx（捕获 ctx.on 的 handler 再手动触发）与假 hana.tasks，不起真进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalOwnsTask,
  approvalSessionIdOf,
  previewArgs,
  collectToolCallsFromEvent,
  ToolCallCache,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  TOOL_ARGS_PREVIEW_MAX,
  clipForLabel,
  summarizeOperation,
  describeEscalation,
  buildApprovalLabel,
  preWatchVerdict,
  startApprovalBridge,
} from "@dshana/host/approval-bridge.ts";

test("approvalOwnsTask：parentTaskId 一致才放行", () => {
  assert.equal(approvalOwnsTask({ parentTaskId: "task-1" }, "task-1"), true);
  assert.equal(approvalOwnsTask({ parentTaskId: "task-2" }, "task-1"), false, "不一致必须拒绝");
});

test("approvalOwnsTask：缺失/非字符串/空串一律按不一致处理（fail-closed）", () => {
  for (const bad of [{}, { parentTaskId: "" }, { parentTaskId: null }, { parentTaskId: 42 }, null, undefined]) {
    assert.equal(approvalOwnsTask(bad, "task-1"), false, JSON.stringify(bad) + " 应判为不一致");
  }
  assert.equal(approvalOwnsTask({ parentTaskId: "task-1" }, ""), false, "期望值为空也必须拒绝");
});

test("approvalSessionIdOf：只认 agent.session.id", () => {
  assert.equal(approvalSessionIdOf({ agent: { session: { id: "session-1" } } }), "session-1");
  assert.equal(approvalSessionIdOf({ agent: { session: { id: 7 } } }), null);
  assert.equal(approvalSessionIdOf({}), null);
  assert.equal(approvalSessionIdOf(null), null);
});

test("previewArgs：JSON 字符串截断 + 空值归 null", () => {
  assert.equal(previewArgs(null), null);
  assert.equal(previewArgs("  "), null);
  assert.equal(previewArgs({ a: 1 }), '{"a":1}');
  const long = "x".repeat(TOOL_ARGS_PREVIEW_MAX + 50);
  const cut = previewArgs(long);
  assert.equal(cut.length, TOOL_ARGS_PREVIEW_MAX + 1, "截断后带一个省略号");
  assert.ok(cut.endsWith("…"));
});

test("collectToolCallsFromEvent：只吃 assistant/message 的 tool-call 块", () => {
  const ev = {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "hi" }, { type: "tool-call", id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }] } },
  };
  const got = collectToolCallsFromEvent("session-1", ev);
  assert.deepEqual(got, [{ sessionId: "session-1", callId: "c1", name: "bash", args: '{"cmd":"ls"}' }]);
  assert.deepEqual(collectToolCallsFromEvent("session-1", { type: "user/message" }), []);
  assert.deepEqual(collectToolCallsFromEvent(null, ev), [], "无会话 id 不收集");
  assert.deepEqual(collectToolCallsFromEvent("session-1", { type: "assistant/message", data: { message: { content: [{ type: "tool-call", name: "x" }] } } }), [], "无 callId 不收集");
});

test("ToolCallCache：有界 + 按会话隔离 + 取不到返回 null", () => {
  const cache = new ToolCallCache();
  cache.push([
    { sessionId: "s1", callId: "c1", name: "bash", args: '{"a":1}' },
    { sessionId: "s2", callId: "c9", name: "fs", args: null },
  ]);
  assert.deepEqual(cache.get("s1", "c1"), { name: "bash", args: '{"a":1}' });
  assert.equal(cache.get("s2", "c1"), null, "不同会话不串");
  assert.deepEqual(cache.get("s2", "c9"), { name: "fs", args: null });
  assert.equal(cache.get("s1", "nope"), null);
  cache.clear();
  assert.equal(cache.get("s1", "c1"), null);
});

test("常量：默认审批超时是 App 侧策略值，不是宿主默认（宿主默认 0 = 不超时）", () => {
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 30000);
});

// —— 审批载荷的"具体操作" ——
// 宿主通知正文是 `Approval requested: <label>`，label 之外的内容不保证写进审批方的视线；
// 审批是 Agent 的活，只给工具名等于让它凭信任签字。下列用例锁住 label 里的实义。

test("clipForLabel：压平空白 + 保头保尾截断", () => {
  assert.equal(clipForLabel("  a   b\tc  ", 40), "a b c");
  const long = "A".repeat(80) + "Z".repeat(80);
  const cut = clipForLabel(long, 40);
  assert.equal(cut.length, 40, "截断到上限");
  assert.ok(cut.includes("…"), cut);
  assert.ok(cut.startsWith("A") && cut.endsWith("Z"), "路径尾部也承载信息，两头都留");
});

test("summarizeOperation：说出要动什么（写/改/命令/URL/兜底）", () => {
  const writeArgs = JSON.stringify({
    file_path: "E:\\Hanako\\probe.txt",
    content: "x".repeat(61),
    sandbox_permissions: "danger-full-access",
  });
  assert.equal(summarizeOperation("write", writeArgs), "写文件 E:\\Hanako\\probe.txt（61 字符）");
  assert.equal(
    summarizeOperation("edit", JSON.stringify({ file_path: "a.ts", old_string: "abc", new_string: "de" })),
    "改文件 a.ts（替换 3 → 2 字符）",
  );
  assert.equal(summarizeOperation("bash", '{"command":"ls -la","cwd":"/x"}'), "执行命令 ls -la");
  assert.equal(summarizeOperation("fetch", '{"url":"https://example.com"}'), "请求 https://example.com");
  assert.equal(summarizeOperation("write", '{"file_path":"a.txt"}'), "访问 a.txt");
  assert.equal(summarizeOperation("mystery", '{"a":1}'), '调用 mystery（{"a":1}）');
  assert.equal(summarizeOperation("write", null), "调用 write");
  assert.equal(
    summarizeOperation("write", '{"file_path":"a.txt",'),
    '调用 write（{"file_path":"a.txt",）',
    "预览被截断/非法 JSON 退回兜底，不抛",
  );
});

test("describeEscalation：读出申请的沙箱档 + 一句人话（未知档不臆测）", () => {
  assert.deepEqual(describeEscalation('{"sandbox_permissions":"danger-full-access"}'), {
    mode: "danger-full-access",
    note: "越过工作区限制（工作区外读写、更宽执行面）",
  });
  assert.equal(describeEscalation('{"command":"ls"}'), null, "没有档位字段就不编造");
  assert.equal(describeEscalation(null), null);
  const unknown = describeEscalation('{"sandbox":"weird-mode"}');
  assert.equal(unknown.mode, "weird-mode");
  assert.ok(unknown.note.includes("未登记"), unknown.note);
});

test("buildApprovalLabel：label 自带具体操作与申请的权限档，并保留既有前缀", () => {
  const args = JSON.stringify({
    file_path: "E:\\Hanako\\probe.txt",
    content: "x".repeat(61),
    sandbox_permissions: "danger-full-access",
  });
  const label = buildApprovalLabel("write", summarizeOperation("write", args), describeEscalation(args));
  assert.ok(label.startsWith("DSH 请求执行越界/敏感操作（write）"), label);
  assert.ok(label.includes("probe.txt"), label);
  assert.ok(label.includes("61 字符"), label);
  assert.ok(label.includes("danger-full-access"), label);
  const bare = buildApprovalLabel("mystery", summarizeOperation("mystery", null), describeEscalation(null));
  assert.equal(bare, "DSH 请求执行越界/敏感操作（mystery）：调用 mystery", "拿不到 args 时不编造档位");
});

// —— 认领前的收尾判定（拿到 approvalId 之后、起 watcher 之前）——

test("preWatchVerdict：已中止/桥已停止 → rejected；否则 null（正常进 watch）", () => {
  assert.equal(preWatchVerdict({ aborted: true, stopped: false }), "rejected");
  assert.equal(preWatchVerdict({ aborted: false, stopped: true }), "rejected");
  assert.equal(preWatchVerdict({ aborted: true, stopped: true }), "rejected");
  assert.equal(preWatchVerdict({ aborted: false, stopped: false }), null);
  assert.equal(preWatchVerdict({}), null, "只有布尔真才算命中");
  assert.equal(preWatchVerdict(null), null);
  assert.equal(preWatchVerdict(undefined), null);
});

// —— 组装面：假 ctx + 假 hana.tasks（不起真进程）——

const SID = "session-11111111-2222-3333-4444-555555555555";

/** 造一条宿主任务记录（形状取 AppTaskRecordV2 里绑定归一读的那几格）。 */
function hostRec(over = {}) {
  return {
    taskId: "task-1",
    status: "running",
    metadata: { dsh: { action: "create", sessionId: SID, rpcId: "r_1", approvalTimeoutMs: 30000 } },
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

/** 假 ctx：捕获 ctx.on 注册的 handler，返回 fire 手动触发（模拟 DSH 瀑布事件）。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    ctx: {
      on: (ev, h) => {
        handlers.set(ev, h);
        return () => handlers.delete(ev);
      },
    },
    fire: (ev, ...args) => handlers.get(ev)(...args),
  };
}

/**
 * 假宿主任务面 + 假 hana.tasks。approvalGate 挂在 requestApproval 上（在途窗口用）；
 * approvalResult 覆盖 requestApproval 的返回（默认一条 pending 审批记录）。
 * watcher 对账读到的是"已终态但无 outcome"的审批记录 ⇒ fail-closed rejected，一轮即收敛，
 * 不留在后台重连退避上；calls.gets 是对账读次数，>0 就说明 watcher 真的起了。
 */
function harness({ rows = [hostRec()], approvalGate = null, approvalResult = null } = {}) {
  const store = new Map(rows.map((r) => [r.taskId, r]));
  const tasks = {
    list: async () => [...store.values()],
    get: async (id) => store.get(id) || null,
    update: async (id, patch) => {
      const next = { ...(store.get(id) || {}), ...patch };
      store.set(id, next);
      return next;
    },
  };
  const calls = { requested: [], responded: [], gets: 0 };
  const hana = {
    tasks: {
      ...tasks,
      requestApproval: async (req) => {
        calls.requested.push(req);
        if (approvalGate) await approvalGate;
        return approvalResult || { approvalId: "appr-1", parentTaskId: req.taskId, status: "pending" };
      },
      respondApproval: async (a) => { calls.responded.push(a); return { ...a, status: "terminal" }; },
      watch: async () => ({ body: null }),
      get: async (id) => {
        calls.gets += 1;
        return { approvalId: id, parentTaskId: "task-1", status: "completed" };
      },
    },
  };
  const { ctx, fire } = fakeCtx();
  const notes = [];
  const stop = startApprovalBridge({ ctx, hana, log: (m) => notes.push(m) });
  return { store, tasks, calls, hana, fire, stop, notes };
}

const req = () => ({ agent: { session: { id: SID } }, callId: "c1", toolName: "bash", reason: null, signal: null });
const tick = () => new Promise((r) => setTimeout(r, 20));

test("绑定已终结 → 按无绑定委托，不认领（不得把审批挂到已结束的父任务上）", async () => {
  const h = harness({ rows: [hostRec({ status: "completed" })] });
  let delegated = 0;
  const out = await h.fire("approval/request", req(), () => { delegated += 1; return "delegated"; });
  assert.equal(out, "delegated", "终结态绑定必须走 next() 委托");
  assert.equal(delegated, 1);
  assert.equal(h.calls.requested.length, 0, "不得在终结的父任务上创建审批");
  assert.ok(h.notes.some((n) => n.includes("已终结")), "note 要说明原因：" + h.notes.join(" | "));
  h.stop();
});

test("绑定已终结（终态各值同款）→ 委托；读取失败仍是显式 rejected（两者不混）", async () => {
  for (const status of ["completed", "failed", "canceled", "aborted"]) {
    const h = harness({ rows: [hostRec({ status })] });
    let delegated = 0;
    await h.fire("approval/request", req(), () => { delegated += 1; });
    assert.equal(delegated, 1, status + " 应委托");
    assert.equal(h.calls.requested.length, 0);
    h.stop();
  }
  // 宿主不可达 = 状态丢了：显式拒绝且**不委托**（委托会把真因掩盖成 DSH 的 fail-closed）
  const broken = harness();
  broken.hana.tasks.list = async () => { throw new Error("host down"); };
  let delegated2 = 0;
  const out = await broken.fire("approval/request", req(), () => { delegated2 += 1; });
  assert.equal(out, "rejected");
  assert.equal(delegated2, 0, "读取失败不得委托");
  broken.stop();
});

test("活动绑定 → 正常认领（不误伤这条路）", async () => {
  const h = harness();
  const out = await h.fire("approval/request", req(), () => { throw new Error("不该委托"); });
  await tick(); // 让 watcher 收尾（终态帧结算后它把自己从 pendings 摘掉）
  assert.equal(h.calls.requested.length, 1, "活动绑定的审批照旧创建");
  assert.equal(h.calls.requested[0].taskId, "task-1", "认领时用绑定的 taskId 作父任务");
  assert.ok(h.calls.gets > 0, "认领后起 watcher 对账等宿主终态");
  assert.equal(out, "rejected", "宿主审批记录已终结且无 outcome ⇒ fail-closed rejected");
  // 宿主记录已是终态，桥不替宿主动作答；stop 也不该再应答一次
  assert.deepEqual(h.calls.responded, []);
  h.stop();
  assert.deepEqual(h.calls.responded, []);
});

test("审批创建即终态 → 直接按宿主结果结算，不入 pendings（stop 不重复应答）", async () => {
  const h = harness({ approvalResult: { approvalId: "appr-1", parentTaskId: "task-1", status: "canceled" } });
  const out = await h.fire("approval/request", req(), () => {});
  assert.equal(out, "rejected", "终态无 outcome ⇒ fail-closed 拒绝");
  assert.equal(h.calls.gets, 0, "已即时终态就不起 watcher");
  h.stop();
  assert.deepEqual(h.calls.responded, [], "宿主记录已是终态，stop 不该再应答一次");
});

test("中止窗口：requestApproval 在途被中止 → 宿主审批被 rejected 收尾，且不进 pendings", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ approvalGate: gate });
  const ac = new AbortController();
  const p = h.fire("approval/request", { ...req(), signal: ac.signal }, () => { throw new Error("不该委托"); });
  await tick();
  assert.equal(h.calls.requested.length, 1, "requestApproval 已发出（在途）");
  assert.equal(h.calls.responded.length, 0, "approvalId 还没到手，这时没有可应答的对象");

  ac.abort(); // DSH 回合取消落在 requestApproval 在途期间
  release();  // 宿主此刻才返回 approvalId
  const verdict = await p;
  await tick(); // 在途 answerer 拿到 approvalId 后的收尾（同一批微任务之后）

  assert.equal(verdict, "cancelled", "DSH 等待者收到取消，绝不是 allowed-once");
  assert.deepEqual(
    h.calls.responded,
    [{ approvalId: "appr-1", outcome: "rejected" }],
    "宿主那条审批必须被 rejected 收尾（不留孤儿）",
  );
  assert.equal(h.calls.gets, 0, "已中止的审批不该起 watcher");
  // 不进 pendings：stop() 的兜底循环扫不到它——它已经自己收尾了，不该再被应答第二次
  h.stop();
  assert.deepEqual(h.calls.responded, [{ approvalId: "appr-1", outcome: "rejected" }], "stop 不该重复应答");
});

test("中止窗口：先中止再拿到 approvalId（abort 早于 requestApproval 返回）同样收尾", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ approvalGate: gate });
  const ac = new AbortController();
  const p = h.fire("approval/request", { ...req(), signal: ac.signal }, () => {});
  await tick();
  ac.abort();
  await tick();
  release();
  const verdict = await p;
  await tick();
  assert.equal(verdict, "cancelled");
  assert.deepEqual(h.calls.responded, [{ approvalId: "appr-1", outcome: "rejected" }]);
  assert.equal(h.calls.gets, 0);
  h.stop();
});

test("停止窗口：桥在 requestApproval 在途时停止 → 手边的审批被 rejected 收束", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ approvalGate: gate });
  const p = h.fire("approval/request", req(), () => { throw new Error("不该委托"); });
  await tick();
  assert.equal(h.calls.requested.length, 1);
  h.stop();     // runtime shutdown 落在同一窗口
  release();
  const verdict = await p;
  await tick();
  assert.equal(verdict, "rejected", "桥已停止 ⇒ 既不拒绝也不放行的挂起是不允许的");
  assert.deepEqual(h.calls.responded, [{ approvalId: "appr-1", outcome: "rejected" }]);
  assert.equal(h.calls.gets, 0, "停止后不该再起 watcher");
});
