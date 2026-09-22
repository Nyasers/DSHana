// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/dev/install-local.mts — 把本地打好的 zip 装进宿主（开发循环用）
//
// 走宿主自己的扩装面（与界面里「安装本地包」同一条）：
//   DELETE /api/extensions/app:<id>
//   → POST /api/extensions/install（source = { type: "local", path }）
//   → POST /api/extensions/staged/<stagedId>/confirm
//   → 轮询 App 的 boot-state 到 phase=ready
// 宿主的地址与令牌取自 <HANA_HOME>/server-info.json（{ port, token }）——HANA_HOME 缺省
// 是 ~/.hanako，可用 --home 或环境变量 HANA_HOME 覆盖。
//
// 为什么不用 shell 脚本：这条循环每次改完都要走一遍，跨平台 + 能直接读 SHA/包大小/版本，
// 比在每个平台上各养一份 ps1/sh 划算。
//
// 用法：node scripts/dev/install-local.mts --zip releases/<包>.zip [--id dshana] [--home <HANA_HOME>]
//        [--no-uninstall] [--timeout <秒>] [--quiet]
// 退出码：0 = 安装完成且 runtime 就绪；1 = 任一步骤失败或超时；2 = 参数/环境问题。

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { errText } from "../shared/err-text.mts";
// 仅为加载 Node 版本断言（本入口以 TypeScript 直跑，依赖原生类型剥离；仓库纪律：每个 CLI 入口都得触达它）
import "../shared/root.mts";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

/** 参数/环境问题（退出码 2）或运行失败（退出码 1）。return 类型是 never：调用点靠它完成收窄。 */
function fail(code, message): never {
  console.error("[install-local] " + message);
  process.exit(code);
}

const zipArg = value("--zip");
if (!zipArg) fail(2, "缺 --zip <包路径>（用法见本文件头注释）");
const zip = resolve(zipArg);
if (!existsSync(zip)) fail(2, "包不存在：" + zip);
const appId = value("--id") || "dshana";
const home = resolve(value("--home") || process.env.HANA_HOME || join(homedir(), ".hanako"));
const uninstallFirst = !flag("--no-uninstall");
const quiet = flag("--quiet");
const readyTimeoutSec = Number(value("--timeout") || 600);

const infoPath = join(home, "server-info.json");
if (!existsSync(infoPath)) fail(2, "找不到 " + infoPath + "（宿主没在跑？）");
const info = JSON.parse(readFileSync(infoPath, "utf8"));
if (!info || typeof info.port !== "number" || typeof info.token !== "string") {
  fail(2, infoPath + " 形状不对（需要 { port, token }）");
}
const base = "http://127.0.0.1:" + info.port;
const log = (...args) => { if (!quiet) console.log("[install-local]", ...args); };

/**
 * 一次宿主 API 调用。
 * @param {string} method HTTP 方法。
 * @param {string} path 路径（以 / 开头）。
 * @param {unknown} [body] JSON 体。
 * @param {number} [timeoutMs] AbortSignal 超时。
 * @returns {Promise<any>} 解析后的 JSON。
 */
async function api(method, path, body, timeoutMs = 1800000): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: "Bearer " + info.token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样带回 */ }
  if (!res.ok) {
    const detail = parsed ? JSON.stringify(parsed) : text.slice(0, 400);
    throw new Error(method + " " + path + " → HTTP " + res.status + "：" + detail);
  }
  return parsed;
}

/** zip 的 SHA256 与字节数（流式，166 MB 也不吃内存）。 */
function digest(path) {
  return new Promise((ok, no) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", no);
    stream.on("end", () => ok(hash.digest("hex").toUpperCase()));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bytes = statSync(zip).size;
  const sha = await digest(zip);
  log("包：" + zip);
  log("  大小 " + bytes.toLocaleString("en-US") + " 字节 · SHA256 " + sha);

  if (uninstallFirst) {
    log("1/4 卸载旧版 …");
    const removed = await api("DELETE", "/api/extensions/app:" + appId, undefined, 300000);
    log("  卸载 ok=" + String(removed && removed.ok === true));
  } else {
    log("1/4 跳过卸载（--no-uninstall）");
  }

  log("2/4 提交 staging（本地包要解包，慢是正常的）…");
  const staged = await api("POST", "/api/extensions/install", {
    kind: "app",
    source: { type: "local", path: zip },
  });
  const stagedId = staged && staged.staged && staged.staged.stagedId;
  if (typeof stagedId !== "string" || !stagedId) {
    throw new Error("提交后没拿到 stagedId：" + JSON.stringify(staged).slice(0, 400));
  }
  log("  status=" + staged.status + " stagedId=" + stagedId + " version=" + staged.staged.version
    + " warnings=" + (Array.isArray(staged.staged.warnings) ? staged.staged.warnings.length : 0));

  log("3/4 确认安装 …");
  const confirmed = await api("POST", "/api/extensions/staged/" + stagedId + "/confirm", undefined, 900000);
  log("  status=" + confirmed.status + " version=" + confirmed.record.version);

  log("4/4 等 runtime 就绪（最多 " + readyTimeoutSec + " 秒）…");
  const deadline = Date.now() + readyTimeoutSec * 1000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await sleep(attempt === 1 ? 2000 : 5000);
    // boot-state 形状由 App 侧决定（phase/ready/service/error/note），这里只做转发展示。
    let state: any = null;
    try {
      const boot = await api("GET", "/api/apps/" + appId + "/routes/" + appId + "/boot-state", undefined, 20000);
      state = boot && boot.state ? boot.state : null;
    } catch (e) {
      log("  第 " + attempt + " 次：boot-state 取不到（" + errText(e) + "）");
    }
    if (state) {
      log("  第 " + attempt + " 次：phase=" + state.phase + " ready=" + state.ready
        + " port=" + (state.service && state.service.port ? state.service.port : "-")
        + (state.error ? " error=" + JSON.stringify(state.error).slice(0, 200) : ""));
      if (state.ready === true) {
        log("就绪：" + (state.note || ""));
        return;
      }
      if (state.phase === "error") {
        log("note：" + (state.note || ""));
        throw new Error("runtime 落到 error：" + JSON.stringify(state.error));
      }
    }
    if (Date.now() > deadline) throw new Error("等待就绪超时（" + readyTimeoutSec + "s）");
  }
}

main().then(
  () => { log("完成。"); },
  (e) => fail(1, "失败：" + ((e && e.message) || e)),
);
