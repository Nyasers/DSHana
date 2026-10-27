// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/activity-feed.test.mjs — 会话活动事件源与快照收包
// （packages/host/src/activity-feed.ts、packages/runtime/src/activity-stream.ts 的可测面）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivityFeed } from "@dshana/host/activity-feed.ts";
import { normalizeSnapshot } from "@dshana/runtime/activity-stream.ts";

/** 假 DSH 上下文：只提供 ctx.on，把 emit 暴露给测试。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    ctx: {
      on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
    emit(event, ...args) {
      const handler = handlers.get(event);
      if (handler) handler(...args);
    },
    count: () => handlers.size,
  };
}

test("activity-feed：订阅即刻拿到当前快照", () => {
  const feed = createActivityFeed();
  const seen = [];
  const off = feed.subscribe((snap) => seen.push(snap.running));
  assert.deepEqual(seen, [[]]);
  off();
});

test("activity-feed：未经 attach 时恒为空（还没接上 DSH）", () => {
  const feed = createActivityFeed();
  assert.deepEqual(feed.snapshot().running, []);
});

test("activity-feed：status true/false 翻转进出集合，只推变化", () => {
  const bench = fakeCtx();
  const feed = createActivityFeed();
  const seen = [];
  feed.subscribe((snap) => seen.push([...snap.running]));
  const detach = feed.attach(bench.ctx);

  bench.emit("api-session/status", "session-a", true);
  assert.deepEqual(feed.snapshot().running, ["session-a"]);
  // 重复 true 不再推一次
  bench.emit("api-session/status", "session-a", true);
  assert.deepEqual(feed.snapshot().running, ["session-a"]);
  bench.emit("api-session/status", "session-b", true);
  assert.deepEqual(feed.snapshot().running.sort(), ["session-a", "session-b"]);
  bench.emit("api-session/status", "session-a", false);
  assert.deepEqual(feed.snapshot().running, ["session-b"]);

  assert.deepEqual(seen.map((r) => r.length), [0, 1, 2, 1]);
  detach();
  assert.equal(bench.count(), 0);
});

test("activity-feed：每次变化版本号 +1（长轮询靠它判断有没有新东西）", () => {
  const bench = fakeCtx();
  const feed = createActivityFeed();
  feed.attach(bench.ctx);
  const v0 = feed.snapshot().version;
  bench.emit("api-session/status", "session-a", true);
  const v1 = feed.snapshot().version;
  assert.equal(v1, v0 + 1);
  // 重复事件不推进版本
  bench.emit("api-session/status", "session-a", true);
  assert.equal(feed.snapshot().version, v1);
});

test("activity-feed：wait 在版本已推进时立刻返回", async () => {
  const bench = fakeCtx();
  const feed = createActivityFeed();
  feed.attach(bench.ctx);
  bench.emit("api-session/status", "session-a", true);
  const snap = await feed.wait(0, 5000);
  assert.deepEqual(snap.running, ["session-a"]);
});

test("activity-feed：wait 被变化唤醒", async () => {
  const feed = createActivityFeed();
  const pending = feed.wait(feed.snapshot().version, 5000);
  const bench = fakeCtx();
  feed.attach(bench.ctx);
  bench.emit("api-session/status", "session-b", true);
  const snap = await pending;
  assert.deepEqual(snap.running, ["session-b"]);
});

test("activity-feed：wait 超时返回当前快照（没有变化时也不 hang）", async () => {
  const feed = createActivityFeed();
  const started = Date.now();
  const snap = await feed.wait(999, 30);
  assert.deepEqual(snap.running, []);
  assert.ok(Date.now() - started >= 20, "应当等到达超时才回");
});

test("activity-feed：畸形事件不炸、不污染集合", () => {
  const bench = fakeCtx();
  const feed = createActivityFeed();
  feed.attach(bench.ctx);
  bench.emit("api-session/status", undefined, true);
  bench.emit("api-session/status", "", true);
  bench.emit("api-session/status", "session-a", "true");
  bench.emit("api-session/status", "session-a", false);
  assert.deepEqual(feed.snapshot().running, []);
});

test("activity-feed：单个订阅方抛错不影响其它订阅方", () => {
  const bench = fakeCtx();
  const feed = createActivityFeed();
  const seen = [];
  feed.subscribe(() => { throw new Error("boom"); });
  feed.subscribe((snap) => seen.push([...snap.running]));
  feed.attach(bench.ctx);
  bench.emit("api-session/status", "session-a", true);
  assert.deepEqual(seen.at(-1), ["session-a"]);
});

test("normalizeSnapshot：只留形状对的字段，脏数据退化成空表", () => {
  assert.deepEqual(normalizeSnapshot({ running: ["a"], at: 1, version: 2 }), { running: ["a"], at: 1, version: 2 });
  assert.deepEqual(normalizeSnapshot({ running: ["a"] }), { running: ["a"] });
  assert.deepEqual(normalizeSnapshot(null), { running: [] });
  assert.deepEqual(normalizeSnapshot({}), { running: [] });
  assert.deepEqual(normalizeSnapshot({ running: "a" }), { running: [] });
  assert.deepEqual(normalizeSnapshot({ running: ["a", 1, null, ""] }), { running: ["a"] });
  assert.deepEqual(normalizeSnapshot({ running: [], at: "x", version: "y" }), { running: [] });
});
