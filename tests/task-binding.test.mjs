// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-binding.test.mjs — src/lib/task-binding.ts 单测
//
// 锁死的是**绑定事实源 = 宿主任务记录**这条路：
//   · 归一：metadata.dsh 里有什么算绑定、什么不算（无绑定 vs 记录畸形）；
//   · 索引：短 TTL 缓存 + fresh 读 + 同会话取最新 + 畸形会话显式失败（TASK_MAP_BROKEN）；
//   · 写：取消标记读-改-写**全量 dsh**（update 的合并语义没写死，残键不能被吃掉）；
//   · 交付：globalThis 上的索引供 cordis provider 身份判定读取（publish/unpublish）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidSessionId,
  taskBindingOf,
  dshMetadataFor,
  isTerminalTaskStatus,
  createTaskBindingIndex,
  publishTaskBindingIndex,
  taskBindingBroken,
  TASK_MAP_BROKEN,
  TASK_BINDING_GLOBAL_KEY,
} from "../src/lib/task-binding.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";
const OTHER = "session-bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

/** 造一条宿主任务记录（形状取 AppTaskRecordV2 里我们真读的那几格）。 */
function rec(over = {}) {
  return {
    taskId: "task-1",
    status: "running",
    metadata: { dsh: { action: "create", sessionId: SID, rpcId: "r_1", timeoutSec: 1800, approvalTimeoutMs: 30000 } },
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

test("isValidSessionId：session-<uuid> 才合法（防畸形名进宿主查询）", () => {
  assert.equal(isValidSessionId(SID), true);
  assert.equal(isValidSessionId(SID.toUpperCase()), true);
  assert.equal(isValidSessionId("session-abc"), false);
  assert.equal(isValidSessionId("../../etc/passwd"), false);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(null), false);
});

test("taskBindingOf：合法 metadata.dsh → 归一绑定（字段原样）", () => {
  const b = taskBindingOf(rec());
  assert.equal(b.taskId, "task-1");
  assert.equal(b.dshSessionId, SID);
  assert.equal(b.action, "create");
  assert.equal(b.rpcId, "r_1");
  assert.equal(b.timeoutSec, 1800);
  assert.equal(b.approvalTimeoutMs, 30000);
  assert.equal(b.cancel, null);
  assert.equal(b.status, "running");
});

test("taskBindingOf：没有绑定 / 记录畸形 → null（不是抛出）", () => {
  assert.equal(taskBindingOf(null), null);
  assert.equal(taskBindingOf({}), null, "没有 metadata 不是绑定");
  assert.equal(taskBindingOf({ metadata: {} }), null, "没有 dsh 不是绑定");
  assert.equal(taskBindingOf({ metadata: { dsh: {} } }), null, "没有 sessionId 不是绑定");
  assert.equal(taskBindingOf({ metadata: { dsh: { sessionId: "not-a-session" } } }), null, "畸形 sessionId 不是绑定");
  assert.equal(taskBindingOf(rec({ taskId: undefined })), null, "没有 taskId 不是绑定");
});

test("taskBindingOf：cancel 标记只认带数字 at 的对象", () => {
  const marked = taskBindingOf(rec({ metadata: { dsh: { sessionId: SID, cancel: { at: 7, reason: "timeout" } } } }));
  assert.deepEqual(marked.cancel, { at: 7, reason: "timeout" });
  const bad = taskBindingOf(rec({ metadata: { dsh: { sessionId: SID, cancel: { reason: "x" } } } }));
  assert.equal(bad.cancel, null, "没有 at 的取消标记不算标记");
});

test("isTerminalTaskStatus：宿主终态集合", () => {
  for (const s of ["completed", "failed", "canceled", "aborted"]) assert.equal(isTerminalTaskStatus(s), true);
  for (const s of ["pending", "running", "paused", "blocked", "recovering", ""]) assert.equal(isTerminalTaskStatus(s), false);
});

test("dshMetadataFor：保留任务其它 metadata 键，dsh 整块按已有值 + patch 覆盖", () => {
  const r = rec({ metadata: { dsh: { sessionId: SID, rpcId: "r_1" }, other: { keep: true } } });
  const meta = dshMetadataFor(r, { cancel: { at: 1, reason: "user" } });
  assert.deepEqual(meta.other, { keep: true }, "别家键不能被吃掉");
  assert.equal(meta.dsh.sessionId, SID, "已有 dsh 键保留");
  assert.equal(meta.dsh.rpcId, "r_1");
  assert.deepEqual(meta.dsh.cancel, { at: 1, reason: "user" });
});

test("taskBindingBroken：code = TASK_MAP_BROKEN", () => {
  assert.equal(taskBindingBroken("why", "sub").code, TASK_MAP_BROKEN);
});

// ---- 索引：读 ----

/** 假宿主任务面：list/get/update 全部可注入，记录调用次数。 */
function fakeTasks(rows) {
  const calls = { list: 0, get: [], update: [] };
  const store = new Map(rows.map((r) => [r.taskId, r]));
  return {
    calls,
    store,
    list: async () => {
      calls.list += 1;
      return [...store.values()];
    },
    get: async (id) => {
      calls.get.push(id);
      return store.get(id) || null;
    },
    update: async (id, patch) => {
      calls.update.push({ id, patch });
      const cur = store.get(id) || {};
      const next = { ...cur, ...patch };
      store.set(id, next);
      return next;
    },
  };
}

test("bySession：命中 / 未命中（未命中 = 无绑定，不抛）", async () => {
  const tasks = fakeTasks([rec()]);
  const index = createTaskBindingIndex(tasks);
  assert.equal((await index.bySession(SID)).taskId, "task-1");
  assert.equal(await index.bySession(OTHER), null, "没有绑定返回 null");
  assert.equal(await index.bySession("bad-id"), null, "畸形会话 id 不去宿主查");
  assert.equal(tasks.calls.list, 1);
});

test("bySession：短 TTL 内共用一次宿主往返；fresh 强制重建", async () => {
  const tasks = fakeTasks([rec()]);
  const index = createTaskBindingIndex(tasks, { ttlMs: 60_000 });
  await index.bySession(SID);
  await index.bySession(SID);
  assert.equal(tasks.calls.list, 1, "热路径不得每请求往返宿主");
  await index.bySession(SID, { fresh: true });
  assert.equal(tasks.calls.list, 2, "fresh 必须绕过缓存");
  index.invalidate();
  await index.bySession(SID);
  assert.equal(tasks.calls.list, 3, "失效后重建");
});

test("缓存竞态：失效期间回填的旧 build 不得覆盖缓存（invalidate 之后必须重建）", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let listCalls = 0;
  const tasks = {
    list: async () => {
      listCalls += 1;
      await gate; // 把读挂在闸上：模拟“读到一半”
      return [rec()];
    },
  };
  const index = createTaskBindingIndex(tasks, { ttlMs: 60_000 });
  const inFlight = index.bySession(SID); // 起一次读（在途）
  index.invalidate();                    // 读回期间写点到达（失效）
  release();
  await inFlight;
  listCalls = 0;
  await index.bySession(SID);
  assert.equal(listCalls, 1, "旧 build 回填的快照不得被当成有效缓存");
});

test("缓存竞态：fresh 读发起新 build，不复用代次不符的在途读", async () => {
  const releases = [];
  let listCalls = 0;
  const tasks = {
    list: () => {
      listCalls += 1;
      return new Promise((r) => releases.push(() => r([rec()])));
    },
  };
  const index = createTaskBindingIndex(tasks, { ttlMs: 60_000 });
  const first = index.bySession(SID);                   // build#1 在途
  index.invalidate();                                   // 写点
  const second = index.bySession(SID, { fresh: true }); // 必须另起 build
  assert.equal(listCalls, 2, "fresh 不得复用写前开始的在途读");
  for (const r of releases) r();
  await Promise.all([first, second]);
});

test("bySession：同会话多条取 createdAt 最新的一条", async () => {
  const old = rec({ taskId: "old", createdAt: 10 });
  const fresh = rec({ taskId: "fresh", createdAt: 20 });
  const index = createTaskBindingIndex(fakeTasks([old, fresh]));
  assert.equal((await index.bySession(SID)).taskId, "fresh");
});

test("bySession：sessionId 形态非法的记录进不了索引（也归不到任何会话）", async () => {
  const tasks = fakeTasks([rec({ metadata: { dsh: { sessionId: "../../etc/passwd" } } })]);
  const index = createTaskBindingIndex(tasks);
  assert.equal(await index.bySession("../../etc/passwd"), null);
  assert.equal(await index.bySession(SID), null, "畸形记录不得被当成某个会话的绑定");
});

test("bySession：宿主任务面缺失/失败 → TASK_MAP_BROKEN（不降级成“无绑定”）", async () => {
  const noList = createTaskBindingIndex({});
  await assert.rejects(() => noList.bySession(SID), (e) => e.code === TASK_MAP_BROKEN);
  const failing = createTaskBindingIndex({ list: async () => { throw new Error("host down"); } });
  await assert.rejects(() => failing.bySession(SID), (e) => e.code === TASK_MAP_BROKEN && /host down/.test(e.message));
  const wrongShape = createTaskBindingIndex({ list: async () => null });
  await assert.rejects(() => wrongShape.bySession(SID), (e) => e.code === TASK_MAP_BROKEN);
});

test("byTask：直接读宿主记录（不吃缓存）；没有绑定/宿主失败显式处理", async () => {
  const tasks = fakeTasks([rec()]);
  const index = createTaskBindingIndex(tasks);
  assert.equal((await index.byTask("task-1")).dshSessionId, SID);
  assert.equal(await index.byTask("missing"), null, "记录不在 = 无绑定");
  assert.equal(await index.byTask(""), null);
  // 记录自称有 dsh 绑定却归一不出会话（缺 sessionId / taskId）= 状态丢了 ⇒ 显式失败
  const corrupt = createTaskBindingIndex(fakeTasks([
    { taskId: "task-2", status: "running", metadata: { dsh: { rpcId: "r_2" } } },
  ]));
  await assert.rejects(() => corrupt.byTask("task-2"), (e) => e.code === TASK_MAP_BROKEN);
  // 完全不带 dsh 的记录 = 没有绑定
  const plain = createTaskBindingIndex(fakeTasks([{ taskId: "task-3", status: "running", metadata: {} }]));
  assert.equal(await plain.byTask("task-3"), null);
  assert.match(taskBindingBroken("x").message, /宿主任务记录不可读/);
});

// ---- 索引：写（取消标记）----

test("markCancel：读-改-写全量 metadata，cancel 落到 metadata.dsh 且别键不丢", async () => {
  const tasks = fakeTasks([rec({ metadata: { dsh: { sessionId: SID, rpcId: "r_1" }, other: 1 } })]);
  const index = createTaskBindingIndex(tasks);
  const out = await index.markCancel("task-1", "timeout");
  assert.equal(out.cancel.reason, "timeout");
  assert.ok(typeof out.cancel.at === "number");
  const written = tasks.calls.update[0];
  assert.equal(written.id, "task-1");
  assert.equal(written.patch.metadata.dsh.sessionId, SID, "写入必须是全量 dsh（合并语义没写死）");
  assert.equal(written.patch.metadata.dsh.rpcId, "r_1");
  assert.equal(written.patch.metadata.other, 1);
  // 幂等覆盖
  await index.markCancel("task-1", "user");
  assert.equal(tasks.store.get("task-1").metadata.dsh.cancel.reason, "user");
});

test("markCancel：任务不存在返回 null；宿主写入失败抛错（调用方决定继续与否）", async () => {
  const tasks = fakeTasks([]);
  const index = createTaskBindingIndex(tasks);
  assert.equal(await index.markCancel("ghost", "user"), null);
  const failing = createTaskBindingIndex({
    get: async () => rec(),
    update: async () => { throw new Error("nope"); },
  });
  await assert.rejects(() => failing.markCancel("task-1", "user"), /取消标记写入失败/);
});

// ---- 跨 bundle 交付（provider 身份判定读的那一格）----

test("publishTaskBindingIndex：挂到 globalThis 约定的键上；dispose 只撤自己那一份", () => {
  const index = createTaskBindingIndex(fakeTasks([rec()]));
  const dispose = publishTaskBindingIndex(index);
  assert.equal(globalThis[TASK_BINDING_GLOBAL_KEY], index);
  dispose();
  assert.equal(globalThis[TASK_BINDING_GLOBAL_KEY], undefined);
  // 后来的索引被撤掉时，不得误清掉已经被别人替换的当前值
  const a = createTaskBindingIndex(fakeTasks([]));
  const b = createTaskBindingIndex(fakeTasks([]));
  const disposeA = publishTaskBindingIndex(a);
  publishTaskBindingIndex(b);
  disposeA();
  assert.equal(globalThis[TASK_BINDING_GLOBAL_KEY], b);
  delete globalThis[TASK_BINDING_GLOBAL_KEY];
});
