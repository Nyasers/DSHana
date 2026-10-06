// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/index.ts — dshana 工具统一入口（一个插件一个同名工具 + subcommand）
//
// 形态：一个插件只暴露一个与插件同名的工具（name = "dshana"），动作以顶层 action
// （subcommand）区分；parameters 用 oneOf 为每个子命令单独声明参数字段集，模型的参数面因此
// 不串味（open 看不到 approvalId）。每个子命令是本目录 actions/ 下的一个独立模块，本文件只做
// 装配（name/description/parameters）与分发（execute）。
//
// 每个 action 模块导出同一组字段：
//   command  subcommand 名（顶层 action 取值，全局唯一）
//   summary  一句话语义（汇总进 description）
//   fields   本子命令的 JSON Schema properties（不含 action）
//   required 必填字段（不含 action）
//   readOnly 只读动作（不产生副作用）
//   run(input, ctx, deps)  执行体（deps 仅单测注入提交链，线上为 undefined）
//
// 语义对齐 subagent：open ≈ subagent（创建即带任务）、reply ≈ subagent_reply（按句柄续）、
// close ≈ subagent_close（收工）；get / approve 是本项目特色（subagent 没有）。
// 调用模型：句柄默认（taskId/approvalId，按宿主记录的来源会话校验归属）、凭证显式
// （sessionId = 我要跨对话）。
//
// 数据目录取 ctx.dataDir（宿主 app-data/<id>/）；工具名以本文件 name 为单一事实源
// （v2 注册不自动加前缀，重名会被宿主当场拒掉）。
import * as openAction from "./actions/open.ts";
import * as replyAction from "./actions/reply.ts";
import * as closeAction from "./actions/close.ts";
import * as getAction from "./actions/get.ts";
import * as approveAction from "./actions/approve.ts";
import type { ToolCtx } from "@dshana/shared/host.ts";
import type { ToolInputBase } from "./shared/types.ts";
// 查任务不经本工具：会话靠句柄（宿主 taskId）定位，任务清单由宿主提供给 Agent 的内置任务查询
// 工具承担（模型侧，本环境是 check_pending_tasks）——dshana 的 open/reply 建的后台任务本来
// 就在那份清单里，本工具面不开“先列清单再操作”的门。
// 官方 session/list 仍被 get 用来定位读位点（见 packages/tools/src/actions/get.ts）。

/** subcommand 注册表（顺序即 description 的列举顺序）。 */
const ACTIONS = [openAction, replyAction, closeAction, getAction, approveAction];

export const name = "dshana";

/** description 前缀：模型侧唯一的固定入口（细则一律在 SKILL 全文里，这里不重复）。 */
const DESCRIPTION_LEAD = "DeepSeek Harness (DSH) sub-agent executor. Actions: ";

/** 工具描述：由各 action 的 summary 汇总（顺序即 ACTIONS 顺序），细则见 SKILL。 */
export const description =
  DESCRIPTION_LEAD +
  ACTIONS.map((mod) => mod.command + "=" + mod.summary).join("; ") +
  ". Full manual: skills/dshana/SKILL.md";

/** 参数 Schema：顶层 action + oneOf 分支（每个子命令独立的参数字段集）。 */
export const parameters = {
  type: "object",
  oneOf: ACTIONS.map((mod) => ({
    type: "object",
    additionalProperties: false,
    required: ["action", ...mod.required],
    properties: { action: { const: mod.command }, ...mod.fields },
  })),
};

/** 工具入参：公共部分 + 顶层 subcommand 名。 */
export interface DshanaToolInput extends ToolInputBase {
  action?: string;
}

/**
 * action 实现体。deps 只给单测注入提交链（open/reply；缺省用真实 submitDshTask）；
 * 线上路径经 execute 调用时 deps 为 undefined，行为不变。
 */
export async function doExecute(input: DshanaToolInput, ctx: ToolCtx, deps?: unknown): Promise<unknown> {
  const action = String((input && input.action) || "").trim();
  const mod = ACTIONS.find((m) => m.command === action);
  if (!mod) {
    throw new Error(
      "action must be one of " + ACTIONS.map((m) => m.command).join(" / ") + " (got " + action + ")",
    );
  }
  // 每个 action 的 run 参数面各不相同（各自 fields），统一成一个可调用的宽签名再分发。
  const run = mod.run as (
    input: DshanaToolInput,
    ctx: ToolCtx,
    deps?: unknown,
  ) => Promise<unknown>;
  return run(input, ctx, deps);
}

export async function execute(input: unknown, ctx: ToolCtx): Promise<unknown> {
  try {
    return await doExecute(input as DshanaToolInput, ctx, null);
  } catch (e) {
    // ctx 为 App apply 注入的工具上下文（见 index.ts makeToolCtx：统一日志出口）；缺失时静默（防御）
    const err = e as { stack?: string; message?: string } | null;
    ctx?.log?.error?.("[dshana] dshana failed:", err?.stack || err?.message || String(e));
    throw e;
  }
}
