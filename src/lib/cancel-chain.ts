// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/cancel-chain.ts — dshana close / 执行超时取消编排（App 主进程侧）
//
// 职责：
//   ① 触发：dshana(action=close)（本模块 cancelDshTask）或执行超时看门狗
//      （session-run 定时器，同一函数）；
//   ② DSH 侧中止：经 loopback HTTP RPC session/cancel（DSH 中止 agent 回合 → provider
//      adapter 流 signal abort → hana.models.cancel(requestId)，工具/终端由 DSH 回合
//      中止机制收尾——v1 同款语义）；
//   ③ 只关本工作资源：取消按 sessionId 定位（先经宿主任务记录解出 taskId）；单例受管
//      runtime 服务多会话时 session/cancel 只作用该会话，绝不停整个 runtime/他人会话；
//   ④ 确定取消状态：任务 metadata.dsh 写 cancel 标记（先于 RPC）→ task-bridge 在 DSH
//      turn/end(aborted) 时据此把宿主任务结算成 canceled（真中止后才取消，不是先标
//      canceled）→ 确认窗口内轮询 tasks.get 等终态；超窗未确认时升级 ctx.tasks.cancel 兜底
//      （残留风险见 DESIGN 边界）。**窗口不进工具回调**：工具路径（requestCancel）标记 +
//      RPC 后立即返回，结算丢后台；执行超时看门狗（cancelSessionWork）本就在后台（setTimeout
//      起的），才等满窗口求收尾判断。
//
// 与宿主「取消 UI」的反向触发（host task canceled/aborted → DSH cancel）在受管 runtime
// 的 task-bridge 侧实现（watch 宿主任务 SSE），不在此模块（App 进程内看不到 DSH 事件）。
import { appCtx, appDataDir, appConfig } from "#/lib/app-runtime.ts";
import { APP_SETTING_DEFAULTS } from "#/lib/config.ts";
import { errText } from "#/lib/err-text.ts";
import { createTaskBindingIndex, type TaskBinding } from "#/lib/task-binding.ts";
import { rpcSessionCancel, cancelAccepted } from "#/lib/dsh-rpc.ts";
import { rpcViaControl } from "#/lib/controller.ts";
import { readSettingsSync } from "#/lib/data-source.ts";

/** 宿主任务记录（ctx.tasks.get 的返回值；从 ctx 下钻，勿手抄形状）。 */
type HostTaskRecord = Awaited<
  ReturnType<NonNullable<NonNullable<ReturnType<typeof appCtx>>["tasks"]>["get"]>
>;

export const CANCEL_CONFIRM_MS = 15000; // DSH 中止确认窗口（超窗升级宿主 cancel）
export const CANCEL_ESCALATE_REASON = "cancel-confirm-timeout";

/** 纯函数：按绑定条目给出取消编排计划（供单测与执行器共用）。 */
export function planCancel(entry: TaskBinding | null | undefined) {
  const sid = String((entry && entry.dshSessionId) || "");
  const taskId = String((entry && entry.taskId) || "");
  return {
    sessionId: sid,
    taskId,
    // 已有取消标记：不重复发 DSH cancel（幂等）；否则需要 DSH 侧取消
    dshCancelNeeded: !!(sid && !(entry && entry.cancel)),
    hostEscalateAvailable: !!taskId,
  };
}

function logWarn(log, msg) {
  try { if (log && typeof log.warn === "function") log(msg); } catch { /* 忽略 */ }
}

/**
 * 取消编排执行（cancel 工具 / 执行超时共用）。返回 { status, taskId, reason }：
 *   status = 'cancelling'（DSH cancel 已请求，宿主终态随后由 task-bridge 结算）
 *          | 'no-active-work'（无绑定/空闲会话；仍发幂等 session.cancel）
 *          | 'already-requested'（取消标记已存在——幂等，不再重复发）
 *          | 'dsh-rpc-failed'（DSH 侧不可达：已尽力，任务仍会由宿主侧终结兜底）
 */
/** 取消编排的结果：status 定分支，其余字段按 status 出现。 */
export interface CancelWorkResult {
  status: "canceled" | "no-active-work" | "already-requested" | "dsh-rpc-failed" | "cancelling";
  sessionId: string;
  taskId?: string | null;
  reason?: string;
  /** DSH 侧是否接受了取消（null = 未确认）。 */
  dshAccepted?: boolean | null;
  /** DSH 侧取消调用失败时的错误文本。 */
  dshError?: string;
  /** true = 等不到 DSH 确认，已升级为宿主 ctx.tasks.cancel。 */
  escalated?: boolean;
  /** 确认窗口内等到的宿主任务终态记录（有则带出）。 */
  terminal?: unknown;
}

export async function executeCancel({ sessionId, reason, log }: { sessionId?: string; reason?: string; log?: any }): Promise<CancelWorkResult> {
  const ctx = appCtx();
  if (!ctx) throw new Error("App 运行包未初始化（apply 未注入宿主 ctx）");
  const sid = String(sessionId || "").trim();
  if (!sid) throw new Error("cancel 需要 sessionId");
  // 绑定读取失败（宿主不可达/记录畸形）按 fail-closed 拒绝取消：状态丢了还发 DSH cancel，
  // 等于在不知道归属的情况下停别人的会话，且后续终态判定没有依据。
  let entry: TaskBinding | null = null;
  try {
    entry = await createTaskBindingIndex((ctx as any).tasks).bySession(sid, { fresh: true });
  } catch (e) {
    throw new Error("取消前读会话任务绑定失败（fail-closed，未发任何取消）：" + errText(e));
  }
  const plan = planCancel(entry);
  if (!entry) {
    // 无绑定（空闲会话/绑定已被回收）：仍向 DSH 发幂等 cancel，防「宿主侧已清、DSH 仍在跑」
    let dshAccepted: boolean | null = null;
    try {
      const value = await rpcViaControl(ctx, { method: "session/cancel", payload: { sessionId: String(sid || "") } });
      dshAccepted = cancelAccepted(value);
    } catch (e) {
      logWarn(log, "[dsh-session] cancel RPC（无绑定兜底）失败：" + errText(e));
    }
    return { status: "no-active-work", sessionId: sid, dshAccepted, taskId: null, reason };
  }
  if (!plan.dshCancelNeeded) {
    return { status: "already-requested", sessionId: sid, taskId: entry.taskId, reason: (entry.cancel && entry.cancel.reason) || reason };
  }
  // ① 写取消标记（先于 RPC：终态判定据此把 aborted 结算成 canceled）。标记落在宿主任务记录
  //    的 metadata.dsh.cancel（读-改-写全量 dsh）；App 侧与 runtime 侧（task-bridge 的
  //    onHostCancel）写同一格——App 进程拿不到会话句柄，取消不经会话事件日志。
  try {
    await createTaskBindingIndex((ctx as any).tasks).markCancel(entry.taskId, reason || "user");
  } catch (e) {
    logWarn(log, "[dsh-session] cancel 标记写失败（继续取消）：" + errText(e));
  }
  // ② DSH session.cancel（loopback；失败不阻断——记录并交由终态兜底）
  let dshAccepted: boolean | null = null;
  let dshError: string | null = null;
  try {
    const value = await rpcViaControl(ctx, { method: "session/cancel", payload: { sessionId: String(sid || "") } });
    dshAccepted = cancelAccepted(value);
  } catch (e) {
    dshError = errText(e);
    logWarn(log, "[dsh-session] DSH session.cancel RPC 失败：" + dshError);
  }
  if (!dshAccepted && dshError) {
    return { status: "dsh-rpc-failed", sessionId: sid, taskId: entry.taskId, reason, dshError };
  }
  return { status: "cancelling", sessionId: sid, taskId: entry.taskId, reason, dshAccepted };
}

/** 等宿主任务终态（轮询 get；给后台结算用）。返回记录或 null（超窗）。 */
export async function awaitCancelTerminal({ taskId, timeoutMs = CANCEL_CONFIRM_MS, pollMs = 500, log }: { taskId?: string; timeoutMs?: number; pollMs?: number; log?: any }) {
  const ctx = appCtx();
  if (!taskId || !ctx || typeof ctx.tasks?.get !== "function") return null;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    let rec: HostTaskRecord | null = null;
    try {
      rec = await ctx.tasks.get(taskId);
    } catch (e) {
      logWarn(log, "[dsh-session] 取消确认 tasks.get 失败：" + errText(e));
    }
    if (rec && ["completed", "failed", "canceled", "aborted"].includes(String(rec.status))) return rec;
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

// ---- 取消结算：窗口只在后台走，工具回调不占 ----

/** 终态结算结果：terminal = 确认中止；escalated = 超窗升级宿主 cancel；unresolved = 两者都没成。 */
export type CancelSettlement =
  | { settled: "terminal"; terminal: unknown }
  | { settled: "escalated" }
  | { settled: "unresolved" };

/** 取消链的可注入面（单测用；缺省走 appCtx 与 awaitCancelTerminal）。 */
export interface CancelDeps {
  executeCancel?: (a: { sessionId: string; reason?: string; log?: any }) => Promise<CancelWorkResult>;
  awaitTerminal?: (a: { taskId: string; timeoutMs: number; log?: any }) => Promise<unknown>;
  cancelHostTask?: (taskId: string, reason: string) => Promise<void>;
  settle?: (a: SettleInput) => Promise<CancelSettlement>;
}

/** 结算入参（deps 透传，便于单测注入）。 */
export interface SettleInput {
  taskId: string;
  sessionId?: string;
  reason?: string;
  confirmMs?: number;
  log?: any;
  deps?: CancelDeps;
}

/**
 * 终态结算（后台面）：等宿主任务终态；超窗则升级 ctx.tasks.cancel。
 * 本函数会等满确认窗口，**只该跑在后台**（requestCancel 的脱手 promise / 看门狗），别放进工具
 * 回调：占着回调等 15 秒就是「请求里握着等待」，多张卡同时取消会堵住宿主通道。
 */
export async function settleCancelTerminal({ taskId, sessionId, reason, confirmMs = CANCEL_CONFIRM_MS, log, deps = {} }: SettleInput): Promise<CancelSettlement> {
  if (!taskId) return { settled: "unresolved" };
  const waitTerminal =
    deps.awaitTerminal || ((a: { taskId: string; timeoutMs: number; log?: any }) => awaitCancelTerminal(a));
  const terminal = await waitTerminal({ taskId, timeoutMs: confirmMs, log });
  if (terminal) return { settled: "terminal", terminal };
  // 升级兜底：宿主任务先 cancel（真实取消状态仍要保证；DSH 若真未停，日志/边界记录）
  const escalate = deps.cancelHostTask || defaultCancelHostTask;
  try {
    await escalate(taskId, String(reason || CANCEL_ESCALATE_REASON));
    logWarn(log, "[dsh-session] 取消超窗未获 DSH 确认，升级宿主 cancel（session=" + String(sessionId || "") + " task=" + taskId + "）");
    return { settled: "escalated" };
  } catch (e) {
    logWarn(log, "[dsh-session] 取消升级 ctx.tasks.cancel 失败：" + errText(e));
  }
  return { settled: "unresolved" };
}

/** 缺省升级实现：宿主 ctx.tasks.cancel（无宿主/无该 API 时报错，由调用方落成 unresolved）。 */
async function defaultCancelHostTask(taskId: string, reason: string): Promise<void> {
  const ctx = appCtx();
  if (!ctx || typeof ctx.tasks?.cancel !== "function") throw new Error("宿主不支持 ctx.tasks.cancel");
  await ctx.tasks.cancel(taskId, reason);
}

/**
 * cancel 工具主流程（**异步版**）：标记 + DSH session.cancel 后**立即返回**，终态结算丢后台。
 * 回执只说「已请求取消」；确认或抖窗升级的证据走两处：宿主任务的终态通知（投递到发起会话）
 * 与 App 日志。deps 可注入（单测断言「返回先于结算」）。
 */
export async function requestCancel({ sessionId, reason, log, confirmMs = CANCEL_CONFIRM_MS, deps = {} }: {
  sessionId: string;
  reason?: string;
  log?: any;
  confirmMs?: number;
  deps?: CancelDeps;
}): Promise<CancelWorkResult> {
  const runCancel =
    deps.executeCancel || ((a: { sessionId: string; reason?: string; log?: any }) => executeCancel(a));
  const settle = deps.settle || settleCancelTerminal;
  const res = await runCancel({ sessionId, reason, log });
  if (res.status !== "cancelling" || !res.taskId) return res;
  const taskId = String(res.taskId);
  void Promise.resolve()
    .then(() => settle({ taskId, sessionId: res.sessionId, reason, confirmMs, log }))
    .catch((e) => logWarn(log, "[dsh-session] 取消结算异常：" + errText(e)));
  return res;
}

/**
 * 取消编排（**等待版**）：执行超时看门狗用——它本就在后台，要的是收尾判断。工具路径用
 * requestCancel，不要用本函数（它会等满窗口）。返回 { status, terminal?, escalated?, ... }。
 */
export async function cancelSessionWork({ sessionId, reason, log, confirmMs = CANCEL_CONFIRM_MS }): Promise<CancelWorkResult> {
  const res = await executeCancel({ sessionId, reason, log });
  if (res.status !== "cancelling" || !res.taskId) return res;
  const out = await settleCancelTerminal({
    taskId: String(res.taskId),
    sessionId: res.sessionId,
    reason,
    confirmMs,
    log,
  });
  if (out.settled === "terminal") return { ...res, status: "canceled", terminal: out.terminal };
  if (out.settled === "escalated") return { ...res, status: "canceled", escalated: true };
  return res;
}

/**
 * 当前 App 设置（同步读自持存储）；离线或文件损坏返回 null，由调用方决定回落。
 * 超时值从这里取：设置页写的就是这份存储（与数据模式同栈同 revision）。
 */
function settingsOrNull() {
  try {
    const dir = appDataDir();
    if (!dir) return null;
    return readSettingsSync(dir);
  } catch {
    return null;
  }
}

/** 执行超时秒解析（纯函数面）：显式值 > 0 采用；否则取 App 设置 defaultTimeoutSec；
 * 读不到/非法/0 回落 APP_SETTING_DEFAULTS.defaultTimeoutSec（与缺省单点同源）。 */
export function resolveTaskTimeoutSec(explicitSec) {
  if (Number.isFinite(Number(explicitSec)) && Number(explicitSec) > 0) return Math.round(Number(explicitSec));
  const v = Number(settingsOrNull()?.defaultTimeoutSec);
  if (Number.isFinite(v) && v > 0) return Math.round(v);
  return APP_SETTING_DEFAULTS.defaultTimeoutSec;
}

/** 审批自动拒绝超时毫秒（随 metadata.dsh 下传宿主任务记录，供 approval-bridge 读取；
 * 0 = 宿主不自动拒绝）。 */
export function resolveApprovalTimeoutMs() {
  const v = Number(settingsOrNull()?.approvalTimeoutSec);
  if (!Number.isFinite(v)) return 30000;
  return v > 0 ? Math.round(v * 1000) : 0;
}
