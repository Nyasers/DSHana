// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/runtime/task-bridge.test.mjs — src/runtime/task-bridge.ts 单测：事件归类纯函数 +
// 宿主取消反向触发的两个回归点（真机踩过：取消标记没落、结算成 failed）。
//
// 绑定事实源是宿主任务记录（metadata.dsh）：取消标记写回任务 metadata，不用私有映射文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDshEvent, BRIDGE_EVENTS, SessionBridge, startTaskBridge } from "../../src/runtime/task-bridge.ts";
import { createTaskBindingIndex } from "../../src/lib/task-binding.ts";

test("classifyDshEvent: api-session/status true/false", () => {
  assert.deepEqual(classifyDshEvent("api-session/status", ["s1", false]), { kind: "status", sessionId: "s1", running: false });
  assert.deepEqual(classifyDshEvent("api-session/status", ["s1", true]), { kind: "status", sessionId: "s1", running: true });
  assert.equal(classifyDshEvent("api-session/status", []), null);
});

test("classifyDshEvent: api-session/error 与 activity", () => {
  assert.deepEqual(classifyDshEvent("api-session/error", ["s1", "boom"]), { kind: "error", sessionId: "s1", message: "boom" });
  assert.deepEqual(classifyDshEvent("api-session/activity", ["s1", 123]), { kind: "activity", sessionId: "s1" });
});

test("classifyDshEvent: session/event turn/end completed/error", () => {
  const completed = classifyDshEvent("session/event", [{ id: "s1" }, { type: "turn/end", data: { reason: { kind: "completed" } } }]);
  assert.deepEqual(completed, { kind: "turn-end", sessionId: "s1", errorKind: null, message: "" });
  const errored = classifyDshEvent("session/event", [
    { id: "s1" },
    { type: "turn/end", data: { reason: { kind: "error", error: { message: "llm failed", code: "X" } } } },
  ]);
  assert.equal(errored.kind, "turn-end");
  assert.equal(errored.errorKind, "error");
  assert.match(errored.message, /llm failed/);
});

test("classifyDshEvent: assistant/message / 未知事件 / 未知 session", () => {
  assert.deepEqual(classifyDshEvent("session/event", [{ id: "s1" }, { type: "assistant/message", data: {} }]), { kind: "assistant", sessionId: "s1" });
  assert.deepEqual(classifyDshEvent("session/event", [{ id: "s1" }, { type: "nope" }]), { kind: "turn-other", sessionId: "s1" });
  assert.equal(classifyDshEvent("unrelated", ["x"]), null);
  assert.equal(classifyDshEvent("session/event", [null, { type: "turn/end" }]), null);
});

test("BRIDGE_EVENTS 覆盖分类所需事件", () => {
  for (const e of ["api-session/status", "api-session/error", "session/event", "api-session/activity"]) {
    assert.ok(BRIDGE_EVENTS.includes(e));
  }
});

// ---- 宿主取消反向触发（真机回归：这条路上取消标记没落、任务被结算成 failed）----

const SID = "session-11111111-2222-3333-4444-555555555555";

/** 假宿主任务面：唯一事实源 = 任务记录本身（metadata.dsh.sessionId 即绑定）。 */
function fakeTasks() {
  const store = new Map([
    ["app:dshana:t1", {
      taskId: "app:dshana:t1",
      status: "running",
      metadata: { dsh: { action: "create", sessionId: SID, rpcId: "r_1" } },
      createdAt: 1,
      updatedAt: 1,
    }],
  ]);
  return {
    store,
    list: async () => [...store.values()],
    get: async (id) => store.get(id) || null,
    update: async (id, patch) => {
      const next = { ...(store.get(id) || {}), ...patch };
      store.set(id, next);
      return next;
    },
  };
}

function makeBridge() {
  const tasks = fakeTasks();
  const calls = { canceled: [], completed: [], failed: [] };
  const hana = {
    tasks: {
      cancel: async (taskId, msg) => calls.canceled.push({ taskId, msg }),
      complete: async (taskId, res) => calls.completed.push({ taskId, res }),
      fail: async (taskId, msg) => calls.failed.push({ taskId, msg }),
    },
  };
  const bridge = new SessionBridge({
    hana,
    bindings: createTaskBindingIndex(tasks),
    log: () => {},
    serviceBaseUrl: "http://127.0.0.1:9", // 连接必然被拒：反向 RPC 失败只记日志，不阻断收尾
    bridgeKey: "",
    cancelModelRequests: async () => {},
  });
  bridge.taskId = "app:dshana:t1";
  bridge.sessionId = SID;
  bridge.binding = { taskId: "app:dshana:t1", dshSessionId: SID, action: "create", rpcId: "r_1", cancel: null };
  return { bridge, tasks, calls };
}

test("宿主取消：先把取消标记落进宿主任务记录", async () => {
  const { bridge, tasks } = makeBridge();
  await bridge.onHostCancel({ status: "canceled" });
  const dsh = tasks.store.get("app:dshana:t1").metadata.dsh;
  assert.equal(dsh.cancel && dsh.cancel.reason, "user");
  assert.equal(dsh.sessionId, SID, "写取消标记不得把已有 dsh 键吃掉（全量读-改-写）");
});

test("宿主取消：本进程亲手取消过 → 结算成 canceled，不得判成 failed", async () => {
  const { bridge, calls } = makeBridge();
  bridge.hostCancelDone = true; // 反向取消路径已置位；此时任务记录里的 cancel 可能还没回读到
  await bridge.settle({ ok: false, message: "DSH 回合被中止（aborted）" });
  assert.equal(calls.canceled.length, 1, "已亲手请求取消 ⇒ 必须结算成 canceled");
  assert.equal(calls.failed.length, 0);
});

test("终态判定：任务记录里有 cancel 标记（App 侧先写）→ 结算成 canceled", async () => {
  const { bridge, tasks, calls } = makeBridge();
  tasks.store.get("app:dshana:t1").metadata.dsh.cancel = { at: Date.now(), reason: "user" };
  await bridge.settle({ ok: false, aborted: true, message: "DSH 回合被中止（aborted）" });
  assert.equal(calls.canceled.length, 1);
  assert.equal(calls.failed.length, 0);
});

test("终态判定：无取消标记的正常失败 → fail，不误判成取消", async () => {
  const { bridge, calls } = makeBridge();
  await bridge.settle({ ok: false, message: "boom" });
  assert.equal(calls.canceled.length, 0);
  assert.equal(calls.failed.length, 1);
});

test("终态判定：取消标记读不出 → 按已请求取消结算（fail-closed，不得记成成功）", async () => {
  const tasks = { list: async () => [], get: async () => { throw new Error("host down"); } };
  const calls = { canceled: [], completed: [], failed: [] };
  const hana = {
    tasks: {
      cancel: async (taskId, msg) => calls.canceled.push({ taskId, msg }),
      complete: async (taskId, res) => calls.completed.push({ taskId, res }),
      fail: async (taskId, msg) => calls.failed.push({ taskId, msg }),
    },
  };
  const bridge = new SessionBridge({
    hana,
    bindings: createTaskBindingIndex(tasks),
    log: () => {},
    serviceBaseUrl: "http://127.0.0.1:9",
    bridgeKey: "",
    cancelModelRequests: async () => {},
  });
  bridge.taskId = "app:dshana:t1";
  bridge.sessionId = SID;
  bridge.binding = { taskId: "app:dshana:t1", dshSessionId: SID, action: "create", rpcId: "r_1", cancel: null };
  await bridge.settle({ ok: true, message: "done" });
  assert.equal(calls.canceled.length, 1, "取消状态未知 ⇒ fail-closed 结算成 canceled");
  assert.equal(calls.completed.length, 0, "不得把不确定当成功");
});

// ---- 同会话续发（真机回归：reply 续发时旧桥已终态占位，新任务的终态回投被吞）----

const SID_REBIND = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const tick = () => new Promise((r) => setTimeout(r, 20));

/** 假宿主任务面：同会话两个任务先后绑定（t2 比 t1 新，对应 reply 的绑定换代）。 */
function fakeRebindTasks() {
  const store = new Map([
    ["app:dshana:t1", {
      taskId: "app:dshana:t1",
      status: "running",
      metadata: { dsh: { action: "create", sessionId: SID_REBIND, rpcId: "r_1" } },
      createdAt: 1,
      updatedAt: 1,
    }],
  ]);
  return {
    store,
    list: async () => [...store.values()],
    get: async (id) => store.get(id) || null,
    update: async (id, patch) => {
      const next = { ...(store.get(id) || {}), ...patch };
      store.set(id, next);
      return next;
    },
  };
}

/** 只收事件订阅的假 ctx：fire 手动投帧（模拟 DSH 侧事件）。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    ctx: { on: (ev, h) => { handlers.set(ev, h); return () => handlers.delete(ev); } },
    fire: (ev, ...args) => {
      const h = handlers.get(ev);
      if (h) h(...args);
    },
  };
}

function rebindHarness() {
  const tasks = fakeRebindTasks();
  const calls = { completed: [], failed: [], canceled: [] };
  const hana = {
    tasks: {
      list: tasks.list,
      get: tasks.get,
      update: tasks.update,
      complete: async (taskId, res) => { calls.completed.push({ taskId, res }); },
      fail: async (taskId, msg) => { calls.failed.push({ taskId, msg }); },
      cancel: async (taskId, msg) => { calls.canceled.push({ taskId, msg }); },
    },
  };
  const { ctx, fire } = fakeCtx();
  const stop = startTaskBridge({ ctx, hana, log: () => {} });
  return { tasks, calls, fire, stop };
}

const turnEnd = { type: "turn/end", data: { reason: { kind: "completed" } } };

test("同会话续发：旧桥终态后绑定换代，新任务的终态仍能回投", async () => {
  const { tasks, calls, fire, stop } = rebindHarness();

  // 第一轮：t1 的 turn/end → 结算 t1
  fire("session/event", { id: SID_REBIND }, turnEnd);
  await tick();
  assert.deepEqual(calls.completed.map((c) => c.taskId), ["app:dshana:t1"]);

  // 宿主换绑到 t2（reply 续发：sessionId 不变、任务记录换新）
  tasks.store.set("app:dshana:t2", {
    taskId: "app:dshana:t2",
    status: "running",
    metadata: { dsh: { action: "send", sessionId: SID_REBIND, rpcId: "r_2" } },
    createdAt: 100,
    updatedAt: 100,
  });

  // 第二轮：同一会话的新 turn/end → 必须回投到 t2，不得被已终态的旧桥吞掉
  fire("session/event", { id: SID_REBIND }, turnEnd);
  await tick();
  assert.deepEqual(calls.completed.map((c) => c.taskId), ["app:dshana:t1", "app:dshana:t2"]);
  assert.equal(calls.failed.length, 0);
  stop();
});

test("同会话续发：同一 tick 内两个终态帧只换一条桥，不重复结算", async () => {
  const { tasks, calls, fire, stop } = rebindHarness();

  fire("session/event", { id: SID_REBIND }, turnEnd);
  await tick();
  assert.deepEqual(calls.completed.map((c) => c.taskId), ["app:dshana:t1"]);

  tasks.store.set("app:dshana:t2", {
    taskId: "app:dshana:t2",
    status: "running",
    metadata: { dsh: { action: "send", sessionId: SID_REBIND, rpcId: "r_2" } },
    createdAt: 100,
    updatedAt: 100,
  });

  // 两条终态帧在同一个 tick 内到达：换代判定 await 期间会交错，
  // 换代必须是原子的，否则同一轮会建出两条桥各自结算一次。
  fire("session/event", { id: SID_REBIND }, turnEnd);
  fire("api-session/status", SID_REBIND, false);
  await tick();

  const t2 = calls.completed.filter((c) => c.taskId === "app:dshana:t2");
  assert.equal(t2.length, 1, "同一个新任务只能结算一次");
  assert.equal(calls.failed.length, 0);
  stop();
});

test("同会话迟到帧：绑定未换代时旧桥不重建，不重复结算", async () => {
  const { calls, fire, stop } = rebindHarness();

  fire("session/event", { id: SID_REBIND }, turnEnd);
  await tick();
  // 宿主绑定仍是 t1（没有新任务）：再来一帧应被已终态的桥忽略
  fire("session/event", { id: SID_REBIND }, turnEnd);
  await tick();
  assert.deepEqual(calls.completed.map((c) => c.taskId), ["app:dshana:t1"]);
  assert.equal(calls.canceled.length, 0);
  assert.equal(calls.failed.length, 0);
  stop();
});
