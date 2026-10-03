// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/intent-landing.test.mjs — 跨面意图的落地面（packages/ui/src/intent-landing.ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIntentLandings } from "@dshana/ui/intent-landing.ts";

/** 只让 selection 通过（模拟“描述符表 + 本页角色”给的判据）。 */
const onlySelection = () => createIntentLandings({ takes: (kind) => kind === "selection" });
const meta = (at = 1) => ({ kind: "selection", at, from: null });

test("登记与退订：派发只给仍登记着的回调", () => {
  const landings = onlySelection();
  const seen = [];
  const off = landings.register("selection", (payload, m) => seen.push([payload, m.at]));
  assert.equal(landings.dispatch("selection", { sessionId: "s1" }, meta(7)), true);
  assert.deepEqual(seen, [[{ sessionId: "s1" }, 7]]);
  off();
  assert.equal(landings.dispatch("selection", { sessionId: "s2" }, meta(8)), false, "退订后不再派发");
  assert.equal(seen.length, 1);
});

test("本面不参与的 kind 一律不派（判据由调用方注入）", () => {
  const landings = onlySelection();
  const seen = [];
  landings.register("selection", () => seen.push("selection"));
  landings.register("panel-view", () => seen.push("panel-view"));
  assert.equal(landings.dispatch("panel-view", { panelId: "p1" }, { kind: "panel-view", at: 1, from: null }), false);
  assert.deepEqual(seen, []);
});

test("没人登记就不算派发出去（给回溯留个可判的信号）", () => {
  const landings = onlySelection();
  assert.equal(landings.dispatch("selection", { sessionId: "s1" }, meta()), false);
});

test("多个回调都收到；单个抛错不拖累别的回调，且有留痕", () => {
  const errors = [];
  const landings = createIntentLandings({
    takes: () => true,
    onError: (message, error) => errors.push([message, String(error && error.message)]),
  });
  const seen = [];
  landings.register("selection", () => { throw new Error("落地端炸了"); });
  landings.register("selection", () => seen.push("ok"));
  assert.equal(landings.dispatch("selection", { sessionId: "s1" }, meta()), true);
  assert.deepEqual(seen, ["ok"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /落地回调抛错/);
  assert.equal(errors[0][1], "落地端炸了");
});

test("kind 清单与 has() 随登记/退订变化（诊断面）", () => {
  const landings = onlySelection();
  assert.equal(landings.has("selection"), false);
  const offA = landings.register("selection", () => {});
  const offB = landings.register("selection", () => {});
  assert.equal(landings.has("selection"), true);
  assert.deepEqual(landings.kinds(), ["selection"]);
  offA();
  assert.equal(landings.has("selection"), true, "还有一个登记着");
  offB();
  assert.equal(landings.has("selection"), false);
  assert.deepEqual(landings.kinds(), []);
});
