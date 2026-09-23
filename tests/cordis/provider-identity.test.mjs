// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cordis/provider-identity.test.mjs — src-cordis/plugins/provider/lib/identity.ts 单测
//
// 锁死的是**三态判定**（App 身份仅限“用户直接在 WebUI 使用”）：
//   ① 无绑定            ⇒ App 身份（用户自建会话）
//   ② 有绑定 + 任务终结 ⇒ App 身份（任务已终结，用户接着在 WebUI 里跑——事实，不是降级）
//   ③ 有绑定 + 任务活动 ⇒ { taskId }（必须，绑定不能丢）
//   ④ 绑定读不出/索引缺席 ⇒ **抛错**（TASK_MAP_BROKEN / BINDING_UNAVAILABLE）——绝不伪装成 ①
// 身份字段只有 taskId（callToken 是工具调用期推理的事，本 adapter 从不传）。
// 绑定来源是宿主任务记录（受管 runtime 的绑定索引），不是我们自己的映射文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModelIdentity,
  resolveSessionIdentity,
  TASK_MAP_BROKEN,
  BINDING_UNAVAILABLE,
  TASK_BINDING_GLOBAL_KEY,
} from "../../src-cordis/plugins/provider/lib/identity.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";

test("① 无绑定（用户自建会话）→ App 身份，reason=unowned-session", () => {
  const r = resolveModelIdentity(null);
  assert.deepEqual(r, { identity: {}, source: "app", reason: "unowned-session" });
  assert.equal("taskId" in r.identity, false);
  assert.equal("callToken" in r.identity, false);
  assert.deepEqual(resolveModelIdentity(undefined), { identity: {}, source: "app", reason: "unowned-session" });
});

test("③ 有绑定且任务活动 → taskId 身份，且只带 taskId", () => {
  const r = resolveModelIdentity({ taskId: "task-1", status: "running" });
  assert.deepEqual(r, { identity: { taskId: "task-1" }, source: "task" });
  assert.deepEqual(Object.keys(r.identity), ["taskId"]);
});

test("② 有绑定但任务终结 → App 身份，reason=task-ended（不遗留陈旧 taskId）", () => {
  for (const status of ["completed", "failed", "canceled", "aborted"]) {
    assert.deepEqual(
      resolveModelIdentity({ taskId: "task-1", status }),
      { identity: {}, source: "app", reason: "task-ended" },
      status + " 应视为已终结",
    );
  }
});

test("③ 绑定缺 taskId → 抛 TASK_MAP_BROKEN，不降级成 App 身份", () => {
  assert.throws(
    () => resolveModelIdentity({ taskId: "", status: "running" }),
    (e) => e && e.code === TASK_MAP_BROKEN,
  );
});

// ---- 运行期：经 globalThis 的绑定索引解析 ----

/** 假索引：bySession 可注入结果或抛错。 */
function fakeIndex(impl) {
  return { bySession: impl };
}

test("resolveSessionIdentity：索引给出绑定 → 走三态", async () => {
  assert.deepEqual(
    await resolveSessionIdentity(SID, fakeIndex(async () => ({ taskId: "task-1", status: "running" }))),
    { identity: { taskId: "task-1" }, source: "task" },
  );
  assert.deepEqual(
    await resolveSessionIdentity(SID, fakeIndex(async () => null)),
    { identity: {}, source: "app", reason: "unowned-session" },
  );
  assert.deepEqual(
    await resolveSessionIdentity(SID, fakeIndex(async () => ({ taskId: "task-1", status: "completed" }))),
    { identity: {}, source: "app", reason: "task-ended" },
  );
});

test("④ 索引读取失败 → 原样上抛 TASK_MAP_BROKEN，绝不降级", async () => {
  const boom = Object.assign(new Error("宿主不可达"), { code: TASK_MAP_BROKEN });
  await assert.rejects(
    () => resolveSessionIdentity(SID, fakeIndex(async () => { throw boom; })),
    (e) => e && e.code === TASK_MAP_BROKEN && /宿主不可达/.test(e.message),
  );
});

test("④ 索引缺席（能力未挂载）→ BINDING_UNAVAILABLE，绝不降级", async () => {
  await assert.rejects(
    () => resolveSessionIdentity(SID, null),
    (e) => e && e.code === BINDING_UNAVAILABLE,
  );
  await assert.rejects(
    () => resolveSessionIdentity(SID, {}),
    (e) => e && e.code === BINDING_UNAVAILABLE,
  );
  // 不给 index 参数时读 globalThis 约定键（受管 runtime publishTaskBindingIndex 挂的）
  delete globalThis[TASK_BINDING_GLOBAL_KEY];
  await assert.rejects(
    () => resolveSessionIdentity(SID),
    (e) => e && e.code === BINDING_UNAVAILABLE,
  );
  const index = fakeIndex(async () => ({ taskId: "task-9", status: "running" }));
  globalThis[TASK_BINDING_GLOBAL_KEY] = index;
  try {
    assert.deepEqual(await resolveSessionIdentity(SID), { identity: { taskId: "task-9" }, source: "task" });
  } finally {
    delete globalThis[TASK_BINDING_GLOBAL_KEY];
  }
});
