// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/activity.test.mjs — 页面状态点的判定与写入计划（packages/runtime/src/activity.ts、
// activity-sync.ts 的纯函数面）
import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFromTasks } from "@dshana/runtime/activity.ts";
import { planChromeWrite, mergeDescription } from "@dshana/runtime/activity-sync.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";

/** 一条带 DSH 绑定的宿主任务记录。 */
function task(status, over = {}) {
  return { taskId: "t1", status, metadata: { dsh: { sessionId: SID } }, ...over };
}

test("activityFromTasks：非数组 / 空表都不亮", () => {
  assert.equal(activityFromTasks(null), null);
  assert.equal(activityFromTasks(undefined), null);
  assert.equal(activityFromTasks("x"), null);
  assert.equal(activityFromTasks([]), null);
});

test("activityFromTasks：非终态任务 → running", () => {
  for (const status of ["pending", "running", "blocked", "paused", "recovering"]) {
    assert.equal(activityFromTasks([task(status)]), "running", status + " 应点亮");
  }
});

test("activityFromTasks：全部终态 → 不亮", () => {
  for (const status of ["completed", "failed", "canceled", "aborted"]) {
    assert.equal(activityFromTasks([task(status)]), null, status + " 应灭灯");
  }
  assert.equal(activityFromTasks([task("completed"), task("failed")]), null);
});

test("activityFromTasks：只要有一条在跑就亮，不看顺序", () => {
  assert.equal(activityFromTasks([task("completed"), task("running")]), "running");
  assert.equal(activityFromTasks([task("running"), task("completed")]), "running");
});

test("activityFromTasks：不带 DSH 绑定的任务不算（别的 App 的任务不该点亮这一页）", () => {
  assert.equal(activityFromTasks([{ taskId: "t2", status: "running", metadata: {} }]), null);
  assert.equal(activityFromTasks([{ taskId: "t2", status: "running" }]), null);
  // 会话 id 非法的记录也归不到这一页
  assert.equal(activityFromTasks([{ taskId: "t3", status: "running", metadata: { dsh: { sessionId: "bad" } } }]), null);
  // 畸形项跳过，不炸
  assert.equal(activityFromTasks([null, 1, "x", task("running")]), "running");
});

test("planChromeWrite：与现描述一致就不写", () => {
  assert.equal(planChromeWrite({ revision: 3, activity: "running" }, "running"), null);
  assert.equal(planChromeWrite({ revision: 3, activity: null }, null), null);
  // 从未写过（description 为 null）而目标也是不亮 → 仍然不写
  assert.equal(planChromeWrite(null, null), null);
});

test("planChromeWrite：变化时给出递增的 revision", () => {
  assert.deepEqual(planChromeWrite(null, "running"), { revision: 1, activity: "running" });
  assert.deepEqual(planChromeWrite({ revision: 3, activity: null }, "running"), { revision: 4, activity: "running" });
  assert.deepEqual(planChromeWrite({ revision: 3, activity: "running" }, null), { revision: 4, activity: null });
  // 非法 revision 当 0（宿主契约是正整数，读不到就从头算）
  assert.deepEqual(planChromeWrite({ revision: "x", activity: null }, "running"), { revision: 1, activity: "running" });
  assert.deepEqual(planChromeWrite({ revision: -5, activity: null }, "running"), { revision: 1, activity: "running" });
});

test("mergeDescription：整份替换，页面自己的字段必须带着", () => {
  const current = { revision: 2, title: "DSHana", tabs: [{ id: "a", label: "A" }], actions: [] };
  const merged = mergeDescription(current, { revision: 3, activity: "running" });
  assert.deepEqual(merged, { ...current, revision: 3, activity: "running" });
  // 不改变入参
  assert.equal(current.revision, 2);
  assert.equal(current.activity, undefined);
});

test("mergeDescription：从未写过时只交 revision 与 activity", () => {
  assert.deepEqual(mergeDescription(null, { revision: 1, activity: "running" }), { revision: 1, activity: "running" });
  assert.deepEqual(mergeDescription(undefined, { revision: 1, activity: null }), { revision: 1, activity: null });
});
