// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/model-sync.test.mjs — 宿主模型变更信号的识别契约
//
// 宿主把 app_event 打成 { type: "app_event", event: { type, payload, source } }（引擎侧 Ws()
// 发射点：设置写入、凭据/OAuth、模型信息目录刷新三条路都发 models-changed）。识别只看这一层
// 信封，别把别的 app_event（agent-updated / locale-changed / plugin_config_changed…）当变更。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isModelsChangedEvent, MODELS_CHANGED_EVENT, MODELS_REFRESH_ACTION } from "../../src/lib/model-sync.ts";

/** 宿主真实信封形状。 */
function appEvent(type, payload = { agentId: null }) {
  return { type: "app_event", event: { type, payload, source: "server" } };
}

test("isModelsChangedEvent: 认宿主 models-changed 信封", () => {
  assert.equal(isModelsChangedEvent(appEvent(MODELS_CHANGED_EVENT)), true);
  assert.equal(isModelsChangedEvent(appEvent("models-changed", { agentId: "hanako" })), true);
});

test("isModelsChangedEvent: 别的 app_event 不算", () => {
  for (const other of ["agent-updated", "locale-changed", "skills-changed", "plugin_config_changed"]) {
    assert.equal(isModelsChangedEvent(appEvent(other)), false, other);
  }
});

test("isModelsChangedEvent: 非 app_event 与其他形状一律不算", () => {
  for (const value of [
    null, undefined, 0, "models-changed", [],
    { type: "models-changed" },                       // 没包 app_event 信封
    { type: "app_event" },                            // 信封里没有 event
    { type: "app_event", event: null },
    { type: "app_event", event: {} },                 // event 没有 type
    { type: "app_event", event: "models-changed" },
    { type: "session_created", event: { type: "models-changed" } },
  ]) {
    assert.equal(isModelsChangedEvent(value), false, JSON.stringify(value));
  }
});

test("控制面动作名与订阅事件名是稳定的对外契约", () => {
  assert.equal(MODELS_CHANGED_EVENT, "models-changed");
  assert.equal(MODELS_REFRESH_ACTION, "models-refresh");
});
