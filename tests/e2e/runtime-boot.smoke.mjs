// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/e2e/runtime-boot.smoke.mjs — dsh-host 离线 boot / preflight 冒烟（开发者本机验证用，
// 不属 node --test 默认集——文件名不匹配 *.test.*）
//
// 目的：没有真实 Hana 宿主时尽量验证受管 runtime 子进程的两条路径：
//   boot 模式（默认）：定位 DSH → profile 种子化 → runProfile → webserver 真实监听 → 起中继
//   preflight 模式（--preflight）：只验证目标 DSH_HOME 可用性（数据源切换探针），不 boot
// 用本仓库 node_modules 作 depsRoot（替代随包物化），dataDir 指向临时目录；@dshana 子插件由
// build:cordis 落进仓库的 node_modules/@dshana（仓库树扮演安装树，与出包后同形）；profile 用官方
// 随附的 web（DSH 首次加载时自建），我们的 roster patch 由 runtime 经 patchFiles 传入
// （仓库形态下 installRoot = <repo>/dist，即 dist/cordis.patch.yml）。
// 经 child_process.fork 建立 IPC 通道（满足 connectAppRuntime 的 process.send 前置）。
// 就绪判据（boot）= 中继端口对 http://127.0.0.1:<bridgePort>/ 有 HTTP 应答（无 key 得 403 也算
// 「有服务在听」；中继只在 DSH 就绪后才起，故等价于就绪门）。真机验收仍须装包后由主上下文做。
//
// 用法（仓库根，先 node src/build.ts && node src-cordis/build.ts）：
//   node tests/e2e/runtime-boot.smoke.mjs [--keep] [--preflight] [--packed]
// 环境（缺省已指向本仓库）：DSH_REPO_ROOT、DSH_DATA_DIR、DSH_DEPS_ROOT、
//   DSH_SMOKE_TIMEOUT_MS、DSH_PACKED_APP_DIR、HANA_HOME
//
// --packed：把来源换成**装好的 App 树**（安装目录的 node_modules / cordis / runtime 入口），
// 验的是随包物化后的产物本身。DSH 版本 bump、重新装包之后先跑它一遍——仓库树能过不代表装好
// 的树能过（0.1.6 那次 profile-boot 就是只在装好的树里不合格：哈希产物被压缩，导出名全丢）。
import { fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.DSH_REPO_ROOT || join(here, "..", ".."));
const KEEP = process.argv.includes("--keep");
const PREFLIGHT = process.argv.includes("--preflight");
const PACKED = process.argv.includes("--packed");
const appDir = PACKED ? resolvePackedAppDir() : null;
// 缺省数据目录：--packed 放到本仓库之外。真机上 profile 住在 <DSH_HOME>/profiles/<名>，向上 node
// 解析走不到安装树的 node_modules，子插件只能靠被选中 bundle 的依赖图进解析代；数据目录留在仓库里
// 会向上撞见 <repo>/node_modules/@dshana，把这条路径整个盖住（历史误报的来源）。仓库形态（非 packed）
// 没有那份 bundle 依赖声明，只能留在仓库内、靠仓库树自己扮演安装树。
const dataDir = resolve(
  process.env.DSH_DATA_DIR ||
  (appDir ? join(tmpdir(), `dshana-smoke-${process.pid}`) : join(REPO, ".tmp", "smoke-data")),
);
const depsRoot = resolve(process.env.DSH_DEPS_ROOT || join(appDir || REPO, "node_modules"));
const entry = appDir ? join(appDir, "runtime", "dsh-host.mjs") : join(REPO, "dist", "runtime", "dsh-host.mjs");
const READY_TIMEOUT_MS = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 180000);

/**
 * 装好的 App 树（--packed）：HANA_HOME 下的 apps/<id>，或用 DSH_PACKED_APP_DIR 直接点名。
 * @returns 绝对路径；入口文件不在时直接报错（别把“App 没装”误读成“服务没连上”）。
 */
function resolvePackedAppDir() {
  const home = process.env.HANA_HOME || join(homedir(), ".hanako");
  const dir = resolve(process.env.DSH_PACKED_APP_DIR || join(home, "apps", "dshana"));
  const marker = join(dir, "runtime", "dsh-host.mjs");
  if (!existsSync(marker)) {
    throw new Error("--packed 指向的 App 树里没有 " + marker + "（用 DSH_PACKED_APP_DIR 或 HANA_HOME 指定，先确认 App 已安装）");
  }
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opaque = (n = 24) => randomBytes(n).toString("base64url");

async function probeOk(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/", { signal: AbortSignal.timeout(1500) });
    return res.status >= 200 && res.status < 600;
  } catch {
    return false;
  }
}

/** 写私有运行时配置文件（0600）；返回路径。argv[1] 是子进程唯一入参。 */
function writeConfig(payload) {
  const dir = join(dataDir, "integration");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `smoke-${opaque(8)}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return file;
}

function forkEntry(configPath) {
  console.log("[smoke] mode=" + (PREFLIGHT ? "preflight" : "boot") + (PACKED ? " source=packed" : " source=repo"));
  console.log("[smoke] entry=" + entry);
  console.log("[smoke]   dataDir=" + dataDir + "\n  depsRoot=" + depsRoot);
  const child = fork(entry, [configPath], {
    stdio: ["ignore", "inherit", "inherit", "ipc"], // 子进程日志直接进本进程 stdout/stderr
    env: { ...process.env },
  });
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    console.log("[smoke] child exit code=" + code + " signal=" + (signal || ""));
  });
  return { child, exit: () => exit };
}

async function stopChild(child, exitOf) {
  try {
    if (exitOf() === null) child.kill("SIGTERM");
  } catch {
    /* 已退出 */
  }
  for (let i = 0; i < 40 && exitOf() === null; i++) await sleep(250);
  if (exitOf() === null) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    await sleep(300);
  }
}

async function runBoot() {
  const bridgePort = randomInt(38000, 52000);
  let dshPort = randomInt(38000, 52000);
  while (dshPort === bridgePort) dshPort = randomInt(38000, 52000);
  const configPath = writeConfig({
    dataDir,
    dshHome: join(dataDir, ".dsh"),
    dshPort,
    bridgePort,
    bridgeKey: opaque(),
    controlKey: opaque(),
    readyMarker: "SMOKE_READY:" + opaque(12),
    depsRoot,
  });
  const { child, exit } = forkEntry(configPath);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ok = false;
  while (Date.now() < deadline) {
    if (exit() !== null) break;
    if (await probeOk(bridgePort)) { ok = true; break; }
    await sleep(500);
  }
  if (ok) console.log("[smoke] BOOT_OK：中继端口 " + bridgePort + " 有 HTTP 应答（DSH 已就绪）");
  else console.log("[smoke] BOOT_FAIL：" + (exit() ? "子进程提前退出" : "等待超时（" + Math.round(READY_TIMEOUT_MS / 1000) + "s）"));
  await stopChild(child, exit);
  // 成功判据 = 就绪探测通过。收尾用 SIGTERM 杀子进程，exit.code 为 null / signal=SIGTERM 属预期，不算失败。
  return ok;
}

async function runPreflight() {
  const resultPath = join(dataDir, "integration", "preflight-" + opaque(8) + ".json");
  const configPath = writeConfig({
    dataDir,
    dshHome: join(dataDir, ".dsh"),
    preflight: true,
    resultPath,
    depsRoot,
  });
  const { child, exit } = forkEntry(configPath);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && exit() === null) await sleep(200);
  await stopChild(child, exit);
  let result = null;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch (e) {
    console.log("[smoke] PREFLIGHT_FAIL：结果文件不可读（" + ((e && e.message) || e) + "）");
    return false;
  }
  if (result && result.ok) {
    console.log("[smoke] PREFLIGHT_OK：目标 DSH_HOME 可用 " + (result.dshHome || ""));
    return true;
  }
  console.log("[smoke] PREFLIGHT_FAIL：" + ((result && result.error) || "未知原因"));
  return false;
}

async function main() {
  mkdirSync(dataDir, { recursive: true });
  const ok = PREFLIGHT ? await runPreflight() : await runBoot();
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  console.log("[smoke] exit=" + (ok ? "ok" : "fail"));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke] error:", e);
  process.exit(2);
});
