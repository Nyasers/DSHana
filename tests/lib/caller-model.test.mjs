// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/caller-model.test.mjs — 工具建的会话跟着调用方（packages/models/src/caller-model.ts）
//
// 决策的优先序是这一段的全部内容：显式入参 > App 设置的自定义那条 > 调用方会话实际在用的
// （且它得在宿主目录里）。**DSH 自己的默认模型不参与**：那是另一面（DSH 侧全局选择），
// 本 App 不经手也不据它改主意。
// 会话读不到（或它用的那条不在目录里）就不补——不换别的来源充数：跟随调用方是这一模式的
// 实义，拿角色卡上的静态配置顶上就是答非所问。
// resolveCallerPlan 另外守一件事：任何一步取数失败都只记一行、按最保守的结果收场（不补），
// 不能因为读不到就阻断整个提交链。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickOf, planCallerSelection, resolveCallerPlan, sessionModelSettingOf } from "@dshana/models/caller-model.ts";

const SERVED = [
  { provider: "deepseek", id: "deepseek-flash" },
  { provider: "agnes", id: "agnes-3.0-flash" },
];
const SESSION = { provider: "agnes", model: "agnes-3.0-flash", reasoningEffort: "high" };
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
  assert.deepEqual(planCallerSelection({ explicit: { provider: "a", model: "b" }, session: SESSION, served: SERVED }), {
    kind: "skip",
    reason: "explicit",
  });
});

test("没有显式入参时 → 用调用方会话当前的选择（含推理强度）", () => {
  assert.deepEqual(planCallerSelection({ session: SESSION, served: SERVED }), {
    kind: "select",
    provider: "agnes",
    model: "agnes-3.0-flash",
    reasoningEffort: "high",
  });
  // 会话没带强度时：这一格不传（由 DSH 决定）
  assert.deepEqual(
    planCallerSelection({ session: { provider: "agnes", model: "agnes-3.0-flash" }, served: SERVED }),
    { kind: "select", provider: "agnes", model: "agnes-3.0-flash" },
  );
});

test("调用方会话读不到 → 不补（不换别的来源充数）", () => {
  assert.deepEqual(planCallerSelection({ session: null, served: SERVED }), { kind: "skip", reason: "no-session" });
  assert.deepEqual(planCallerSelection({ served: SERVED }), { kind: "skip", reason: "no-session" });
});

test("调用方会话用的模型不在目录里 → 不补（让报错点到那个名字）", () => {
  assert.deepEqual(
    planCallerSelection({ session: { provider: "gone", model: "gone" }, served: SERVED }),
    { kind: "skip", reason: "session-not-served" },
  );
  assert.deepEqual(planCallerSelection({ session: SESSION, served: [] }), {
    kind: "skip",
    reason: "session-not-served",
  });
});

test("sessionModelSettingOf: 模式只认 caller/custom，custom 填不全就当 caller", () => {
  assert.deepEqual(sessionModelSettingOf({ sessionModelMode: "caller" }), { mode: "caller", provider: "", model: "", reasoningEffort: "" });
  assert.deepEqual(sessionModelSettingOf(undefined), { mode: "caller", provider: "", model: "", reasoningEffort: "" });
  assert.deepEqual(
    sessionModelSettingOf({
      sessionModelMode: "custom",
      sessionModelProvider: " deepseek ",
      sessionModelModel: " deepseek-flash ",
      sessionModelReasoningEffort: " high ",
    }),
    { mode: "custom", provider: "deepseek", model: "deepseek-flash", reasoningEffort: "high" },
  );
  // 推理强度是可选一侧：不填不影响 custom 成立
  assert.equal(
    sessionModelSettingOf({ sessionModelMode: "custom", sessionModelProvider: "a", sessionModelModel: "b" }).reasoningEffort,
    "",
  );
  // 脏值（模式 custom 但缺一侧）不拓：当 caller，不给一个跑不动的选择
  assert.equal(sessionModelSettingOf({ sessionModelMode: "custom", sessionModelProvider: "deepseek" }).mode, "caller");
  assert.equal(sessionModelSettingOf({ sessionModelMode: "custom", sessionModelModel: "x" }).mode, "caller");
  assert.equal(sessionModelSettingOf({ sessionModelMode: "fixed", sessionModelProvider: "a", sessionModelModel: "b" }).mode, "caller");
});

test("App 设置选「自定义模型」时：它优先于调用方会话", () => {
  const appSetting = { mode: "custom", provider: "deepseek", model: "deepseek-flash" };
  assert.deepEqual(
    planCallerSelection({
      appSetting,
      session: SESSION,
      served: SERVED,
    }),
    { kind: "select", provider: "deepseek", model: "deepseek-flash" },
  );
  // 显式入参仍然最高
  assert.deepEqual(
    planCallerSelection({ explicit: { provider: "a", model: "b" }, appSetting, served: SERVED }),
    { kind: "skip", reason: "explicit" },
  );
  // 自定义那条不在目录里 → 不补（不静默滑到会话或角色卡，让报错点到设置里那条）
  assert.deepEqual(
    planCallerSelection({ appSetting: { mode: "custom", provider: "deepseek", model: "deepseek-v4-flash" }, session: SESSION, served: SERVED }),
    { kind: "skip", reason: "custom-not-served" },
  );
  // caller 模式跟着调用方会话走
  assert.deepEqual(
    planCallerSelection({ appSetting: { mode: "caller", provider: "deepseek", model: "deepseek-flash" }, session: SESSION, served: SERVED }),
    { kind: "select", provider: "agnes", model: "agnes-3.0-flash", reasoningEffort: "high" },
  );
});

test("自定义那条带推理强度时：随选择一起交出；不填就不带", () => {
  assert.deepEqual(
    planCallerSelection({
      appSetting: { mode: "custom", provider: "agnes", model: "agnes-3.0-flash", reasoningEffort: "high" },
      served: SERVED,
    }),
    { kind: "select", provider: "agnes", model: "agnes-3.0-flash", reasoningEffort: "high" },
  );
  assert.deepEqual(
    planCallerSelection({
      appSetting: { mode: "custom", provider: "agnes", model: "agnes-3.0-flash", reasoningEffort: "" },
      served: SERVED,
    }),
    { kind: "select", provider: "agnes", model: "agnes-3.0-flash" },
  );
});

test("resolveCallerPlan: 自定义模式不读会话", async () => {
  const { lines, note } = notes();
  let sessionReads = 0;
  const plan = await resolveCallerPlan(
    null,
    {
      setting: () => ({ mode: "custom", provider: "agnes", model: "agnes-3.0-flash" }),
      session: async () => {
        sessionReads += 1;
        return SESSION;
      },
      served: async () => SERVED,
    },
    note,
  );
  assert.deepEqual(plan, { kind: "select", provider: "agnes", model: "agnes-3.0-flash" });
  assert.equal(sessionReads, 0);
  assert.deepEqual(lines, []);
});

test("resolveCallerPlan: 取数面出问题只记一行，按不补收场", async () => {
  const { lines, note } = notes();
  const plan = await resolveCallerPlan(
    null,
    {
      session: () => {
        throw new Error("session:context 被拒");
      },
      served: async () => {
        throw new Error("models.list 失败");
      },
    },
    note,
  );
  assert.deepEqual(plan, { kind: "skip", reason: "no-session" });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /模型目录/);
  assert.match(lines[1], /调用方会话/);
});

test("resolveCallerPlan: 会话那条不可用时记一行", async () => {
  const { lines, note } = notes();
  const plan = await resolveCallerPlan(
    null,
    { session: async () => ({ provider: "gone", model: "gone" }), served: async () => SERVED },
    note,
  );
  assert.deepEqual(plan, { kind: "skip", reason: "session-not-served" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /会话用的模型不在宿主目录里/);
});

test("resolveCallerPlan: 取数齐全时给出补的选择", async () => {
  const a = notes();
  assert.deepEqual(
    await resolveCallerPlan(null, { session: async () => SESSION, served: async () => SERVED }, a.note),
    { kind: "select", provider: "agnes", model: "agnes-3.0-flash", reasoningEffort: "high" },
  );
  assert.deepEqual(a.lines, []);
});
