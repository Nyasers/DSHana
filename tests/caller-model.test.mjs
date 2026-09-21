// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/caller-model.test.mjs — 工具建的会话按调用方角色卡补模型（src/lib/caller-model.ts）
//
// 决策的优先序是这一段的全部内容：显式入参 > 用户设的默认 > 调用方角色卡（且它得在宿主目录里）。
// resolveCallerPlan 另外守一件事：任何一步取数失败都只记一行、按最保守的结果收场（不补），
// 不能因为读不到角色卡就让整个提交链失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickOf, planCallerSelection, resolveCallerPlan, sessionModelSettingOf } from "../src/lib/caller-model.ts";

const SERVED = [
  { provider: "deepseek", id: "deepseek-flash" },
  { provider: "agnes", id: "agnes-3.0-flash" },
];
const CARD = { provider: "deepseek", model: "deepseek-flash" };
const notes = () => {
  const lines = [];
  return { lines, note: (m) => lines.push(m) };
};

test("pickOf: provider/model 都非空才算数", () => {
  assert.deepEqual(pickOf({ provider: "a", model: "b" }), { provider: "a", model: "b" });
  assert.deepEqual(pickOf({ provider: " a ", model: " b " }), { provider: "a", model: "b" });
  assert.equal(pickOf({ provider: "a" }), null);
  assert.equal(pickOf({ model: "b" }), null);
  assert.equal(pickOf(null), null);
});

test("显式入参在就不补（显式照旧，它自己会成为 DSH 新默认）", () => {
  assert.deepEqual(planCallerSelection({ explicit: { provider: "a", model: "b" }, card: CARD, served: SERVED }), {
    kind: "skip",
    reason: "explicit",
  });
});

test("用户设了默认就不补（那是用户的话，对所有会话生效）", () => {
  assert.deepEqual(
    planCallerSelection({ stored: { provider: "gemini", model: "gemini-3-pro-preview" }, card: CARD, served: SERVED }),
    { kind: "skip", reason: "user-default" },
  );
  // 用户设的那条即使已经不可服务，也不该由这里改（对账是 model-default-guard 的事）
  assert.deepEqual(
    planCallerSelection({ stored: { provider: "gone", model: "gone" }, card: CARD, served: SERVED }),
    { kind: "skip", reason: "user-default" },
  );
});

test("没有用户默认 → 用调用方角色卡的模型", () => {
  assert.deepEqual(planCallerSelection({ card: CARD, served: SERVED }), {
    kind: "select",
    provider: "deepseek",
    model: "deepseek-flash",
  });
  assert.deepEqual(planCallerSelection({ card: { provider: "agnes", model: "agnes-3.0-flash" }, served: SERVED }), {
    kind: "select",
    provider: "agnes",
    model: "agnes-3.0-flash",
  });
});

test("角色卡读不到 / 它配的模型不在目录里 → 不补（让报错点到那个名字）", () => {
  assert.deepEqual(planCallerSelection({ card: null, served: SERVED }), { kind: "skip", reason: "no-card" });
  assert.deepEqual(planCallerSelection({ served: SERVED }), { kind: "skip", reason: "no-card" });
  assert.deepEqual(
    planCallerSelection({ card: { provider: "deepseek", model: "deepseek-v4-flash" }, served: SERVED }),
    { kind: "skip", reason: "card-not-served" },
  );
  assert.deepEqual(planCallerSelection({ card: CARD, served: [] }), { kind: "skip", reason: "card-not-served" });
});

test("sessionModelSettingOf: 模式只认 caller/custom，custom 填不全就当 caller", () => {
  assert.deepEqual(sessionModelSettingOf({ sessionModelMode: "caller" }), { mode: "caller", provider: "", model: "" });
  assert.deepEqual(sessionModelSettingOf(undefined), { mode: "caller", provider: "", model: "" });
  assert.deepEqual(
    sessionModelSettingOf({ sessionModelMode: "custom", sessionModelProvider: " deepseek ", sessionModelModel: " deepseek-flash " }),
    { mode: "custom", provider: "deepseek", model: "deepseek-flash" },
  );
  // 脏值（模式 custom 但缺一侧）不拓：当 caller，不给一个跑不动的选择
  assert.equal(sessionModelSettingOf({ sessionModelMode: "custom", sessionModelProvider: "deepseek" }).mode, "caller");
  assert.equal(sessionModelSettingOf({ sessionModelMode: "custom", sessionModelModel: "x" }).mode, "caller");
  assert.equal(sessionModelSettingOf({ sessionModelMode: "fixed", sessionModelProvider: "a", sessionModelModel: "b" }).mode, "caller");
});

test("App 设置选「自定义模型」时：它优先于角色卡与用户默认", () => {
  const appSetting = { mode: "custom", provider: "agnes", model: "agnes-3.0-flash" };
  assert.deepEqual(
    planCallerSelection({
      appSetting,
      stored: { provider: "gemini", model: "gemini-3-pro-preview" },
      card: CARD,
      served: SERVED,
    }),
    { kind: "select", provider: "agnes", model: "agnes-3.0-flash" },
  );
  // 显式入参仍然最高
  assert.deepEqual(
    planCallerSelection({ explicit: { provider: "a", model: "b" }, appSetting, served: SERVED }),
    { kind: "skip", reason: "explicit" },
  );
  // 自定义那条不在目录里 → 不补（不静默滑到角色卡，让报错点到设置里那条）
  assert.deepEqual(
    planCallerSelection({ appSetting: { mode: "custom", provider: "deepseek", model: "deepseek-v4-flash" }, card: CARD, served: SERVED }),
    { kind: "skip", reason: "custom-not-served" },
  );
  // caller 模式照旧走角色卡
  assert.deepEqual(
    planCallerSelection({ appSetting: { mode: "caller", provider: "agnes", model: "agnes-3.0-flash" }, card: CARD, served: SERVED }),
    { kind: "select", provider: "deepseek", model: "deepseek-flash" },
  );
});

test("resolveCallerPlan: 自定义模式不再去读角色卡与用户默认", async () => {
  const { lines, note } = notes();
  let cardReads = 0;
  let storedReads = 0;
  const plan = await resolveCallerPlan(
    null,
    {
      setting: () => ({ mode: "custom", provider: "agnes", model: "agnes-3.0-flash" }),
      card: async () => {
        cardReads += 1;
        return CARD;
      },
      stored: () => {
        storedReads += 1;
        return null;
      },
      served: async () => SERVED,
    },
    note,
  );
  assert.deepEqual(plan, { kind: "select", provider: "agnes", model: "agnes-3.0-flash" });
  assert.equal(cardReads, 0);
  assert.equal(storedReads, 0);
  assert.deepEqual(lines, []);
});

test("resolveCallerPlan: 取数面出问题只记一行，按不补收场", async () => {
  const { lines, note } = notes();
  const plan = await resolveCallerPlan(
    null,
    {
      stored: () => {
        throw new Error("settings.yaml 读不到");
      },
      card: () => {
        throw new Error("agent:config 被拒");
      },
      served: async () => {
        throw new Error("models.list 失败");
      },
    },
    note,
  );
  assert.deepEqual(plan, { kind: "skip", reason: "no-card" });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /默认模型/);
  assert.match(lines[1], /角色卡/);
  assert.match(lines[2], /模型目录/);
});

test("resolveCallerPlan: 取数齐全时给出补的选择，不补时也只报一行", async () => {
  const a = notes();
  assert.deepEqual(
    await resolveCallerPlan(null, { stored: () => null, card: async () => CARD, served: async () => SERVED }, a.note),
    { kind: "select", provider: "deepseek", model: "deepseek-flash" },
  );
  assert.deepEqual(a.lines, []);

  const b = notes();
  assert.deepEqual(
    await resolveCallerPlan(
      null,
      { stored: () => ({ provider: "gemini", model: "gemini-3-pro-preview" }), card: async () => CARD, served: async () => SERVED },
      b.note,
    ),
    { kind: "skip", reason: "user-default" },
  );
  assert.deepEqual(b.lines, []);

  const c = notes();
  assert.deepEqual(
    await resolveCallerPlan(
      null,
      { stored: () => null, card: async () => ({ provider: "deepseek", model: "deepseek-v4-flash" }), served: async () => SERVED },
      c.note,
    ),
    { kind: "skip", reason: "card-not-served" },
  );
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /deepseek\/deepseek-v4-flash/);
});
