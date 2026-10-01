// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/stream-carrier.test.mjs — 远端流载体（createStreamCarrier）的协议与失败语义
//
// 为什么单锁这一层：载体抛出的错误不是内部细节，它是**跨 bundle 契约**。DSH 的
// normalizeConnectionStream 只看结构标记（页半与内核半的类身份跨不过去），据此决定
// 「可重试的载体丢失」还是「终态故障」：
//   · carrier 标记丢了 → 同一个断链被折成 gateway/internal 终态 → 会话历史流一次死透，
//     界面停在「历史加载失败」（重连也不恢复）；
//   · remote 标记缺码 → 宿主的业务码（如 session/not-found）被折成 gateway/internal。
// 另外两条：open 的 payload 必须成键出现（协议两端都是我们，缺键一律当非法），
// 以及收到 end 帧之后不该再补发 cancel（对端已摘表）。

import test from "node:test";
import assert from "node:assert/strict";

import { createStreamCarrier } from "@dshana/ui/stream-carrier.ts";
import {
  STREAM_PATH_CANCEL,
  STREAM_PATH_END,
  STREAM_PATH_ITEM,
  STREAM_PATH_OPEN,
} from "@dshana/shared/stream-carrier.ts";

const BASE = new URL("https://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/");
const MARK = "dshRemoteStreamFailure";

/** 一条可驱动的 NDJSON 下行响应（测试推帧，载体读）；中止信号让读取以 AbortError 失败。 */
function openStreamResponse(signal) {
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  const push = (frame) => controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
  if (signal) {
    signal.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("Aborted", "AbortError"));
      } catch { /* 已关 */ }
    }, { once: true });
  }
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    item(value) { push({ type: "item", value }); },
    end() { push({ type: "end" }); controller.close(); },
    fail(error) { push({ type: "error", error }); controller.close(); },
    truncate() { controller.close(); },
  };
}

/** 假 fetch：记录每次 POST，open 那条返回可驱动的下行响应。 */
function newCarrier() {
  const calls = [];
  let downlink = null;
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: init && init.method, body });
    if (body && typeof body.streamId === "string" && String(url).endsWith(STREAM_PATH_OPEN)) {
      downlink = openStreamResponse(init && init.signal);
      return downlink.response;
    }
    return new Response(null, { status: 204 });
  };
  const carrier = createStreamCarrier({
    resolve: (pathname) => new URL(String(pathname).replace(/^\//, ""), BASE),
    fetchImpl,
  });
  return { carrier, calls, downlink: () => downlink };
}

/** 等一个条件成立（fetch 的链条走完）。 */
async function waitFor(fn) {
  for (let i = 0; i < 100 && !fn(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fn(), "等待条件超时");
}

/** 起一条流并等下行响应就位，返回 { iterator, first, 下行驱动器, open 请求体 }。 */
async function startStream(carrier, calls, downlink, opts = {}) {
  const endpoint = "endpoint" in opts ? opts.endpoint : "$events";
  const payload = "payload" in opts ? opts.payload : { args: {} };
  const sig = "signal" in opts ? opts.signal : undefined;
  const iterator = carrier.openStream(endpoint, payload, sig)[Symbol.asyncIterator]();
  const first = iterator.next();
  await waitFor(() => downlink() !== null);
  const opened = calls.find((call) => call.url.endsWith(STREAM_PATH_OPEN));
  return { iterator, first, down: downlink(), opened };
}

const rejection = (p) => p.then(() => undefined, (error) => error);

test("宿主 error 帧：域码与 details 原样带出（remote 标记，不折成 gateway/internal）", async () => {
  const { carrier, calls, downlink } = newCarrier();
  const { first, down } = await startStream(carrier, calls, downlink);
  down.fail({ code: "session/not-found", message: "会话不存在", details: { sessionId: "session-1" } });
  const error = await rejection(first);
  assert.equal(error.message, "会话不存在");
  assert.deepEqual(error[MARK], {
    kind: "remote",
    code: "session/not-found",
    details: { sessionId: "session-1" },
  });
  carrier.dispose();
});

test("下行被截断（响应流结束而无 end 帧）：在途流以 carrier 标记收场（DSH 侧才敢重连）", async () => {
  const { carrier, calls, downlink } = newCarrier();
  const { iterator, first, down } = await startStream(carrier, calls, downlink);
  down.item({ seq: 1 });
  assert.deepEqual(await first, { value: { seq: 1 }, done: false });
  const next = iterator.next();
  down.truncate();
  const error = await rejection(next);
  assert.equal(error.message, "DSH stream carrier closed before the stream ended");
  assert.deepEqual(error[MARK], { kind: "carrier" });
  carrier.dispose();
});

test("open 请求：走 /_stream/open，payload 成键出现（undefined 补成 null）", async () => {
  const { carrier, calls, downlink } = newCarrier();
  const { iterator, first, opened } = await startStream(carrier, calls, downlink, { endpoint: "session/follow", payload: undefined });
  assert.equal(opened.url, new URL(STREAM_PATH_OPEN.replace(/^\//, ""), BASE).toString());
  assert.ok(Object.hasOwn(opened.body, "payload"));
  assert.equal(opened.body.payload, null);
  assert.equal(opened.body.endpoint, "session/follow");
  downlink().end();
  assert.deepEqual(await first, { value: undefined, done: true });
  void iterator.return?.();
  carrier.dispose();
});

test("end 帧是正常收尾：done，且不补发 cancel", async () => {
  const { carrier, calls, downlink } = newCarrier();
  const { iterator, first, down } = await startStream(carrier, calls, downlink);
  down.item({ seq: 1 });
  assert.deepEqual(await first, { value: { seq: 1 }, done: false });
  const next = iterator.next();
  down.end();
  assert.deepEqual(await next, { value: undefined, done: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.url.endsWith(STREAM_PATH_CANCEL)).length, 0);
  carrier.dispose();
});

test("一批帧一起到达：逐项交出，最后 done（消费端没在等也不丢）", async () => {
  const { carrier, calls, downlink } = newCarrier();
  const { iterator, first, down } = await startStream(carrier, calls, downlink);
  down.item({ seq: 1 });
  down.item({ seq: 2 });
  down.end();
  assert.deepEqual(await first, { value: { seq: 1 }, done: false });
  assert.deepEqual(await iterator.next(), { value: { seq: 2 }, done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  carrier.dispose();
});

test("外部信号中止：交出中止原因，并向对端发 cancel", async () => {
  const { carrier, calls, downlink } = newCarrier();
  const controller = new AbortController();
  const { first } = await startStream(carrier, calls, downlink, { signal: controller.signal });
  controller.abort(new Error("换了会话"));
  const error = await rejection(first);
  assert.equal(error.message, "换了会话");
  await waitFor(() => calls.some((call) => call.url.endsWith(STREAM_PATH_CANCEL)));
  carrier.dispose();
});

test("上行：项经 /_stream/item，半关经 /_stream/end", async () => {
  const { carrier, calls, downlink } = newCarrier();
  async function* uplink() {
    yield { delta: "a" };
    yield { delta: "b" };
  }
  const iterator = carrier.openStream("$events", { args: {} }, undefined, uplink())[Symbol.asyncIterator]();
  const first = iterator.next();
  await waitFor(() => downlink() !== null);
  await waitFor(() => calls.filter((call) => call.url.endsWith(STREAM_PATH_ITEM)).length === 2);
  const items = calls.filter((call) => call.url.endsWith(STREAM_PATH_ITEM)).map((call) => call.body.value);
  assert.deepEqual(items, [{ delta: "a" }, { delta: "b" }]);
  await waitFor(() => calls.some((call) => call.url.endsWith(STREAM_PATH_END)));
  downlink().end();
  assert.deepEqual(await first, { value: undefined, done: true });
  carrier.dispose();
});

test("dispose 是页面收尾，不是载体丢失：终态错、无 carrier 标记", async () => {
  const { carrier, calls, downlink } = newCarrier();
  const { first } = await startStream(carrier, calls, downlink);
  carrier.dispose();
  const error = await rejection(first);
  assert.equal(error.message, "DSH stream carrier disposed");
  assert.equal(error[MARK], undefined);
});

test("开流前就已被收尾：open 直接以载体失败拒绝", async () => {
  const { carrier } = newCarrier();
  carrier.dispose();
  const error = await rejection(carrier.openStream("$events", {}, undefined)[Symbol.asyncIterator]().next());
  assert.deepEqual(error[MARK], { kind: "carrier" });
});

test("老宿主没有这条路（open 回 404）：按载体失败收场，不装成功", async () => {
  const carrier = createStreamCarrier({
    resolve: (pathname) => new URL(String(pathname).replace(/^\//, ""), BASE),
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  const error = await rejection(carrier.openStream("$events", {}, undefined)[Symbol.asyncIterator]().next());
  assert.match(error.message, /HTTP 404/);
  assert.deepEqual(error[MARK], { kind: "carrier" });
});

test("流 id 跨面唯一：两个载体实例的 id 不重叠（同一个 runtime 被多面共用）", async () => {
  // 宿主那张在途流表是按受管 runtime 的，而主卡与流卡各是一份文档、各自装配一份注入代码。
  // 只用自增序号的话，第二个面的 hana-1 永远撞上第一个面那条长命的 $events（宿主答 409）。
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const { carrier, calls, downlink } = newCarrier();
    const { iterator, first } = await startStream(carrier, calls, downlink);
    ids.push(calls.find((call) => call.url.endsWith(STREAM_PATH_OPEN)).body.streamId);
    downlink().end();
    assert.deepEqual(await first, { value: undefined, done: true });
    void iterator.return?.();
    carrier.dispose();
  }
  assert.notEqual(ids[0], ids[1], "两个面铸的 id 必须不同");
  assert.match(ids[0], /^hana-[a-z0-9]+-1$/);
});
