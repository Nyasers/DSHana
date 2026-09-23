// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cordis/provider-adapter.test.mjs — provider adapter（buildHanaAdapter）stream() 接线单测。
//
// 为什么要有这一层：adapter 的方法只在 DSH 运行期被调用，先前单测只覆盖 lib/* 纯函数，
// 于是"在 adapter 里引用了不存在的 ctx"这类错，构建与单测都看不见，只有真机第一次推理才炸。
// 这里用假 LlmAdapter/LlmError + 假 hana client + 真 Response
// 走完整条路径：身份判定（App / taskId）、NDJSON → DSH 块、宿主参数校验适配（maxTokens /
// temperature）、非 2xx 与空消息报错。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildHanaAdapter } from "../../src-cordis/plugins/provider/index.ts";
import { TASK_BINDING_GLOBAL_KEY } from "../../src/lib/task-binding.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";
// big = 现实里那种“1M 上下文 / 384k 输出”的模型（published 上限远大于宿主的请求闸 65536）
const MODELS = [
  { provider: "hana", id: "m1", name: "m1" }, // 未声明 maxTokens
  { provider: "hana", id: "big", name: "big", maxTokens: 393216 },
  { provider: "hana", id: "small", name: "small", maxTokens: 4096 },
];

class FakeLlmError extends Error {
  constructor(message, code, opts) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    if (opts && opts.requestId) this.requestId = opts.requestId;
  }
}
class FakeLlmAdapter {}

// 身份判定读的是受管 runtime 挂在 globalThis 上的绑定索引（见 lib/task-binding.ts）；
// 单测直接注入一个同形索引，不碰文件系统。
let savedIndex;
beforeEach(() => {
  savedIndex = globalThis[TASK_BINDING_GLOBAL_KEY];
});
afterEach(() => {
  if (savedIndex === undefined) delete globalThis[TASK_BINDING_GLOBAL_KEY];
  else globalThis[TASK_BINDING_GLOBAL_KEY] = savedIndex;
});

/** 装一个假绑定索引：bySession 按 sessionId 回绑定（null = 无绑定）。 */
function seedBinding(binding) {
  globalThis[TASK_BINDING_GLOBAL_KEY] = {
    bySession: async (sid) => (sid === SID ? binding : null),
  };
}

function ndjsonResponse(events) {
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return new Response(text, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

function makeHana(events) {
  const seen = [];
  return {
    seen,
    models: {
      list: async () => ({ models: MODELS }),
      stream: async (request) => {
        seen.push(request);
        return ndjsonResponse(events);
      },
      cancel: async () => { /* 无操作 */ },
    },
  };
}

function makeAdapter(hana, log, warn) {
  return buildHanaAdapter(FakeLlmAdapter, FakeLlmError, { models: MODELS, hana, log, warn });
}

async function collect(adapter, options) {
  const out = [];
  for await (const chunk of adapter.stream(options)) out.push(chunk);
  return out;
}

function streamOnce(options, hana) {
  const adapter = makeAdapter(hana, () => {}, () => {});
  return collect(adapter, options).then(() => hana.seen[0]);
}

test("live 目录：换掉 catalog.models 后 listModels/resolveModel 立刻看新的（不需要重建 adapter）", async () => {
  const hana = makeHana(okEvents);
  const catalog = { models: MODELS };
  const adapter = buildHanaAdapter(FakeLlmAdapter, FakeLlmError, { catalog, hana });

  assert.deepEqual((await adapter.listModels("hana")).map((m) => m.id), ["m1", "big", "small"]);
  await assert.rejects(async () => { await adapter.resolveModel("hana", "late", undefined) }, /无模型/);

  // 宿主目录变了：插件把包里的 models 整体换掉（provider/index.ts 的 reload 就这么干）
  catalog.models = [{ provider: "hana", id: "late", name: "late" }, { provider: "other", id: "o", name: "o" }];

  assert.deepEqual((await adapter.listModels("hana")).map((m) => m.id), ["late"]);
  const info = await adapter.resolveModel("hana", "late", undefined);
  assert.equal(info.provider, "hana");
  assert.equal(info.id, "late");
});

const userMessages = [{ role: "user", content: [{ type: "text", text: "你好" }] }];
const okEvents = [
  { type: "start", requestId: "r1" },
  { type: "text-delta", requestId: "r1", delta: "你好" },
  {
    type: "done",
    requestId: "r1",
    stopReason: "stop",
    assistant: { role: "assistant", content: [{ type: "text", text: "你好", textSignature: "sig-1" }] },
  },
];

test("App 身份（无任务绑定）：两个身份参数都不传，且日志说明原因", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const lines = [];
  const adapter = makeAdapter(hana, (m) => lines.push(m));
  const out = await collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages });

  const req = hana.seen[0];
  assert.equal(req.taskId, undefined);
  assert.equal(req.callToken, undefined);
  assert.equal("scope" in req, false);
  assert.equal(typeof req.requestId, "string");
  assert.equal(req.requestId.length > 0, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /无任务绑定/);
  assert.equal(out.length > 0, true);
  assert.match(JSON.stringify(out), /你好/);
});

test("委派身份（有任务绑定且活动）：带 taskId、不带 callToken、不写身份日志", async () => {
  seedBinding({ taskId: "task-1", status: "running" });
  const hana = makeHana(okEvents);
  const lines = [];
  const adapter = makeAdapter(hana, (m) => lines.push(m));
  await collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages });

  assert.equal(hana.seen[0].taskId, "task-1");
  assert.equal(hana.seen[0].callToken, undefined);
  assert.equal("scope" in hana.seen[0], false);
  assert.deepEqual(lines, []);
});

test("任务已终结（有绑定但 status 终态）：同样按 App 身份，不遗留 taskId", async () => {
  seedBinding({ taskId: "task-1", status: "completed" });
  const hana = makeHana(okEvents);
  await collect(makeAdapter(hana, () => {}), { provider: "hana", model: "m1", sessionId: SID, messages: userMessages });
  assert.equal(hana.seen[0].taskId, undefined);
});

test("绑定索引缺席：显式失败（不降级成 App 身份）", async () => {
  delete globalThis[TASK_BINDING_GLOBAL_KEY];
  const hana = makeHana(okEvents);
  await assert.rejects(
    () => collect(makeAdapter(hana, () => {}), { provider: "hana", model: "m1", sessionId: SID, messages: userMessages }),
    (e) => e && e.code === "BINDING_UNAVAILABLE",
  );
  assert.equal(hana.seen.length, 0, "身份判不出就不发模型请求");
});

test("绑定读取失败（宿主不可达）：显式失败并保留 TASK_MAP_BROKEN code", async () => {
  globalThis[TASK_BINDING_GLOBAL_KEY] = {
    bySession: async () => { throw Object.assign(new Error("host down"), { code: "TASK_MAP_BROKEN" }); },
  };
  const hana = makeHana(okEvents);
  await assert.rejects(
    () => collect(makeAdapter(hana, () => {}), { provider: "hana", model: "m1", sessionId: SID, messages: userMessages }),
    (e) => e && e.code === "TASK_MAP_BROKEN",
  );
});

test("HTTP 非 2xx：以 MODEL_HTTP_ERROR 上抛（带状态与响应体）", async () => {
  seedBinding(null);
  const hana = {
    seen: [],
    models: {
      list: async () => ({ models: MODELS }),
      stream: async () => new Response('{"error":"forbidden"}', { status: 403 }),
      cancel: async () => { /* 无操作 */ },
    },
  };
  const adapter = makeAdapter(hana, () => {});
  await assert.rejects(
    () => collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages }),
    (e) => e instanceof FakeLlmError && e.code === "MODEL_HTTP_ERROR" && /HTTP 403/.test(e.message),
  );
});

test("空消息：EMPTY_MESSAGES，且不发起模型请求", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const adapter = makeAdapter(hana, () => {});
  await assert.rejects(
    () => collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: [] }),
    (e) => e.code === "EMPTY_MESSAGES",
  );
  assert.equal(hana.seen.length, 0);
});

test("log 缺失也不崩（deps.log 缺省为空函数）", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const adapter = makeAdapter(hana, undefined);
  const out = await collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages });
  assert.equal(out.length > 0, true);
});

// ---- 宿主参数校验适配（APP_MODEL_INVALID_REQUEST）----
// 宿主 bundle 校验器原文："maxTokens must be a positive integer no larger than 65536."
// （写死的默认 limits.maxTokens，构造 App 模型服务时没有 limits 入口），另有一条
// "maxTokens exceeds the selected model's published limit."；温度必须 [0,2]。
// 关键取舍：DSH 的输出预算来自模型真实上限（384k），超过宿主请求闸时**不传字段**——
// 收敛到 65536 等于把输出悄悄砍到 64k。

test("maxTokens：超过宿主请求闸 → 不传字段（而非压到 65536）", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const warns = [];
  const adapter = makeAdapter(hana, () => {}, (m) => warns.push(m));
  await collect(adapter, { provider: "hana", model: "big", sessionId: SID, messages: userMessages, maxTokens: 393216 });
  assert.equal("maxTokens" in hana.seen[0], false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /改为不传/);
});

test("maxTokens：未声明 published 上限时，超闸同样不传", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const req = await streamOnce(
    { provider: "hana", model: "m1", sessionId: SID, messages: userMessages, maxTokens: 100000 },
    hana,
  );
  assert.equal("maxTokens" in req, false);
});

test("maxTokens：未超宿主闸 → 原样透传，不写提示", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const warns = [];
  const adapter = makeAdapter(hana, () => {}, (m) => warns.push(m));
  await collect(adapter, { provider: "hana", model: "big", sessionId: SID, messages: userMessages, maxTokens: 60000 });
  assert.equal(hana.seen[0].maxTokens, 60000);
  assert.deepEqual(warns, []);
});

test("maxTokens：未超宿主闸但超过该模型 published 上限 → 按模型上限收敛", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const warns = [];
  const adapter = makeAdapter(hana, () => {}, (m) => warns.push(m));
  await collect(adapter, { provider: "hana", model: "small", sessionId: SID, messages: userMessages, maxTokens: 8192 });
  assert.equal(hana.seen[0].maxTokens, 4096);
  assert.match(warns[0], /published 上限/);
});

test("maxTokens：非正整数不发字段（交给宿主默认）", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const req = await streamOnce(
    { provider: "hana", model: "m1", sessionId: SID, messages: userMessages, maxTokens: 0 },
    hana,
  );
  assert.equal("maxTokens" in req, false);
});

test("temperature：越界收敛到 [0,2]", async () => {
  seedBinding(null);
  const hana = makeHana(okEvents);
  const req = await streamOnce(
    { provider: "hana", model: "m1", sessionId: SID, messages: userMessages, temperature: 3 },
    hana,
  );
  assert.equal(req.temperature, 2);
});

test("目录投影（resolveModel）：声明模型真实上限，不夹宿主请求闸", async () => {
  seedBinding(null);
  const adapter = makeAdapter(makeHana(okEvents), () => {}, () => {});
  const big = await adapter.resolveModel("hana", "big");
  const m1 = await adapter.resolveModel("hana", "m1");
  assert.equal(big.defaultMaxTokens, 393216);
  assert.equal(m1.defaultMaxTokens, undefined); // 模型未声明就不猜
});
