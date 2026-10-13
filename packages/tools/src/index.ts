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
//   summary  一句话语义（作参数参照里该 action 的小节标题；不进 description）
//   fields   本子命令专属字段的 zod 片段映射（不含 action；公共字段见 shared/fields.ts）
//   readOnly 只读动作（不产生副作用）
//   run(input, ctx, deps)  执行体（deps 仅单测注入提交链，线上为 undefined）
//
// fields 是唯一事实源：模型面 parameters 由它生成，运行期入参校验也用同一批字段——校验在本层
// 发生，各 action 的 run 只管业务。必填/可选由 zod 的 .optional() 表达，不再单列一份 required。
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
import { z } from "zod";
import { HOST_CONTEXT } from "./shared/fields.ts";
import type { ToolCtx } from "@dshana/shared/host.ts";
import type { ToolInputBase } from "./shared/types.ts";
// 查任务不经本工具：会话靠句柄（宿主 taskId）定位，任务清单由宿主提供给 Agent 的内置任务查询
// 工具承担（模型侧，本环境是 check_pending_tasks）——dshana 的 open/reply 建的后台任务本来
// 就在那份清单里，本工具面不开“先列清单再操作”的门。
// 官方 session/list 仍被 get 用来定位读位点（见 packages/tools/src/actions/get.ts）。

/** subcommand 注册表（顺序即分发与参数参照的列举顺序）。
 *
 * `export` 是给派生的参数参照用：它按这张表列出每个 action 的字段与语义，与本节装配出的
 * `parameters` 同源。派生只消费它，不再自己收一遍 action 清单。 */
export const ACTIONS = [openAction, replyAction, closeAction, getAction, approveAction];

export const name = "dshana";

/** 手册的技能名（技能目录按此名定位；与 skills/ 下的目录名一致，单一事实源）。 */
export const SKILL_NAME = "dshana";

/**
 * 工具描述：模型侧唯一的固定入口。只说这工具是什么，其余一律交出手册（技能 `dshana` 的
 * SKILL.md 与其 references/）——动作清单、字段与逐动作规则都在那里；在这里重列一遍是把同一
 * 事实再抄一份，还要求每个 action 的 summary 永远与这段文案同步。
 *
 * 指**技能名**而不是仓库里的相对路径：技能目录（系统提示里的 available_skills 段）按名字
 * 给出每个技能的 `location` 绝对路径，模型拿得到可解析的坐标；写相对路径则模型不知道相对谁。
 * 也不指 `tool_help`：本工具的模块面是顶层 oneOf，而宿主的参数摘要（paramsSummary）只认顶层
 * 平铺 properties，`tool_help("dshana")` 因此返回“无参数”——指向它等于指向空页。
 */
export const description =
  "DeepSeek Harness (DSH) subagent: read the `" + SKILL_NAME + "` skill for details.";

// ---- zod 单一来源：同一批字段长出「模型面 parameters」与「运行期校验 union」 ----
//
// 分支由 z.strictObject 产出（普通 ZodObject）：discriminatedUnion 只接受普通对象 schema，分支上
// 挂 refine/superRefine 会让它不再是 ZodObject，构造时直接抛 "Invalid discriminated union option"。
// 故跨字段语义检查（"taskId 或 sessionId 二选一"等）不进 schema，仍留在 run() / resolveTarget() 里。
/** discriminatedUnion 的 options 形参要求至少一支；ACTIONS 非空，这里只做类型收口。 */
function nonEmpty<T>(items: T[]): [T, ...T[]] {
  return items as [T, ...T[]];
}

/** 模型面分支：顶层 action 字面量 + 本动作专属字段。 */
const modelBranches = ACTIONS.map((mod) => z.strictObject({ action: z.literal(mod.command), ...mod.fields }));

/** 参数 Schema：顶层 action + oneOf 分支（每个子命令独立的参数字段集），由 zod 生成，不再手写。 */
const { $schema, ...modelJsonSchema } = z.toJSONSchema(
  z.discriminatedUnion("action", nonEmpty(modelBranches)),
  { io: "input" },
);
export const parameters = { type: "object", ...modelJsonSchema };

/**
 * 运行期 union：与模型面同一批字段，额外接受宿主注入的 context。context 只在这里出现，
 * 绝不进 parameters——模型不该看到也不该传它。
 */
const runtimeUnion = z.discriminatedUnion(
  "action",
  nonEmpty(modelBranches.map((branch) => branch.extend({ context: HOST_CONTEXT.optional() }))),
);

/**
 * 入参闸门：失败抛一行抬头 + 逐条 issues（path 为空写 (root)，消息用英文，与本文件其它抛错同口径），
 * 末尾指路到手册。只做准入，不整形数据：通过后仍把**原始 input**交给 run()，各 action 的取值与兜底逻辑一行不改。
 *
 * 读者是模型（不是人）：所以既说错在哪，也说下一步去哪看。不指 `tool_help`——本工具是顶层 oneOf，
 * 宿主的参数摘要只认平铺 properties，那里的参数栏是空的（详见 description 上方注释）。
 */
function assertValidInput(input: unknown): void {
  const parsed = runtimeUnion.safeParse(input);
  if (parsed.success) return;
  const issues = parsed.error.issues.map(
    (issue) => "  - " + (issue.path.join(".") || "(root)") + ": [" + issue.code + "] " + issue.message,
  );
  throw new Error(
    "dshana: invalid arguments\n" + issues.join("\n") + "\nFields and per-action rules: read the `" + SKILL_NAME + "` skill.",
  );
}

/** 工具入参：公共部分 + 顶层 subcommand 名。 */
export interface DshanaToolInput extends ToolInputBase {
  action?: string;
}

/**
 * action 实现体。deps 只给单测注入提交链（open/reply；缺省用真实 submitDshTask）；
 * 线上路径经 execute 调用时 deps 为 undefined，行为不变。
 */
export async function doExecute(input: DshanaToolInput, ctx: ToolCtx, deps?: unknown): Promise<unknown> {
  // 分发之前的准入校验（畸形入参在这里就拒，不进各 action 的业务）。
  assertValidInput(input);
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
