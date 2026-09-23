// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/model-catalog-view.test.mjs — 宿主目录 → 设置页候选视图的纯函数契约
// （src/lib/model-catalog-view.ts）
//
// 这一段管两件事：
//   · 一条目录项的可用推理档：宿主声明的档位 ∩ off..max 词表；声明了 reasoning 但档位
//     无从得时给保守面 [off, high]（DSH agent 默认档 high 必须可被接受）；
//   · 分组视图：按 provider 成组、组内按显示名排序，缺 provider/id 的条目与重复 id 不进列表。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_EFFORT_IDS, groupHostCatalog, supportedEfforts } from "../../src/lib/model-catalog-view.ts";

test("supportedEfforts: 按声明取与词表的交集（升序，不按声明顺序）", () => {
  const item = { reasoning: true, thinkingLevels: ["high", "off", "max"], defaultThinkingLevel: "high" };
  assert.deepEqual(supportedEfforts(item), ["off", "high", "max"]);
  assert.deepEqual(CANONICAL_EFFORT_IDS.slice(0, 3), ["off", "minimal", "low"]);
});

test("supportedEfforts: 只声明 defaultThinkingLevel / xhigh 也认", () => {
  assert.deepEqual(supportedEfforts({ reasoning: true, defaultThinkingLevel: "medium" }), ["medium"]);
  assert.deepEqual(supportedEfforts({ reasoning: true, xhigh: true }), ["xhigh"]);
});

test("supportedEfforts: thinkingLevels 是对象形状（值为 true）也算声明", () => {
  assert.deepEqual(supportedEfforts({ reasoning: true, thinkingLevels: { low: true, high: true } }), ["low", "high"]);
});

test("supportedEfforts: 声明了 reasoning 但档位一个都认不出 → 保守面 [off, high]", () => {
  assert.deepEqual(supportedEfforts({ reasoning: true }), ["off", "high"]);
  assert.deepEqual(supportedEfforts({ reasoning: true, thinkingLevels: ["turbo"] }), ["off", "high"]);
});

test("supportedEfforts: 非 reasoning 模型没有显式档", () => {
  assert.deepEqual(supportedEfforts({ reasoning: false, thinkingLevels: ["high"] }), []);
  assert.deepEqual(supportedEfforts({}), []);
  assert.deepEqual(supportedEfforts(null), []);
});

test("groupHostCatalog: 按 provider 成组、组内按显示名排序、带默认档", () => {
  const groups = groupHostCatalog([
    { provider: "deepseek", id: "deepseek-pro", name: "zeta", reasoning: true, thinkingLevels: ["low", "high"] },
    { provider: "agnes", id: "agnes-3.0-flash", name: "Agnes 3.0 Flash" },
    { provider: "deepseek", id: "deepseek-flash", name: "Alpha", reasoning: true, thinkingLevels: ["off", "high"] },
  ]);
  assert.deepEqual(groups.map((g) => g.id), ["agnes", "deepseek"]);
  assert.deepEqual(groups.map((g) => g.name), ["agnes", "deepseek"]);
  assert.deepEqual(groups[1].models.map((m) => m.id), ["deepseek-flash", "deepseek-pro"]);
  assert.deepEqual(groups[1].models[0].efforts, [{ id: "off", name: "Off" }, { id: "high", name: "High" }]);
  assert.equal(groups[1].models[0].defaultEffort, "high");
  assert.equal(groups[0].models[0].efforts, undefined, "非 reasoning 模型不画档位行");
});

test("groupHostCatalog: 缺 provider/id 的条目与同一 provider 里的重复 id 都不进列表", () => {
  const groups = groupHostCatalog([
    { provider: "deepseek", id: "deepseek-flash", name: "第一次" },
    { provider: "deepseek", id: "deepseek-flash", name: "第二次" },
    { provider: "deepseek", id: "" },
    { provider: "", id: "orphan" },
    null,
    "nope",
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].models.length, 1);
  assert.equal(groups[0].models[0].name, "第一次");
});

test("groupHostCatalog: 目录形状不符 → 空数组（页面画成没有可选模型）", () => {
  assert.deepEqual(groupHostCatalog(null), []);
  assert.deepEqual(groupHostCatalog({ models: [] }), []);
  assert.deepEqual(groupHostCatalog([]), []);
});

test("groupHostCatalog: 模型没给显示名时用 id 顶上", () => {
  const groups = groupHostCatalog([{ provider: "deepseek", id: "deepseek-flash" }]);
  assert.equal(groups[0].models[0].name, "deepseek-flash");
});
