// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/approve-respond.ts — dshana approve 应答编排（App 主进程侧）
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
import { appCtx } from "#/lib/app-runtime.ts";
import { taskBindingOf } from "#/lib/task-binding.ts";
import { errText } from "#/lib/err-text.ts";
import type { ToolResult } from "#/types/tool.ts";

/** 宿主审批记录（ctx.tasks.respondApproval 的返回值；从 ctx 下钻，勿手抄形状）。 */
type SettledApproval = Awaited<
  ReturnType<NonNullable<ReturnType<typeof appCtx>>["tasks"]["respondApproval"]>
>;

/** 读一条宿主记录（任务/审批同面）；读失败显式抛（归属校验必须 fail-closed）。 */
async function readRecord(ctx: NonNullable<ReturnType<typeof appCtx>>, id: string): Promise<any> {
  try {
    return await ctx.tasks.get(id);
  } catch (e) {
    throw new Error("宿主记录读取失败（无法校验审批归属，按 fail-closed 处理）：" + errText(e));
  }
}

/** 校验并应答一个挂起审批；返回 { content:[...], details }（与 v1 approve.js 同形态）。 */
export async function respondApprovalAction({ input, log }): Promise<ToolResult> {
  const sessionId = String((input && input.sessionId) || "").trim();
  const approvalId = String((input && input.approvalId) || "").trim();
  const outcome = input && input.outcome === "rejected" ? "rejected" : "allowed-once";
  if (!sessionId) throw new Error("approve 需要 sessionId（审批所属 DSH 会话）");
  if (!approvalId) throw new Error("approve 需要 approvalId（审批通知里带；同一任务可挂起多个审批，逐个应答）");

  const ctx = appCtx();
  if (!ctx) throw new Error("App 运行包未初始化（apply 未注入宿主 ctx/dataDir）");
  if (!ctx.tasks || typeof ctx.tasks.respondApproval !== "function") {
    throw new Error("宿主 ctx.tasks.respondApproval 不可用（缺 app/tasks.manage 能力授予）");
  }

  // 归属校验的事实源是宿主记录：审批记录自带 parentTaskId，父任务的 metadata.dsh.sessionId
  // 必须等于调用方给的会话。不一致/缺失一律拒绝（宁可拒绝一次，不拿来源不明的审批去结算）。
  const approval = await readRecord(ctx, approvalId);
  if (!approval) throw new Error("找不到审批 " + approvalId + "（可能已被回收或宿主记录已清）");
  const parentTaskId = typeof (approval as any).parentTaskId === "string" ? String((approval as any).parentTaskId) : "";
  if (!parentTaskId) {
    throw new Error("审批 " + approvalId + " 的宿主记录缺 parentTaskId（异常状态），已按 fail-closed 拒绝");
  }
  const parent = await readRecord(ctx, parentTaskId);
  const binding = taskBindingOf(parent);
  if (!binding || binding.dshSessionId !== sessionId) {
    throw new Error(
      "审批 " + approvalId + " 不属于会话 " + sessionId + "（宿主记录指向 " +
        (binding ? binding.dshSessionId : "无绑定") + "），已按 fail-closed 拒绝",
    );
  }
  const already = (approval as any).outcome;
  if (already === "allowed-once" || already === "rejected") {
    throw new Error("审批 " + approvalId + " 已应答（" + already + "），勿重复应答");
  }

  // 结算宿主审批（权威决策源）；失败（已超时/他方已应答/宿主已终态）直接抛给 Agent
  let settled: SettledApproval | null = null;
  try {
    settled = await ctx.tasks.respondApproval({ approvalId, outcome });
  } catch (e) {
    const msg = errText(e);
    throw new Error("审批应答未接受（" + msg.slice(0, 300) + "）：可能已超时或被其他方处理，任务侧会自行感知终态");
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
