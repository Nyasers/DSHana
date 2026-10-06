// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/shared/target.ts — 目标解析（句柄优先、凭证显式）
//
// 与任务归属校验配套的公共入口，reply/close/get/approve 共用：
//   · 显式 sessionId ⇒ 凭证路径：直接用，跳过归属校验（故意跨对话的能力保留）；
//   · taskId ⇒ 句柄路径：读**宿主任务记录**的 metadata.dsh.sessionId 得会话坐标
//     （见 lib/task-binding.ts），再以该记录的 parentSessionPath 校验归属
//     （packages/session/src/task-ownership.ts）；
//   · approvalId ⇒ 句柄路径：宿主审批记录的 parentTaskId 指向父任务，取父任务的
//     metadata.dsh.sessionId 与 parentSessionPath（审批记录本身就带父任务的归属字段）。
// 解析不出来一律显式失败：不猜、不降级。
import { taskBindingOf, isValidSessionId } from "@dshana/shared/task-binding.ts";
import { taskOwnership, ownershipRefusalText } from "@dshana/session/task-ownership.ts";
import { errText } from "@dshana/shared/err-text.ts";
import type { OwnershipReason } from "@dshana/session/task-ownership.ts";
import type { ToolCtx } from "@dshana/shared/host.ts";
import type { ToolInputBase } from "./types.ts";

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
    throw new Error("failed to read the host task record (ownership cannot be verified; fail-closed): " + errText(e));
  }
}

export async function resolveTarget(input: ToolInputBase, ctx: ToolCtx): Promise<ResolvedTarget> {
  const explicit = String((input && input.sessionId) || "").trim();
  if (explicit) {
    if (!isValidSessionId(explicit)) {
      throw new Error("malformed sessionId (expected session-<uuid>): " + explicit);
    }
    return { sessionId: explicit, explicit: true, taskId: null, ownership: "explicit-session-id" };
  }
  const taskIdIn = String((input && input.taskId) || "").trim();
  const approvalIdIn = String((input && input.approvalId) || "").trim();
  if (!taskIdIn && !approvalIdIn) {
    throw new Error("a target is required: pass taskId (default, handle path) or sessionId (explicit credential path)");
  }
  // 句柄 → 宿主任务记录：taskId 直接是任务；approvalId 经宿主审批记录的 parentTaskId 取父任务。
  let taskId = taskIdIn;
  if (!taskId) {
    const approval = await readTaskRecord(ctx, approvalIdIn);
    const parent = approval && typeof (approval as any).parentTaskId === "string" ? String((approval as any).parentTaskId) : "";
    if (!parent) {
      throw new Error(
        "no host task found for this approval (the approval may have been reclaimed, or the host record lacks parentTaskId): " + approvalIdIn +
          ". To operate across conversations, pass sessionId explicitly.",
      );
    }
    taskId = parent;
  }
  const record = await readTaskRecord(ctx, taskId);
  const binding = taskBindingOf(record);
  const sessionId = binding ? binding.dshSessionId : "";
  if (!sessionId) {
    throw new Error(
      "no DSH session found for this handle (the task may have been reclaimed, or the host record's metadata.dsh.sessionId is missing/invalid): " +
        (taskIdIn || approvalIdIn) + ". To operate across conversations, pass sessionId explicitly.",
    );
  }
  const sessionPath = input && input.context ? input.context.sessionPath : null;
  const verdict = taskOwnership({ taskRecord: record, sessionPath, explicitSessionId: false });
  if (!verdict.ok) throw new Error(ownershipRefusalText(verdict.reason));
  return { sessionId, explicit: false, taskId, ownership: verdict.reason };
}
