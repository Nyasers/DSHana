// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/stream-carrier.test.mjs — api/remote.mux 载体（createStreamMux）的失败语义
//
// 为什么单锁这一层：载体抛出的错误不是内部细节，它是**跨 bundle 契约**。DSH 的
// normalizeConnectionStream 只看结构标记（页半与内核半的类身份跨不过去），据此决定
// 「可重试的载体丢失」还是「终态故障」：
//   · carrier 标记丢了 → 同一个断链被折成 gateway/internal 终态 → 会话历史流一次死透，
//     界面停在「历史加载失败」（重连也不恢复）；
//   · remote 标记缺码 → 宿主的业务码（如 session/not-found）被折成 gateway/internal。
// 所以这里三条各锁一件事：载体失败带 carrier 标、宿主失败带域码、旧载体不误杀新载体。

import test from "node:test";
import assert from "node:assert/strict";

import { createStreamMux } from "../../src/ui/dsh-inject.ts";
import {
  MUX_CHUNK_QUERY,
  MUX_CHUNK_QUERY_VALUE,
  decodeMuxControlFrame,
  encodeUtf8,
  splitTextMessage,
} from "../../src/lib/mux-chunks.ts";

const BASE = new URL("https://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/");
const MARK = "dshRemoteStreamFailure";
const signal = () => new AbortController().signal;

/** 最小 WebSocket 替身：记录发出的帧，测试驱动 open / 收帧 / 断链。 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeArgs = null;
    this.listeners = new Map();
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((fn) => fn !== listener));
  }
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("send on a non-open socket");
    this.sent.push(data);
  }
  close(code, reason) {
    this.closeArgs = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
  }

  // ---- 测试驱动 ----
  accept() {
    this.readyState = FakeWebSocket.OPEN;
    for (const fn of [...(this.listeners.get("open") || [])]) fn();
  }
  deliver(frame) { if (this.onmessage) this.onmessage({ data: typeof frame === "string" ? frame : JSON.stringify(frame) }); }
  /** 交付一帧二进制（分片信封）：binaryType=arraybuffer 时浏览器就是这个形态。 */
  deliverBinary(bytes) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    if (this.onmessage) this.onmessage({ data: copy.buffer });
  }
  /** 对端正常关闭（只有 close 事件，浏览器两端 TCP 断开就是这样）。 */
  drop() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({}); }
  /** 传输层失败：error 先到、close 随后（两条都要驱动，先到者定音）。 */
  lose() { this.onerror?.({}); this.drop(); }
}

function newMux() {
  FakeWebSocket.instances = [];
  return createStreamMux(BASE, FakeWebSocket);
}

/** 起一条流，返回 { iterator, next, open 帧里的 streamId }（此刻 socket 仍在握手）。 */
function startStream(mux, endpoint = "session/follow") {
  const iterator = mux.openStream(endpoint, { args: {} }, signal());
  const pending = iterator.next();
  const ws = FakeWebSocket.last();
  ws.accept();
  const opened = JSON.parse(ws.sent[0]);
  assert.equal(opened.type, "open");
  return { iterator, pending, ws, streamId: opened.streamId };
}

const rejection = (p) => p.then(() => undefined, (error) => error);

test("宿主 error 帧：域码与 details 原样带出（remote 标记，不折成 gateway/internal）", async () => {
  const mux = newMux();
  const { pending, ws, streamId } = startStream(mux);
  ws.deliver({
    type: "error",
    streamId,
    error: { code: "session/not-found", message: "会话不存在", details: { sessionId: "session-1" } },
  });
  const error = await rejection(pending);
  assert.equal(error.message, "会话不存在");
  assert.deepEqual(error[MARK], {
    kind: "remote",
    code: "session/not-found",
    details: { sessionId: "session-1" },
  });
});

test("socket 断链：在途流以 carrier 标记收场（DSH 侧才敢重连）", async () => {
  const mux = newMux();
  const { pending, iterator, ws, streamId } = startStream(mux);
  ws.deliver({ type: "item", streamId, value: { seq: 1 } });
  assert.deepEqual(await pending, { value: { seq: 1 }, done: false });

  const next = iterator.next();
  ws.drop();
  const error = await rejection(next);
  assert.equal(error.message, "DSH stream carrier closed");
  assert.deepEqual(error[MARK], { kind: "carrier" });
});

test("传输层失败（error 先到）：同样是 carrier 标记，消息取先到的那条", async () => {
  const mux = newMux();
  const { pending, ws } = startStream(mux);
  ws.lose();
  const error = await rejection(pending);
  assert.equal(error.message, "DSH stream carrier failed");
  assert.deepEqual(error[MARK], { kind: "carrier" });
});

test("旧 socket 迟到的 error/close 不误杀新载体上的流", async () => {
  const mux = newMux();
  const first = startStream(mux);
  first.ws.lose();
  assert.deepEqual((await rejection(first.pending))[MARK], { kind: "carrier" });

  // 新载体：另起一条 socket，旧 socket 上的流编号不再复用
  const second = startStream(mux);
  assert.notEqual(second.ws, first.ws);
  first.ws.lose(); // 旧 socket 的重复 close/error 事件（真实浏览器会补发）
  second.ws.deliver({ type: "item", streamId: second.streamId, value: { seq: 2 } });
  assert.deepEqual(await second.pending, { value: { seq: 2 }, done: false });
});

test("旧 socket 还在 CLOSING 就被换代：先按载体失败收场，不留悬挂的流", async () => {
  const mux = newMux();
  const first = startStream(mux);
  // 对端已开始关闭（close 事件还没到）：此刻新 open 会触发换代
  first.ws.readyState = FakeWebSocket.CLOSING;
  const second = startStream(mux);
  assert.notEqual(second.ws, first.ws);
  assert.deepEqual((await rejection(first.pending))[MARK], { kind: "carrier" });
  // 换代之后的帧照常送达新载体上的流
  second.ws.deliver({ type: "item", streamId: second.streamId, value: { seq: 2 } });
  assert.deepEqual(await second.pending, { value: { seq: 2 }, done: false });
});

test("畸形帧：机制整条载体（carrier 标记 + 4002 关闭），不是只废一条流", async () => {
  const mux = newMux();
  const { pending, ws } = startStream(mux);
  ws.deliver("{ not json");
  const error = await rejection(pending);
  assert.deepEqual(error[MARK], { kind: "carrier" });
  assert.equal(ws.closeArgs.code, 4002);
});

test("end 帧是正常收尾：done，不额外发 cancel", async () => {
  const mux = newMux();
  const { iterator, pending, ws, streamId } = startStream(mux);
  ws.deliver({ type: "item", streamId, value: { seq: 1 } });
  assert.deepEqual(await pending, { value: { seq: 1 }, done: false });
  const next = iterator.next();
  ws.deliver({ type: "end", streamId });
  assert.deepEqual(await next, { value: undefined, done: true });
  assert.equal(ws.sent.length, 1); // 只有 open：已收尾的流不该再收到 cancel
});

test("item 后紧跟 end 而消费端没在等：缓冲的 item 不丢，然后才是 done", async () => {
  const mux = newMux();
  const { iterator, pending, ws, streamId } = startStream(mux);
  ws.deliver({ type: "item", streamId, value: { seq: 1 } });
  await pending; // 这一刻消费端不挂在 next() 上（日志流在做异步处理）
  ws.deliver({ type: "item", streamId, value: { seq: 2 } });
  ws.deliver({ type: "end", streamId });
  assert.deepEqual(await iterator.next(), { value: { seq: 2 }, done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

test("open 帧永远带 payload 成键（缺键会被宿主当非法帧关掉整条载体）", async () => {
  const mux = newMux();
  const iterator = mux.openStream("session/control", undefined, signal());
  const pending = iterator.next();
  const ws = FakeWebSocket.last();
  ws.accept();
  const opened = JSON.parse(ws.sent[0]);
  assert.ok(Object.hasOwn(opened, "payload"));
  assert.equal(opened.payload, null);
  // 收尾，别留悬挂的迭代器
  ws.deliver({ type: "end", streamId: opened.streamId });
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("dispose 是页面收尾，不是载体丢失：终态错、无 carrier 标记", async () => {
  const mux = newMux();
  const { pending, ws } = startStream(mux);
  mux.dispose();
  const error = await rejection(pending);
  assert.equal(error.message, "DSH stream carrier disposed");
  assert.equal(error[MARK], undefined);
  assert.equal(ws.readyState, FakeWebSocket.CLOSED);
});

// ---- 承载面分片（见 src/lib/mux-chunks.ts）：宿主的 1 MiB 上游帧上限使长会话的首帧打不开，
// 中继把超限帧按尺寸切开、载体在页面侧重组成一条消息再交给 DSH；每片回执驱动中继的窗口。
test("分片信封：载体逐片重组后交给 DSH，并按片回执", async () => {
  const mux = newMux();
  const { pending, ws, streamId } = startStream(mux);
  const text = JSON.stringify({ type: "item", streamId, value: { seq: 7, note: "中文内容" } });
  const chunks = splitTextMessage(text, 8); // 切得碎，逼出逐片重组
  assert.ok(chunks.length > 3, "测试前提：消息应被切成多片");
  for (const chunk of chunks) ws.deliverBinary(chunk);

  const first = await pending;
  assert.deepEqual(first.value, { seq: 7, note: "中文内容" });

  const acks = ws.sent.slice(1).map((frame) => decodeMuxControlFrame(new Uint8Array(frame)));
  assert.equal(acks.length, chunks.length, "每收一片回一次执");
  assert.ok(acks.every((ack) => ack?.kind === "ack"), "回执帧应被识别为 ack");
  assert.equal(acks.reduce((sum, ack) => sum + ack.bytes, 0), encodeUtf8(text).length, "回执字节合计等于原文长度");
});

test("分片信封：切点落在多字节码点中间也还原（先拼字节再解码）", async () => {
  const mux = newMux();
  const { pending, ws, streamId } = startStream(mux);
  const text = JSON.stringify({ type: "item", streamId, value: { note: "中文字" } });
  for (const chunk of splitTextMessage(text, 1)) ws.deliverBinary(chunk);
  const first = await pending;
  assert.deepEqual(first.value, { note: "中文字" });
});

test("分片信封：非本模块的二进制帧不当作消息（不猜）", async () => {
  const mux = newMux();
  const { pending, ws, streamId } = startStream(mux);
  ws.deliverBinary(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
  ws.deliver({ type: "item", streamId, value: { seq: 1 } });
  const first = await pending;
  assert.deepEqual(first.value, { seq: 1 }, "陌生二进制帧应被忽略，随后的文本帧照常投递");
});

test("载体在 mux URL 上声明分片能力（中继据此启用）", () => {
  const mux = newMux();
  const iterator = mux.openStream("session/follow", { args: {} }, signal());
  void iterator.next().catch(() => {});
  const ws = FakeWebSocket.last();
  const url = new URL(ws.url);
  assert.equal(url.pathname, BASE.pathname + "api/remote.mux");
  assert.equal(url.searchParams.get(MUX_CHUNK_QUERY), MUX_CHUNK_QUERY_VALUE);
  void iterator.return?.();
});
