// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/main.ts — dshana 受管 Node runtime 入口主体
//
// 打包产物：dist/runtime/dsh-host.mjs（rspack ESM bundle）。宿主以 ctx.runtime.start({ runtime:
// "node", entry: "runtime/dsh-host.mjs", ... }) 拉起，本进程自持生命周期，不回宿主进程。
//
// 职责：
//   1. 解析 App 自有配置（唯一 argv = 私有运行时配置文件路径，0600，启动即删；schema 见
//      options.js）——字段与 App 主进程 lib/managed-runtime.js buildRuntimeConfig() 对偶一致
//      （凭据/端口不经 argv、环境变量、日志）；
//   2. connectAppRuntime() 连宿主（tasks/models/network.fetch/close）；无父 IPC fd 时给可
//      操作报错 + 退出码 3，绝不假装能跑；
//   3. 设本进程自有 env（DSH_HOME / DSHANA_*，不污染宿主进程环境）；
//   4. 依赖就位（随包物化在 <installRoot>/node_modules，无运行时安装）；
//   5. 产物在位（@dshana 子插件在 <installRoot>/node_modules/@dshana，roster patch 在
//      <installRoot>/cordis.patch.yml——profile 不归我们：官方 web 模板由 DSH 首次加载时自建）；
//   6. 子进程内 boot DSH（locateDsh → appBoot.loadLayeredEnv → profileBoot.runProfile，
//      profile = 官方 web + patchFiles = roster patch），webserver 监听配置中的 dshPort；
//   7. 真实监听成功（webServer 服务端口 === 期望端口 + HTTP 探测）才向 stdout 打印约定
//      readyMarker（独占一行、无前缀）——任何失败路径绝不打印 READY；
//   8. SIGTERM/SIGINT/父进程 disconnect → 优雅释放：先关 DSH fiber（含 webserver），再
//      hana.close()。顺序纪律：拿到流式 Response 后不能立刻 close()——hana.close() 只在退出前
//      调用；接活动流后需先结束/取消流再关闭。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { parseRuntimeConfig, UsageError, USAGE } from "#/runtime/options.ts";
import { startDshBridge } from "#/runtime/bridge.ts";
import { checkCwd } from "#/runtime/cwd-check.ts";
import { info, warn, err } from "#/runtime/log.ts";
import { runtimeErrorState } from "#/lib/runtime-error.ts";
// @hana/app-sdk 为 devDependencies（file:vendor/hana-app-sdk/hana-app-sdk.tgz，版本随宿主
// 0.946.2 App 契约）；connectAppRuntime 运行时实现经 rspack 构建时静态内联进本 bundle（只
// 依赖 node:crypto，无运行时包解析——见 rspack.config.mts 打包纪律注释）。升级 = 换 vendor
// 里的 sdk tgz + pnpm install + 重建。
import { connectAppRuntime } from "@hana/app-sdk";
import { startTaskBridge } from "#/runtime/task-bridge.ts"; // DSH 事件 → Hana task 回投
import { startApprovalBridge } from "#/runtime/approval-bridge.ts"; // DSH 审批 → Hana requestApproval / watch 对账
import { createTaskBindingIndex, publishTaskBindingIndex } from "#/lib/task-binding.ts"; // 绑定事实源 = 宿主任务记录
import { recordIsTerminal, TERMINAL_STATUSES } from "#/lib/watch-sse.ts"; // 闸门判据：宿主任务终态
import { PROVIDER_RELOAD_GLOBAL_KEY } from "#/lib/provider-hooks.ts"; // 目录重载钩子键（provider 插件装）
import { resolveInstallRoot, locateDsh } from "#/runtime/locate.ts";

/** 退出码约定（App 主进程 managed-runtime.js classify 读 exitCode 归类；勿随意改）。 */
export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  IPC_UNAVAILABLE: 3,
  DEPS: 4,
  SEED: 5,
  BOOT: 6,
  PORT: 7,
  DISCONNECT: 8,
};

/** 就绪等待上限（v1 PORT_READY_TIMEOUT_MS 同量级；boot 已完成后的监听/探测窗口）。 */
export const READY_TIMEOUT_MS = 60000;
/** 优雅释放时 ctx.fiber.dispose 的最长等待（超时强退；dsh 自身 shutdown 5s 兜底）。 */
const DISPOSE_TIMEOUT_MS = 4000;
const PROFILE_NAME = "web";

/** 取错误的可读文本。catch 到的值类型未知，字段访问一律经这里。 */
const errText = (e: unknown): string => ((e as any)?.message as string) || String(e);

/** 中继句柄（startDshBridge 的产物）。 */
type BridgeHandle = Awaited<ReturnType<typeof startDshBridge>>;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** webServer service 的实际监听端口读回（listen 显式端口后 service.port = 实际端口）。 */
function resolveSvcPort(svc) {
  try {
    if (svc && typeof svc.port === "number" && svc.port > 0) return svc.port;
    const srv = svc && (svc._server || (svc.server && svc.server._server));
    if (srv && typeof srv.address === "function") {
      const a = srv.address();
      if (a && typeof a === "object" && a.port) return a.port;
    }
  } catch {
    /* 读端口失败 */
  }
  return 0;
}

/** HTTP 探测：任意 HTTP 应答（2xx/3xx/4xx/5xx）即视为「有服务在监听」；连接错误返回 false。 */
function probeHttp(port, timeoutMs) {
  return new Promise((resolveProbe) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: timeoutMs, headers: { connection: "close" } },
      (res) => {
        res.resume();
        resolveProbe(true);
      },
    );
    req.on("timeout", () => {
      try { req.destroy(); } catch { /* 已断 */ }
      resolveProbe(false);
    });
    req.on("error", () => resolveProbe(false));
  });
}

/**
 * 等 webServer 真实就绪：① DSH 侧 webServer 服务声称绑定了期望端口（防「别的进程占
 * 端口、探测撞到别人」的虚假 READY——若 DSH bind 失败，其服务端口不会等于期望值）；
 * ② 对 127.0.0.1:<expectedPort>/ 的 HTTP 探测成功。任一不满足即继续等至超时抛错。
 */
async function waitWebReady({ ctx, expectedPort, log }) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastPort = 0;
  for (;;) {
    let port = 0;
    try {
      const svc = typeof ctx.get === "function" ? ctx.get("webServer") : null;
      if (svc) port = resolveSvcPort(svc);
    } catch {
      /* 服务未暴露：继续等 */
    }
    lastPort = port;
    if (port === expectedPort && (await probeHttp(expectedPort, 1200))) return port;
    if (Date.now() >= deadline) {
      throw new Error(
        `DSH webserver 未在期望端口 ${expectedPort} 就绪（webServer 服务端口=${lastPort || "未暴露"}，HTTP 探测失败）。完整运行日志见宿主 runtime 日志。`,
      );
    }
    await sleep(250);
  }
}

/**
 * 有序释放：ctx.fiber.dispose（关 webserver/loader/插件树）→ hana.close()。幂等。
 * 不 await 超过 DISPOSE_TIMEOUT_MS（dsh profile-boot 的 shutdown 控制器还有 5s force
 * exit 兜底，见 locate/profile-boot 注释）。
 */
function makeShutdown(state, exitCodeLog) {
  let done = false;
  return async function shutdown(reason, code) {
    if (done) return;
    done = true;
    info(`shutdown：${reason}（exit ${code}）`);
    const ctx = state.ctx;
    const hana = state.hana;
    // 先停任务桥与审批桥（退订 ctx 事件，防关闭中再触发回投/流消费）再 dispose；
    // 最后撤掉绑定索引的 globalThis 暴露（provider 若仍在跑会得到 BINDING_UNAVAILABLE）。
    for (const key of ["stopBridge", "stopApproval", "stopBindings"]) {
      const fn = state[key];
      if (typeof fn === "function") {
        try {
          fn();
        } catch (e) {
          warn(key + " 退订异常（继续退出）：" + errText(e));
        }
        state[key] = null;
      }
    }
    // 中继关闭（异步；释放监听与在途连接）
    if (state.bridge && typeof state.bridge.close === "function") {
      try {
        await state.bridge.close();
      } catch (e) {
        warn("中继关闭异常（继续退出）：" + errText(e));
      }
      state.bridge = null;
    }
    try {
      // @dshana/provider 等子插件经该句柄取 hana client（见本文件上方子插件钩子说明）
      if (globalThis.__dshanaHana === hana) globalThis.__dshanaHana = null;
    } catch { /* 忽略 */ }
    try {
      if (ctx && ctx.fiber && typeof ctx.fiber.dispose === "function") {
        await Promise.race([
          Promise.resolve().then(() => ctx.fiber.dispose()),
          sleep(DISPOSE_TIMEOUT_MS),
        ]);
      }
    } catch (e) {
      warn("ctx dispose 异常（继续退出）：" + errText(e));
    }
    // 流纪律：拿到流式 Response 后不能立刻 close。本步不消费宿主流；
    // 接入模型/任务流后，此处必须先结束/取消活动流再 close。
    try {
      if (hana && typeof hana.close === "function") hana.close();
    } catch {
      /* close 幂等 */
    }
    state.hana = null;
    state.ctx = null;
    process.exit(code);
  };
}

/**
 * 产物在位检查（fail-closed）：@dshana 子插件与我们的 roster patch 都得在。
 * 缺了就在这里报清楚，而不是等 DSH 自己把「bundle/插件找不到」抛上来。
 * @returns 缺失项（空数组 = 齐备）。
 */
function missingArtifacts(depsRoot: string, rosterPatch: string): string[] {
  const missing: string[] = [];
  for (const name of ["provider", "theme", "clipboard"]) {
    const dir = join(depsRoot, "@dshana", name);
    if (!existsSync(join(dir, "index.js"))) missing.push(dir);
  }
  if (!existsSync(rosterPatch)) missing.push(rosterPatch);
  return missing;
}

/**
 * 预检模式（数据源切换探针）：只验证「依赖就位 → 定位 DSH → 产物在位」能否在目标 DSH_HOME 上
 * 成立，不连宿主 IPC、不 boot DSH、不起中继，也不往目标 home 写任何东西（profile 由 DSH 自己在
 * 首次加载时按随附模板建）。结果写 resultPath（{ok:true} 或 {ok:false,error}，0600）后立即退出。
 * 退出码对齐 classify：0 = 预检通过；4 = deps/locate；5 = 产物缺失。
 */
async function runPreflight({ opts, dataDir, dshHome, depsRoot, rosterPatch }): Promise<never> {
  const write = (payload) => writeFileSync(opts.resultPath, JSON.stringify(payload), { mode: 0o600 });
  try {
    process.env.DSH_HOME = dshHome;
    process.env.DSHANA_HOME = dataDir;
    info(`预检开始：dshHome=${dshHome} depsRoot=${depsRoot}`);
    await locateDsh({ depsRoot, log: (s) => info("locate", s) });
    const missing = missingArtifacts(depsRoot, rosterPatch);
    if (missing.length > 0) {
      err("preflight", "产物不在位：" + missing.join("、"));
      write({ ok: false, error: `目标环境缺产物（先跑 pnpm run build 再打包）：${missing.join("、")}` });
      process.exit(EXIT.SEED);
    }
    info("预检通过（deps + locate + 产物在位；未写目标 home）");
    write({ ok: true, dshHome });
    process.exit(EXIT.OK);
  } catch (e) {
    const text = errText(e);
    err("preflight", "预检失败：" + text);
    try {
      write({ ok: false, error: text });
    } catch (writeErr) {
      err("preflight", "结果文件写入失败（由父侧超时兜底）：" + errText(writeErr));
    }
    process.exit(EXIT.DEPS);
  }
}

/**
 * 主流程（导出便于宿主/测试以不同 argv 调用；正常由 bundle 顶部执行）。
 * @returns 退出码（成功就绪后由信号/断连驱动退出，本函数返回 EXIT.OK）
 */
export async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    opts = parseRuntimeConfig(argv, (p) => readFileSync(p, "utf8"));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(e.message + "\n\n" + USAGE);
      return EXIT.USAGE;
    }
    throw e;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  /**
   * 致命路径统一出口：先把结构化失败报告写到 opts.fatalPath（App 据此把真实成因呈现给
   * 用户，而不是只报退出码（含嵌套 AggregateError 的每一层）），再由各分支继续 err/退出。
   * 报告写失败不影响退出。
   */
  const reportFatal = (kind, error) => {
    if (!opts.fatalPath) return;
    try {
      const message = runtimeErrorState(error).message || String(error);
      const causes = error instanceof AggregateError ? error.errors.map((e) => runtimeErrorState(e).message) : [];
      writeFileSync(opts.fatalPath, JSON.stringify({ ok: false, kind, message, causes, at: new Date().toISOString() }), { mode: 0o600 });
    } catch (e) {
      warn("fatal-report", "写失败报告失败（忽略）：" + errText(e));
    }
  };
  info(opts.preflight
    ? `dsh-host 启动（preflight 预检）：dshHome=${opts.dshHome} dataDir=${opts.dataDir}`
    : `dsh-host 启动（managed node runtime entry）：dshPort=${opts.dshPort} bridgePort=${opts.bridgePort} dataDir=${opts.dataDir}`);

  const entryFile = fileURLToPath(import.meta.url);
  let installRoot;
  try {
    installRoot = resolveInstallRoot(entryFile);
  } catch (e) {
    err("install-root", errText(e));
    reportFatal("install-root", e);
    return EXIT.INTERNAL;
  }
  const dataDir = resolve(opts.dataDir);
  // 依赖根默认指向 App 安装目录（随包物化的 node_modules）；--deps-root 可覆盖（调试）。
  // @dshana 插件与 @deepseek-ai/* 同锚点住在这里（运行时解析模式从安装树算解析代，不建链接），
  // 我们的 roster patch 随包放在安装根（与 manifest.json 并排，经 patchFiles 作启动期 overlay）。
  const depsRoot = resolve(opts.depsRoot || join(installRoot, "node_modules"));
  const rosterPatch = join(installRoot, "cordis.patch.yml");
  const dshHome = opts.dshHome ? resolve(opts.dshHome) : join(dataDir, ".dsh");
  // ---- 0) 预检模式（数据源切换探针）：不连宿主 IPC、不起服务，只验证目标环境可用性 ----
  if (opts.preflight) {
    return await runPreflight({ opts, dataDir, dshHome, depsRoot, rosterPatch });
  }
  const state: {
    hana: any;
    ctx: any;
    stopBridge: (() => void) | null;
    stopApproval: (() => void) | null;
    stopBindings: (() => void) | null;
    bridge: BridgeHandle | null;
  } = { hana: null, ctx: null, stopBridge: null, stopApproval: null, stopBindings: null, bridge: null };
  const shutdown = makeShutdown(state, info);

  // ---- 1) 宿主 IPC（先于一切：非受管运行时立刻给出可操作报错，不输出 READY）----
  let hana: ReturnType<typeof connectAppRuntime> | null = null;
  try {
    hana = connectAppRuntime();
  } catch (e) {
    err(
      "ipc",
      "connectAppRuntime() 失败：" + errText(e) +
      "。本入口只能由 Hana ctx.runtime.start({ runtime: \"node\" }) 启动——宿主在启动该" +
      " Node 进程时经父进程 IPC fd 注入受管通道。直接 node 运行无父 IPC，无法" +
      " 连接宿主 tasks/models/network，退出。",
    );
    reportFatal("ipc", e);
    return EXIT.IPC_UNAVAILABLE;
  }
  state.hana = hana;
  // 受管子进程内子插件经该句柄调用宿主
  // tasks/models/network（connectAppRuntime 的 client 对象；与插件同进程，globalThis
  // 共享——provider adapter 重建见 src-cordis/plugins/provider/index.ts v2）。关闭顺序：
  // 先停 task-bridge/流，再 ctx dispose，最后 hana.close()（流纪律）。
  try {
    globalThis.__dshanaHana = hana;
  } catch { /* 忽略 */ }
  // 父进程退出（宿主 stop/卸载）：有序释放后退出
  process.on("disconnect", () => {
    void shutdown("parent-disconnect", EXIT.DISCONNECT);
  });
  // 信号（宿主 stop 语义）：SIGTERM 正常停（0）、SIGINT 用户中断（130）
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 130));
  info("宿主 IPC 已连接（connectAppRuntime 已就绪）");

  // ---- 2) 进程级 env（自有受管进程内设置，不改宿主进程环境）----
  // DSH_HOME 已在上方定下（当前数据源 / 旧行为回落）。
  mkdirSync(dshHome, { recursive: true });
  process.env.DSH_HOME = dshHome;
  process.env.DSHANA_HOME = dataDir;
  if (!process.env.DSHANA_BUS_SECRET) process.env.DSHANA_BUS_SECRET = randomUUID();
  info(`env：DSH_HOME=${dshHome} DSHANA_HOME=${dataDir}`);

  // ---- 3) 依赖就位（自包含打包：依赖随包在 <installRoot>/node_modules，无运行时安装）----
  info(`依赖区：${depsRoot}（随包物化，无 ensure）`);

  // ---- 4) 定位 DSH + 产物在位检查 ----
  // profile 不归我们：官方随附模板 `web` 由 DSH 首次加载时自建自维护（loadProfile 的
  // template 分支），我们不写 DSH_HOME 里的任何东西（不种子化、不链接、不归一清单）。
  let located;
  try {
    located = await locateDsh({ depsRoot, log: (s) => info("locate", s) });
  } catch (e) {
    err("locate", errText(e));
    err("exit", "exit=" + EXIT.DEPS + " kind=locate");
    reportFatal("deps", e);
    return EXIT.DEPS;
  }
  const missing = missingArtifacts(depsRoot, rosterPatch);
  if (missing.length > 0) {
    err("artifacts", "产物不在位（先跑 pnpm run build 再打包/运行）：" + missing.join("、"));
    err("exit", "exit=" + EXIT.SEED + " kind=artifacts-missing");
    reportFatal("seed", new Error("产物不在位：" + missing.join("、")));
    return EXIT.SEED;
  }

  // ---- 5) 子进程内 boot DSH（官方 web profile + 我们的 roster 作启动期 overlay；显式端口）----
  const environment = located.appBoot.loadLayeredEnv("dsh");
  info(`runProfile({ profile: ${PROFILE_NAME}, patchFiles: [${rosterPatch}], port: ${opts.dshPort} }) …`);
  let boot;
  try {
    boot = await located.profileBoot.runProfile({
      environment,
      profile: PROFILE_NAME,
      patchFiles: [rosterPatch],
      args: ["--port", String(opts.dshPort), "--no-open"],
    });
  } catch (e) {
    const text = errText(e);
    const kind = /EADDRINUSE|address already in use/i.test(text) ? "port-busy" : "boot-failed";
    err("boot", `runProfile 失败（${kind}）：${text}`);
    err("exit", "exit=" + EXIT.PORT + " kind=" + kind);
    reportFatal(kind, e);
    return EXIT.PORT;
  }
  state.ctx = boot.ctx;
  info(`DSH boot 完成（ctx=${!!boot.ctx}，shutdown=${typeof boot.shutdown}）——等待 webserver 真实监听`);

  // ---- 6) 就绪门：webServer 服务端口 === 期望端口 且 HTTP 探测成功，才打 readyMarker ----
  try {
    await waitWebReady({ ctx: boot.ctx, expectedPort: opts.dshPort, log: info });
  } catch (e) {
    const text = errText(e);
    const kind = /未在期望端口/.test(text) ? "port-unreachable" : "boot-failed";
    err("ready", `就绪等待失败（${kind}）：${text}`);
    err("exit", "exit=" + EXIT.PORT + " kind=" + kind);
    reportFatal(kind, e);
    await shutdown("ready-failed", EXIT.PORT);
    return EXIT.PORT;
  }
  info(`webserver 已在 127.0.0.1:${opts.dshPort} 真实监听——准备凭据交换与中继`);
  // ---- 7) 桥挂载：订阅 DSH 事件 → Hana task/审批。
  // 先于 readyMarker（App 等到 ready 后才提交 session.create/prompt，事件在 prompt 之后
  // 才发生——先挂订阅无遗漏窗口）。失败不阻断就绪（桥不可用时任务将无终态/审批回投，
  // 由 App 侧日志与超时暴露）。----
  // ---- 6.5) DSH 凭据交换 + 中继（本 App 唯一服务面）----
  // 官方 connection（BrowserAuth）生效后，宿主 runtime 代理会剥 cookie，App 页/App 主进程都
  // 无法直接携带 DSH 凭据。交换得到 DSH cookie 后由中继统一注入——注册给宿主的 service.port
  // 是中继端口，DSH 真实端口只在中继上游出现（对齐官方样例 hana-dsh 的 bootstrap.mjs）。
  const upstreamOrigin = "http://127.0.0.1:" + opts.dshPort;
  let dshCookie = "";
  try {
    const connection = typeof boot.ctx.get === "function" ? boot.ctx.get("connection") : null;
    if (!connection || typeof connection.authenticatedUrl !== "function") {
      throw new Error("dshana profile 未提供官方 connection（BrowserAuth 凭据面）——检查 bundle 层序：需含 @deepseek-ai/dsh-web-app");
    }
    const launch = connection.authenticatedUrl(upstreamOrigin);
    const exchange = await fetch(launch, { redirect: "manual" });
    const setCookie = typeof exchange.headers.getSetCookie === "function"
      ? exchange.headers.getSetCookie()[0]
      : exchange.headers.get("set-cookie");
    await exchange.body?.cancel().catch(() => {});
    if (!setCookie) throw new Error("DSH 浏览器凭据交换失败（未返回 Set-Cookie）");
    dshCookie = String(setCookie).split(";", 1)[0];
    info("DSH 凭据已交换（BrowserAuth cookie 就绪）");
  } catch (e) {
    err("auth", "DSH 凭据交换失败（中继无法通过 DSH 鉴权）：" + errText(e));
    err("exit", "exit=" + EXIT.PORT + " kind=auth-exchange");
    reportFatal("auth-exchange", e);
    await shutdown("auth-failed", EXIT.PORT);
    return EXIT.PORT;
  }
  // 绑定事实源 = 宿主任务记录的 metadata.dsh：中继闸门与两桥共用同一个索引（各自进程内短 TTL
  // 缓存，模型请求热路径不至于每请求往返宿主）。读取失败在各自读点显式处理（fail-closed）。
  const bindings = createTaskBindingIndex(hana.tasks);

  // 闸门（卡的流）：带票（dshanaSid / dshanaTask）的 WS 只在对应宿主任务还活跃时放行/留活——
  // 任务失活就断开并拒建（中继侧执行，见 bridge.ts）。无票不闸（主卡 / FP / 直开页）；读不出
  // 记录按放行（宁多活一条流，不误杀在用会话）。
  const streamGate = async (ticket: { sessionId: string; taskId: string }): Promise<boolean> => {
    try {
      if (ticket.taskId) return !recordIsTerminal(await hana.tasks.get(ticket.taskId));
      const entry = await bindings.bySession(ticket.sessionId, { fresh: true });
      if (!entry) return true; // 无绑定（用户在 DSH UI 里自建的会话）：没有 task 可判，不闸
      return !TERMINAL_STATUSES.includes(String(entry.status));
    } catch (e) {
      info("stream-gate", "闸门判定失败（放行）：" + errText(e));
      return true;
    }
  };
  try {
    state.bridge = await startDshBridge({
      port: opts.bridgePort,
      bridgeKey: opts.bridgeKey,
      controlKey: opts.controlKey,
      upstreamOrigin,
      upstreamCookie: dshCookie,
      gate: streamGate,
      // 控制面：App 工具（controller.invoke）经宿主 ctx.runtime.fetch(runtimeId, "/_control") 到达
      // 这里，由本进程带 cookie 转发到 DSH /api（App 侧不直接摸 DSH HTTP，也不需 network 到中继）。
      // 参数 = 客户端信封本身（buildClientRequest 产物，含 rpcId/method/payload）。
      onControl: async (action, args) => {
        // prepare-switch：数据源切换前的忙判定守门（冻结标志由中继置位/解除）。0.1.2 下 DSH
        // 无稳定对外「忙」服务口，故按可用性尽力判定：agents 服务在则查运行中/排队中的
        // agent；不在则放行（会话忙判定的正式接入见数据源切换刀 T3）。
        if (action === "prepare-switch") {
          let busy = false;
          try {
            const agents = typeof boot.ctx.get === "function" ? boot.ctx.get("agents") : null;
            const list = agents && typeof agents.list === "function" ? agents.list() : null;
            busy = Array.isArray(list) && list.some((agent) => agent && (
              agent.status === "running"
              || (agent.inbox && (
                (Array.isArray(agent.inbox.nextTurn) && agent.inbox.nextTurn.length > 0)
                || (Array.isArray(agent.inbox.nextStep) && agent.inbox.nextStep.length > 0)
              ))
            ));
          } catch (e) {
            err("switch-gate", "agents 忙判定不可用（放行）：" + errText(e));
          }
          if (busy) throw new Error("DSH 仍有运行中/排队中的任务，先结束或停止它们再切换数据源。");
          info("switch-gate：无在途工作，允许切换数据源（prepare-switch）");
          return { ready: true };
        }
        if (action === "cwd-check") {
          // App 侧（lib/session-run.js）在 create 之前问一次：cwd 是给本进程及其子进程用的，
          // 判定必须出自看得见用户路径的这一侧（宿主半的 fs 只覆盖应用自己的目录）。
          const result = await checkCwd(args && args.cwd);
          const target = String((args && args.cwd) || "");
          if (result.ok) info("cwd-check：可用 " + target);
          else info("cwd-check：不可用 code=" + String(result.code) + "（" + String(result.message) + "）：" + target);
          return result;
        }
        if (action === "models-refresh") {
          // 宿主模型/提供商变更：App 侧（lib/model-sync.js）订阅 app_event/models-changed 后
          // 打进来，让 provider 子插件重拉目录并按差异重注册路由。两个 bundle 同进程不能互相
          // import，约定键名见 lib/provider-hooks.ts；插件不在场（未激活/已退场）就是空操作。
          const g = globalThis as unknown as Record<string, unknown>;
          const reload = g[PROVIDER_RELOAD_GLOBAL_KEY];
          if (typeof reload !== "function") {
            info("models-refresh：provider 未装重载钩子（未激活），跳过");
            return { changed: false };
          }
          const changed = await (reload as () => Promise<boolean>)();
          info("models-refresh：changed=" + String(changed === true));
          return { changed: changed === true };
        }
        if (action !== "rpc") throw new Error("未知控制动作：" + String(action));
        const body = args && args.body;
        if (!body || typeof body !== "object" || typeof body.method !== "string") {
          throw new Error("rpc 控制动作需要客户端信封 body（{ type, rpcId, method, payload }）");
        }
        invalidateBindings(body.method);
        const res = await fetch(upstreamOrigin + "/api/" + body.method, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: dshCookie },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error("DSH /api/" + body.method + " HTTP " + res.status + (text ? "：" + text.slice(0, 300) : ""));
        }
        return await res.json();
      },
      log: (s) => info("dshbridge", s),
    });
  } catch (e) {
    err("dshbridge", "中继启动失败：" + errText(e));
    err("exit", "exit=" + EXIT.PORT + " kind=bridge-bind");
    reportFatal("bridge-bind", e);
    await shutdown("bridge-failed", EXIT.PORT);
    return EXIT.PORT;
  }
  // 反向 session.cancel 经中继（带 bridgeKey），不走免鉴权的 DSH 端口。
  const serviceBaseUrl = "http://127.0.0.1:" + opts.bridgePort;
  // provider 是 cordis 子插件 bundle，与本 runtime bundle 同进程但不能互相 import：
  // 绑定索引经 globalThis 约定交付（键名见 lib/task-binding.ts），供模型请求的身份判定读取。
  state.stopBindings = publishTaskBindingIndex(bindings);
  // 写点之后失效缓存：App 在 session/prompt 之前回写 metadata.dsh（session/cancel 之前写取消标记），
  // 那两个 RPC 到达即代表宿主记录刚被改过——不吃 3s TTL 里的陈旧快照（陈旧 = 新绑定读不到，
  // provider 会误判成 App 身份）。schedule 类只读 RPC 不失效，避免无谓的宿主往返。
  const invalidateOn = new Set(["session/prompt", "session/cancel"]);
  const invalidateBindings = (method: unknown) => {
    if (!invalidateOn.has(String(method))) return;
    try { bindings.invalidate(); } catch { /* 忽略 */ }
  };
  try {
    state.stopBridge = startTaskBridge({
      ctx: boot.ctx,
      hana,
      bindings,
      serviceBaseUrl, // 宿主任务取消反向触发 → 本进程 DSH session.cancel（只本会话，经中继）
      bridgeKey: opts.bridgeKey,
      log: (s) => info("bridge", s),
    });
  } catch (e) {
    err("bridge", "task-bridge 挂载失败（任务终态将无回投）：" + errText(e));
  }
  try {
    state.stopApproval = startApprovalBridge({
      ctx: boot.ctx,
      hana,
      bindings,
      log: (s) => info("approval", s),
    });
  } catch (e) {
    err("approval", "approval-bridge 挂载失败（DSH 越界审批将 fail-closed）：" + errText(e));
  }
  process.stdout.write(opts.readyMarker + "\n");
  return EXIT.OK;
}

// ---- bundle 自执行：受管 runtime 进程加载即跑（宿主只等 stdout readyMarker / 进程退出）----
const rawArgv = process.argv.slice(2);
/**
 * 失败必须**真正结束进程**：宿主父进程的 IPC 通道会保持事件循环活着，只设 process.exitCode
 * 不会退出——宿主侧就一直停在 starting，App 侧只能等到超时（真实成因也随之后置）。
 * 断开 IPC 通道再 exit，宿主按退出码归类，失败报告（reportFatal）已落盘。
 * 成功就绪（OK）不走这里：进程由信号/断连驱动 shutdown() 退出。
 */
const exitWith = (code) => {
  try { process.disconnect?.(); } catch { /* 无 IPC 通道（如直接 node 运行） */ }
  process.exit(code);
};
main(rawArgv).then((code) => {
  if (code !== EXIT.OK) exitWith(code);
}).catch((e) => {
  // main 自身抛出的意外错误（未被上述分支拦住的）：同样走 stderr + 退出码，不让它静默。
  err("fatal", "未预期的致命错误：" + errText(e));
  err("exit", "exit=" + EXIT.INTERNAL + " kind=internal");
  exitWith(EXIT.INTERNAL);
});
