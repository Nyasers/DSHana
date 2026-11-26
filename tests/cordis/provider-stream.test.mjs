// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cordis/provider-stream.test.mjs — provider 的真流式（增量 emit）与终态收尾
//
// 真机反馈：跳过 text-delta/reasoning-delta、只在 done 一次性产出的话，Web UI
// 看不到逐字输出。所以这里：过程出 block-start + delta，终态出权威 block-end（签名只在
// done.assistant 里）+ usage + finish。这里锁三件事：
//   ① 增量字段是契约里的 `delta`（不是 text），空增量不发；
//   ② 同类型连续增量共用一块，类型切换开新块；
//   ③ 已经流过 delta 的 index 在 done 时**只补 block-end**，不重复 block-start/delta。
//
// 与上游 @deepseek-ai/dsh-llm 的 BlockAssembler 对账不放在本文件：本仓不依赖那个包（它只是
// @deepseek-ai/dsh 的传递依赖，根 node_modules 下没有链接），import 必然 ERR_MODULE_NOT_FOUND。
// 要验那份契约就临时 `pnpm add -D @deepseek-ai/dsh-llm` 再跑，不在单测里留常驻 skip。

import test from "node:test";
import assert from "node:assert/strict";

import { buildDoneChunks, createHanaStreamState } from "../../packages/dsh/provider/lib/stream.ts";

const scope = { provider: "hana", model: "deepseek-chat", requestId: "req-1" };

function doneEvent({
  content,
  stopReason = "stop",
  usage = { input: 10, output: 5, totalTokens: 15 },
} = {}) {
  return {
    type: "done",
    stopReason,
    usage,
    assistant: { role: "assistant", content },
  };
}

test("增量：block-start + delta 立刻产出，同块共用 index，类型切换开新块", () => {
  const state = createHanaStreamState();
  assert.deepEqual(state.push({ type: "start" }), []);
  assert.deepEqual(state.push({ type: "text-delta", delta: "你" }), [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "你" },
  ]);
  // 同类型：不再 block-start
  assert.deepEqual(state.push({ type: "text-delta", delta: "好" }), [
    { type: "text-delta", index: 0, text: "好" },
  ]);
  // 类型切换：新 index
  assert.deepEqual(state.push({ type: "reasoning-delta", delta: "想" }), [
    { type: "block-start", index: 1, blockType: "reasoning" },
    { type: "reasoning-delta", index: 1, text: "想" },
  ]);
  // 空增量 / 无关事件：什么都不发
  assert.deepEqual(state.push({ type: "text-delta", delta: "" }), []);
  assert.deepEqual(state.push({ type: "tool-call", id: "t1", name: "fs", arguments: {} }), []);
  assert.deepEqual([...state.startedIndexes], [0, 1]);
});

test("增量只认契约字段 delta（不是 text）", () => {
  const state = createHanaStreamState();
  assert.deepEqual(state.push({ type: "text-delta", text: "错误字段" }), []);
  assert.equal(state.startedIndexes.size, 0, "没有 delta 字段就不该开块");
});

test("done：已流过的 index 只补权威 block-end，不重复 block-start/delta", () => {
  const state = createHanaStreamState();
  state.push({ type: "text-delta", delta: "半" });
  state.push({ type: "text-delta", delta: "句" });
  const chunks = buildDoneChunks({
    doneEvent: doneEvent({ content: [{ type: "text", text: "半句", textSignature: "sig-1" }] }),
    ...scope,
    startedIndexes: state.startedIndexes,
  });
  assert.deepEqual(chunks, [
    { type: "block-end", index: 0, block: { type: "text", text: "半句" } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    {
      type: "finish",
      reason: { kind: "stop" },
      replayState: {
        response: { kind: "hana", version: 1, provider: "hana", model: "deepseek-chat", requestId: "req-1", stopReason: "stop" },
        blocks: [{ textSignature: "sig-1" }],
      },
    },
  ]);
});

test("done：没流过的块（如 tool-call）仍走完整 block-start/delta/block-end", () => {
  const state = createHanaStreamState();
  state.push({ type: "text-delta", delta: "先说话" });
  const chunks = buildDoneChunks({
    doneEvent: doneEvent({
      content: [
        { type: "text", text: "先说话", textSignature: "sig-a" },
        { type: "toolCall", id: "call-1", name: "fs.read", arguments: { path: "a" }, thoughtSignature: "sig-b" },
      ],
      stopReason: "toolUse",
    }),
    ...scope,
    startedIndexes: state.startedIndexes,
  });
  assert.deepEqual(chunks.slice(0, 4), [
    { type: "block-end", index: 0, block: { type: "text", text: "先说话" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    { type: "tool-call-delta", index: 1, id: "call-1", name: "fs.read", argumentsDelta: '{"path":"a"}' },
    { type: "block-end", index: 1, block: { type: "tool-call", id: "call-1", name: "fs.read", arguments: '{"path":"a"}' } },
  ]);
  assert.equal(chunks.at(-1).type, "finish");
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
  assert.deepEqual(chunks.at(-1).replayState.blocks, [{ textSignature: "sig-a" }, { id: "call-1", thoughtSignature: "sig-b" }]);
});

test("不传 startedIndexes 时保持旧行为（兼容）", () => {
  const chunks = buildDoneChunks({
    doneEvent: doneEvent({ content: [{ type: "text", text: "整段" }] }),
    ...scope,
  });
  assert.deepEqual(chunks.slice(0, 3), [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "整段" },
    { type: "block-end", index: 0, block: { type: "text", text: "整段" } },
  ]);
});
