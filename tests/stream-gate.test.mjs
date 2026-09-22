// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/stream-gate.test.mjs — 中继闸门（带票的流只在对应任务活跃时建/留）
//
// 背景：会话流卡把「钉住的会话 + 对应的宿主任务」带到 mux URL 上（dshanaSid / dshanaTask），
// 中继按票问「这个任务还活跃吗」：活 = 放行并定期复查；失活 = 拒建，并把已建的活流断开（1008）。
// 本测钉住三条：① 票面参数被取走（不上上游）；② 失活拒建、活跃放行、无票不闸；
// ③ 流建立之后任务转失活 → 复查断开活流，且此后拒建。
// 用最小假上游（只回 101 握手）+ 裸 socket 客户端，不起真 DSH。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import { startDshBridge, readGateTicket, gateToken } from "../src/runtime/bridge.ts";

const KEY = "hana-test-bridge-key";

/** 最小上游：只做 WS 握手（101），不理会帧语义。 */
async function startUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"] || "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

/** 收假上游：先断所有连接再 close（裸 socket 会半开，不等它自己走）。 */
async function stopUpstream(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
}

/** 裸 socket 客户端：发一次 WS 升级（凭据走路径票据 `/_hana/<key>/`，与真机同形），
 *  回第一段字节（101 = 放行；空 = 被拒/断开）。 */
function upgrade(port, path) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /_hana/${KEY}${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        + `Sec-WebSocket-Key: ${Buffer.from("hanatestnonce").toString("base64")}\r\n`
        + "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let head = "";
    let settled = false;
    const done = (state) => {
      if (settled) return;
      settled = true;
      resolve({ socket, head, state });
    };
    socket.on("data", (d) => {
      head += d.toString("latin1");
      if (!settled) done("data");
    });
    socket.on("error", () => done("error"));
    socket.on("close", () => done("close"));
  });
}

test("readGateTicket: 取走票面参数，无票返回 null", () => {
  const q = new URLSearchParams("dshanaMuxChunks=1&dshanaSid=session-1&dshanaTask=task-1&keep=2");
  assert.deepEqual(readGateTicket(q), { sessionId: "session-1", taskId: "task-1" });
  assert.equal(q.get("dshanaSid"), null, "票面参数要从查询串里取走（不上上游）");
  assert.equal(q.get("dshanaTask"), null);
  assert.equal(q.get("keep"), "2", "别人的参数不动");
  assert.equal(q.get("dshanaMuxChunks"), "1");

  assert.equal(readGateTicket(new URLSearchParams("")), null, "无票 = 不闸的页面");
  assert.deepEqual(readGateTicket(new URLSearchParams("dshanaSid=session-1")), { sessionId: "session-1", taskId: "" });
  assert.equal(gateToken({ sessionId: "s", taskId: "t" }), "t", "同一任务的流共用一条令牌");
  assert.equal(gateToken({ sessionId: "s", taskId: "" }), "s");
  assert.equal(gateToken(null), "");
});

test("闸门：失活拒建、活跃放行、无票不闸", async () => {
  const up = await startUpstream();
  const asked = [];
  const bridge = await startDshBridge({
    port: 0,
    bridgeKey: KEY,
    upstreamOrigin: `http://127.0.0.1:${up.port}`,
    gateRecheckMs: 50,
    gate: (t) => {
      asked.push(t);
      return t.taskId !== "task-dead";
    },
    log: () => {},
  });
  try {
    const dead = await upgrade(bridge.port, "/api/remote.mux?dshanaTask=task-dead&dshanaSid=session-1");
    assert.equal(dead.head.includes("101"), false, "失活的票不该建起流");
    assert.deepEqual(asked[0], { sessionId: "session-1", taskId: "task-dead" }, "票面原样交给判据");
    dead.socket.destroy();

    const live = await upgrade(bridge.port, "/api/remote.mux?dshanaTask=task-live&dshanaSid=session-1");
    assert.equal(live.head.startsWith("HTTP/1.1 101"), true, "活跃的票正常放行");

    const before = asked.length;
    const plain = await upgrade(bridge.port, "/api/remote.mux");
    assert.equal(plain.head.startsWith("HTTP/1.1 101"), true, "无票照旧放行");
    assert.equal(asked.length, before, "无票的流不进闸门判据");

    live.socket.destroy();
    plain.socket.destroy();
  } finally {
    await bridge.close();
    await stopUpstream(up.server);
  }
});

test("闸门：流建立之后任务失活 → 复查断开活流（1008）并拒绝重建", async () => {
  const up = await startUpstream();
  let alive = true;
  const bridge = await startDshBridge({
    port: 0,
    bridgeKey: KEY,
    upstreamOrigin: `http://127.0.0.1:${up.port}`,
    gateRecheckMs: 40,
    gate: () => alive,
    log: () => {},
  });
  try {
    const live = await upgrade(bridge.port, "/api/remote.mux?dshanaTask=task-x");
    assert.equal(live.head.startsWith("HTTP/1.1 101"), true, "先活跃 → 放行");

    // 任务退场：复查（40ms 间隔）应把这条活流以 1008 关闭帧收掉
    const closed = new Promise((resolve) => {
      live.socket.on("data", (d) => {
        if (d[0] === 0x88) resolve("close-frame");
      });
      live.socket.once("close", () => resolve("close"));
    });
    alive = false;
    assert.equal(await closed, "close-frame", "失活的活流收到关闭帧");

    const again = await upgrade(bridge.port, "/api/remote.mux?dshanaTask=task-x");
    assert.equal(again.head.includes("101"), false, "失活后不再建流");
    again.socket.destroy();
  } finally {
    await bridge.close();
    await stopUpstream(up.server);
  }
});
