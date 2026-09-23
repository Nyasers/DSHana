// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/stream-freeze.test.mjs — 会话流卡冻结（createStreamMux.freeze）单测
//
// 背景：DSH 的 $events 是一条**长命订阅流**（断了会自己重连，见 dsh-client-connection），
// 所以「陈旧卡不再吃连接」不能只靠关 socket——必须连重开一起拒掉。本测钉住三条：
//   ① 冻结让在途流以终态收场，并关掉主载体；
//   ② 冻结后 openStream 直接拒绝（不新建载体）；
//   ③ 在途流收场时补发的 cancel 帧不会把载体再开回来。
// 用假 WebSocket 构造器注入（createStreamMux 的第二个参数），不起真连接。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamMux } from "../../src/ui/dsh-inject.ts";

/** 最小假载体：记录新建/发送/关闭，readyState 停在 CONNECTING（对端不会回执）。 */
class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closed = null;
    this.listeners = {};
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  removeEventListener(type) {
    delete this.listeners[type];
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const base = () => new URL("http://example.test/prefix/");

test("freeze: 在途流以终态收场、主载体关掉、之后拒绝重开", async () => {
  FakeWebSocket.instances.length = 0;
  const mux = createStreamMux(base(), FakeWebSocket);

  const pending = mux.openStream("$events", {}, undefined).next();
  assert.equal(FakeWebSocket.instances.length, 1, "开流即建载体");
  assert.equal(mux.hasActiveStreams(), true, "此时有一条在途流");

  mux.freeze();
  assert.equal(mux.hasActiveStreams(), false, "冻结让在途流收场");
  assert.deepEqual(FakeWebSocket.instances[0].closed, { code: 1000, reason: "frozen" }, "主载体被关");

  // 已挂起的读取以终态收场（页面主动收线，不是载体故障）
  await assert.rejects(async () => { await pending; }, /frozen/);
  assert.equal(FakeWebSocket.instances.length, 1, "收场补发 cancel 帧不该把载体开回来");

  // 冻结后拒绝重开：DSH 的事件订阅会自动重连，不拒就冻不住
  await assert.rejects(
    async () => { await mux.openStream("$events", {}, undefined).next(); },
    /frozen/,
  );
  assert.equal(FakeWebSocket.instances.length, 1, "拒绝重开即不新建载体");
  assert.equal(mux.hasActiveStreams(), false);
});

test("dispose 仍是整页收尾（不置冻结位，但同样断流）", async () => {
  FakeWebSocket.instances.length = 0;
  const mux = createStreamMux(base(), FakeWebSocket);
  const pending = mux.openStream("$events", {}, undefined).next();
  assert.equal(mux.hasActiveStreams(), true);
  mux.dispose();
  assert.equal(mux.hasActiveStreams(), false);
  assert.equal(FakeWebSocket.instances[0].readyState, FakeWebSocket.CLOSED);
  // 在途读取同样要以终态收场：不收就是一条永远挂着的 promise（Node 下会报 unhandledRejection）
  await assert.rejects(async () => { await pending; }, /disposed/);
});
