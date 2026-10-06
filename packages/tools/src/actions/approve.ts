// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/actions/approve.ts — dshana approve：应答子代理挂起的审批
//
// 本项目特色（subagent 没有审批面）。approvalId 是唯一句柄——会话由工具解析（句柄路径校验
// 归属），sessionId 仅在“我要跨对话”时显式传。应答编排见 packages/session/src/approve-respond.ts
// （校验审批归属 → ctx.tasks.respondApproval → runtime approval-bridge 把 outcome 只投给
// 该 approvalId 对应的 DSH 等待者）。
import { respondApprovalAction } from "@dshana/session/approve-respond.ts";
import { resolveTarget } from "../shared/target.ts";
import type { ToolCtx } from "@dshana/shared/host.ts";
import type { ToolInputBase, ToolResult } from "../shared/types.ts";

/** approve 入参：approvalId 是唯一句柄（必填），outcome 缺省按 DSH 侧语义处理。 */
export interface ApproveInput extends ToolInputBase {
  approvalId: string;
  outcome?: "allowed-once" | "rejected";
}

export const command = "approve";
export const summary = "answer a pending approval";
export const readOnly = false;

export const fields = {
  approvalId: { type: "string", description: "From the approval notice" },
  outcome: {
    type: "string",
    enum: ["allowed-once", "rejected"],
    description: "allowed-once = this one operation (default) / rejected",
  },
  taskId: { type: "string", description: "taskId returned by open/reply (handle path)" },
  sessionId: { type: "string", description: "Session id; passing it means cross-conversation" },
};
export const required = ["approvalId"];

export async function run(input: ApproveInput, ctx: ToolCtx): Promise<ToolResult> {
  const aid = String((input && input.approvalId) || "").trim();
  if (!aid) {
    throw new Error("approve 需要 approvalId（审批通知里带；同一任务可挂起多个审批，逐个应答）");
  }
  const target = await resolveTarget(input, ctx);
  return respondApprovalAction({ input: { ...input, sessionId: target.sessionId }, log: ctx && ctx.log });
}
