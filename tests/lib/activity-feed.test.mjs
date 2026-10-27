// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/activity-feed.test.mjs — 会话活动事件源与 SSE 解析
// （packages/host/src/activity-feed.ts、packages/runtime/src/activity-stream.ts 的纯函数面）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivityFeed } from "@dshana/host/activity-feed.ts";
import { parseSseData } from "@dshana/runtime/activity-stream.ts";

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
  const gate = feed.snapshot;
  const seen = [];
  feed.subscribe((snap) => seen.push([...snap.running]));
  const detach = feed.attach(bench.ctx);

  bench.emit("api-session/status", "session-a", true);
  assert.deepEqual(gate().running, ["session-a"]);
  // 重复 true 不再推一次
  bench.emit("api-session/status", "session-a", true);
  assert.deepEqual(gate().running, ["session-a"]);
  // 第二个会话
  bench.emit("api-session/status", "session-b", true);
  assert.deepEqual(gate().running.sort(), ["session-a", "session-b"]);
  bench.emit("api-session/status", "session-a", false);
  assert.deepEqual(gate().running, ["session-b"]);

  const opens = seen.map((r) => r.length);
  assert.deepEqual(opens, [0, 1, 2, 1]);
  detach();
  assert.equal(bench.count(), 0);
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

test("parseSseData：数据行解析，注释/空行/坏 JSON 一律 null", () => {
  assert.deepEqual(parseSseData('data: {"running":["session-a"]}'), { running: ["session-a"] });
  assert.deepEqual(parseSseData('data:{"running":[]}'), { running: [] });
  assert.equal(parseSseData(": keep-alive"), null);
  assert.equal(parseSseData(""), null);
  assert.equal(parseSseData("data: not-json"), null);
  assert.equal(parseSseData("data:"), null);
});

test("parseSseData：非字符串的 id 被过滤掉，形状保持稳定", () => {
  assert.deepEqual(parseSseData('data: {"running":["session-a",1,null,""]}'), { running: ["session-a"] });
  assert.deepEqual(parseSseData('data: {"running":"session-a"}'), { running: [] });
  assert.deepEqual(parseSseData("data: {}"), { running: [] });
});
