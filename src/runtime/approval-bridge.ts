// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/approval-bridge.ts — 受管 runtime 内 DSH 审批 → Hana 审批桥
//
// 位置与角色：本模块随 dist/runtime/dsh-host.mjs 打进受管 runtime（与 DSH 同进程），
// main.js 在 DSH boot 就绪后挂载（先于 readyMarker）。它把 DSH 的审批等待者接到 Hana：
//
//   DSH 工具越界/敏感操作（sandbox 升级 approval/policy=ask）
//     → ApprovalService.request → ctx.waterfall(scopeTarget(agent), 'approval/request', …)
//     → 本桥以 ctx.on('approval/request', …, { global: true, prepend: true }) 认领
//       （v1 实证：无 scope 的 ctx.on 因 context filter 收不到 agent-scope 瀑布事件，
//       EventOptions.global = true 无视 context filter 收所有 agent——见 v1 acp-mount）
//     → 按宿主任务记录定位宿主 task（metadata.dsh.sessionId → taskId；绑定读取见
//       lib/task-binding.ts）
//     → hana.tasks.requestApproval({ taskId, label, details, timeoutMs })
//     → 挂起 ApprovalOutcome 承诺，经 watch(approvalId) SSE（snapshot 首条 + app-task；
//       断线 get() 对账；reset 重读快照——lib/watch-sse.js）等宿主终态：
//          outcome=allowed-once → 'allowed-once'（仅本次放行）
//          outcome=rejected     → 'rejected'
//          终态无 outcome（父任务结束/撤销）→ 'rejected'（fail closed，绝不隐式放行）
//          审批超时（timeoutMs 宿主自动拒绝）→ 'rejected'
//     → 只投给该 approvalId 对应的 DSH 等待者（承诺闭包天然定向，不广播）
//
//   DSH 请求侧取消（req.signal abort / 回合中止）：宿主审批若仍 pending → 应答 rejected
//   收尾（不留孤儿审批；父任务终态兜底），DSH 侧 resolve 'cancelled'——不把取消当授权。
//
// 审批载荷写出**具体操作**：宿主那条通知的正文是 `Approval requested: <label>`，label 之外的部分
// 不保证写进审批方的视线；而审批是 Agent 的活，拿不到"要动什么"就只能凭信任签字。所以 label 由
// `buildApprovalLabel` 拼出工具名之外的实义（目标路径 / 命令 / 替换规模 + 申请的权限档），details
// 同源带上 operation / escalationMode / escalationNote /
// approvalTimeoutMs（审批方还有多久）。
//
// 审批等待不计入执行超时：任务执行超时走 cancel 链（session-run 看门狗 → session.cancel
// → 本桥 answerer 的 req.signal 中止 → 上面收尾路径），宿主审批由 approval 的 timeoutMs
// 独立自动拒绝。
import {
  createTaskBindingIndex,
  isValidSessionId,
  type TaskBindingIndex,
} from "#/lib/task-binding.ts";
import { approvalOutcomeOf, runWatchReconcile } from "#/lib/watch-sse.ts";
// 宿主审批契约类型只进类型层（swc / Node 剥类型后不留运行时 import）
import type {
  AppTaskApprovalOutcome,
  AppTaskApprovalRecordV2,
  AppTaskApprovalRequestV2,
} from "#/types/host.ts";

// 审批超时：**30s 是我们自己的策略，不是宿主默认**。APPS.md（0.951.4，后台任务与审批节）明写
// `requestApproval({…, timeoutMs})` 的 `timeoutMs: 0` 禁用超时，**默认也是 0**；父任务结束会拒绝剩余
// 审批；**同一审批的竞争应答只有一次结算**（所以本 App 的去重是友好报错，不是正确性保障）。
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30000; // 显式下传的 App 侧策略（manifest approvalTimeoutSec 默认 30s）
export const TOOL_ARGS_PREVIEW_MAX = 4000; // args 预览上限（审批决策证据，防超大载荷）
const CACHE_SESSION_CAP = 32; // tool-call 缓存会话数上限（有界，防无界内存增长）
const CACHE_CALL_CAP = 64; // 每会话 callId 上限

/** 取错误的可读文本。catch 到的值类型未知，字段访问一律经这里。 */
const errText = (e: unknown): string => ((e as any)?.message as string) || String(e);

/** DSH approval/request 事件里本桥读取的字段（结构面：只声明我们真读到的键）。 */
export interface DshApprovalRequestLike {
  agent?: { session?: { id?: string | null } | null } | null;
  callId?: string | null;
  toolName?: string | null;
  reason?: string | null;
  signal?: AbortSignal | null;
}

/** 一条 tool-call 缓存帧（collectToolCallsFromEvent 的产物）。 */
export interface ToolCallFrame {
  sessionId: string;
  callId: string;
  name: string;
  args: string | null;
}

/** 缓存条目：审批请求只带 callId，name/args 由 tool-call 块补齐。 */
interface ToolCallEntry {
  name: string;
  args: string | null;
}

/** 未结算审批的句柄（stop / 结算时按 approvalId 定位）。 */
interface PendingApproval {
  sessionId: string;
  approvalId: string;
}

/** DSH 等待者收到的裁决：宿主 outcome 原样 + 我侧取消（取消绝不当授权）。 */
type DshApprovalVerdict = AppTaskApprovalOutcome | "cancelled";

/** ctx 事件订阅选项（global 无视 context filter 收所有 agent 的瀑布事件）。 */
interface BridgeEventOptions {
  global?: boolean;
  prepend?: boolean;
}

/** 纯函数：审批请求归一（供单测）。req = DSH ApprovalRequestEvent 的序列化形态。 */
export function approvalSessionIdOf(req: DshApprovalRequestLike | null | undefined): string | null {
  const agent = req && req.agent;
  return agent && agent.session && typeof agent.session.id === "string" ? agent.session.id : null;
}

/** args 预览（纯函数）：JSON 字符串截断 + 拍平对象。 */
export function previewArgs(value: unknown, max: number = TOOL_ARGS_PREVIEW_MAX): string | null {
  if (value === undefined || value === null) return null;
  let s = "";
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  s = s.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 压平空白 + 截断到上限（保头也保尾，路径这类值的尾部同样承载信息）。 */
export function clipForLabel(value: unknown, max: number): string {
  const s = String(value === null || value === undefined ? "" : value).replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const head = Math.max(1, Math.floor(max * 0.4));
  const tail = Math.max(1, max - head - 1);
  return s.slice(0, head) + "…" + s.slice(-tail);
}

/** 解析 args 预览为对象；失败/非对象返回 null（预览被截断过也会走这条路）。 */
function parseArgsObject(argsJson: string | null): Record<string, unknown> | null {
  if (!argsJson) return null;
  try {
    const v = JSON.parse(argsJson);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 各工具族的字段别名（DSH 工具面用 snake_case，Hana 侧偶见 camelCase）
const PATH_KEYS = ["file_path", "filePath", "path", "target", "targetPath", "notebook_path", "file"];
const COMMAND_KEYS = ["command", "cmd", "script", "shell_command"];
const CONTENT_KEYS = ["content", "contents", "new_string", "new_str", "text", "data"];
const OLD_KEYS = ["old_string", "old_str"];
const URL_KEYS = ["url", "endpoint"];
const MODE_KEYS = ["sandbox_permissions", "sandboxPermissions", "sandbox", "permission_mode"];

function firstStringOf(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function firstKeyOf(obj: Record<string, unknown> | null, keys: string[]): unknown {
  if (!obj) return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return null;
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  try { return JSON.stringify(value).length; } catch { return 0; }
}

/** 纯函数：把一次待审批的工具调用写成"具体操作"一句（审批方要判的第一件事）。
 *
 *  这是通知里唯一保证写进视线的实义（label 的一部分），所以宁可具体、宁可截断：
 *  `写文件 <path>（n 字符）` / `改文件 <path>（替换 a → b 字符）` / `执行命令 <cmd>` /
 *  `访问 <path>` / `请求 <url>`，认不出的工具退回 `调用 <tool>（args 摘要）`。
 */
export function summarizeOperation(toolName: string, argsJson: string | null, max: number = 160): string {
  const tool = clipForLabel(toolName || "tool", 40);
  const obj = parseArgsObject(argsJson);
  if (!obj) {
    return argsJson ? "调用 " + tool + "（" + clipForLabel(argsJson, max) + "）" : "调用 " + tool;
  }
  const command = firstStringOf(obj, COMMAND_KEYS);
  if (command) return "执行命令 " + clipForLabel(command, max);
  const target = firstStringOf(obj, PATH_KEYS);
  const oldText = firstStringOf(obj, OLD_KEYS);
  const hasContent = firstKeyOf(obj, CONTENT_KEYS) !== null || firstStringOf(obj, CONTENT_KEYS) !== null;
  if (target && oldText) {
    return "改文件 " + clipForLabel(target, max) + "（替换 " + oldText.length + " → " + sizeOf(firstKeyOf(obj, CONTENT_KEYS)) + " 字符）";
  }
  if (target && hasContent) {
    return "写文件 " + clipForLabel(target, max) + "（" + sizeOf(firstKeyOf(obj, CONTENT_KEYS)) + " 字符）";
  }
  if (target) return "访问 " + clipForLabel(target, max);
  const url = firstStringOf(obj, URL_KEYS);
  if (url) return "请求 " + clipForLabel(url, max);
  return "调用 " + tool + "（" + clipForLabel(JSON.stringify(obj), max) + "）";
}

/** 纯函数：读出这次要申请的沙箱档位，附一句人话（未登记档位原样回显，不臆测语义）。 */
export function describeEscalation(argsJson: string | null): { mode: string; note: string } | null {
  const mode = firstStringOf(parseArgsObject(argsJson), MODE_KEYS);
  if (!mode) return null;
  const notes: Record<string, string> = {
    "danger-full-access": "越过工作区限制（工作区外读写、更宽执行面）",
    "require_escalated": "升级到受审的更宽模式",
    "workspace-write": "限工作区内写入",
    "read-only": "只读",
  };
  return { mode, note: notes[mode] || "未登记的模式，按宿主沙箱语义执行" };
}

/** 纯函数：宿主审批记录是否确实属于我们以为的那条任务（以宿主字段为准）。
 *
 *  契约上 `AppTaskApprovalRecordV2.parentTaskId` 必填；**缺失按不一致处理**（fail-closed）——
 *  宁可拒绝一次审批，也不拿一条来源不明的审批去等结果。
 */
export function approvalOwnsTask(approval: Partial<AppTaskApprovalRecordV2> | null | undefined, expectedTaskId: unknown): boolean {
  const got = approval && typeof approval.parentTaskId === "string" ? approval.parentTaskId : "";
  const want = String(expectedTaskId || "");
  return Boolean(got) && got === want;
}

/** tool-call 缓存：callId → { name, args }（审批请求只带 callId，name/args 由模型
 *  assistant/message 的 tool-call 块补齐——v1 toolCache 同款信息源）。 */
export function collectToolCallsFromEvent(sessionId: string | null, ev: any): ToolCallFrame[] {
  if (!sessionId || !ev || ev.type !== "assistant/message") return [];
  const data = ev.data && typeof ev.data === "object" ? ev.data : {};
  const message = data.message && typeof data.message === "object" ? data.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const out: ToolCallFrame[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "tool-call") continue;
    const callId = typeof block.id === "string" && block.id ? block.id : typeof block.callId === "string" ? block.callId : "";
    const name = typeof block.name === "string" ? block.name : "";
    if (!callId) continue;
    out.push({ sessionId, callId, name, args: previewArgs(block.arguments) });
  }
  return out;
}

/** 有界 tool-call 缓存（sessionId → Map(callId → {name,args})）。 */
export class ToolCallCache {
  sessions: Map<string, Map<string, ToolCallEntry>>;
  log: ((msg: string) => void) | null;
  constructor({ log }: { log?: (msg: string) => void } = {}) {
    this.sessions = new Map();
    this.log = log || null;
  }
  push(frames: ToolCallFrame[] | null | undefined): void {
    for (const f of frames || []) {
      if (!f || !f.sessionId || !f.callId) continue;
      let per = this.sessions.get(f.sessionId);
      if (!per) {
        if (this.sessions.size >= CACHE_SESSION_CAP) {
          const oldest = this.sessions.keys().next().value;
          if (oldest !== undefined) this.sessions.delete(oldest);
        }
        per = new Map();
        this.sessions.set(f.sessionId, per);
      }
      if (per.size >= CACHE_CALL_CAP) {
        const oldestKey = per.keys().next().value;
        if (oldestKey !== undefined) per.delete(oldestKey);
      }
      per.set(f.callId, { name: f.name || "tool", args: f.args || null });
    }
  }
  get(sessionId: string, callId: string): ToolCallEntry | null {
    const per = this.sessions.get(sessionId);
    return per && callId ? per.get(callId) || null : null;
  }
  clear(): void {
    this.sessions.clear();
  }
}

/** 纯函数：审批 label。宿主那条通知的正文是 `Approval requested: <label>`，label 之外的内容
 *  不保证写进审批方的视线，所以实义（具体操作 + 申请的权限档）都拼在这里。
 */
export function buildApprovalLabel(
  toolName: string,
  operation: string,
  escalation: { mode: string; note: string } | null,
): string {
  return (
    "DSH 请求执行越界/敏感操作（" + toolName + "）：" + operation +
    (escalation ? "；申请 " + escalation.mode + "：" + escalation.note : "")
  );
}

/** 挂载审批桥。@returns stop 函数（幂等）：退订 ctx 事件、中止全部等待中的审批 watcher。
 * 挂载失败抛错由 main.js 决定（不阻断 ready——审批不可用时 DSH 等待者 fail-closed）。
 * bindings 缺省用 hana.tasks 建绑定索引（读宿主任务记录里的 metadata.dsh）。
 */
export function startApprovalBridge({ ctx, hana, bindings, log }: { ctx: any; hana: any; bindings?: TaskBindingIndex; log?: (msg: string) => void }): () => void {
  const offs: Array<() => void> = [];
  const index = bindings || createTaskBindingIndex(hana && hana.tasks);
  const pendings = new Set<PendingApproval>(); // 未结算审批的取消器（stop 时统一中止）
  const cache = new ToolCallCache({ log });
  const note = (msg: string) => {
    try { if (typeof log === "function") log("[approval-bridge] " + msg); } catch { /* 忽略 */ }
  };

  const onEvent = (event: string, handler: (...args: any[]) => unknown, opts?: BridgeEventOptions) => {
    try {
      const off = ctx.on(event, handler, opts);
      if (typeof off === "function") offs.push(off);
    } catch {
      /* 单事件订阅失败跳过 */
    }
  };

  // ---- ① tool-call 缓存订阅（审批决策的 args 证据来源）----
  onEvent("session/event", (session, ev) => {
    const sid = session && typeof session.id === "string" ? session.id : null;
    try {
      cache.push(collectToolCallsFromEvent(sid, ev));
    } catch { /* 缓存失败忽略 */ }
  });

  // ---- ② approval/request global waterfall 认领 ----
  async function answerer(req: DshApprovalRequestLike, next: () => unknown) {
    const sessionId = approvalSessionIdOf(req);
    if (!sessionId || !isValidSessionId(sessionId)) {
      // 未知/畸形会话：不认领（next 委托其他应答者；无应答者 DSH fail-closed）
      return next();
    }
    // 绑定读取失败（宿主不可达/记录畸形）与"没有绑定"必须分开：前者不能委托给别的应答者
    // 假装无事发生（那会把"状态丢了"变成 DSH 的 fail-closed 拒绝，掩盖真因），显式拒绝并记日志。
    let binding;
    try {
      binding = await index.bySession(sessionId, { fresh: true });
    } catch (e) {
      note("审批会话绑定读取失败（fail-closed 拒绝，不委托）：" + errText(e));
      return "rejected";
    }
    if (!binding) {
      // 非 dshana 工具发起的会话（如 DSH Web UI 直开）：没有宿主 task scope，
      // 无法 requestApproval——委托（DSH 无应答者时 fail-closed，不隐式放行）
      note("审批无任务绑定（session=" + sessionId.slice(0, 12) + "）——委托，不认领");
      return next();
    }
    const callId = (req && req.callId) || null;
    const cached = callId ? cache.get(sessionId, callId) : null;
    const toolName = (req && req.toolName) || (cached && cached.name) || "tool";
    const args = previewArgs((cached && cached.args) || null);
    const reason = (req && req.reason) || null;
    const rpcId = binding.rpcId || "";
    // 缺省（null / 非有限数）落回 DEFAULT；显式 0 是“宿主不自动拒绝”的既定语义，原样保留。
    const configuredTimeoutMs = binding.approvalTimeoutMs;
    const timeoutMs =
      typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 0
        ? configuredTimeoutMs
        : DEFAULT_APPROVAL_TIMEOUT_MS;
    note("审批请求收到（session=" + sessionId.slice(0, 12) + " tool=" + toolName + (callId ? " call=" + callId.slice(0, 12) : "") + "）");

    const entry: PendingApproval = { sessionId, approvalId: "" }; // pendings 条目（审批创建后填 approvalId）
    // settleOutcome 在 Promise executor 内立即赋值；这里先给占位，声明处就把类型定死
    let settleOutcome: (outcome: DshApprovalVerdict) => void = () => { /* 待 executor 赋值 */ };
    let settled = false;
    let doRespond: ((outcome: AppTaskApprovalOutcome) => Promise<unknown>) | null = null;
    let cancelWatch: (() => void) | null = null;
    let abortedCleanup = false;
    const pending = new Promise<DshApprovalVerdict>((resolve) => {
      settleOutcome = (outcome) => {
        if (settled) return;
        settled = true;
        if (cancelWatch) { try { cancelWatch(); } catch { /* 忽略 */ } cancelWatch = null; }
        if (entry.approvalId) { try { pendings.delete(entry); } catch { /* 忽略 */ } }
        resolve(outcome);
      };
    });
    // req.signal 中止 = DSH 回合取消/中止：宿主审批收尾为 rejected（不留孤儿），
    // DSH 等待者 resolve 'cancelled'（不是 allowed-once——取消绝不当授权，v1 教训）
    const signal = req && req.signal;
    const onAbort = () => {
      if (settled) return;
      abortedCleanup = true;
      if (doRespond) {
        try { doRespond("rejected").catch(() => {}); } catch { /* 忽略 */ }
      }
      settleOutcome("cancelled");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    // 宿主审批创建
    // 具体操作一句（label 的实义部分）+ 申请的权限档：审批方要判的第一件事
    const operation = summarizeOperation(toolName, args);
    const escalation = describeEscalation(args);
    let approval: AppTaskApprovalRecordV2 | null = null;
    try {
      const request: AppTaskApprovalRequestV2 = {
        taskId: binding.taskId,
        label: buildApprovalLabel(toolName, operation, escalation),
        details: {
          dshSessionId: sessionId,
          rpcId,
          toolName,
          operation,
          ...(escalation ? { escalationMode: escalation.mode, escalationNote: escalation.note } : {}),
          ...(callId ? { callId } : {}),
          ...(reason ? { reason } : {}),
          ...(args ? { args } : {}),
          approvalTimeoutMs: timeoutMs,
          kind: "dsh-approval",
        },
        timeoutMs,
      };
      approval = await hana.tasks.requestApproval(request);
    } catch (e) {
      note("requestApproval 失败（fail-closed）：" + errText(e));
      settleOutcome("rejected"); // 创建失败 = 无法等待 = fail closed（绝不放行）
      return pending;
    }
    const approvalId = approval && approval.approvalId;
    if (!approvalId) {
      note("requestApproval 未返回 approvalId（fail-closed）");
      settleOutcome("rejected");
      return pending;
    }
    doRespond = (outcome) => hana.tasks.respondApproval({ approvalId, outcome });
    // 宿主权威字段交叉校验：审批记录自带 parentTaskId。不一致或缺失说明我们读到的绑定
    // 与宿主审批记录已经漂移——这种情况把审批结算成 rejected（fail-closed，绝不放行），
    // 不继续等一个可能属于别人的结果。
    if (!approvalOwnsTask(approval, binding.taskId)) {
      note(
        "审批 parentTaskId 与绑定不一致（宿主 " + String((approval && approval.parentTaskId) || "缺失") +
          " / 绑定 " + String(binding.taskId) + "）：fail-closed 拒绝",
      );
      try { await doRespond?.("rejected"); } catch { /* 尽力：宿主侧拒绝失败也仍投 rejected */ }
      settleOutcome("rejected");
      return pending;
    }
    // 立即按请求创建结果结算一次（宿主可能已即时终态——如父任务刚结束）
    const immediate = approvalOutcomeOf(approval);
    if (immediate) {
      note("审批 " + approvalId.slice(0, 12) + " 已即时终态：" + immediate);
      settleOutcome(immediate);
      return pending;
    }
    entry.approvalId = approvalId;
    pendings.add(entry);
    // watch(approvalId) 等宿主终态（SSE snapshot + app-task；断线 get() 对账）
    const stopFlag = { value: false };
    const watcher = (async () => {
      try {
        await runWatchReconcile({
          watch: () => hana.tasks.watch(approvalId),
          get: () => hana.tasks.get(approvalId),
          onFrame: async (rec, kind) => {
            if (settled || stopFlag.value) return false;
            if (kind === "snapshot" || kind === "app-task") {
              const outcome = approvalOutcomeOf(rec);
              if (outcome) {
                note("审批 " + approvalId.slice(0, 12) + " 终态 outcome=" + outcome + " → 投递 DSH 等待者");
                settleOutcome(outcome);
                return false; // 结算完成，结束 watch
              }
            }
            return true;
          },
          shouldStop: () => settled || stopFlag.value,
          retryBaseMs: 1000,
          maxRetryMs: 15000,
          log: (m) => note(m),
        });
      } catch (e) {
        note("审批 watch 异常（fail-closed）：" + errText(e));
        if (!settled) settleOutcome("rejected");
      } finally {
        try { pendings.delete(entry); } catch { /* 忽略 */ }
      }
    })();
    cancelWatch = () => { stopFlag.value = true; };
    void watcher;
    return pending;
  }
  onEvent("approval/request", (req, next) => answerer(req, next), { global: true, prepend: true });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const off of offs) {
      try { off(); } catch { /* 忽略 */ }
    }
    offs.length = 0;
    cache.clear();
    // 中止未结算 watcher（等待者由 DSH 信号/宿主终态自然收尾；stop 只是释放流）
    for (const p of [...pendings]) {
      try {
        if (p && p.sessionId && p.approvalId) {
          hana.tasks.respondApproval({ approvalId: p.approvalId, outcome: "rejected" }).catch(() => {});
        }
      } catch { /* 忽略 */ }
    }
    pendings.clear();
    note("审批桥已停止（订阅退订 + 未结算审批收尾 rejected）");
  };
  try {
    note("已挂载（approval/request global waterfall 应答 + tool-call 缓存 + watch 对账）");
  } catch { /* 忽略 */ }
  return stop;
}
