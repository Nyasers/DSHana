// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/agent-models.test.mjs — 读宿主角色卡配的模型（src/lib/agent-models.ts）
//
// 两张卡配的是同一套事实：agents/<id>/config.yaml 的 models.chat。读的形状要与宿主那份一致
// （{ provider, id }），挑卡的优先序要能按调用方（current）与主角色（primary）两个方向走。
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatModelOf, pickRoleCardAgent } from "../../src/lib/agent-models.ts";

test("chatModelOf: 认 models.chat 的 provider+id（也认 model 拼法），别的形状给 null", () => {
  assert.deepEqual(chatModelOf({ models: { chat: { provider: "deepseek", id: "deepseek-flash" } } }), {
    provider: "deepseek",
    model: "deepseek-flash",
  });
  assert.deepEqual(chatModelOf({ models: { chat: { provider: "agnes", model: "agnes-3.0-flash" } } }), {
    provider: "agnes",
    model: "agnes-3.0-flash",
  });
  assert.deepEqual(chatModelOf({ models: { chat: { provider: " deepseek ", id: " deepseek-flash " } } }), {
    provider: "deepseek",
    model: "deepseek-flash",
  });
  for (const bad of [
    null,
    {},
    { models: {} },
    { models: { chat: "" } },
    { models: { chat: { provider: "deepseek" } } },
    { models: { chat: { id: "deepseek-flash" } } },
  ]) {
    assert.equal(chatModelOf(bad), null, JSON.stringify(bad));
  }
});

test("pickRoleCardAgent: 缺省主角色优先，prefer=current 时调用方优先", () => {
  const agents = [
    { id: "agnes", state: "active" },
    { id: "sensenova", state: "active", isCurrent: true },
    { id: "hanako", state: "active", isPrimary: true },
    { id: "retired-one", state: "retired", isPrimary: true },
  ];
  assert.equal(pickRoleCardAgent(agents), "hanako");
  assert.equal(pickRoleCardAgent(agents, "current"), "sensenova");
  // 一侧标记缺席时退到另一侧，再退到第一张在场的
  assert.equal(pickRoleCardAgent([{ id: "a", state: "active" }, { id: "b", state: "active", isCurrent: true }]), "b");
  assert.equal(pickRoleCardAgent([{ id: "a", state: "active", isPrimary: true }, { id: "b", state: "active" }], "current"), "a");
  assert.equal(pickRoleCardAgent([{ id: "a", state: "active", isPrimary: true }, { id: "b", state: "active", isCurrent: true }], "current"), "b");
  assert.equal(pickRoleCardAgent([{ id: "a" }, { id: "b" }]), "a");
  // 退场的卡不当候选
  assert.equal(pickRoleCardAgent([{ id: "gone", state: "retired" }]), "");
  assert.equal(pickRoleCardAgent([{ state: "active" }]), "");
  assert.equal(pickRoleCardAgent(undefined), "");
});
