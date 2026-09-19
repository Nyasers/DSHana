// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/target.ts — 目标解析（句柄优先、凭证显式）
//
// 与任务归属校验配套的公共入口，reply/close/get/approve 共用：
//   · 显式 sessionId ⇒ 凭证路径：直接用，跳过归属校验（故意跨对话的能力保留）；
//   · taskId ⇒ 句柄路径：读**宿主任务记录**的 metadata.dsh.sessionId 得会话坐标
//     （见 lib/task-binding.ts），再以该记录的 parentSessionPath 校验归属
//     （lib/task-ownership.ts）；
//   · approvalId ⇒ 句柄路径：宿主审批记录的 parentTaskId 指向父任务，取父任务的
//     metadata.dsh.sessionId 与 parentSessionPath（审批记录本身就带父任务的归属字段）。
// 解析不出来一律显式失败：不猜、不降级。
import { taskBindingOf, isValidSessionId } from "#/lib/task-binding.ts";
import { taskOwnership, ownershipRefusalText } from "#/lib/task-ownership.ts";
import { errText } from "#/lib/err-text.ts";
import type { OwnershipReason } from "#/lib/task-ownership.ts";
import type { ToolCtx } from "#/types/host.ts";
import type { ToolInputBase } from "#/tools/shared/types.ts";

/** 宿主任务记录（ctx.tasks.get 的返回值；从 ctx 下钻，勿手抄形状）。 */
type HostTaskRecord = Awaited<ReturnType<NonNullable<ToolCtx["tasks"]>["get"]>>;

/** 解析出的调用目标（reply/close/get/approve 共用）。 */
export interface ResolvedTarget {
  sessionId: string;
  /** true = 显式 sessionId 的凭证路径（未做归属校验）。 */
  explicit: boolean;
  /** 句柄路径下解析出的宿主任务 id；凭证路径为 null。 */
  taskId: string | null;
  ownership: OwnershipReason;
}

/** 宿主任务读取：宿主不可达/面缺失抛错（句柄解析无法继续，fail-closed）。 */
async function readTaskRecord(ctx: ToolCtx, taskId: string): Promise<HostTaskRecord | null> {
  try {
    return ctx && ctx.tasks && typeof ctx.tasks.get === "function" ? await ctx.tasks.get(taskId) : null;
  } catch (e) {
    throw new Error("宿主任务记录读取失败（归属无法校验，按 fail-closed 处理）：" + errText(e));
  }
}

export async function resolveTarget(input: ToolInputBase, ctx: ToolCtx): Promise<ResolvedTarget> {
  const explicit = String((input && input.sessionId) || "").trim();
  if (explicit) {
    if (!isValidSessionId(explicit)) {
      throw new Error("sessionId 形态不对（应为 session-<uuid>）：" + explicit);
    }
    return { sessionId: explicit, explicit: true, taskId: null, ownership: "explicit-session-id" };
  }
  const taskIdIn = String((input && input.taskId) || "").trim();
  const approvalIdIn = String((input && input.approvalId) || "").trim();
  if (!taskIdIn && !approvalIdIn) {
    throw new Error("需要目标：传 taskId（默认，句柄路径）或 sessionId（显式凭证路径）");
  }
  // 句柄 → 宿主任务记录：taskId 直接是任务；approvalId 经宿主审批记录的 parentTaskId 取父任务。
  let taskId = taskIdIn;
  if (!taskId) {
    const approval = await readTaskRecord(ctx, approvalIdIn);
    const parent = approval && typeof (approval as any).parentTaskId === "string" ? String((approval as any).parentTaskId) : "";
    if (!parent) {
      throw new Error(
        "找不到该审批对应的宿主任务（审批可能已被回收，或宿主记录缺 parentTaskId）：" + approvalIdIn +
          "。要跨对话操作请显式传 sessionId。",
      );
    }
    taskId = parent;
  }
  const record = await readTaskRecord(ctx, taskId);
  const binding = taskBindingOf(record);
  const sessionId = binding ? binding.dshSessionId : "";
  if (!sessionId) {
    throw new Error(
      "找不到该句柄对应的 DSH 会话（任务可能已被回收，或宿主记录的 metadata.dsh.sessionId 缺失/非法）：" +
        (taskIdIn || approvalIdIn) + "。要跨对话操作请显式传 sessionId。",
    );
  }
  const sessionPath = input && input.context ? input.context.sessionPath : null;
  const verdict = taskOwnership({ taskRecord: record, sessionPath, explicitSessionId: false });
  if (!verdict.ok) throw new Error(ownershipRefusalText(verdict.reason));
  return { sessionId, explicit: false, taskId, ownership: verdict.reason };
}
