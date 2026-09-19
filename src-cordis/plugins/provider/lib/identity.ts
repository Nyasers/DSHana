// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/identity.ts — 模型请求身份判定
// （《DSHana 调用 Hana 模型接口指南》§3/§5）
//
// 身份参数二选一，且不能同时传；本 adapter 只可能给出两种形态：
//   · 会话有任务绑定**且任务仍活动**（dshana_session 创建/续写）→ { taskId }：
//     保留任务绑定，结果沿 task-bridge 回投到发起它的 Hana 会话；
//   · App 身份 → {}：callToken 与 taskId 都不传，宿主据此把请求归属 App 自己。
// 注意 models.stream **不接受** scope 字段（scope:"app" 是 models.utility 的参数）。
//
// 绑定事实源是**宿主任务记录**的 metadata.dsh（taskId / dshSessionId / status），由
// 受管 runtime 的 src/lib/task-binding.ts 建索引，经 globalThis.__dshanaTaskBindings
// 暴露给本插件（provider 是 cordis 子插件 bundle，dsh-host 是 runtime bundle，两者同进程
// 但不同 bundle，不能互相 import——与 __dshanaHana / __dshanaActiveModelRequests 同款约定；
// 键名字面与 src/lib/task-binding.ts 的 TASK_BINDING_GLOBAL_KEY 一致）。
//
// 三态判定（**App 身份仅限“用户直接在 WebUI 使用”**）：
//   ① 无绑定            ⇒ App 身份。**只有**这里与下一条才允许 App 身份。
//   ② 有绑定 + 任务终结 ⇒ App 身份（任务已终结，用户接着在 WebUI 里跑——事实，不是降级）
//   ③ 有绑定 + 任务活动 ⇒ { taskId }（必须：这是我们建的会话，绑定不能丢）
//   ④ 绑定读不出/索引缺席 ⇒ **报错**（TASK_MAP_BROKEN / BINDING_UNAVAILABLE → 上层转 LlmError）
// ④ 是关键：“状态读不到”不能降级成 App 身份——那等于把“状态丢了”伪装成“用户会话”，
// 对一条还活着的任务就是丢掉绑定、结果不回投，静默失败。
//
// 明确不做的事：拿到失效或归属不正确的 taskId 时，**不得**捕获错误、删掉身份参数重新调用。
// 那种情况必须让宿主报错并原样上抛，由 DSH 的错误处理呈现给对应会话。本模块只回答
// “这条会话的身份是什么”，不承担任何降级重试。
//
// 判定函数是纯函数（可被 node --test 直接 import）；宿主读取单独一层，只在 adapter 运行期用。
import { errText } from "./err-text.ts";

/** 绑定索引的 globalThis 键（与 src/lib/task-binding.ts 的 TASK_BINDING_GLOBAL_KEY 一致）。 */
export const TASK_BINDING_GLOBAL_KEY = "__dshanaTaskBindings";

/** 绑定读取失败（宿主不可达/记录损坏）的 code。 */
export const TASK_MAP_BROKEN = "TASK_MAP_BROKEN";
/** 绑定能力缺席（索引未挂载 = 受管 runtime 未把索引暴露给本插件）的 code。 */
export const BINDING_UNAVAILABLE = "BINDING_UNAVAILABLE";

/** 宿主任务终态（终结后同会话续聊按 App 身份推理）。 */
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "canceled", "aborted"];

/** 身份判定只读这两格：taskId 与宿主任务状态。 */
export interface TaskBindingView {
  taskId: string;
  status: string;
}

/** 模型请求身份判定结果。 */
export interface ModelIdentity {
  identity: { taskId?: string };
  source: "task" | "app";
  reason?: string;
}

/** 绑定读取失败错误（code 供上层转 LlmError）。 */
export function identityError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * 纯函数：三态判定（见文件头）。
 * @param binding 会话当前绑定；null = 没有绑定（不是我们创建的会话）
 * @throws 不抛——读取失败由调用方在建 binding 之前处理
 */
export function resolveModelIdentity(binding: TaskBindingView | null | undefined): ModelIdentity {
  // ① 无绑定 ⇒ 不是我们创建的会话（用户在 WebUI 自建）⇒ App 身份。
  if (!binding) return { identity: {}, source: "app", reason: "unowned-session" };
  // ② 我们建的，但任务已终结（用户接着在 WebUI 里跑）⇒ App 身份。
  if (TERMINAL_TASK_STATUSES.includes(String(binding.status))) {
    return { identity: {}, source: "app", reason: "task-ended" };
  }
  // ③ 我们建的、任务活动 ⇒ 必须带 taskId（失效由宿主报错，不降级）。
  if (typeof binding.taskId !== "string" || !binding.taskId) {
    throw identityError(TASK_MAP_BROKEN, "task-binding: 绑定记录缺 taskId");
  }
  return { identity: { taskId: binding.taskId }, source: "task" };
}

/**
 * 运行期：经 globalThis 上的绑定索引解析会话身份。
 * 索引缺席（能力未挂载）⇒ 抛 BINDING_UNAVAILABLE；索引读取失败 ⇒ 原样上抛
 * （索引自己抛 TASK_MAP_BROKEN）。两者都不降级成 App 身份。
 */
export async function resolveSessionIdentity(sessionId: unknown, index?: unknown): Promise<ModelIdentity> {
  let handle = index;
  if (handle === undefined) {
    try {
      handle = (globalThis as any)[TASK_BINDING_GLOBAL_KEY] || null;
    } catch {
      handle = null;
    }
  }
  if (!handle || typeof (handle as any).bySession !== "function") {
    throw identityError(
      BINDING_UNAVAILABLE,
      "会话绑定不可读：受管 runtime 未暴露任务绑定索引（" + TASK_BINDING_GLOBAL_KEY + " 缺席）",
    );
  }
  let binding: TaskBindingView | null = null;
  try {
    binding = await (handle as any).bySession(String(sessionId ?? ""));
  } catch (e) {
    throw identityError(
      (e as any)?.code === TASK_MAP_BROKEN ? TASK_MAP_BROKEN : "TASK_IDENTITY_UNRESOLVED",
      "会话绑定读取失败：" + errText(e),
    );
  }
  return resolveModelIdentity(binding);
}
