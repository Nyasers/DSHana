// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/model-selection.test.mjs — 显式模型选择的成对契约（packages/session/src/session-run.ts）
//
// 守三件事，都是真机上踩出来的：
//   ① provider 与 model 是**一条路由的两半**，只给一半必须拒，不得去别处补另一半。
//      旧实现遇到半个路由会读 DSH_HOME/settings.yaml 的 agent-default-model 补全；那份文件在
//      DSH 现版里已被 settings 服务整份迁进 profile 并改名（settings.yaml.imported），于是
//      「补不出来」在真机上表现为一条与真实原因无关的硬失败。真机现场：open 只传
//      reasoningEffort 即被拒 provider/model required（会话记录里 arguments 无 provider/model）。
//   ② 只给 reasoningEffort 不等于「要选模型」。它是强度，不是路由；判「要不要选模型」只看
//      provider/model，不看 effort。旧实现把 effort 也算进去，于是单独传 effort 会去补路由。
//   ③ effort 单独给时的收场分两路：create 由 caller-plan 补出路由再带上（补不出就拒），
//      reply 直接拒（DSH 的模型选择是整体，没有「只改强度」的下传形状）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { explicitModelSelection, halfModelSelectionError } from "@dshana/session/session-run.ts";

// ---- ① 成对才成立 ----

test("成对给：provider+model 都非空才产出选择", () => {
  assert.deepEqual(explicitModelSelection({ provider: "magpie", model: "group/auto-v4" }), {
    provider: "magpie",
    model: "group/auto-v4",
  });
});

test("成对给：effort 一并带上；不给就不带这一格", () => {
  assert.deepEqual(explicitModelSelection({ provider: "p", model: "m", reasoningEffort: "high" }), {
    provider: "p",
    model: "m",
    reasoningEffort: "high",
  });
  assert.deepEqual(Object.hasOwn(explicitModelSelection({ provider: "p", model: "m" }), "reasoningEffort"), false);
});

test("空白串当没给：provider/model 任一为空即不成对", () => {
  assert.equal(explicitModelSelection({ provider: "", model: "m" }), null);
  assert.equal(explicitModelSelection({ provider: "p", model: "" }), null);
  assert.equal(explicitModelSelection({ provider: "   ", model: "m" }), null);
  assert.equal(explicitModelSelection({ provider: "p", model: "  " }), null);
});

test("都不给 → null（交给 caller-plan / 会话自己的选择），不是错误", () => {
  assert.equal(explicitModelSelection({}), null);
  assert.equal(explicitModelSelection({ provider: null, model: null, reasoningEffort: null }), null);
  assert.equal(explicitModelSelection(undefined), null);
  assert.equal(halfModelSelectionError({}), null);
  assert.equal(halfModelSelectionError({ provider: null, model: null, reasoningEffort: "high" }), null);
});

// ---- ② 只给一半必须拒，且不谎称是别的错 ----

test("只给 provider：拒，文案说清要成对给", () => {
  const e = halfModelSelectionError({ provider: "magpie" });
  assert.ok(e, "只给 provider 应被拒");
  assert.match(e.message, /together/);
  assert.match(e.message, /provider only/);
});

test("只给 model：拒，文案说清是少了 provider", () => {
  const e = halfModelSelectionError({ model: "group/auto-v4" });
  assert.ok(e, "只给 model 应被拒");
  assert.match(e.message, /together/);
  assert.match(e.message, /model only/);
});

test("成对给 / 都不给：不拒（成对的走显式，都不给的走 caller-plan）", () => {
  assert.equal(halfModelSelectionError({ provider: "p", model: "m" }), null);
  assert.equal(halfModelSelectionError({}), null);
});

// ---- ③ effort 不是「要选模型」的判据 ----

test("只给 effort：不是「显式模型选择」，也不因它被当成半个路由", () => {
  const parsed = { reasoningEffort: "high" };
  assert.equal(explicitModelSelection(parsed), null, "effort 不构成路由选择");
  assert.equal(halfModelSelectionError(parsed), null, "effort 不是路由的一半，不该按半路由拒");
});

test("effort 与半路由并存：仍按半路由拒（effort 不掩盖缺的那一半）", () => {
  const e = halfModelSelectionError({ provider: "magpie", reasoningEffort: "high" });
  assert.ok(e, "缺 model 时给了 effort 也要拒");
  assert.match(e.message, /provider only/);
});

test("trim 后才判：带空白的成对给照旧成立", () => {
  assert.deepEqual(explicitModelSelection({ provider: "  magpie ", model: " m " }), {
    provider: "magpie",
    model: "m",
  });
});
