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
import { zstdCompressSync } from "node:zlib";

import { MAX_INFLATED_BYTES, inflateFrame } from "@dshana/ui/dsh-inject.ts";
import { MUX_CHUNK_BYTES } from "@dshana/shared/mux-chunks.ts";

/** 与中继同一套压缩：Node 内建 zstd，整条消息独立压。 */
const pack = (text) => new Uint8Array(zstdCompressSync(Buffer.from(text, "utf8")));

test("正常压缩帧解得回原文（含多字节码点）", () => {
  const text = JSON.stringify({ hello: "世界", list: [1, 2, 3] }).repeat(64);
  assert.equal(inflateFrame(pack(text)), text);
});

test("解压输出超过上限时当场抛错，不把整帧解完", () => {
  const text = "x".repeat(8 * 1024);
  assert.throws(() => inflateFrame(pack(text), 1024), /inflates past 1024 bytes/);
  // 同一帧在足够大的上限下正常解开：上限是唯一的差别。
  assert.equal(inflateFrame(pack(text), text.length), text);
});

test("默认上限与分片协议的单片上限同源", () => {
  assert.equal(MAX_INFLATED_BYTES, MUX_CHUNK_BYTES);
});
