// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/frame-inflate.test.mjs — 压缩帧解压（inflateFrame）的输出上限
//
// 为什么单锁这一层：中继会把超长的可压缩文本整条压成 zstd 再发，页面侧同步解压。
// 上限若只在解完之后判断，一次几十 MB 的帧已经把主线程和页面内存吃掉了——所以上限必须
// 在解压过程里守。这里锁三件事：正常帧解得回来、超限帧当场抛错、上限与分片协议同源。
import test from "node:test";
import assert from "node:assert/strict";
import { createZstdCompress, zstdCompressSync } from "node:zlib";

import { MAX_INFLATED_BYTES, declaredFrameBytes, inflateFrame } from "@dshana/ui/dsh-inject.ts";
import { MUX_CHUNK_BYTES } from "@dshana/shared/mux-chunks.ts";

/** 与中继同一套压缩：Node 内建 zstd，整条消息独立压。 */
const pack = (text) => new Uint8Array(zstdCompressSync(Buffer.from(text, "utf8")));
/**
 * 流式压一块，得到**非 single-segment** 帧（帧头声明的是窗口，不是整帧尺寸）。
 * 中继发的是 single-segment 帧，但页面不能假定对端一定那样发。
 */
const packStreamed = async (chunk, count) => {
  const parts = [];
  const stream = createZstdCompress();
  stream.on("data", (part) => parts.push(part));
  const drained = new Promise((resolve) => stream.on("end", resolve));
  for (let i = 0; i < count; i += 1) stream.write(Buffer.from(chunk, "utf8"));
  stream.end();
  await drained;
  return new Uint8Array(Buffer.concat(parts));
};
/** 手搭一个帧头：魔术 + 描述字节 + 其余字节。 */
const frame = (descriptor, rest = []) => new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, descriptor, ...rest]);

test("正常压缩帧解得回原文（含多字节码点）", () => {
  const text = JSON.stringify({ hello: "世界", list: [1, 2, 3] }).repeat(64);
  assert.equal(inflateFrame(pack(text)), text);
});

test("解压输出超过上限的帧在解之前就被拒", () => {
  const text = "x".repeat(8 * 1024);
  // 帧头声明的尺寸已经超限，连解码器都不该构造。
  assert.throws(() => inflateFrame(pack(text), 1024), /over 1024/);
  // 同一帧在足够大的上限下正常解开：上限是唯一的差别。
  assert.equal(inflateFrame(pack(text), text.length), text);
});

test("默认上限与分片协议的单片上限同源", () => {
  assert.equal(MAX_INFLATED_BYTES, MUX_CHUNK_BYTES);
});

test("帧头声明超大窗口的帧在构造解码器前就被拒", () => {
  // 描述字节 0 表示非 single-segment，窗口描述字节 0xFF 声明 2^41 字节级窗口：
  // fzstd 会在回调之前按它分配，所以必须在解码之前就拒。
  const evil = frame(0x00, [0xff, 0, 0, 0]);
  assert.ok(declaredFrameBytes(evil) > MAX_INFLATED_BYTES * 1000, "帧头读出的窗口应远大于上限");
  assert.throws(() => inflateFrame(evil), /declares .* over/);
});

test("帧头声明 8 字节解压尺寸的帧同样被拒", () => {
  // 0xE0 = single-segment + 8 字节帧内容尺寸；任何上限都拦。
  const evil = frame(0xe0, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(declaredFrameBytes(evil), Number.MAX_SAFE_INTEGER);
  assert.throws(() => inflateFrame(evil), /declares .* over/);
});

test("非 zstd 帧直接抛错", () => {
  assert.throws(() => inflateFrame(new Uint8Array([1, 2, 3, 4, 5, 6])), /not a zstd frame/);
});

test("窗口在预算内、解压输出超预算时由流式累加拦下", async () => {
  // 非 single-segment 帧的帧头只声明窗口：内容可以比窗口大，于是帧头预检过得去，
  // 超限只能在逐块累加那一步发现。
  const frame = await packStreamed("x".repeat(512 * 1024), 8);
  const budget = declaredFrameBytes(frame);
  assert.ok(budget < 4 * 1024 * 1024, "帧头声明的窗口应小于实际解压内容");
  assert.throws(() => inflateFrame(frame, budget), /inflates past/);
  // 同一个帧在预算够大时正常解开：差别的只有上限。
  const text = inflateFrame(frame, 4 * 1024 * 1024);
  assert.equal(text.length, 4 * 1024 * 1024);
});
