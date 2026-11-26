// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/host/bridge-control.test.mjs — packages/host/src/bridge.ts 的凭据与控制面契约（真起 http/socket）
// 覆盖：bridgeKey 与 controlKey 互不通用、失败动作回 409 + 可读原因、控制请求体上限、
// WS 升级握手头不被剥离（剥了就握手不上，浏览器事件流整条连不通）。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { startDshBridge } from "@dshana/host/bridge.ts";

const KEY = "bridge-key-0123456789abcdef";
const CONTROL = "control-key-0123456789abcdef";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** 最小上游：HTTP 200 + 可选 WS 握手（校验 sec-websocket-key 后才 101）——用来证明中继没剥握手头。 */
async function startUpstream(opts = {}) {
  const hits = { get: 0, post: 0 };
  const sockets = new Set(); // 升级后的 socket 不受 server.closeAllConnections 管辖，关闭时需自己收
  const server = http.createServer((req, res) => {
    if (req.method === "POST") hits.post++;
    else hits.get++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  server.on("upgrade", (req, socket) => {
    if (!opts.ws) { socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return; }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + createHash("sha1").update(key + GUID).digest("base64") + "\r\n\r\n",
    );
    socket.on("error", () => {});
  });
  const port = await listen(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    server,
    hits,
    origin: "http://127.0.0.1:" + port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function startBridge(upstream, onControl) {
  return startDshBridge({
    port: 0,
    bridgeKey: KEY,
    controlKey: CONTROL,
    upstreamOrigin: upstream.origin,
    upstreamCookie: "dsh=1",
    onControl: onControl || (async (action) => ({ ok: true, action })),
  });
}

async function get(port, path = "/", key = KEY) {
  const res = await fetch("http://127.0.0.1:" + port + path, { headers: key ? { "x-hana-dsh-bridge": key } : {} });
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}

async function control(port, action, key = CONTROL, rawBody) {
  const res = await fetch("http://127.0.0.1:" + port + "/_control", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-hana-dsh-control": key } : {}) },
    body: rawBody === undefined ? JSON.stringify({ action, args: {} }) : rawBody,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("bridge: 数据面与控制面的凭据互不通用", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    assert.equal((await get(bridge.port)).status, 200, "带 bridgeKey 的 GET 应被转发");
    assert.equal((await get(bridge.port, "/", null)).status, 403, "无 key 应 403");
    assert.equal((await get(bridge.port, "/", CONTROL)).status, 403, "controlKey 不得当 bridgeKey 用");

    assert.equal((await control(bridge.port, "rpc")).status, 200, "带 controlKey 的控制请求应放行");
    assert.equal((await control(bridge.port, "rpc", null)).status, 403, "无 controlKey 应 403");
    assert.equal((await control(bridge.port, "rpc", KEY)).status, 403, "bridgeKey 不得当 controlKey 用");
    assert.equal((await control(bridge.port, "rpc", "wrong-key-0000000000000000")).status, 403, "错误 controlKey 应 403");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 动作失败（含未知动作）回 409 + 可读原因，不吞成 200", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream, async (action) => {
    if (action !== "cwd-check") throw new Error("未知控制动作：" + action);
    return { ok: true };
  });
  try {
    const r = await control(bridge.port, "什么动作");
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /未知控制动作/);
    assert.equal((await control(bridge.port, "cwd-check")).status, 200);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 控制请求体超过 256 KiB 被拒（不缓冲成无界内存）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    const huge = JSON.stringify({ action: "rpc", args: { body: "x".repeat(300 * 1024) } });
    const r = await control(bridge.port, "rpc", CONTROL, huge);
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /too large/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 请求体边发边超限 → 仍收到 409（不因中途中断迭代而断连）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    const total = 2 * 1024 * 1024;
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: bridge.port,
        path: "/_control",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hana-dsh-control": CONTROL,
          "content-length": String(total),
        },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      // 分块写：让服务端在请求尚未结束时就越过上限（一次性灌完测不出这个时序）
      const chunk = "x".repeat(64 * 1024);
      let written = 0;
      const pump = () => {
        while (written < total) {
          written += chunk.length;
          if (!req.write(chunk)) { req.once("drain", pump); return; }
        }
        req.end();
      };
      pump();
    });
    assert.equal(result.status, 409, "超限应回可读的 409，而不是连接重置");
    assert.match(result.text, /too large/);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: WS 升级握手头不被剥离（101）", async () => {
  const upstream = await startUpstream({ ws: true });
  const bridge = await startBridge(upstream);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/api/remote.mux?dshBridge=${KEY}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS 升级超时")), 3000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS 升级失败（握手头可能被剥离）")); }, { once: true });
    });
    ws.close();
  } finally {
    await bridge.close();
    await upstream.close();
  }
});
