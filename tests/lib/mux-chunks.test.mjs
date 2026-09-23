// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/mux-chunks.test.mjs — 承载面分片信封单测（纯函数/纯状态，无 socket）
// 覆盖：分片与重组往返（含多字节码点被切断的情形）、线上字节布局、回执编解码、
// 畸形帧拒绝、在途窗口的放行与唤醒。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChunkAssembler,
  ChunkWindow,
  MUX_CHUNK_BYTES,
  MUX_CHUNK_FRAME_OVERHEAD,
  MUX_CHUNK_MAGIC,
  MUX_CHUNK_WINDOW,
  decodeMuxControlFrame,
  encodeAck,
  encodeChunk,
  encodeUtf8,
  decodeUtf8,
  isMuxControlFrame,
  sliceBytes,
  splitTextMessage,
} from "../../src/lib/mux-chunks.ts";

test("mux-chunks: 分片与重组往返（长文本，逐片喂入）", () => {
  const text = "会话历史 " + "x".repeat(400_000) + " 收尾";
  const frames = splitTextMessage(text, 64 * 1024);
  assert.ok(frames.length > 1, "超过上限的文本应被切成多片");
  for (const frame of frames) {
    assert.ok(frame.length <= 64 * 1024 + 8, "单片载荷不得超过上限（+ 帧头）");
  }
  const assembler = new ChunkAssembler();
  let out = null;
  for (let i = 0; i < frames.length; i += 1) {
    const decoded = decodeMuxControlFrame(frames[i]);
    assert.equal(decoded?.kind, "chunk");
    out = assembler.push(decoded.payload, decoded.last);
    if (i < frames.length - 1) assert.equal(out, null, "未收齐最后一片前不得交出结果");
  }
  assert.equal(decodeUtf8(out), text, "重组结果必须与原文逐字相同");
  assert.equal(assembler.pending, 0, "收齐后缓冲应清空");
});

test("mux-chunks: 切点落在多字节码点中间也能还原（先拼字节再解码）", () => {
  const text = "中文字符".repeat(50);
  const frames = splitTextMessage(text, 1); // 逐字节切，切点必然落在码点中间
  assert.equal(frames.length, encodeUtf8(text).length);
  const assembler = new ChunkAssembler();
  let out = null;
  for (const frame of frames) {
    const decoded = decodeMuxControlFrame(frame);
    out = assembler.push(decoded.payload, decoded.last);
  }
  assert.equal(decodeUtf8(out), text);
});

test("mux-chunks: 线上布局（分片头 / 回执头）", () => {
  const chunk = encodeChunk(encodeUtf8("hi"), false);
  assert.deepEqual([...chunk.subarray(0, 4)], [...MUX_CHUNK_MAGIC]);
  assert.equal(chunk[4], 1, "kind=chunk");
  assert.equal(chunk[5], 0, "last=false");
  assert.equal(decodeUtf8(chunk.subarray(6)), "hi");
  assert.equal(encodeChunk(encodeUtf8("hi"), true)[5], 1);

  const ack = encodeAck(123456);
  assert.deepEqual([...ack.subarray(0, 4)], [...MUX_CHUNK_MAGIC]);
  assert.equal(ack[4], 2, "kind=ack");
  assert.equal(ack.length, 9);
  assert.deepEqual(decodeMuxControlFrame(ack), { kind: "ack", bytes: 123456 });
});

test("mux-chunks: 正常 mux 帧不会被误判为控制帧", () => {
  const json = encodeUtf8(JSON.stringify({ type: "open", streamId: "hana-1", endpoint: "session/follow" }));
  assert.equal(isMuxControlFrame(json), false);
  assert.equal(decodeMuxControlFrame(json), null);
});

test("mux-chunks: 畸形控制帧一律拒绝（不猜、不半信）", () => {
  const short = new Uint8Array([...MUX_CHUNK_MAGIC]);
  assert.equal(decodeMuxControlFrame(short), null, "只有一个魔数不算控制帧");
  const unknownKind = new Uint8Array([...MUX_CHUNK_MAGIC, 9, 0]);
  assert.equal(decodeMuxControlFrame(unknownKind), null, "未知 kind 应拒绝");
  const truncatedAck = new Uint8Array([...MUX_CHUNK_MAGIC, 2, 0, 0]);
  assert.equal(decodeMuxControlFrame(truncatedAck), null, "回执长度不足应拒绝");
});

test("mux-chunks: sliceBytes 的边界（limit<=0 视作单段；整除时不产生空片）", () => {
  const bytes = encodeUtf8("abcdef");
  assert.deepEqual(sliceBytes(bytes, 0).map((b) => b.length), [6]);
  assert.deepEqual(sliceBytes(bytes, -1).map((b) => b.length), [6]);
  assert.deepEqual(sliceBytes(bytes, 3).map((b) => b.length), [3, 3]);
  assert.deepEqual(sliceBytes(bytes, 6).map((b) => b.length), [6]);
  assert.deepEqual(sliceBytes(bytes, 4).map((b) => b.length), [4, 2]);
});

test("mux-chunks: 在途窗口只在额度内放行，回执唤醒等待者", async () => {
  const window = new ChunkWindow(300);
  window.reserve(300);
  assert.equal(window.room, 0);
  let released = false;
  const waiting = window.waitForRoom(128).then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false, "额度用尽时不得放行");
  window.ack(200);
  await waiting;
  assert.equal(released, true, "回执应唤醒等待者");
  assert.equal(window.outstanding, 100);
  window.reserve(128);
  assert.equal(window.room, 72);
  window.ack(1_000);
  assert.equal(window.outstanding, 0, "回执超出在途时按 0 收，不出现负数");
});

test("mux-chunks: 默认上限离宿主的 1 MiB 守卫有余量（按线上字节核算）", () => {
  assert.equal(MUX_CHUNK_BYTES, 128 * 1024);
  assert.ok(MUX_CHUNK_WINDOW >= MUX_CHUNK_BYTES, "窗口至少容得下一片");
  assert.ok(MUX_CHUNK_WINDOW % MUX_CHUNK_BYTES === 0, "窗口应为单片整数倍（避免多压半片）");
  // 宿主守卫：bufferedAmount > 1 MiB 就掐。一片的线上字节 = 载荷 + 帧头/信封开销。
  const wirePerChunk = MUX_CHUNK_BYTES + MUX_CHUNK_FRAME_OVERHEAD;
  const windowWire = (MUX_CHUNK_WINDOW / MUX_CHUNK_BYTES) * wirePerChunk;
  assert.ok(windowWire < 1024 * 1024, `满窗口的线上字节 ${windowWire} 必须小于 1 MiB 守卫`);
  assert.ok(1024 * 1024 - windowWire >= 128 * 1024, "至少要给 live 帧与 ping 留 128 KiB");
});
