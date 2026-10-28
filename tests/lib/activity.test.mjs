// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/activity.test.mjs — 状态点写入计划的纯函数面
// （packages/runtime/src/activity-sync.ts 的 planChromeWrite / mergeDescription）
import { test } from "node:test";
import assert from "node:assert/strict";
import { planChromeWrite, mergeDescription } from "@dshana/runtime/activity-sync.ts";

test("planChromeWrite：与现描述一致就不写", () => {
  assert.equal(planChromeWrite({ revision: 3, activity: "running" }, "running"), null);
  assert.equal(planChromeWrite({ revision: 3 }, null), null);
  assert.equal(planChromeWrite(null, null), null);
});

test("planChromeWrite：变化时给出递增的 revision", () => {
  assert.deepEqual(planChromeWrite({ revision: 3, activity: null }, "running"), { revision: 4, activity: "running" });
  assert.deepEqual(planChromeWrite({ revision: 1, activity: "running" }, null), { revision: 2, activity: null });
  // 从未写过：从 1 开始
  assert.deepEqual(planChromeWrite(null, "running"), { revision: 1, activity: "running" });
  assert.deepEqual(planChromeWrite({}, "running"), { revision: 1, activity: "running" });
});

test("planChromeWrite：非法 revision 一律从头算（负数也是非法）", () => {
  // Number.isSafeInteger(-5) 是真，不额外判正负就会把 -5+1 交上去
  assert.deepEqual(planChromeWrite({ revision: -5, activity: null }, "running"), { revision: 1, activity: "running" });
  assert.deepEqual(planChromeWrite({ revision: 0, activity: null }, "running"), { revision: 1, activity: "running" });
  assert.deepEqual(planChromeWrite({ revision: 1.5, activity: null }, "running"), { revision: 1, activity: "running" });
  assert.deepEqual(planChromeWrite({ revision: "7", activity: null }, "running"), { revision: 1, activity: "running" });
});

test("mergeDescription：整份替换，页面自己的字段必须带着", () => {
  const current = { revision: 2, title: "DSHana", tabs: [{ id: "a" }], actions: [{ id: "x" }] };
  const merged = mergeDescription(current, { revision: 3, activity: "running" });
  assert.deepEqual(merged, { revision: 3, title: "DSHana", tabs: [{ id: "a" }], actions: [{ id: "x" }], activity: "running" });
  // 不改原对象
  assert.equal(current.revision, 2);
  assert.equal("activity" in current, false);
});

test("mergeDescription：从未写过时只交 revision 与 activity", () => {
  assert.deepEqual(mergeDescription(null, { revision: 1, activity: null }), { revision: 1, activity: null });
  assert.deepEqual(mergeDescription(undefined, { revision: 1, activity: "running" }), { revision: 1, activity: "running" });
});
