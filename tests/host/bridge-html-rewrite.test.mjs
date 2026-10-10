// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/host/bridge-html-rewrite.test.mjs — 中继的 HTML 引用相对化（真起 http 服务）
// 覆盖：text/html 的根相对引用被相对化且反向解析回原目标、非 HTML 与错误页原样透传、
// 无 content-length 的流式响应不改、超限不改、改写后 content-length 正确、非 UTF-8 字节透明。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { HTML_REWRITE_MAX_BYTES, isRewritableHtml, startDshBridge } from "@dshana/host/bridge.ts";

const KEY = "{{SECRET_ip0fqq52}}";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** 上游：按路径回不同形态的响应。 */
async function startUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    hits.push(url.pathname);
    if (url.pathname === "/wallpaper-engine/scene-live/index.html") {
      const body =
        '<!doctype html><head>' +
        '<script type="module" src="/wallpaper-engine/scene-live/assets/renderer-A.js"></script>' +
        '<link rel="modulepreload" href="/wallpaper-engine/scene-live/assets/polyfill-B.js">' +
        "</head><body></body>";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    if (url.pathname === "/api/x") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ href: "/should-stay" }));
      return;
    }
    if (url.pathname === "/err.html") {
      const body = '<script src="/from-error-page.js"></script>';
      res.writeHead(500, { "content-type": "text/html", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    if (url.pathname === "/stream.html") {
      // 分块（无 content-length）：不该被读全量改写
      res.writeHead(200, { "content-type": "text/html" });
      res.write('<script src="/streamed.js"></script>');
      res.end();
      return;
    }
    if (url.pathname === "/big.html") {
      const pad = "x".repeat(HTML_REWRITE_MAX_BYTES + 10);
      const body = '<script src="/big.js"></script>' + pad;
      res.writeHead(200, { "content-type": "text/html", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    if (url.pathname === "/gbk.html") {
      // 非 UTF-8 文档（charset=gbk）：中文文件名“中”的 GBK 字节是 D6 D0，整段不是合法 UTF-8。
      // 改写必须字节透明地过手，否则这两个字节会被换成 U+FFFD 再编码成 EF BF BD。
      const body = Buffer.concat([
        Buffer.from('<meta charset="gbk"><img src="/wallpaper-engine/', "latin1"),
        Buffer.from([0xd6, 0xd0]),
        Buffer.from('.png">', "latin1"),
      ]);
      res.writeHead(200, { "content-type": "text/html; charset=gbk", "content-length": String(body.length) });
      res.end(body);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain");
  });
  const port = await listen(server);
  return { server, hits, origin: "http://127.0.0.1:" + port, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * 取一个中继下的响应。
 * 凭据有两种形态，与 authorizeBridgeRequest 一一对应，两者不能同时给：
 *   · header 形态：path 直接就是上游路径（不带前缀）
 *   · 路径票据形态：path 前拼 `/_hana/<key>/`
 */
async function get(port, path, { ticket = false } = {}) {
  const url = "http://127.0.0.1:" + port + (ticket ? "/_hana/" + KEY : "") + path;
  const res = await fetch(url, { headers: ticket ? {} : { "x-hana-dsh-bridge": KEY } });
  return { status: res.status, headers: res.headers, text: await res.text().catch(() => "") };
}

function startBridge(upstream) {
  return startDshBridge({ port: 0, bridgeKey: KEY, upstreamOrigin: upstream.origin, upstreamCookie: "dsh=1" });
}

test("bridge: text/html 的根相对引用被相对化，且解析后仍在卡里", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    const r = await get(bridge.port, "/wallpaper-engine/scene-live/index.html", { ticket: true });
    assert.equal(r.status, 200);
    assert.ok(!/src="\/wallpaper-engine/.test(r.text), "模块脚本 src 不该再是根相对:\n" + r.text);
    assert.ok(!/href="\/wallpaper-engine/.test(r.text), "modulepreload href 不该再是根相对:\n" + r.text);

    // 反验：把改写后的引用按文档的**浏览器侧 URL**（含路径票据前缀）解析，
    // 应回到这张卡的中继前缀下的原目标 —— 这就证明引用没跑到宿主源去。
    const docUrl = "http://127.0.0.1:" + bridge.port + "/_hana/" + KEY + "/wallpaper-engine/scene-live/index.html";
    const src = /src="([^"]+)"/.exec(r.text)[1];
    const resolved = decodeURIComponent(new URL(src, docUrl).pathname);
    assert.equal(resolved, "/_hana/" + KEY + "/wallpaper-engine/scene-live/assets/renderer-A.js");

    // content-length 必须与改写后的实体一致（改写改变了字节数）
    assert.equal(Number(r.headers.get("content-length")), Buffer.byteLength(r.text, "utf8"));
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 两种凭据形态都通（header 与路径票据）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    const viaHeader = await get(bridge.port, "/wallpaper-engine/scene-live/index.html");
    const viaTicket = await get(bridge.port, "/wallpaper-engine/scene-live/index.html", { ticket: true });
    assert.equal(viaHeader.status, 200);
    assert.equal(viaTicket.status, 200);
    assert.ok(!/src="\/wallpaper-engine/.test(viaHeader.text), "header 形态也应改写");
    assert.ok(!/src="\/wallpaper-engine/.test(viaTicket.text), "票据形态也应改写");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 非 HTML 原样透传（JSON 里的路径不被碰）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    const r = await get(bridge.port, "/api/x");
    assert.equal(r.status, 200);
    assert.equal(r.text, JSON.stringify({ href: "/should-stay" }));
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 分块 HTML（无 content-length）也要改写", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    // /stream.html 是 chunked 且带根相对引用：这曾经因「要求长度已知」而被整类放行，
    // 而那正是真机上游的形态（插件文档服务发的就是分块）。
    const r = await get(bridge.port, "/stream.html");
    assert.equal(r.status, 200);
    assert.ok(!/src="\//.test(r.text), "分块 HTML 的根相对引用应被改写:\n" + r.text);
    const docUrl = "http://127.0.0.1:" + bridge.port + "/stream.html";
    const src = /src="([^"]+)"/.exec(r.text)[1];
    assert.equal(decodeURIComponent(new URL(src, docUrl).pathname), "/streamed.js");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 错误页不改写（非 200）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    const err = await get(bridge.port, "/err.html");
    assert.equal(err.status, 500);
    assert.ok(err.text.includes('src="/from-error-page.js"'), "非 200 的 HTML 不该改:\n" + err.text);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 超限 HTML 不改写（避免把大响应整段缓冲）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    const r = await get(bridge.port, "/big.html");
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('src="/big.js"'), "超限不该改");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 非 UTF-8（charset=gbk）的 HTML 改写后字节保真", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    // 取原始字节而非 text（text 会按 UTF-8 解码，看不到字节层的事实）
    const res = await fetch("http://127.0.0.1:" + bridge.port + "/gbk.html", {
      headers: { "x-hana-dsh-bridge": KEY },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.equal(Number(res.headers.get("content-length")), buf.length, "content-length 该按改写后字节数");
    // 中文那两字节必须原样，不能被换成 U+FFFD 的编码（EF BF BD）
    assert.ok(buf.includes(Buffer.from([0xd6, 0xd0])), "GBK 字节应原样保留：" + buf.toString("hex"));
    assert.ok(!buf.includes(Buffer.from([0xef, 0xbf, 0xbd])), "不该出现替换字符：" + buf.toString("hex"));
    // 引用照常被相对化
    assert.ok(buf.toString("latin1").includes('src="./wallpaper-engine/'), "引用该被相对化：" + buf.toString("latin1"));
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("isRewritableHtml：判据边界（不要求 content-length）", () => {
  const h = (ct) => new Headers(ct ? { "content-type": ct } : {});
  assert.equal(isRewritableHtml(h("text/html"), "/a.html"), true);
  assert.equal(isRewritableHtml(h("text/html; charset=utf-8"), "/a.html"), true);
  assert.equal(isRewritableHtml(h("application/json"), "/a.html"), false);
  assert.equal(isRewritableHtml(h("text/plain"), "/a.html"), false);
  assert.equal(isRewritableHtml(h("text/html"), "no-slash"), false);
  // 无 content-type 时应判否（不为未知类型去缓冲）
  assert.equal(isRewritableHtml(h(null), "/a.html"), false);
});
