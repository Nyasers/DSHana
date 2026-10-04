// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cordis/provider-messages.test.mjs — DSH Message → hana messages 转换纯函数单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHanaMessages, collectToolNames, isToolResultMessage } from "../../packages/provider/lib/messages.ts";

const HANA_ENVELOPE = {
  kind: "hana",
  version: 1,
  response: { provider: "deepseek", model: "m", requestId: "r1" },
  // blocks 与 assistant content 按序对齐（回放信封契约）
  blocks: [
    { signature: "sig-reason" },
    { textSignature: "sig-text-1" },
    { thoughtSignature: "sig-thought", id: "call-1" },
  ],
};

test("assistant 历史：文本/推理/tool-call → hana assistant content（签名保留）", () => {
  const msgs = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "思考" },
        { type: "text", text: "回答" },
        { type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.txt"}' },
      ],
      source: { kind: "model", provider: "deepseek", model: "m", replayState: HANA_ENVELOPE },
    },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  assert.equal(messages.length, 1);
  const content = messages[0].content;
  assert.equal(content[0].type, "reasoning");
  assert.equal(content[0].reasoning, "思考");
  assert.equal(content[0].signature, "sig-reason");
  assert.equal(content[1].type, "text");
  assert.equal(content[1].textSignature, "sig-text-1");
  assert.equal(content[2].type, "toolCall");
  assert.deepEqual(content[2].arguments, { path: "a.txt" });
  assert.equal(content[2].thoughtSignature, "sig-thought");
});

test("tool 消息（DSH 形态）：转独立 toolResult（toolName 反查 + content 数组 + isError）", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    { role: "tool", source: { kind: "tool", callId: "c1" }, toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  assert.equal(messages.length, 2);
  const tr = messages[1];
  assert.equal(tr.role, "toolResult");
  assert.equal(tr.toolCallId, "c1");
  assert.equal(tr.toolName, "read");
  assert.deepEqual(tr.content, [{ type: "text", text: "ok" }]);
  assert.equal(tr.isError, false);
  assert.equal(isToolResultMessage(msgs[1]), true);
});

test("tool 消息：isError 透传、callId 缺 toolCallId 时读 source.callId、空内容落空文本项", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", id: "c9", name: "bash", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    { role: "tool", source: { kind: "tool", callId: "c9" }, content: [], isError: true },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  const tr = messages[1];
  assert.equal(tr.toolCallId, "c9");
  assert.equal(tr.toolName, "bash");
  assert.equal(tr.isError, true);
  assert.deepEqual(tr.content, [{ type: "text", text: "" }]);
});

test("兼容形态：user 消息内嵌的 tool-result 块同样拆为独立 toolResult", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false }], source: { kind: "tool", callId: "c1" } },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  assert.equal(messages.length, 2);
  const tr = messages[1];
  assert.equal(tr.role, "toolResult");
  assert.equal(tr.toolCallId, "c1");
  assert.equal(tr.toolName, "bash");
  assert.deepEqual(tr.content, [{ type: "text", text: "ok" }]);
  assert.equal(tr.isError, false);
});

test("用户纯文本/图片消息与 system 文本", () => {
  const images = new Map([["att-1", { data: "aGVsbG8=", mimeType: "image/png" }]]);
  const msgs = [
    { role: "system", content: [{ type: "text", text: "sys" }] },
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png" } }] },
  ];
  const { messages, systemPrompt } = toHanaMessages({ messages: msgs, images });
  assert.equal(systemPrompt, "sys");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 2);
  assert.equal(messages[0].content[1].type, "image");
  assert.equal(messages[0].content[1].data, "aGVsbG8=");
});

test("图片块无解析字节 → UNSUPPORTED_CONTENT", () => {
  const msgs = [{ role: "user", content: [{ type: "image", attachment: { attachmentId: "att-x", mediaType: "png" } }] }];
  assert.throws(() => toHanaMessages({ messages: msgs, images: null }), (e) => e.code === "UNSUPPORTED_CONTENT");
});

test("replay.blocks 与 content 长度不等 → 整体丢弃签名，其余行为不变", () => {
  // 宿主 assembler 在剪枝/压缩后会连带剪掉 replay 条目或 content 块；一旦两者长度
  // 不等，按下标取值就会把签名挂到错误的块上，这里按同样口径整体丢弃。
  const msgs = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "保留" },
        { type: "reasoning", text: "思考" },
        { type: "tool-call", id: "call-1", name: "read", arguments: "{}" },
      ],
      // 只有 2 个 meta，却有 3 个 content 块（content 多出块）
      source: {
        kind: "model",
        provider: "deepseek",
        model: "m",
        replayState: { kind: "hana", version: 1, response: {}, blocks: [{ textSignature: "s0" }, { signature: "s1" }] },
      },
    },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  const content = messages[0].content;
  // 内容与顺序不变
  assert.deepEqual(content.map((c) => c.type), ["text", "reasoning", "toolCall"]);
  assert.equal(content[0].text, "保留");
  assert.equal(content[1].reasoning, "思考");
  assert.deepEqual(content[2].arguments, {});
  // 没有任何签名挂上去（尤其不能错位）
  assert.equal(content[0].textSignature, undefined);
  assert.equal(content[1].signature, undefined);
  assert.equal(content[2].thoughtSignature, undefined);
});

test("replay.blocks 比 content 短：meta 不被挂到别的块上（错位防护）", () => {
  // 压缩剪掉了 content 里的尾块、replay 里也少了一条；剩下的那条 meta 属于谁已不可知。
  // 按下标取值会把它挂到 index 0 的 tool-call 上，这里必须整体丢弃。
  const msgs = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
        { type: "text", text: "尾块" },
      ],
      source: {
        kind: "model",
        provider: "p",
        model: "m",
        replayState: { kind: "hana", version: 1, response: {}, blocks: [{ thoughtSignature: "sig-of-removed-block" }] },
      },
    },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  const content = messages[0].content;
  assert.equal(content[0].type, "toolCall");
  assert.equal(content[0].thoughtSignature, undefined, "长度不等时不得采用任何签名");
  assert.equal(content[1].textSignature, undefined);
});

test("replay 信封非 hana / blocks 非数组 → 不采用签名（原有行为）", () => {
  const base = { role: "assistant", content: [{ type: "text", text: "t" }] };
  for (const replayState of [
    { kind: "pi-ai", blocks: [{ textSignature: "x" }] },
    { kind: "hana", blocks: "not-an-array" },
    { kind: "hana" },
  ]) {
    const { messages } = toHanaMessages({
      messages: [{ ...base, source: { kind: "model", provider: "p", model: "m", replayState } }],
      images: null,
    });
    assert.equal(messages[0].content[0].textSignature, undefined, JSON.stringify(replayState));
  }
});

test("助手 arguments 非法 JSON 回落 {}；collectToolNames/isToolResultMessage", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "x", arguments: "{bad" }], source: { kind: "model", provider: "p", model: "m" } },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  assert.deepEqual(messages[0].content[0].arguments, {});
  const names = collectToolNames(msgs);
  assert.equal(names.get("c2"), "x");
  assert.equal(isToolResultMessage(msgs[0]), false);
});
