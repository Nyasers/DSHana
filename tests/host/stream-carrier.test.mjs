// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/host/stream-carrier.test.mjs — 远端流载体（runtime 侧）的协议与生命周期
//
// 这一层是页面与内核之间的那段：页面 POST 一条流，载体在本进程内调
// typertGateway.wireStream 并把内核交出的项写成 NDJSON 下行。锁三件事：
//   1) 请求形状（open 的 streamId/endpoint/payload、重复 id、非法方法）；
//   2) 上行与取消确实落到内核那一侧的 inbox 与 signal；
//   3) 收场语义（end 帧、error 帧、断开取消、close 取消在途流）。

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createStreamCarrier } from "@dshana/host/stream-carrier.ts";
import { STREAM_PATH_CANCEL, STREAM_PATH_END, STREAM_PATH_ITEM, STREAM_PATH_OPEN } from "@dshana/shared/stream-carrier.ts";

/** 起一只载体 + 一个真 http 服务，返回调用助手。 */
async function harness(makeStream) {
  const opened = [];
  const aborters = [];
  const carrier = createStreamCarrier({
    open: async (endpoint, payload, uplink, peer, signal) => {
      const stream = makeStream({ endpoint, payload, uplink, peer, signal });
      opened.push({ endpoint, payload, signal, ...stream });
      return stream.source;
    },
    failure: (error) => ({ code: "gateway/test", message: String(error && error.message ? error.message : error), details: {} }),
  });
  const server = createServer((req, res) => {
    void carrier.handle(req, res).then((owned) => {
      if (!owned) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  /** 一条控制请求；不传 signal 时给一个默认信号，收尾时一并中止。 */
  const post = (path, body, signal) => {
    const controller = signal === undefined ? new AbortController() : null;
    if (controller) aborters.push(controller);
    return fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal === undefined ? controller.signal : signal,
    });
  };
  /** 读一行（NDJSON）。 */
  const readLines = async (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const lines = [];
    let buffer = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
    }
    return lines;
  };
  return {
    carrier, opened, post, readLines,
    close: async () => {
      for (const controller of aborters) controller.abort();
      carrier.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 一条永不自己结束的流：只在 signal 中止时收场（内核侧的真实形态）。 */
function endlessSource(signal) {
  return (async function* () {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    yield { after: "abort" };
  })();
}

test("open：内核交出的项逐条写成 NDJSON，收尾以 end 帧结束", async () => {
  const h = await harness(() => ({
    source: (async function* () { yield { seq: 1 }; yield { seq: 2 }; })(),
  }));
  try {
    const response = await h.post(STREAM_PATH_OPEN, { streamId: "s1", endpoint: "$events", payload: { args: {} } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
    const lines = await h.readLines(response);
    assert.deepEqual(lines, [
      { type: "item", value: { seq: 1 } },
      { type: "item", value: { seq: 2 } },
      { type: "end" },
    ]);
    assert.equal(h.opened[0].endpoint, "$events");
    assert.deepEqual(h.opened[0].payload, { args: {} });
  } finally {
    await h.close();
  }
});

test("上行：item 进内核的 inbox，end 半关，cancel 中止 signal", async () => {
  const h = await harness(({ uplink }) => ({
    source: (async function* () {
      for await (const value of uplink) yield { echo: value };
    })(),
  }));
  try {
    const response = await h.post(STREAM_PATH_OPEN, { streamId: "s1", endpoint: "$events", payload: {} });
    const lines = h.readLines(response);
    await h.post(STREAM_PATH_ITEM, { streamId: "s1", value: { delta: "a" } });
    await h.post(STREAM_PATH_ITEM, { streamId: "s1", value: { delta: "b" } });
    await h.post(STREAM_PATH_END, { streamId: "s1" });
    assert.deepEqual(await lines, [
      { type: "item", value: { echo: { delta: "a" } } },
      { type: "item", value: { echo: { delta: "b" } } },
      { type: "end" },
    ]);

    // 第二条：内核侧卡在读 uplink 上，取消必须把它放下来（否则响应会挂到底）。
    const second = await h.post(STREAM_PATH_OPEN, { streamId: "s2", endpoint: "$events", payload: {} });
    const secondLines = h.readLines(second);
    await h.post(STREAM_PATH_CANCEL, { streamId: "s2" });
    assert.equal(h.opened[1].signal.aborted, true);
    assert.deepEqual(await secondLines, []);
  } finally {
    await h.close();
  }
});

test("内核抛错：折成 error 帧（code/message/details 来自 failure）", async () => {
  const h = await harness(() => ({
    source: (async function* () { throw new Error("内核炸了"); })(),
  }));
  try {
    const response = await h.post(STREAM_PATH_OPEN, { streamId: "s1", endpoint: "$events", payload: {} });
    const lines = await h.readLines(response);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "error");
    assert.equal(lines[0].error.code, "gateway/test");
    assert.equal(lines[0].error.message, "内核炸了");
  } finally {
    await h.close();
  }
});

test("请求形状：重复 streamId 409，缺 endpoint 400，非 POST 405，陌生路径不接管", async () => {
  const h = await harness(({ signal }) => ({ source: endlessSource(signal) }));
  try {
    const first = await h.post(STREAM_PATH_OPEN, { streamId: "dup", endpoint: "$events", payload: {} });
    const firstLines = h.readLines(first);
    assert.equal(first.status, 200);
    assert.equal((await h.post(STREAM_PATH_OPEN, { streamId: "dup", endpoint: "$events", payload: {} })).status, 409);
    assert.equal((await h.post(STREAM_PATH_OPEN, { streamId: "x", payload: {} })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${new URL(first.url).port}/_stream/open`)).status, 405);
    assert.equal((await h.post("/something-else", {})).status, 404);
    await h.post(STREAM_PATH_CANCEL, { streamId: "dup" });
    assert.deepEqual(await firstLines, []);
  } finally {
    await h.close();
  }
});

test("close：在途流被取消，内核那侧的 signal 中止", async () => {
  const h = await harness(({ signal }) => ({ source: endlessSource(signal) }));
  try {
    const response = await h.post(STREAM_PATH_OPEN, { streamId: "s1", endpoint: "$events", payload: {} });
    const lines = h.readLines(response);
    assert.equal(h.carrier.active, 1);
    h.carrier.close();
    assert.equal(h.opened[0].signal.aborted, true);
    assert.equal(h.carrier.active, 0);
    assert.deepEqual(await lines, []);
  } finally {
    await h.close();
  }
});

test("中继剥前缀后交路径：带 /_hana/<key>/ 的请求也要落到载体", async () => {
  // 回归锁：中继在鉴权时剥掉 /_hana/<key>/，而 req.url 上还带着它。载体若从 req.url 自己重解路径，
  // 会把自身路径认成不归它管，既不分流也不回响应，请求就挂在那里。
  const opened = [];
  const carrier = createStreamCarrier({
    open: async (endpoint) => {
      opened.push({ endpoint });
      return (async function* () { yield { ok: true }; })();
    },
    failure: () => ({ code: "gateway/test", message: "x", details: {} }),
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname.replace(/^\/_hana\/[^/]+/, "") || "/";
    void carrier.handle(req, res, pathname).then((owned) => { if (!owned) { res.writeHead(404); res.end(); } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/_hana/KEY`;
  try {
    const response = await fetch(base + "/_stream/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ streamId: "s1", endpoint: "$events", payload: { args: {} } }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"type":"item"/);
    assert.equal(opened[0].endpoint, "$events");
  } finally {
    carrier.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
