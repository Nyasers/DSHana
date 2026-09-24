// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/stream-mux-dispose.test.mjs — 流载体的整页收尾（createStreamMux.dispose）。
//
// 页面卸载（pagehide）时收线：关掉主载体、让在途流以终态收场（页面主动收线，不是载体故障），
// 否则会留下一条永远挂着的 promise（Node 下报 unhandledRejection）。
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

test("dispose: 整页收尾——关载体、在途流以终态收场", async () => {
  FakeWebSocket.instances.length = 0;
  const mux = createStreamMux(base(), FakeWebSocket);

  const pending = mux.openStream("$events", {}, undefined).next();
  assert.equal(FakeWebSocket.instances.length, 1, "开流即建载体");

  mux.dispose();
  assert.equal(FakeWebSocket.instances[0].readyState, FakeWebSocket.CLOSED, "主载体被关");
  await assert.rejects(async () => { await pending; }, /disposed/);
});
