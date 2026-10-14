// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/model-selection.test.mjs — 会话模型选择的元组语义（packages/session/src/session-run.ts）
//
// 守三件事，都是真机上踩出来的：
//   ① provider 与 model 是**一条路由的两半**，只给一半必须拒，不得去别处补另一半。
//      旧实现遇到半个路由会读 DSH_HOME/settings.yaml 的 agent-default-model 补全；那份文件在
//      DSH 现版里已被 settings 服务整份迁进 profile 并改名（settings.yaml.imported），于是
//      「补不出来」在真机上表现为一条与真实原因无关的硬失败。真机现场：open 只传
//      reasoningEffort 即被拒 provider/model required（会话记录里 arguments 无 provider/model）。
//   ② 只给 reasoningEffort 不等于「要选模型」。它是强度，不是路由；判「要不要选模型」只看
//      provider/model，不看 effort。旧实现把 effort 也算进去，于是单独传 effort 会去补路由。
//   ③ 合并按元组语义：**请求给的那部分覆盖，没给的那部分沿用会话当前值**。
//      · 路由：请求给了就用请求的；没给时 create 由 caller-plan 算、reply 沿用会话当前那条；
//      · 强度：请求给了就用请求的，没给就沿用会话当前的。
//      换路由本身允许（DSH 侧就地装上会话选择），代价是丢上下文缓存，所以一般不推荐；
//      单独改强度不换路由，没有这个代价。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  halfModelSelectionError,
  mergeModelSelection,
  requestedEffort,
  requestedRoute,
} from "@dshana/session/session-run.ts";

// ---- ① 路由成对才成立 ----

test("成对给：provider+model 都非空才产出一条路由", () => {
  assert.deepEqual(requestedRoute({ provider: "magpie", model: "group/auto-v4" }), {
    provider: "magpie",
    model: "group/auto-v4",
  });
});

test("空白串当没给：任一为空即不成路由", () => {
  assert.equal(requestedRoute({ provider: "", model: "m" }), null);
  assert.equal(requestedRoute({ provider: "p", model: "" }), null);
  assert.equal(requestedRoute({ provider: "   ", model: "m" }), null);
  assert.equal(requestedRoute({ provider: "p", model: "  " }), null);
  assert.equal(requestedRoute({}), null);
  assert.equal(requestedRoute(undefined), null);
});

test("trim 后才判：带空白的成对给照旧成立", () => {
  assert.deepEqual(requestedRoute({ provider: "  magpie ", model: " m " }), { provider: "magpie", model: "m" });
});

test("effort 不是路由的一部分：只给 effort 不产出路由", () => {
  assert.equal(requestedRoute({ reasoningEffort: "high" }), null);
  assert.equal(requestedEffort({ reasoningEffort: "high" }), "high");
  assert.equal(requestedEffort({ reasoningEffort: "  " }), "");
  assert.equal(requestedEffort({}), "");
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

test("成对给 / 都不给：不拒", () => {
  assert.equal(halfModelSelectionError({ provider: "p", model: "m" }), null);
  assert.equal(halfModelSelectionError({}), null);
  assert.equal(halfModelSelectionError({ reasoningEffort: "high" }), null, "effort 不是路由的一半");
});

test("effort 与半路由并存：仍按半路由拒（effort 不掩盖缺的那一半）", () => {
  const e = halfModelSelectionError({ provider: "magpie", reasoningEffort: "high" });
  assert.ok(e, "缺 model 时给了 effort 也要拒");
  assert.match(e.message, /provider only/);
});

// ---- ③ 合并按元组语义：缺省的那部分不改 ----

const current = { provider: "magpie", model: "group/auto-v4", reasoningEffort: "high" };

test("都给了：请求的覆盖当前值", () => {
  assert.deepEqual(
    mergeModelSelection({ route: { provider: "p2", model: "m2" }, effort: "low", current }),
    { provider: "p2", model: "m2", reasoningEffort: "low" },
  );
});

test("只给路由：强度沿用会话当前值（不静默清掉）", () => {
  assert.deepEqual(mergeModelSelection({ route: { provider: "p2", model: "m2" }, current }), {
    provider: "p2",
    model: "m2",
    reasoningEffort: "high",
  });
});

test("只给强度：路由沿用会话当前值（这就是「单独改 effort」）", () => {
  assert.deepEqual(mergeModelSelection({ effort: "low", current }), {
    provider: "magpie",
    model: "group/auto-v4",
    reasoningEffort: "low",
  });
});

test("都不给：完整沿用会话当前值", () => {
  assert.deepEqual(mergeModelSelection({ current }), {
    provider: "magpie",
    model: "group/auto-v4",
    reasoningEffort: "high",
  });
});

test("当前值没有 effort：给了路由就不带这一格", () => {
  const bare = { provider: "magpie", model: "group/auto-v4" };
  assert.deepEqual(mergeModelSelection({ route: { provider: "p2", model: "m2" }, current: bare }), {
    provider: "p2",
    model: "m2",
  });
});

test("当前值读不到：只给强度时返回 null（由调用方决定退路，不编路由）", () => {
  assert.equal(mergeModelSelection({ effort: "low", current: null }), null);
  assert.equal(mergeModelSelection({ current: null }), null);
});

test("当前值读不到：给了路由照常产出", () => {
  assert.deepEqual(mergeModelSelection({ route: { provider: "p", model: "m" }, current: null }), {
    provider: "p",
    model: "m",
  });
});

test("当前值形状不全（缺 model）：当读不到", () => {
  assert.equal(mergeModelSelection({ effort: "low", current: { provider: "magpie" } }), null);
});
