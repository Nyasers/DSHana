// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/session/src/approve-respond.ts — dshana approve 应答编排（App 主进程侧）
//
// 职责：
//   用户/Agent 经 dshana(action=approve, sessionId, approvalId, outcome) 应答 →
//   本模块校验审批归属（宿主审批记录的 parentTaskId → 父任务的 metadata.dsh.sessionId
//   必须等于给定会话；记录本身没有 outcome 才允许应答——防串会话/重复应答）→
//   ctx.tasks.respondApproval({ approvalId, outcome }) 结算宿主审批 → 受管 runtime 的
//   approval-bridge 经 watch(approvalId) 观察到终态 outcome，只投给**该 approvalId 对应的
//   DSH 等待者**（allowed-once/rejected 原样，绝不自动 allowed-once）。本模块**不**直接向
//   DSH 投递任何结果——宿主审批记录是唯一决策事实源。
//
//   超时/父任务结束/撤销：宿主侧把审批结算成 rejected（timeoutMs 自动拒绝 / 父任务终态
//   拒绝剩余审批），approval-bridge watch 同样把 rejected 投给 DSH 等待者——DSH 得到
//   确定终态，绝不隐式放行。本模块不设本地定时器（不重复宿主语义）。
import { appCtx } from "@dshana/runtime/app-runtime.ts";
import { taskBindingOf } from "@dshana/shared/task-binding.ts";
import { errText } from "@dshana/shared/err-text.ts";
import type { ToolResult } from "./tool-result.ts";

/** 宿主审批记录（ctx.tasks.respondApproval 的返回值；从 ctx 下钻，勿手抄形状）。 */
type SettledApproval = Awaited<
  ReturnType<NonNullable<ReturnType<typeof appCtx>>["tasks"]["respondApproval"]>
>;

/** 读一条宿主记录（任务/审批同面）；读失败显式抛（归属校验必须 fail-closed）。 */
async function readRecord(ctx: NonNullable<ReturnType<typeof appCtx>>, id: string): Promise<any> {
  try {
    return await ctx.tasks.get(id);
  } catch (e) {
    throw new Error("failed to read the host record (approval ownership cannot be verified; fail-closed): " + errText(e));
  }
}

/** 校验并应答一个挂起审批；返回 { content:[...], details }（与 v1 approve.js 同形态）。 */
export async function respondApprovalAction({ input, log }): Promise<ToolResult> {
  const sessionId = String((input && input.sessionId) || "").trim();
  const approvalId = String((input && input.approvalId) || "").trim();
  const outcome = input && input.outcome === "rejected" ? "rejected" : "allowed-once";
  if (!sessionId) throw new Error("approve requires sessionId (the DSH session the approval belongs to)");
  if (!approvalId) throw new Error("approve requires approvalId (carried in the approval notice; one task can have several pending approvals, answer them one by one)");

  const ctx = appCtx();
  if (!ctx) throw new Error("App runtime not initialized (apply did not inject host ctx/dataDir)");
  if (!ctx.tasks || typeof ctx.tasks.respondApproval !== "function") {
    throw new Error("host ctx.tasks.respondApproval unavailable (missing the app/tasks.manage capability grant)");
  }

  // 归属校验的事实源是宿主记录：审批记录自带 parentTaskId，父任务的 metadata.dsh.sessionId
  // 必须等于调用方给的会话。不一致/缺失一律拒绝（宁可拒绝一次，不拿来源不明的审批去结算）。
  const approval = await readRecord(ctx, approvalId);
  if (!approval) throw new Error("approval " + approvalId + " not found (it may have been reclaimed or the host record cleared)");
  const parentTaskId = typeof (approval as any).parentTaskId === "string" ? String((approval as any).parentTaskId) : "";
  if (!parentTaskId) {
    throw new Error("the host record of approval " + approvalId + " lacks parentTaskId (invalid state); rejected fail-closed");
  }
  const parent = await readRecord(ctx, parentTaskId);
  const binding = taskBindingOf(parent);
  if (!binding || binding.dshSessionId !== sessionId) {
    throw new Error(
      "approval " + approvalId + " does not belong to session " + sessionId + " (host record points to " +
        (binding ? binding.dshSessionId : "no binding") + "); rejected fail-closed",
    );
  }
  const already = (approval as any).outcome;
  if (already === "allowed-once" || already === "rejected") {
    throw new Error("approval " + approvalId + " was already answered (" + already + "); do not answer again");
  }

  // 结算宿主审批（权威决策源）；失败（已超时/他方已应答/宿主已终态）直接抛给 Agent
  let settled: SettledApproval | null = null;
  try {
    settled = await ctx.tasks.respondApproval({ approvalId, outcome });
  } catch (e) {
    const msg = errText(e);
    throw new Error("approval answer not accepted (" + msg.slice(0, 300) + "): it may have timed out or been handled by another party; the task side observes the terminal state on its own");
  }

  const verb = outcome === "allowed-once" ? "已放行" : "已拒绝";
  return {
    content: [
      {
        type: "text",
        text:
          verb + "审批 " + approvalId +
          "。决策只投给该审批对应的 DSH 等待者（allowed-once 仅放行本次操作）；DSH 侧继续/收尾结果随后续任务通知送达。",
      },
    ],
    details: {
      dsh: {
        action: "approve",
        sessionId,
        approvalId,
        taskId: parentTaskId,
        outcome,
        accepted: !!(settled && ((settled as any).outcome || (settled as any).status)),
      },
    },
  };
}
