// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/overlay-intents.test.mjs — 跨面转发通道的落地协议（packages/ui/src/surface-bridge.ts）
//
// 重点守两件真出过事的事：
//   ① 清空必须带回刚消费的 at：盖新时间戳的话，落地端会被自己的清空再唤醒（读到的 at 更新 →
//      再应用 → 再清空），真机上表现为「主卡一直在弹同一条面、关不掉还抢焦点」。
//   ② 被消费过的意图（值已被写成 null）在面重开时不能再应用一次——载荷本身为空的 kind
//      （快捷键参考框）光看载荷分不出来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { hana } from "@hana/plugin-sdk";

// 应用态存储的打桩：一张键 → 值表 + 变更订阅表（形状照 hana.storage.global）。
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

const {
  readIntent, writeIntent, clearIntent, onIntentChanged,
  publishIntent, readIntentState, readSelection, writeSelection,
} = await import("../../packages/ui/src/surface-bridge.ts");

test("command：写下去是待落地，清空带回同一个 at 且不再待落地", async () => {
  await writeIntent("shortcuts-panel", {});
  const written = await readIntent("shortcuts-panel");
  assert.equal(written.pending, true);
  assert.deepEqual(written.value, {});
  assert.ok(written.at > 0, "at 由通道盖章");

  await clearIntent("shortcuts-panel", written.at);
  const cleared = await readIntent("shortcuts-panel");
  assert.equal(cleared.pending, false, "清空后读取方必须看出这条已经落地过了");
  assert.equal(cleared.at, written.at, "清空不得盖新时间戳——否则落地端会被自己的清空再唤醒");
});

test("空槽：从没写过的 kind 不待落地（面一挂载不得把空槽当成指令）", async () => {
  const untouched = await readIntent("session-archive");
  assert.equal(untouched.pending, false);
  assert.equal(untouched.at, 0);
  assert.deepEqual(untouched.value, { sessionId: null, displayTitle: "", activity: [] });
});

test("command：写与清空各一次通知，回声的 at 不比已消费的那条更新", async () => {
  const seen = [];
  const off = onIntentChanged("session-rename", () => { seen.push(1) });
  await writeIntent("session-rename", { sessionId: "s1", title: "甲" });
  const first = await readIntent("session-rename");
  await clearIntent("session-rename", first.at);
  const echo = await readIntent("session-rename");
  assert.equal(echo.pending, false);
  assert.ok(echo.at <= first.at, "回声的 at 不得比已消费的那条更新");
  assert.equal(seen.length, 2, "写一次、清一次（清空本身就是那一次事实）");
  off();
});

test("下一条命令仍然能盖过上次的消费标记（at 更新即视为新指令）", async () => {
  const before = await readIntent("session-rename");
  await writeIntent("session-rename", { sessionId: "s2", title: "乙" });
  const next = await readIntent("session-rename");
  assert.equal(next.pending, true);
  assert.deepEqual(next.value, { sessionId: "s2", title: "乙" });
  assert.ok(next.at >= before.at);
});

test("state 类 kind 不吃清空（镜像一定要读得回来）", async () => {
  await publishIntent("settings-view", { open: true, section: "models" });
  assert.deepEqual((await readIntentState("settings-view"))?.value, { open: true, section: "models" });
  await publishIntent("settings-view", { open: false, section: null });
  assert.deepEqual((await readIntentState("settings-view"))?.value, { open: false, section: null });
  await writeSelection("s3");
  const selection = await readSelection();
  assert.equal(selection.sessionId, "s3");
  assert.ok(selection.at > 0);
});

test("词表外的 kind：读、写、清都当场拒", async () => {
  await assert.rejects(() => readIntent("overlay"), /未知跨面意图/);
  await assert.rejects(() => writeIntent("overlay", {}), /未知跨面意图/);
  await assert.rejects(() => clearIntent("overlay", 1), /未知跨面意图/);
});
