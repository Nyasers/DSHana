// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/model-default-guard.test.mjs — 对账「用户设的默认模型」的挑选逻辑
// （src/lib/model-default-guard.ts）
//
// 这一段只管一件事：用户层有值、且它不在宿主目录里时换一条。四条规矩：
//   · 现值在目录里 → 不改（不许动用户的选择）；
//   · provider 还在、只是模型不在 → 留在该 provider 里换（保住原方向）；
//   · provider 整个没了（例如官方路由 deepseek-official）→ 用宿主角色卡配的模型；
//   · 角色卡读不到或它自己也不在目录里 → 目录第一条；目录为空则谁也不猜。
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDefaultRepair } from "../src/lib/model-default-guard.ts";

const CATALOG = [
  { provider: "sensenova", id: "deepseek-flash" },
  { provider: "deepseek", id: "deepseek-flash" },
  { provider: "deepseek", id: "deepseek-v4-pro" },
];

/** 角色卡配的模型（宿主 agents/<id>/config.yaml 的 models.chat）。 */
const CARD = { provider: "deepseek", model: "deepseek-flash" };

test("现值在宿主目录里 → 不改（角色卡也不改这条结论）", () => {
  assert.equal(planDefaultRepair(CATALOG, { provider: "deepseek", model: "deepseek-flash" }, CARD), null);
  assert.equal(planDefaultRepair(CATALOG, { provider: "deepseek", model: "deepseek-v4-pro" }, CARD), null);
  assert.equal(planDefaultRepair(CATALOG, { provider: "sensenova", model: "deepseek-flash" }, CARD), null);
});

test("provider 还在、模型不在 → 留在该 provider 里换（角色卡不参与该档）", () => {
  assert.deepEqual(planDefaultRepair(CATALOG, { provider: "deepseek", model: "deepseek-v4-flash" }, CARD), {
    provider: "deepseek",
    model: "deepseek-flash",
    reason: "provider-kept",
  });
});

test("provider 整个没了（官方路由 deepseek-official）→ 用角色卡配的模型", () => {
  assert.deepEqual(planDefaultRepair(CATALOG, { provider: "deepseek-official", model: "deepseek-flash" }, CARD), {
    provider: "deepseek",
    model: "deepseek-flash",
    reason: "agent-model",
  });
});

test("角色卡读不到、或它自己不在目录里 → 目录第一条", () => {
  const current = { provider: "deepseek-official", model: "deepseek-flash" };
  for (const preferred of [null, undefined, { provider: "gemini", model: "gemini-3-pro-preview" }]) {
    assert.deepEqual(planDefaultRepair(CATALOG, current, preferred), {
      provider: "sensenova",
      model: "deepseek-flash",
      reason: "catalog-first",
    }, JSON.stringify(preferred));
  }
});

test("空值/缺字段的现值同样按目录修", () => {
  // 只剩 provider：留在该 provider 里换
  assert.deepEqual(planDefaultRepair(CATALOG, { provider: "deepseek" }, CARD), {
    provider: "deepseek",
    model: "deepseek-flash",
    reason: "provider-kept",
  });
  // 只剩 model / 什么都没有：角色卡在目录里就用角色卡
  for (const current of [null, undefined, {}, { provider: "" }, { model: "deepseek-flash" }]) {
    assert.deepEqual(planDefaultRepair(CATALOG, current, CARD), {
      provider: "deepseek",
      model: "deepseek-flash",
      reason: "agent-model",
    }, JSON.stringify(current));
  }
});

test("宿主目录为空 → 不猜（保持现值）", () => {
  assert.equal(planDefaultRepair([], { provider: "deepseek-official", model: "deepseek-flash" }, CARD), null);
  assert.equal(planDefaultRepair([], null, CARD), null);
  assert.equal(planDefaultRepair(undefined, { provider: "a", model: "b" }, CARD), null);
});
