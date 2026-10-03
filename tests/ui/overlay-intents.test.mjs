// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/overlay-intents.test.mjs — 跨面意图在**无凭据页面**的退化路（packages/ui/src/surface-bridge.ts）
//
// 主路（七个 kind 的指名投递）由 tests/ui/face-channel.test.mjs、tests/routes/faces-hub.test.mjs
// 与 tests/lib/faces-channel.test.mjs 覆盖。这里只钉无凭据页面（本 Node 环境就是：没有 location、
// 没有 surface 票据）的退化行为：读写落到共享空间那张权威记录上，词表外的值当场拒。
import test from "node:test";
import assert from "node:assert/strict";
import { hana } from "@hana/plugin-sdk";

// 应用态存储的打桩：一张键 → 值表 + 变更订阅表（形状照 hana.storage.global）。
// 注意：必须改**import 进来的那个 hana**，不是 globalThis.hana——桥读的就是 SDK 这一份。
const entries = new Map();
const listeners = new Set();
hana.storage = {
  global: {
    get: async (key) => (entries.has(key) ? { value: entries.get(key) } : undefined),
    set: async (key, value) => {
      entries.set(key, value);
      for (const listener of [...listeners]) listener([key]);
    },
    delete: async (key) => { entries.delete(key) },
    onChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  },
};

const { readIntentState, publishIntent, readSelection, writeSelection } = await import("../../packages/ui/src/surface-bridge.ts");

test("退化路：state 类写出去读得回来（共享空间那张记录）", async () => {
  await publishIntent("settings-view", { open: true, section: "models" });
  assert.deepEqual((await readIntentState("settings-view"))?.value, { open: true, section: "models" });
  await publishIntent("settings-view", { open: false, section: null });
  assert.deepEqual((await readIntentState("settings-view"))?.value, { open: false, section: null });
});

test("空槽：没写过就没有当前值（不假装有一个）", async () => {
  const untouched = await readIntentState("panel-view");
  assert.equal(untouched, null);
});

test("会话选中在退化路上照样读得回（ui-session 的启动握手不因通道缺席而失）", async () => {
  await writeSelection("s3");
  const selection = await readSelection();
  assert.equal(selection.sessionId, "s3");
  assert.ok(selection.at > 0);
});

test("词表外的 kind：读与写都当场拒（不退化成随便塞）", async () => {
  await assert.rejects(() => publishIntent("overlay", {}), /未知跨面意图/);
  await assert.rejects(() => readIntentState("overlay"), /未知跨面意图/);
});
