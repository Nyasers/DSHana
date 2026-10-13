// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/shared/fields.ts — 跨 action 共用的 zod 字段片段与宿主 context 形状
//
// 每个 action 的专属字段住在自己的模块（actions/<action>.ts 的 fields），公共字段在这里定义
// 一次：模型面 parameters 与运行期入参校验由同一份 zod 定义长出（装配见 packages/tools/src/index.ts），
// 两处不再各写一遍，也就不会各自漂移。字段描述就是模型看到的说明文本。
//
// 只表达形状类约束（类型、必填/可选、enum、形态正则），不加取值范围约束：timeout 的
// 「非法/0 回落到缺省」是既有契约，min/positive 会把它改成拒绝。
import { z } from "zod";
import { SESSION_ID_RE } from "@dshana/shared/task-binding.ts";

/** 本次请求的秒数上限；缺省用 App 设置里的 defaultTimeoutSec。 */
export const timeout = z.number().optional().describe("Seconds; defaults to the App's defaultTimeoutSec");

/** 推理档位（宿主侧 levels）。 */
export const reasoningEffort = z.string().optional().describe("Reasoning effort (host-side levels)");

/** 仅本次请求生效的 provider。 */
export const provider = z.string().optional().describe("Explicit provider for this request only");

/** 显式模型 id（回落规则见 SKILL）。 */
export const model = z.string().optional().describe("Explicit model id (fallback rules in the SKILL)");

/** open/reply 返回的句柄（句柄路径）。 */
export const taskId = z.string().optional().describe("taskId returned by open/reply (handle path)");

/**
 * 显式会话凭证：传了就是跨对话。形态正则取自 task-binding（一份实现，本文件不复制）。
 *
 * 两面因此逐字等价：那份正则把大小写容忍内联在字符类里（不带 `i` 标志），所以投影出的
 * JSON Schema `pattern` 与运行期（isValidSessionId，fail-closed）接受同一个集合——模型的
 * 提示不会比真闸门更窄或更宽。
 */
export const sessionId = z
  .string()
  .regex(SESSION_ID_RE)
  .optional()
  .describe("Session id; passing it means cross-conversation");

/**
 * 宿主随工具调用注入的 context。这里只声明本工具真正读到的两个键，其余键交给 loose 放行：
 * 宿主的 context 形状随通道变（模型工具调用与 UI 动作通道的键集不同），用 strict 会把未知键
 * 判成 unrecognized_keys，宿主每加一个键就会让全部动作在校验闸门处被拒。
 */
export const HOST_CONTEXT = z.looseObject({
  sessionPath: z.string().nullish(),
  callToken: z.string().optional(),
});
