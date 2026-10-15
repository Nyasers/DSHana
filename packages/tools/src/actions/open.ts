// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/actions/open.ts — dshana open：开一个 DSH 子代理并交首件活
//
// 语义对齐 subagent 的「创建即带任务」：新建 DSH 会话 + 立即提交首条 prompt（task/cwd 必填），
// 固定异步，结果作为后台结果回投来源会话。提交链见 packages/session/src/session-run.ts
// （ctx.tasks.create → 受管 runtime 就绪 → session.create（带模型）→ 绑定回写宿主任务记录 → prompt）。
//
// 模块契约（五个 action 模块共用，见 packages/tools/src/index.ts）：导出 command / summary / fields /
// readOnly / run；fields 是本 action 专属字段的 zod 片段映射（公共字段见 shared/fields.ts），
// run(input, ctx, deps) 中 deps 仅单测注入提交链。
import { z } from "zod";
import { submitDshTask } from "@dshana/session/session-run.ts";
import { sessionCardNote } from "../shared/card.ts";
import { timeout, reasoningEffort, provider, model } from "../shared/fields.ts";
import type { ToolCtx } from "@dshana/shared/host.ts";
import type { ToolInputBase, ToolResult } from "../shared/types.ts";

/** open 入参：task/cwd 必填（语义对齐 subagent 的“创建即带任务”）。 */
export interface OpenInput extends ToolInputBase {
  task: string;
  cwd: string;
  label?: string;
  timeout?: number;
  agentPreset?: string;
  reasoningEffort?: string;
  provider?: string;
  model?: string;
}

/** 提交链注入面（仅单测用；线上为 undefined）。 */
export interface SubmitDeps {
  submitDshTask?: typeof submitDshTask;
}

export const command = "open";
export const summary = "start a DSH sub-agent with a first task";
export const readOnly = false;

export const fields = {
  task: z.string().describe("First task for the sub-agent"),
  cwd: z.string().describe("Absolute sandbox working directory (required; no fallback)"),
  label: z.string().optional().describe("Optional display name"),
  agentPreset: z.string().optional().describe("Agent preset (names defined by DSH)"),
  timeout,
  reasoningEffort,
  provider,
  model,
};

export async function run(input: OpenInput, ctx: ToolCtx, deps?: SubmitDeps): Promise<ToolResult> {
  const callToken = (input && input.context && input.context.callToken) || "";
  // 提交面（deps 可注入以单测 open 分支；缺省用真实 submitDshTask）返回 { promise, ready }：
  // ready 在 prompt 被 DSH 接受后 resolve 定位键（sessionId/rpcId/taskId），提交阶段失败则
  // reject（错误上抛给工具面）；promise 是后台生命周期（等 task 终态、释放串行锁），本处不 await。
  const submit = deps && typeof deps.submitDshTask === "function" ? deps.submitDshTask : submitDshTask;
  const { ready } = submit({ action: "create", input, callToken, log: ctx && ctx.log });
  const loc = await ready;
  const sid = String(loc.sessionId || "");
  const rpc = String(loc.rpcId || "");
  const text =
    "已开启 DSH 子代理（open）：taskId " + loc.taskId + "（后续续/关优先用它），sessionId " + sid + "，rpcId " + rpc +
    (loc.cwd ? "，cwd " + loc.cwd : "") +
    "。任务在后台执行，完成/失败按 " + loc.delivery + " 档投递回本会话（下一个输入点自动贴回，不必为等结果结束回合）；要看执行过程或最终结论用 dshana action=get（taskId " +
    loc.taskId + "）。" +
    // 会话卡由 App 在提交成功后往本会话投一条自定义消息（contributes.messageRenderers 渲染成流内卡），
    // 不是工具回执里的 details.card。卡的状态措辞由 shared/card.ts 单点给出（open/reply 共用）。
    sessionCardNote(loc);
  return {
    content: [{ type: "text", text }],
    details: {
      dsh: {
        action: "open",
        sessionId: sid,
        rpcId: rpc,
        taskId: loc.taskId,
        status: "running",
        delivery: loc.delivery,
        cwd: loc.cwd || undefined,
        cardEntryId: loc.cardEntryId || undefined,
      },
    },
  };
}
