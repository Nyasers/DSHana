// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/provider — DSH provider adapter（v2 重写：模型推理走受管 runtime 内 hana）
//
// v1（0.1.2）形态：消费宿主 provider 路由（models.json + apiKey）注册官方 PiAiAdapter 直连
// 各 provider 端点。本 adapter 不再有 apiKey/baseURL/直连：**推理在受管
// runtime 内经 connectAppRuntime().models 发起**（受管子进程与 DSH 同进程，hana client
// 由 dsh-host.mjs 挂 globalThis.__dshanaHana，见 src/runtime/main.ts）：
//   · 目录：hana.models.list() → 显式 provider/model 选择（id 原样透传，不二次映射）；
//   · 推理：hana.models.stream({ requestId, provider, model, messages, systemPrompt, tools,
//     reasoningEffort?, maxTokens?, temperature?, taskId? })——requestId 由本 adapter 自管
//     （cancel 按 requestId 定向）。**身份三态且不能同传**（见 lib/identity.ts）：无绑定 =
//     用户自建会话 = App 身份；有绑定 + 任务终结（用户接着在 WebUI 用）= App 身份；
//     有绑定 + 任务活动 = taskId（保留任务绑定与结果回投）；绑定读不出/索引缺席 = **显式失败**，
//     不改走 App 身份（《DSHana 调用 Hana 模型接口指南》§3/§5）。不传 scope——那是
//     models.utility 的参数，stream 不接受；
//   · NDJSON 逐行解析（lib/ndjson.js），done.assistant 完整保存回放（含 text/reasoning/
//     toolCall 续接签名，lib/stream.js buildDoneChunks + 回放信封）；error 事件=失败不算成功；
//   · 图片：DSH 消息含 ImageBlock 时经 attachment store 读字节 → base64+MIME（不传路径），
//     缺 store 时报 UNSUPPORTED_CONTENT（边界见 DESIGN）。
// DSH 侧工具循环不变：Hana 不替 DSH 执行传入工具 schema（tools 仅声明）；DSH 执行工具后把
// role:toolResult 消息放回 messages（lib/messages.js 转换）。
//
// 容错纪律（v1 同款）：apply 全程 try/catch 不抛——依赖缺失/目录空/错误只记日志，插件
// 降级为空操作（DSH 无 provider 可用），不阻断 dsh 启动。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readNdjsonEvents } from "./lib/ndjson.ts";
import { providerRoutes, listModelsForProvider, resolveModelInfo, supportedEfforts, modelPublishedMaxTokens, sameCatalog, HOST_MAX_OUTPUT_TOKENS } from "./lib/catalog.ts";
import { toHanaMessages } from "./lib/messages.ts";
import { buildDoneChunks, createHanaStreamState } from "./lib/stream.ts";
import { resolveSessionIdentity, TASK_MAP_BROKEN, BINDING_UNAVAILABLE } from "./lib/identity.ts";
import { errText } from "./lib/err-text.ts";

// 目录重载钩子的键名：与 dsh-host 入口（src/runtime/main.ts 经 src/lib/provider-hooks.ts）
// **字面一致**。本插件是独立的 cordis 插件包，读不到 App 侧的 #/ 路径映射，两个 bundle
// 同进程不能互相 import（与 ACTIVE_MODEL_KEY / __dshanaHana 同款约定）。
const PROVIDER_RELOAD_GLOBAL_KEY = "__dshanaReloadModels";

export const name = "@dshana/provider";
export const inject = ["llm"];

/** 动态依赖解析基座（profiles 全量视图优先——pnpm 严格结构下 dsh-pkg 顶层只有直接声明）。 */
function resolveLlmEntry() {
  const home = process.env.DSH_HOME;
  const bases: string[] = [];
  if (home) bases.push(join(home, "profiles", "node_modules"));
  const candidates: string[] = [];
  for (const base of bases) {
    try {
      const p = join(base, "@deepseek-ai", "dsh-llm", "package.json");
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      const entry = (pkg.exports && pkg.exports["."] && pkg.exports["."].default) || pkg.main || "index.js";
      candidates.push(pathToFileURL(join(base, "@deepseek-ai", "dsh-llm", entry)).href);
    } catch {
      /* 该基座不可解析，试下一个 */
    }
  }
  return candidates;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 独立会话（无任务绑定 = DSH Web UI 自建）按 App 身份推理：每会话只提示一次——
// 日志要能回答“这次请求为什么没有 task 绑定”，这是诊断信息而非错误。
const APP_IDENTITY_LOGGED = new Set();
function noteAppIdentity(logLine, sessionId) {
  const key = String(sessionId || "?");
  if (APP_IDENTITY_LOGGED.has(key) || APP_IDENTITY_LOGGED.size >= 64) return;
  APP_IDENTITY_LOGGED.add(key);
  logLine("会话 " + key + " 无任务绑定 → 按 App 身份推理（DSH Web UI 独立会话，不传 callToken/taskId）");
}

// 参数收敛提示（按 provider/model 去重，不逐次刷屏）。宿主对模型请求的字段有硬校验，
// 我们能忠实收敛的就收敛（上限就是宿主的上级），不做“多发几次报错再回头改”。
const CLAMP_NOTICED = new Set();
function noteClamp(warnLine, key, msg) {
  if (CLAMP_NOTICED.has(key) || CLAMP_NOTICED.size >= 64) return;
  CLAMP_NOTICED.add(key);
  warnLine(msg);
}

function log(ctx, msg) {
  try {
    ctx.logger?.info?.("[" + name + "] " + msg);
  } catch {
    /* 日志失败不阻断 */
  }
}
function warn(ctx, msg) {
  try {
    ctx.logger?.warn?.("[" + name + "] " + msg);
  } catch {
    /* 日志失败不阻断 */
  }
}

// ---- 活动模型 requestId 注册表（globalThis 与 dsh-host bundle 共享）----
// 键名与 src/lib/model-requests.ts MODEL_REQUEST_GLOBAL_KEY 字面一致（本插件与 task-bridge
// 分属 cordis 插件 bundle / dsh-host bundle，不能互相 import——同进程 globalThis 约定，
// 与 __dshanaHana 同款）。结构：Map<dshSessionId, Set<requestId>>；取消消费侧只读。
const ACTIVE_MODEL_KEY = "__dshanaActiveModelRequests";
function registerActiveModelRequest(sessionId, requestId) {
  try {
    if (!sessionId || !requestId) return;
    const g = globalThis;
    let m = g[ACTIVE_MODEL_KEY];
    if (!(m instanceof Map)) {
      m = new Map();
      try { g[ACTIVE_MODEL_KEY] = m; } catch { /* globalThis 只读兜底 */ }
    }
    let set = m.get(sessionId);
    if (!set) {
      set = new Set();
      m.set(sessionId, set);
    }
    set.add(requestId);
  } catch {
    /* 注册失败不影响推理（取消仅尽力而为） */
  }
}
function unregisterActiveModelRequest(sessionId, requestId) {
  try {
    if (!sessionId) return;
    const g = globalThis;
    const m = g && g[ACTIVE_MODEL_KEY];
    if (!(m instanceof Map)) return;
    const set = m.get(sessionId);
    if (!set) return;
    set.delete(requestId);
    if (set.size === 0) m.delete(sessionId);
  } catch {
    /* 注销失败忽略 */
  }
}

function toLlmError(LlmError, e, requestId) {
  const message = (e && e.message) || String(e || "模型调用失败");
  const code = (e && e.code) || "MODEL_ERROR";
  const opts = requestId ? { requestId } : undefined;
  try {
    return new LlmError(message, code, opts);
  } catch {
    return new Error(message);
  }
}

/** 归一 attachment mediaType → MIME（ref.mediaType 可能不带 image/ 前缀）。 */
function mimeOf(mediaType) {
  const s = String(mediaType || "").toLowerCase();
  if (!s) return "image/png";
  return /^image\//.test(s) ? s : "image/" + s;
}

/**
 * 预解析消息里的全部图片块（DSH ImageBlock.attachment → base64 + mime）。
 * @returns Promise<Map<string,{data:string,mimeType:string}>>（attId → 编码）
 */
async function prepareImages(store, messages, signal) {
  const out = new Map();
  if (!store) return out;
  const seen = new Set();
  const walk = (blocks) => {
    for (const b of blocks || []) {
      if (!b) continue;
      if (b.type === "image") {
        const ref = b.attachment;
        if (ref && typeof ref.attachmentId === "string" && !seen.has(ref.attachmentId)) {
          seen.add(ref.attachmentId);
          out.set(ref.attachmentId, ref);
        }
      } else if (b.type === "tool-result" && Array.isArray(b.content)) {
        walk(b.content);
      }
    }
  };
  for (const m of messages || []) walk(m && m.content);
  const loaded = new Map();
  for (const [attId, ref] of out) {
    try {
      const img = await store.readImageRequest(ref, { maxPixels: 4194304, maxBytes: 4000000 }, signal);
      const data = img && img.data ? img.data : null;
      if (!data) throw new Error("readImageRequest 未返回字节");
      loaded.set(attId, { data: Buffer.from(data).toString("base64"), mimeType: mimeOf(ref.mediaType) });
    } catch (e) {
      const err = new Error(
        "DSH 图片附件解析失败（attachmentId=" + attId + "）：" + errText(e),
      ) as Error & { code: string };
      err.code = "UNSUPPORTED_CONTENT";
      throw err;
    }
  }
  return loaded;
}

/**
 * 运行时构建 HanaAdapter（extends 需要运行时 import 的 LlmAdapter）。
 * @param {Function} LlmAdapter LlmAdapter 基类（dsh-llm）
 * @param {Function} LlmError LlmError（dsh-llm）
 * @param {object} deps { catalog?, models?, hana, getImages: () => store|null }
 *
 * 目录可换：deps.catalog 是插件持有的**活目录**（重拉时整体替换它的 models 字段），
 * adapter 每次调用现读；没有 catalog 时退回 deps.models 的一次性快照（单测与旧调用姿势）。
 */
export function buildHanaAdapter(LlmAdapter, LlmError, deps) {
  const catalog = deps && deps.catalog && typeof deps.catalog === "object"
    ? deps.catalog
    : { models: Array.isArray(deps && deps.models) ? deps.models : [] };
  const currentModels = () => (Array.isArray(catalog.models) ? catalog.models : []);
  // adapter 方法在插件作用域之外（apply 的 ctx 在这里不可见），日志只能走 deps 注入。
  const logLine = typeof deps.log === "function" ? deps.log : () => {};
  const warnLine = typeof deps.warn === "function" ? deps.warn : () => {};
  const adapter = new (class HanaAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: provider };
    }

    listModels(provider) {
      return Promise.resolve(listModelsForProvider(provider, currentModels()));
    }

    resolveModel(provider, model, _signal) {
      const models = currentModels();
      const item = models.find((m) => m && m.provider === provider && m.id === model) || null;
      const info = resolveModelInfo(item);
      if (!info) {
        const err = new Error(
          "hana provider \"" + provider + "\" 无模型 \"" + model + "\"（宿主目录快照 " +
            (models.filter((m) => m && m.provider === provider).length || 0) + " 条）",
        ) as Error & { code: string };
        err.code = "UNKNOWN_MODEL";
        throw err;
      }
      return Promise.resolve(info);
    }

    async *stream(options) {
      const sessionId = options && options.sessionId;
      const item = currentModels().find((m) => m && m.provider === options.provider && m.id === options.model) || null;
      const requestId = randomUUID();
      // 身份判定（三态，见 lib/identity.ts）：
      //   无绑定 ⇒ App 身份（用户在 WebUI 自建的会话）；
      //   有绑定 + 任务终结 ⇒ App 身份（用户接着用，事实而非降级）；
      //   有绑定 + 任务活动 ⇒ taskId（必须）；
      //   绑定读不出/索引缺席（损坏/能力缺席）⇒ **显式失败**，绝不改走 App 身份。
      // 失效/归属不正确的 taskId 仍由宿主报错并原样上抛——不做“删掉身份参数重试”的兜底。
      let identity;
      let source;
      try {
        ({ identity, source } = await resolveSessionIdentity(sessionId));
      } catch (e) {
        const code = (e as any)?.code;
        throw new LlmError(
          "模型身份判定失败（会话绑定不可读）：" + errText(e),
          code === TASK_MAP_BROKEN || code === BINDING_UNAVAILABLE ? code : "TASK_IDENTITY_UNRESOLVED",
          { requestId },
        );
      }
      if (source === "app") noteAppIdentity(logLine, sessionId);
      const ac = new AbortController();
      const onAbort = () => {
        ac.abort();
        try {
          deps.hana && deps.hana.models && deps.hana.models.cancel(requestId).catch(() => {});
        } catch {
          /* 忽略 */
        }
      };
      const signal = options && options.signal;
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      // 图片解析（store 缺失/失败 → UNSUPPORTED_CONTENT 明确报错）
      let images: Map<string, { data: string; mimeType: string }> | null = null;
      try {
        const store = typeof deps.getImages === "function" ? deps.getImages() : null;
        images = store ? await prepareImages(store, options && options.messages, ac.signal) : null;
      } catch (e) {
        if (signal) signal.removeEventListener("abort", onAbort);
        throw toLlmError(LlmError, e, requestId);
      }
      // 消息转换（assistant 历史回放签名/tool-result 拆分/图片编码）
      let hanaMessages;
      let systemPrompt;
      try {
        const conv = toHanaMessages({ messages: options && options.messages, images });
        hanaMessages = conv.messages;
        systemPrompt = conv.systemPrompt;
      } catch (e) {
        if (signal) signal.removeEventListener("abort", onAbort);
        throw toLlmError(LlmError, e, requestId);
      }
      if (hanaMessages.length === 0) {
        if (signal) signal.removeEventListener("abort", onAbort);
        throw new LlmError("请求消息为空（无 user/assistant/toolResult 消息）", "EMPTY_MESSAGES", { requestId });
      }
      const request = {
        requestId,
        ...identity, // taskId（Hana 委派）或 无身份字段（App 身份，DSH Web UI 独立会话）
        provider: options.provider,
        model: options.model,
        messages: hanaMessages,
      };
      if (systemPrompt) request.systemPrompt = systemPrompt;
      if (Array.isArray(options.tools) && options.tools.length) request.tools = options.tools;
      if (options.reasoningEffort) request.reasoningEffort = String(options.reasoningEffort);
      // maxTokens 三层（宿主校验器全文见 DESIGN）：
      //  ① 未给/非正整数 → 不发字段；
      //  ② 超过宿主请求闸 HOST_MAX_OUTPUT_TOKENS(65536) → **不发字段**（不是压到 65536！
      //     收敛到 65536 等于把输出悄悄砍到 64k，而模型 published 上限可能是 384k；不传则
      //     上限交回模型/供应商默认）。想显式带 >64k 需宿主侧放宽 limits.maxTokens，那是宿主的闸；
      //  ③ 未超宿主闸、但超过该模型 published 上限 → 按模型上限收敛（模型自身硬限，无法绕过）。
      if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) {
        const published = modelPublishedMaxTokens(item);
        const keyBase = options.provider + "/" + options.model;
        if (options.maxTokens > HOST_MAX_OUTPUT_TOKENS) {
          noteClamp(
            warnLine,
            "maxTokens-drop:" + keyBase,
            "DSH 请求 maxTokens=" + options.maxTokens + " 超出宿主请求上限 " + HOST_MAX_OUTPUT_TOKENS +
              "，改为不传该字段（上限交回模型/供应商默认；如需显式声明 > " + HOST_MAX_OUTPUT_TOKENS +
              " 需放宽宿主 limits.maxTokens）",
          );
        } else if (published !== null && options.maxTokens > published) {
          request.maxTokens = published;
          noteClamp(
            warnLine,
            "maxTokens-model:" + keyBase,
            "DSH 请求 maxTokens=" + options.maxTokens + " 超过该模型 published 上限 " + published + "，已收敛到 " + published,
          );
        } else {
          request.maxTokens = options.maxTokens;
        }
      }
      if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
        const temp = Math.min(2, Math.max(0, options.temperature));
        request.temperature = temp;
        if (temp !== options.temperature) {
          noteClamp(
            warnLine,
            "temperature:" + options.provider + "/" + options.model,
            "温度 " + options.temperature + " 超出宿主允许区间 [0,2]，已收敛到 " + temp,
          );
        }
      }
      // 活动模型流注册（task-bridge 的取消/审批链按会话定向 models.cancel，
      // 只停本工作不误停他人会话；键契约见 src/lib/model-requests.ts MODEL_REQUEST_GLOBAL_KEY）
      registerActiveModelRequest(sessionId, requestId);
      try {
        const response = await deps.hana.models.stream(request);
        let done = false;
        // 增量状态机：text-delta/reasoning-delta 立刻转成
        // block-start + delta 产出，Web UI 才能逐字长出来；done 时仍由 buildDoneChunks 产出
        // 权威 block-end（签名只在 done.assistant 里）+ usage + finish。
        const streamState = createHanaStreamState();
        try {
          for await (const ev of readNdjsonEvents(response)) {
            if (!ev || typeof ev.type !== "string") continue;
            if (ev.type === "done") {
              const chunks = buildDoneChunks({
                doneEvent: ev,
                provider: options.provider,
                model: options.model,
                requestId,
                startedIndexes: streamState.startedIndexes,
              });
              for (const c of chunks) yield c;
              done = true;
              break;
            }
            if (ev.type === "error") {
              throw new LlmError(
                String(ev.message || "模型错误"),
                String(ev.code || "MODEL_ERROR"),
                { requestId },
              );
            }
            // start 忽略；text-delta/reasoning-delta 实时产出；tool-call 只从 done 取
            // （同一个 tool call 不能重复执行）。
            const live = streamState.push(ev);
            for (const c of live) yield c;
          }
        } finally {
          if (signal) signal.removeEventListener("abort", onAbort);
          try {
            ac.abort();
          } catch { /* 忽略 */ }
        }
        if (!done) {
          if (options && options.signal && options.signal.aborted) {
            throw new LlmError("模型流已中止", "ABORTED", { requestId });
          }
          throw new LlmError("模型流未以 done 事件结束（宿主连接中断）", "STREAM_CLOSED", { requestId });
        }
      } catch (e) {
        if (e instanceof LlmError) throw e;
        throw toLlmError(LlmError, e, requestId);
      } finally {
        unregisterActiveModelRequest(sessionId, requestId);
      }
    }
  })();
  return adapter;
}

export async function apply(ctx, config) {
  try {
    // 1. hana client 句柄（dsh-host.mjs 在 connectAppRuntime 后、runProfile 前设置；
    // 插件加载晚于该点；仍给窗口兜底轮询）
    let hana: any = null;
    try {
      hana = globalThis.__dshanaHana || null;
    } catch {
      hana = null;
    }
    if (!hana || !hana.models || typeof hana.models.list !== "function") {
      warn(ctx, "hana client（globalThis.__dshanaHana）不可用——provider 停用（受管 runtime 未正确注入宿主 IPC）");
      return;
    }
    // 2. 附件 store（图片 base64 解析；缺失时图片内容报 UNSUPPORTED_CONTENT）
    let attachmentStore: any = null;
    try {
      ctx.inject(["attachments"], (aCtx) => {
        try {
          const s = aCtx && aCtx.attachments;
          if (s && typeof s.readImageRequest === "function") attachmentStore = s;
        } catch { /* 忽略 */ }
      });
    } catch {
      /* attachments 服务不可用：图片内容报 UNSUPPORTED_CONTENT */
    }
    // 3. 目录快照（models.list；引擎未就绪窗口内重试 ≤20s）
    let models: any[] = [];
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const res = await (hana.models.list());
        const list = res && Array.isArray(res.models) ? res.models : [];
        if (list.length > 0) {
          models = list;
          break;
        }
      } catch (e) {
        warn(ctx, "hana.models.list 暂不可用：" + errText(e));
      }
      if (Date.now() >= deadline) break;
      await sleep(500);
    }
    if (models.length === 0) {
      warn(ctx, "hana 模型目录为空——provider 无路由可注册（宿主无可用模型/目录未就绪）");
      return;
    }
    // 4. dsh-llm 动态依赖 + adapter
    let llmMod: any = null;
    for (const href of resolveLlmEntry()) {
      try {
        // webpackIgnore：运行时原生 import（变量基座，cordis 子插件打包保留原生语义）
        llmMod = await import(/* webpackIgnore: true */ href);
        break;
      } catch { /* 试下一个基座 */ }
    }
    if (!llmMod) {
      try {
        llmMod = await import(/* webpackIgnore: true */ "@deepseek-ai/dsh-llm");
      } catch { /* 不可用 */ }
    }
    const LlmAdapter = llmMod && llmMod.LlmAdapter;
    const LlmError = llmMod && llmMod.LlmError;
    if (typeof LlmAdapter !== "function" || typeof LlmError !== "function") {
      warn(ctx, "dsh-llm 未导出 LlmAdapter/LlmError——provider 停用");
      return;
    }
    const routes = providerRoutes(models);
    // 活目录：重载时整体替换它的 models 字段，adapter 每次调用现读（见 buildHanaAdapter）。
    const catalog: { models: any[] } = { models };
    const adapter = buildHanaAdapter(LlmAdapter, LlmError, {
      catalog,
      hana,
      getImages: () => attachmentStore,
      log: (msg) => log(ctx, msg),
      warn: (msg) => warn(ctx, msg),
    });
    // 5. 注册（空 routes 不注册——llm 注册表要求非空；目录空已在上方 return）。
    // 句柄留着：宿主目录变更时用它的 replace 原子换路（见第 6 步）。
    const registration = ctx.llm.registerAdapter(routes, adapter);
    log(ctx, "已注册 " + routes.length + " 个 provider 路由（" + models.length + " 个模型，源=hana.models.list）");
    // 6. 目录重载钩子：宿主提供商/模型目录变更时（App 侧订阅 app_event/models-changed 后经控制面
    //    models-refresh 打进来）重拉一次 hana.models.list()；有差异才重注册。
    //    registration.replace 是官方给的原子换路，它自己会广播 llm/adapters-updated，前端模型
    //    目录据此刷新——runtime 不用重启，插件也不用重载。
    //    取不到新目录（宿主暂时不可用）时保留现状，绝不把路由清空。
    const reload = async () => {
      let listed;
      try {
        listed = await hana.models.list();
      } catch (e) {
        warn(ctx, "目录重载：hana.models.list 取不到，保留现状：" + errText(e));
        return false;
      }
      const next: any[] = listed && Array.isArray(listed.models)
        ? listed.models.filter((m) => m && typeof m.provider === "string" && m.provider && typeof m.id === "string" && m.id)
        : [];
      if (next.length === 0) {
        warn(ctx, "目录重载：宿主目录为空，保留现状（不重注册）");
        return false;
      }
      if (sameCatalog(catalog.models, next)) return false;
      const nextRoutes = providerRoutes(next);
      try {
        // 先换路再换目录：replace 先整体校验候选集，被拒时目录保持旧值，两边不打架。
        registration.replace(nextRoutes);
      } catch (e) {
        warn(ctx, "目录重载：provider 路由替换被拒，保留现状：" + errText(e));
        return false;
      }
      catalog.models = next;
      log(ctx, "目录已重载：" + nextRoutes.length + " 个 provider 路由 / " + next.length + " 个模型（宿主目录变更）");
      return true;
    };
    const g = globalThis as unknown as Record<string, unknown>;
    try {
      g[PROVIDER_RELOAD_GLOBAL_KEY] = reload;
    } catch { /* globalThis 只读兜底：重载钩子缺席，控制面按无变化处理 */ }
    ctx.effect(() => () => {
      try {
        if (g[PROVIDER_RELOAD_GLOBAL_KEY] === reload) delete g[PROVIDER_RELOAD_GLOBAL_KEY];
      } catch { /* 忽略 */ }
    }, "@dshana/provider: 目录重载钩子");
  } catch (e) {
    // 顶层兜底：apply 永不抛出
    try {
      ctx.logger?.error?.("[" + name + "] 插件初始化失败，已降级为空操作：" + errText(e));
    } catch { /* 忽略 */ }
  }
}
