// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/runtime/mux-relay.test.mjs — 中继分片模式的端到端契约（真起中继 + 真 socket）
// 覆盖：超限帧被切成多片且客户端重组逐字相同；回执驱动窗口（1 MiB 消息能全部走完）；
// 不回执时在窗口处停住且不断链；控制帧（ping/pong）不被大消息吞掉；
// 未声明分片时仍走原样透传（不切片、无回执）。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

import { startDshBridge } from "../../src/runtime/bridge.ts";
import { OPCODE, framePayload, readFrameHeader, serializeFrame } from "../../src/lib/ws-frames.ts";
import {
  ChunkAssembler,
  MUX_CHUNK_BYTES,
  MUX_CHUNK_QUERY,
  MUX_CHUNK_QUERY_VALUE,
  MUX_CHUNK_WINDOW,
  decodeMuxControlFrame,
  decodeUtf8,
  encodeAck,
  encodeUtf8,
} from "../../src/lib/mux-chunks.ts";

const KEY = "bridge-key-0123456789abcdef";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简上游：完成 WS 握手后把 socket 交给测试；记录它收到的帧（客户端帧带掩码，需解掩码）。 */
async function startUpstream() {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const sockets = new Set();
  const frames = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  let upgraded = null;
  let markReady = () => {};
  const ready = new Promise((resolve) => { markReady = resolve; });

  const pump = () => {
    for (;;) {
      const header = readFrameHeader(buffer);
      if (!header || buffer.length < header.totalLength) return;
      const raw = buffer.subarray(0, header.totalLength);
      buffer = buffer.subarray(header.totalLength);
      const frame = { opcode: header.opcode, payload: framePayload(header, raw) };
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].match(frame)) { waiters.splice(i, 1)[0].resolve(frame); break; }
      }
    }
  };

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`,
    );
    upgraded = socket;
    markReady();
    socket.on("error", () => {});
    socket.on("data", (data) => { buffer = Buffer.concat([buffer, data]); pump(); });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    ready,
    frames,
    send(opcode, payload) { upgraded.write(serializeFrame(opcode, payload)); },
    waitFrame(match, label, timeoutMs = 3000) {
      const hit = frames.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等不到 ${label}`)), timeoutMs);
        waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
      });
    },
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/** 载体替身：按 lib/mux-chunks.ts 的约定重组分片并回执（ack=false 时故意不回）。 */
function startCarrier(url, { ack = true } = {}) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const assembler = new ChunkAssembler();
  const state = { texts: [], chunkFrames: 0, bytes: 0, closed: null };
  const waiters = [];
  const settle = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(state)) { waiters.splice(i, 1)[0].resolve(state); }
    }
  };
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") { state.texts.push(event.data); settle(); return; }
    const view = new Uint8Array(event.data);
    const control = decodeMuxControlFrame(view);
    if (control?.kind !== "chunk") return;
    state.chunkFrames += 1;
    state.bytes += control.payload.length;
    if (ack) ws.send(encodeAck(control.payload.length));
    const done = assembler.push(control.payload, control.last);
    if (done !== null) state.texts.push(decodeUtf8(done));
    settle();
  });
  ws.addEventListener("close", (event) => { state.closed = event.code; settle(); });
  return {
    ws,
    state,
    waitFor(match, label, timeoutMs = 4000) {
      if (match(state)) return Promise.resolve(state);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等不到 ${label}`)), timeoutMs);
        waiters.push({ match, resolve: () => { clearTimeout(timer); resolve(state); } });
      });
    },
    close: () => { try { ws.close(); } catch { /* 忽略 */ } },
  };
}

function startBridge(upstream) {
  return startDshBridge({ port: 0, bridgeKey: KEY, upstreamOrigin: upstream.origin, upstreamCookie: "dsh=1" });
}

const chunkedUrl = (port, extra = "") =>
  `ws://127.0.0.1:${port}/api/remote.mux?dshBridge=${KEY}&${MUX_CHUNK_QUERY}=${MUX_CHUNK_QUERY_VALUE}${extra}`;

test("mux-relay: 超限消息切成多片，客户端重组逐字相同", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  const carrier = startCarrier(chunkedUrl(bridge.port));
  try {
    await upstream.ready;
    const message = "历史 " + "x".repeat(300_000) + " 收尾";
    upstream.send(OPCODE.TEXT, encodeUtf8(message));
    await carrier.waitFor((s) => s.texts.includes(message), "重组后的完整消息");
    assert.ok(carrier.state.chunkFrames >= 3, "300 KB 消息应至少切成 3 片");
    assert.ok(carrier.state.bytes <= encodeUtf8(message).length, "分片载荷合计不应超过原文");
  } finally {
    carrier.close();
    await bridge.close();
    await upstream.close();
  }
});

test("mux-relay: 回执驱动窗口——1 MiB 消息（超过窗口）也能整条走完", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  const carrier = startCarrier(chunkedUrl(bridge.port));
  try {
    await upstream.ready;
    const message = "w".repeat(1_000_000);
    upstream.send(OPCODE.TEXT, encodeUtf8(message));
    await carrier.waitFor((s) => s.texts.includes(message), "整条 1 MiB 消息");
    assert.ok(carrier.state.bytes > MUX_CHUNK_WINDOW, "总量应超过窗口，证明回执确实在放行后续分片");
    assert.ok(carrier.state.chunkFrames > MUX_CHUNK_WINDOW / MUX_CHUNK_BYTES, "分片数应多于窗口内的片数");
  } finally {
    carrier.close();
    await bridge.close();
    await upstream.close();
  }
});

test("mux-relay: 客户端不回执时在窗口处停住（不把宿主 1 MiB 守卫撞爆）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  const carrier = startCarrier(chunkedUrl(bridge.port), { ack: false });
  try {
    await upstream.ready;
    const payload = encodeUtf8("v".repeat(1_000_000));
    upstream.send(OPCODE.TEXT, payload);
    await carrier.waitFor((s) => s.bytes > 0, "第一批分片");
    await sleep(200);
    assert.ok(carrier.state.bytes < payload.length, "不回执时不得把整条消息推完");
    assert.ok(carrier.state.bytes <= MUX_CHUNK_WINDOW, "在途字节不得超过窗口");
    assert.equal(carrier.state.closed, null, "窗口用尽只是等待，不是断链");
  } finally {
    carrier.close();
    await bridge.close();
    await upstream.close();
  }
});

test("mux-relay: 控制帧（ping）不被大消息吞掉，pong 原样回到上游", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  const carrier = startCarrier(chunkedUrl(bridge.port));
  try {
    await upstream.ready;
    upstream.send(OPCODE.TEXT, encodeUtf8("y".repeat(300_000)));
    upstream.send(OPCODE.PING, new Uint8Array([1, 2, 3]));
    const pong = await upstream.waitFrame((f) => f.opcode === OPCODE.PONG, "宿主回的 pong");
    assert.deepEqual([...pong.payload], [1, 2, 3], "pong 载荷应与 ping 一致");
  } finally {
    carrier.close();
    await bridge.close();
    await upstream.close();
  }
});

test("mux-relay: 未声明分片时仍走原样透传（大帧不切片、无回执）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  const carrier = startCarrier(`ws://127.0.0.1:${bridge.port}/api/remote.mux?dshBridge=${KEY}`);
  try {
    await upstream.ready;
    const message = "原样 " + "z".repeat(300_000);
    upstream.send(OPCODE.TEXT, encodeUtf8(message));
    await carrier.waitFor((s) => s.texts.includes(message), "原样透传的大帧");
    assert.equal(carrier.state.chunkFrames, 0, "原路不得出现二进制分片");
    await sleep(120);
    assert.equal(upstream.frames.length, 0, "原路不得有回执帧");
  } finally {
    carrier.close();
    await bridge.close();
    await upstream.close();
  }
});
