// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ws-frames.test.mjs — WS 帧编解码单测（中继帧搬运的承重件）
// 覆盖：三种长度编码（7 位 / 16 位 / 64 位）往返、掩码帧往返、半帧拒绝、
// 帧头长度为整帧长度（含掩码键），以及「未改动的帧原样转发」所依赖的字节级不变性。
import { test } from "node:test";
import assert from "node:assert/strict";

import { OPCODE, framePayload, readFrameHeader, serializeFrame } from "../src/lib/ws-frames.ts";

const bytes = (length, fill = 0x61) => new Uint8Array(length).fill(fill);

test("ws-frames: 三种长度编码往返（7 位 / 16 位 / 64 位）", () => {
  for (const length of [0, 5, 125, 126, 65535, 65536, 200_000]) {
    const payload = bytes(length, 0x62);
    const frame = serializeFrame(OPCODE.BINARY, payload);
    const header = readFrameHeader(frame);
    assert.ok(header, `长度 ${length} 应能解出头`);
    assert.equal(header.opcode, OPCODE.BINARY);
    assert.equal(header.fin, true);
    assert.equal(header.masked, false);
    assert.equal(header.payloadLength, length);
    assert.equal(header.totalLength, frame.length, "totalLength 必须等于整帧长度");
    assert.deepEqual(framePayload(header, frame), Buffer.from(payload));
  }
});

test("ws-frames: 掩码帧往返（客户端 → 服务端方向）", () => {
  const payload = bytes(300, 0x63);
  const frame = serializeFrame(OPCODE.TEXT, payload, { mask: true });
  const header = readFrameHeader(frame);
  assert.ok(header);
  assert.equal(header.masked, true);
  assert.equal(header.headerLength, 2 + 2 + 4, "16 位长度 + 4 字节掩码键");
  assert.deepEqual(framePayload(header, frame), Buffer.from(payload), "解掩码后必须等于原文");
  assert.notDeepEqual(frame.subarray(header.headerLength), Buffer.from(payload), "掩码帧的载荷不应是明文");
});

test("ws-frames: 帧头不全时返回 null；帧头齐但载荷未到则给出头（调用方自己比长度）", () => {
  const frame = serializeFrame(OPCODE.TEXT, bytes(1000, 0x64));
  for (const cut of [1, 2, 3]) {
    assert.equal(readFrameHeader(frame.subarray(0, cut)), null, `截断到 ${cut} 字节时帧头还没齐`);
  }
  // 4 字节正是 16 位长度编码的完整帧头：头能解出，载荷还没到——调用方按 totalLength 判断。
  const headerOnly = readFrameHeader(frame.subarray(0, 4));
  assert.ok(headerOnly, "帧头齐了就该给出头");
  assert.equal(headerOnly.payloadLength, 1000);
  assert.ok(headerOnly.totalLength > 4, "totalLength 大于已有字节：调用方据此继续攒缓冲");
  assert.ok(readFrameHeader(frame), "整帧应解得出");
});

test("ws-frames: 帧头长度含掩码键（原样转发时的切点依据）", () => {
  const small = serializeFrame(OPCODE.PING, bytes(0));
  const header = readFrameHeader(small);
  assert.equal(header.headerLength, 2);
  assert.equal(header.totalLength, 2);

  const ping = serializeFrame(OPCODE.PING, bytes(3, 0x7a), { mask: true });
  const maskedHeader = readFrameHeader(ping);
  assert.equal(maskedHeader.headerLength, 2 + 4, "掩码键属于帧头，不计入载荷");
  assert.equal(maskedHeader.payloadLength, 3);
});
