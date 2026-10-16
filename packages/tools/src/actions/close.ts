// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/actions/close.ts — dshana close：取消这个子代理正在跑的任务
//
// 语义对齐 subagent_close 的「收工」，但只到「取消当前活动工作」为止：DSH 会话是持久的、
// 随时可 resume，没有实例槽位这回事，所以这里不假装释放实例。只停本工作，不影响共享
// runtime 上的其他会话。取消编排见 packages/session/src/cancel-chain.ts（写 cancel 标记 → DSH session.cancel
// → 终态结算放后台：等 DSH 真中止；超窗未确认就升级宿主 cancel）。
// **异步语义**：本动作只发请求就返回，不等确认窗口（15s 不进工具回调——占着回调等确认会
// 堵住宿主通道）；确认或升级的证据随后台任务通知（投递回本会话）与 App 日志落定。
import { requestCancel } from "@dshana/session/cancel-chain.ts";
import { resolveTarget } from "../shared/target.ts";
import { taskId, sessionId } from "../shared/fields.ts";
import type { ToolCtx } from "@dshana/shared/host.ts";
import type { ToolInputBase, ToolResult } from "../shared/types.ts";

export const command = "close";
export const summary = "cancel its running task";
export const readOnly = false;

export const fields = { taskId, sessionId };

export async function run(input: ToolInputBase, ctx: ToolCtx): Promise<ToolResult> {
  const target = await resolveTarget(input, ctx);
  const sessionId = target.sessionId;
  const out = await requestCancel({ sessionId, reason: "user", log: ctx && ctx.log });
  const sid = String(out.sessionId || sessionId);
  let text;
  let status = "cancelling";
  if (out.status === "no-active-work") {
    status = "idle";
    text = "会话 " + sid.slice(0, 12) + "… 当前没有运行中的 DSH 任务（映射为空）；已发送幂等 session.cancel，无副作用";
  } else if (out.status === "already-requested") {
    // 标记已存在**且其 DSH 通知已被接受**：这是一次重复请求，不再重发。回执只陈述已发生的事实。
    text = "该会话的取消请求已发出并被 DSH 接受（reason=" + String(out.reason || "user") +
      "），本次不重复发送；宿主任务的终态随后台任务通知落定";
  } else if (out.status === "dsh-rpc-failed") {
    // RPC 未被接受：标记停在 rpcAccepted:false，结算与超窗升级照走（宿主 status 是唯一权威格）。
    status = "dsh-unreachable";
    text = "已请求取消（session " + sid.slice(0, 12) + "…），但 DSH 侧取消调用未被接受：" +
      String(out.dshError || "unknown") + "。任务已进入结算（超窗未获 DSH 确认时升级为宿主 cancel），终态以后台任务通知为准";
  } else {
    text = "已请求取消（session " + sid.slice(0, 12) +
      "…）：不等确认（窗口在后台走），终态随后台任务通知落定；若 DSH 超窗未停，宿主任务会被升级标记 canceled（App 日志有「升级宿主 cancel」）";
  }
  return {
    content: [{ type: "text", text }],
    details: {
      dsh: {
        action: "close",
        sessionId: sid,
        taskId: out.taskId || undefined,
        status,
        reason: out.reason || "user",
        dshAccepted: Boolean(out.dshAccepted),
      },
    },
  };
}
