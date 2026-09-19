// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/task-binding.ts — 会话↔Hana 任务的绑定事实（唯一事实源 = 宿主任务记录）
//
// 事实源是宿主的任务记录本身：App 主进程在提交前把 DSH 坐标写进 ctx.tasks.create/update 的
// metadata.dsh；受管 runtime 子进程的 hana client 本来就有 tasks.list/get（自 v2 起就在
// AppRuntimeTasksV2 里），直接读同一份记录即可——不需要 dataDir 下的私有映射文件，也不需要
// 经桥向 App 问。metadata 是宿主的自由字典，"创建时还不知道 DSH sessionId" 这条时间差由
// 建会话之后的 tasks.update 补上。
//
// metadata.dsh 形状（**写入方一律给全量 dsh 对象**：tasks.update 的 metadata 是整体替换还是
// 浅合并，宿主契约没写死，给全量在两种语义下都正确）：
//   action / cwd / sessionId / rpcId / timeoutSec / approvalTimeoutMs / cancel
//
// 读侧分两类：
//   · 模型请求热路径（provider 身份判定）走 createTaskBindingIndex 的进程内短 TTL 缓存——
//     每个模型请求兜一次宿主往返不可接受；
//   · 句柄解析 / 取消标记 / 终态判定走 fresh 读（一次会话/任务一跳），宁可多一跳也不吃陈旧值。
//
// 进程内还有一处跨 bundle 的交付：受管 runtime 把同一个索引挂到
// globalThis[TASK_BINDING_GLOBAL_KEY]，供 cordis 子插件 @dshana/provider 的身份判定读取
// （两个 bundle 同进程但不能互相 import——与 __dshanaHana / __dshanaActiveModelRequests
// 同款约定；键名字面在 provider 侧复制为 TASK_BINDING_GLOBAL_KEY）。
//
// 读取失败（宿主不可达、任务面缺失、绑定记录畸形）抛 code TASK_MAP_BROKEN：状态丢了必须
// 显式失败，绝不降级成"没有绑定"（那会让一条活着的任务丢掉 taskId、结果不回投）。
import { errText } from "#/lib/err-text.ts";
import { TERMINAL_STATUSES } from "#/lib/watch-sse.ts";

/** dshSessionId 形态（防畸形名进宿主查询；与 tools/query 的正则同源）。 */
export const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: unknown): boolean {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

/** 绑定读取失败的 code（上层据此转 LlmError / 拒绝操作）。 */
export const TASK_MAP_BROKEN = "TASK_MAP_BROKEN";

/** 索引缓存 TTL：模型热路径每 TTL 至多一次宿主往返。 */
export const TASK_BINDING_TTL_MS = 3000;

/** 绑定索引的 globalThis 键（cordis provider 子插件侧同名字面复制）。 */
export const TASK_BINDING_GLOBAL_KEY = "__dshanaTaskBindings";

/** 读取失败错误（code = TASK_MAP_BROKEN）。 */
export function taskBindingBroken(why: string, subject?: unknown): Error & { code: string } {
  const err = new Error(
    "task-binding: 宿主任务记录不可读（" + why + "，subject=" + String(subject ?? "-") + "）",
  ) as Error & { code: string };
  err.code = TASK_MAP_BROKEN;
  return err;
}

/** 一条工作单元里的取消标记。 */
export interface TaskCancelMark {
  at: number;
  reason: string;
}

/** 归一出的一条会话↔任务绑定（字段名沿用旧的映射记录词汇，读侧语义不变）。 */
export interface TaskBinding {
  taskId: string;
  dshSessionId: string;
  /** 内部动作词汇 create / send；记录里没有则 null。 */
  action: "create" | "send" | null;
  rpcId: string;
  timeoutSec: number | null;
  approvalTimeoutMs: number | null;
  cancel: TaskCancelMark | null;
  /** 宿主任务状态（pending/running/…/completed/failed/canceled/aborted）。 */
  status: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** metadata.dsh 的对象相；缺失/非对象返回 null（不是绑定，不是损坏）。 */
function dshObjectOf(record: any): Record<string, unknown> | null {
  const meta = record && record.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const dsh = (meta as Record<string, unknown>).dsh;
  return dsh && typeof dsh === "object" && !Array.isArray(dsh) ? (dsh as Record<string, unknown>) : null;
}

function finiteOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cancelOf(dsh: Record<string, unknown> | null): TaskCancelMark | null {
  const c = dsh && dsh.cancel;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const at = finiteOrNull((c as any).at);
  if (at === null) return null;
  return { at, reason: String((c as any).reason ?? "user").slice(0, 200) };
}

/**
 * 把宿主任务记录归一成一条绑定；**不是绑定**（没有合法 metadata.dsh.sessionId / 没有 taskId）
 * 返回 null。纯函数：判断"有没有绑定"与"记录畸形"的分界在调用方（按可归属的键判定异常，
 * 见 createTaskBindingIndex 的 broken 集）。
 */
export function taskBindingOf(record: any): TaskBinding | null {
  if (!record || typeof record !== "object") return null;
  const dsh = dshObjectOf(record);
  if (!dsh) return null;
  const sessionId = dsh.sessionId;
  if (!isValidSessionId(sessionId)) return null;
  const taskId = typeof record.taskId === "string" ? record.taskId : "";
  if (!taskId) return null;
  return {
    taskId,
    dshSessionId: sessionId as string,
    action: dsh.action === "send" ? "send" : dsh.action === "create" ? "create" : null,
    rpcId: typeof dsh.rpcId === "string" ? dsh.rpcId : "",
    timeoutSec: finiteOrNull(dsh.timeoutSec),
    approvalTimeoutMs: finiteOrNull(dsh.approvalTimeoutMs),
    cancel: cancelOf(dsh),
    status: typeof record.status === "string" ? record.status : "",
    createdAt: finiteOrNull(record.createdAt) ?? 0,
    updatedAt: finiteOrNull(record.updatedAt) ?? 0,
    completedAt: finiteOrNull(record.completedAt),
  };
}

/** 宿主任务是否已终结（终结后同会话续聊按 App 身份推理）。 */
export function isTerminalTaskStatus(status: unknown): boolean {
  return TERMINAL_STATUSES.includes(String(status));
}

/**
 * 组装一次 metadata 写入的全量对象：保留任务上已有的其它 metadata 键，只把 dsh 整块替换成
 * "已有 dsh + patch"。写入方必须经这里取 metadata——tasks.update 的合并语义没写死。
 */
export function dshMetadataFor(record: any, patch: Record<string, unknown>): Record<string, unknown> {
  const meta = record && record.metadata;
  const base = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  const dsh = dshObjectOf(record) || {};
  return { ...base, dsh: { ...dsh, ...patch } };
}

/** 绑定索引的读/写面（写点之后自己失效缓存）。 */
export interface TaskBindingIndex {
  /** 会话当前绑定的任务（同会话多条取 createdAt 最新的一条）；没有绑定返回 null。 */
  bySession(sessionId: string, opts?: { fresh?: boolean }): Promise<TaskBinding | null>;
  /** 按 taskId 直接读宿主记录（冷路径，不吃缓存）。 */
  byTask(taskId: string): Promise<TaskBinding | null>;
  /** 写取消标记（读-改-写全量 metadata）并失效缓存。 */
  markCancel(taskId: string, reason?: string): Promise<TaskBinding | null>;
  /** 手工失效缓存（读侧写点之后调用）。 */
  invalidate(): void;
}

interface TaskIndexSnapshot {
  at: number;
  bySession: Map<string, any>;
}

function orderOf(record: any): number {
  const n = Number(record && record.createdAt);
  if (Number.isFinite(n)) return n;
  const u = Number(record && record.updatedAt);
  return Number.isFinite(u) ? u : 0;
}

/**
 * 建一个绑定索引。tasks = 宿主任务面（App 侧 ctx.tasks / runtime 侧 hana.tasks）。
 *
 * 会话键只认合法的 dshSessionId：metadata.dsh.sessionId 缺失/不是字符串/形态非法的记录进不了
 * 索引（它们本来也归不到任何会话）。**记录畸形**的可观察点在按 taskId 直读那一侧
 * （byTask/句柄路径）：记录自称有 dsh 绑定却归一不出会话，就是状态丢了，显式抛 TASK_MAP_BROKEN。
 */
export function createTaskBindingIndex(tasks: any, { ttlMs = TASK_BINDING_TTL_MS }: { ttlMs?: number } = {}): TaskBindingIndex {
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : TASK_BINDING_TTL_MS; // 0/非法 = 用缺省 TTL
  let cached: TaskIndexSnapshot | null = null;
  // 缓存代次：invalidate() 递增。一次 build 只在“它的读回期间没被失效过”（gen 仍是最新）时才有
  // 资格写 cached，且只接受比已发布更新的一次（两个 build 乱序完成时，旧的一个不得盖掉新的）。
  let generation = 0;
  let buildSerial = 0;
  let publishedSerial = 0;
  let inflight: { generation: number; promise: Promise<TaskIndexSnapshot> } | null = null;

  function invalidate() {
    cached = null;
    generation += 1;
  }

  async function build(gen: number, serial: number): Promise<TaskIndexSnapshot> {
    if (typeof tasks?.list !== "function") {
      throw taskBindingBroken("宿主任务面不可用（tasks.list 缺失）");
    }
    let rows: unknown;
    try {
      rows = await tasks.list();
    } catch (e) {
      throw taskBindingBroken("tasks.list 失败：" + errText(e));
    }
    if (!Array.isArray(rows)) throw taskBindingBroken("tasks.list 未返回数组");
    const bySession = new Map<string, any>();
    for (const rec of rows) {
      if (!rec || typeof rec !== "object") continue;
      const dsh = dshObjectOf(rec);
      if (!dsh) continue;
      const raw = (dsh as Record<string, unknown>).sessionId;
      if (!isValidSessionId(raw)) continue; // 归不到任何会话（键不是合法 dshSessionId）
      const prev = bySession.get(raw as string);
      if (!prev || orderOf(rec) >= orderOf(prev)) bySession.set(raw as string, rec);
    }
    const snap: TaskIndexSnapshot = { at: Date.now(), bySession };
    if (gen === generation && serial > publishedSerial) {
      publishedSerial = serial;
      cached = snap;
    }
    return snap;
  }

  function startBuild(): Promise<TaskIndexSnapshot> {
    const gen = generation;
    const serial = ++buildSerial;
    const promise = build(gen, serial).finally(() => {
      if (inflight && inflight.promise === promise) inflight = null;
    });
    inflight = { generation: gen, promise };
    return promise;
  }

  function ensure(fresh: boolean): Promise<TaskIndexSnapshot> {
    if (!fresh && cached && Date.now() - cached.at < ttl) return Promise.resolve(cached);
    // fresh 读必须发起于调用者的写点之后：不复用代次不符的在途 build（那可能是写前开始的读）。
    if (!fresh && inflight && inflight.generation === generation) return inflight.promise;
    return startBuild();
  }

  return {
    async bySession(sessionId, opts) {
      const sid = typeof sessionId === "string" ? sessionId : "";
      if (!isValidSessionId(sid)) return null;
      const snap = await ensure(opts?.fresh === true);
      const rec = snap.bySession.get(sid);
      if (!rec) return null;
      const binding = taskBindingOf(rec);
      if (!binding) throw taskBindingBroken("绑定记录缺 taskId", sid);
      return binding;
    },

    async byTask(taskId) {
      const id = String(taskId || "").trim();
      if (!id) return null;
      if (typeof tasks?.get !== "function") throw taskBindingBroken("宿主任务面不可用（tasks.get 缺失）", id);
      let rec: any = null;
      try {
        rec = await tasks.get(id);
      } catch (e) {
        throw taskBindingBroken("tasks.get 失败：" + errText(e), id);
      }
      if (!rec) return null;
      const binding = taskBindingOf(rec);
      // 记录自称有 dsh 绑定（metadata.dsh 是对象）却归一不出会话 = 状态丢了，显式失败；
      // 完全不带 dsh 的记录才是"没有绑定"。
      if (!binding && dshObjectOf(rec)) {
        throw taskBindingBroken("任务记录的 metadata.dsh 归一不出合法会话绑定", id);
      }
      return binding;
    },

    async markCancel(taskId, reason) {
      const id = String(taskId || "").trim();
      if (!id) return null;
      let rec: any = null;
      try {
        rec = await tasks.get(id);
      } catch (e) {
        throw new Error("task-binding: 取消标记写入前读任务失败（" + errText(e) + "，task=" + id + "）");
      }
      if (!rec) return null;
      const metadata = dshMetadataFor(rec, {
        cancel: { at: Date.now(), reason: String(reason || "user").slice(0, 200) },
      });
      let updated: any = null;
      try {
        updated = await tasks.update(id, { metadata });
      } catch (e) {
        throw new Error("task-binding: 取消标记写入失败（" + errText(e) + "，task=" + id + "）");
      }
      invalidate();
      return taskBindingOf(updated ?? rec);
    },

    invalidate,
  };
}

/**
 * 把索引暴露到 globalThis（受管 runtime 在挂桥时调用），供 cordis 子插件 @dshana/provider
 * 的身份判定读取。返回 dispose（卸载时清掉——只清自己挂的那一个）。
 */
export function publishTaskBindingIndex(index: TaskBindingIndex): () => void {
  const g = globalThis as any;
  try {
    g[TASK_BINDING_GLOBAL_KEY] = index;
  } catch {
    return () => { /* 挂不上：身份判定会报 BINDING_UNAVAILABLE（显式失败，不降级） */ };
  }
  return () => {
    try {
      if (g[TASK_BINDING_GLOBAL_KEY] === index) delete g[TASK_BINDING_GLOBAL_KEY];
    } catch { /* 忽略 */ }
  };
}
