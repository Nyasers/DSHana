// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/ws-frames.ts — 极小的 WebSocket 帧编解码（中继的帧搬运与测试共用）
//
// 为什么自持：中继的运行时依赖纪律是零第三方包（见 src/runtime/bridge.ts 的说明），而
// 帧搬运只需要「读头 / 原样转发 / 组一帧」这三件事，用不着完整的 ws 实现。本模块只做
// 这三件，且刻意不碰任何未改动的帧——原样转发的帧保持字节级不变，协议细节（掩码、
// 分片、ping/pong/close）交给两端自己协商。
//
// 约定：服务端→客户端的帧不掩码；本模块默认按「我们对外是服务端」组帧（不掩码），
// 需要组客户端帧（测试里的替身）时显式传 { mask: true }。
import { randomBytes } from "node:crypto";

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface WsFrameHeader {
  fin: boolean;
  opcode: number;
  masked: boolean;
  /** 帧头长度（含掩码键）。 */
  headerLength: number;
  /** 载荷长度。 */
  payloadLength: number;
  /** 整帧长度（头 + 载荷）。 */
  totalLength: number;
}

/** 解一帧头；字节不够返回 null（调用方继续攒缓冲）。 */
export function readFrameHeader(buffer: Buffer): WsFrameHeader | null {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let payloadLength = b1 & 0x7f;
  let at = 2;
  if (payloadLength === 126) {
    if (buffer.length < at + 2) return null;
    payloadLength = buffer.readUInt16BE(at);
    at += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < at + 8) return null;
    const big = buffer.readBigUInt64BE(at);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    payloadLength = Number(big);
    at += 8;
  }
  if (masked) {
    if (buffer.length < at + 4) return null;
    at += 4;
  }
  return { fin, opcode, masked, headerLength: at, payloadLength, totalLength: at + payloadLength };
}

/** 组一帧（FIN=1；不做分片——我们的用途都是整帧发出）。 */
export function serializeFrame(opcode: number, payload: Uint8Array, opts: { mask?: boolean } = {}): Buffer {
  const mask = opts.mask === true;
  const length = payload.length;
  const body = Buffer.from(payload.buffer, payload.byteOffset, length);
  const maskKey = mask ? randomBytes(4) : null;
  let header: Buffer;
  const lengthFlag = mask ? 0x80 : 0;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, lengthFlag | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = lengthFlag | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = lengthFlag | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (maskKey === null) return Buffer.concat([header, body]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= maskKey[i & 3];
  return Buffer.concat([header, maskKey, masked]);
}

/** 解出掩码帧的载荷（未掩码帧返回原文载荷）。 */
export function framePayload(frame: WsFrameHeader, raw: Buffer): Buffer {
  const payload = raw.subarray(frame.headerLength, frame.totalLength);
  if (!frame.masked) return Buffer.from(payload);
  const key = raw.subarray(frame.headerLength - 4, frame.headerLength);
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i += 1) out[i] ^= key[i & 3];
  return out;
}
