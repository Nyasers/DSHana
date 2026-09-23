// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/host-models.test.mjs — 宿主目录的归一化与查询（src/lib/host-models.ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import { servedHas, servedModels } from "../../src/lib/host-models.ts";

test("servedModels: 只留 provider/id 都非空的条目，留白修掉", () => {
  assert.deepEqual(
    servedModels([
      { provider: "sensenova", id: "deepseek-flash" },
      { provider: "x" },
      { id: "y" },
      null,
      { provider: " ", id: "z" },
      { provider: "openrouter", id: " ~deepseek/deepseek-v4-flash-latest " },
    ]),
    [
      { provider: "sensenova", id: "deepseek-flash" },
      { provider: "openrouter", id: "~deepseek/deepseek-v4-flash-latest" },
    ],
  );
  assert.deepEqual(servedModels(undefined), []);
  assert.deepEqual(servedModels("nope"), []);
});

test("servedHas: provider 与 model 都要对上才算在目录里", () => {
  const served = servedModels([{ provider: "deepseek", id: "deepseek-flash" }]);
  assert.equal(servedHas(served, { provider: "deepseek", model: "deepseek-flash" }), true);
  assert.equal(servedHas(served, { provider: "deepseek", model: "deepseek-v4-pro" }), false);
  assert.equal(servedHas(served, { provider: "sensenova", model: "deepseek-flash" }), false);
  assert.equal(servedHas(served, { provider: " deepseek ", model: " deepseek-flash " }), true);
  assert.equal(servedHas(served, { provider: "deepseek" }), false);
  assert.equal(servedHas(served, null), false);
  assert.equal(servedHas([], { provider: "deepseek", model: "deepseek-flash" }), false);
});
