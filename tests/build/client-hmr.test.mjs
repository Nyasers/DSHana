// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/client-hmr.test.mjs — 集成层 overlay（integrations/client-hmr/files/src/index.ts）的行为
//
// 为什么非得测这条：`/plugins/events` 是 DSH 前端唯一一条会长久静默的普通 HTTP 响应，而链路上
// 每一跳转发都用 undici 的 fetch —— 它的 bodyTimeout 是「响应体空闲 300 秒」计时器（onBody 每来
// 一块刷新），静默即被掐断，浏览器报 ERR_INCOMPLETE_CHUNKED_ENCODING（本机 node 26.8.1 实测
// 306.5 秒）。我们的 delta 就是周期注释心跳：EventSource 跳过注释行，而这几字节把链路各层 fetch
// 的计时器都刷住。本测试按构建的同一条路摊源（上游该包的 src 全量 + 我们的 overlay + stub 掉 bare
// 导入），驱动 host 半，断言心跳真的发、已结束但尚未摘掉的连接被跳过、disposer 之后停。
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UPSTREAM_SRC = join(REPO, "vendor", "deepseek-harness", "packages", "client", "hmr", "src");
const OVERLAY = join(REPO, "integrations", "client-hmr", "files", "src", "index.ts");

/** schemastery 的桩：host 半只在模块加载时建一次 Config schema（一条链式调用），与行为无关。 */
const SCHEMASTERY_STUB = [
  "const chain = () => {",
  "  const api = {};",
  "  for (const k of ['step', 'min', 'max', 'default']) api[k] = () => api;",
  "  return api;",
  "};",
  "export default { number: chain, string: chain, object: (shape) => ({ shape }) };",
  "",
].join("\n");

/**
 * 摊源：上游该包的 src 全量 + 我们的 overlay 盖上（与 scripts/integrations/build.mts 同路）。
 * stub 成 `node_modules/@deepseek-ai/schemastery`，让这份 TS 能被 node 直接 import。
 * @returns {{ entry: string, cleanup: () => void }}
 */
function stageHostHalf() {
  const root = mkdtempSync(join(tmpdir(), "hana-client-hmr-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // 上游该目录另有 invariant.ts（client 半用），host 半只依赖 events.ts。
  copyFileSync(join(UPSTREAM_SRC, "events.ts"), join(root, "src", "events.ts"));
  copyFileSync(OVERLAY, join(root, "src", "index.ts"));
  const stub = join(root, "node_modules", "@deepseek-ai", "schemastery");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "@deepseek-ai/schemastery", type: "module", main: "index.js" }));
  writeFileSync(join(stub, "index.js"), SCHEMASTERY_STUB);
  return { entry: join(root, "src", "index.ts"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 假的 ServerResponse：只记写入的行，别的都是上游用得到的空壳。 */
function fakeResponse() {
  return {
    lines: [],
    status: null,
    headers: null,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    write(line) { this.lines.push(line); return true },
    on() { return this },
    destroy() { this.destroyed = true; return this },
    end() { this.writableEnded = true; return this },
  };
}

/**
 * 假的 cordis 上下文：host 半只碰 effect / webServer.register / clientModules 与 logger。
 * @returns {{ ctx: object, route: object, disposeAll: () => void }}
 */
function fakeCtx() {
  const route = { registered: null, handler: null };
  const cleanups = [];
  return {
    route,
    disposeAll: () => { for (const fn of cleanups.splice(0)) fn() },
    ctx: {
      logger: { warn() {}, error() {} },
      effect(fn) { cleanups.push(fn()); return () => {} },
      webServer: {
        register(entry) {
          route.registered = { kind: entry.kind, path: entry.path };
          route.handler = entry.handler;
          return () => { route.handler = null };
        },
      },
      clientModules: {
        entries: [],
        graph: () => ({ entries: [] }),
        artifactBaseline: () => undefined,
        onGraphChanged: () => () => {},
        onRebuilt: () => () => {},
        rebuilt: () => {},
      },
    },
  };
}

/** 起一个 host 半实例（摊源 + import + apply）。 */
async function startHostHalf(t, { pollIntervalMs = 1_000 } = {}) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const staged = await import(pathToFileURL(stageHostHalf().entry).href);
  const { ctx, route, disposeAll } = fakeCtx();
  staged.apply(ctx, { pollIntervalMs });
  return { staged, ctx, route, disposeAll };
}

test("host 半：开通道写注释与当前图，随后每 20 秒一条注释心跳", async (t) => {
  const { route, disposeAll, staged } = await startHostHalf(t);
  assert.equal(staged.name, "client-hmr");
  assert.deepEqual(staged.inject, ["clientModules", "webServer"]);
  assert.deepEqual(route.registered, { kind: "exact", path: "/plugins/events" });

  const res = fakeResponse();
  route.handler({ method: "GET" }, res);
  assert.deepEqual(res.lines, [
    ": connected\n\n",
    "data: {\"type\":\"graph\",\"graph\":{\"entries\":[]}}\n\n",
  ], "开通道先写一条注释与当前图");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");

  t.mock.timers.tick(19_999);
  assert.equal(res.lines.length, 2, "心跳间隔未到，链路上什么都不发");

  t.mock.timers.tick(1);
  assert.deepEqual(res.lines.slice(2), [": heartbeat\n\n"], "到点发一条注释（EventSource 会跳过它）");

  t.mock.timers.tick(60_000);
  assert.equal(res.lines.length, 6, "每 20 秒一条，持续到连接结束");

  disposeAll();
  assert.equal(res.destroyed, true, "disposer 收掉活连接");
  t.mock.timers.tick(60_000);
  assert.equal(res.lines.length, 6, "disposer 之后不再写");
});

test("host 半：已经结束/已销毁的连接被心跳跳过（close 摘除前的那一瞬）", async (t) => {
  const { route, disposeAll } = await startHostHalf(t);

  const live = fakeResponse();
  const ended = fakeResponse();
  const gone = fakeResponse();
  route.handler({ method: "GET" }, live);
  route.handler({ method: "GET" }, ended);
  route.handler({ method: "GET" }, gone);
  ended.writableEnded = true;
  gone.destroyed = true;

  t.mock.timers.tick(20_000);
  assert.deepEqual(live.lines.slice(2), [": heartbeat\n\n"]);
  assert.deepEqual(ended.lines.slice(2), [], "已结束的响应不再写");
  assert.deepEqual(gone.lines.slice(2), [], "已销毁的响应不再写");
  disposeAll();
});

test("host 半：非 GET/HEAD 仍是 405 且不进连接集", async (t) => {
  const { route, disposeAll } = await startHostHalf(t);
  const res = fakeResponse();
  route.handler({ method: "POST" }, res);
  assert.equal(res.status, 405);
  assert.deepEqual(res.lines, [], "405 不带体，也不入连接集");
  t.mock.timers.tick(60_000);
  assert.deepEqual(res.lines, []);
  disposeAll();
});
