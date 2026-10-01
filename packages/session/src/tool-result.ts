// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/session/src/tool-result.ts — 工具返回契约（宿主透传前的形态）
//
// 放这里而不放工具面：本层的审批应答（approve-respond）与工具面的各 action 都要直接构造它，
// 而工面包依赖会话包，放到工具面就成了反向依赖。工具**入参**的公共形状在工具面自己的
// shared/types.ts（那是「模型给什么」），它从这里转出这个返回契约。

/** 工具返回：content 透传给模型，details 供流内卡与诊断。
 *  ok / error 是我们的约定槽：工具自己判定成败（宿主按 content 透传，不消费这两个字段）。 */
export interface ToolResult {
  ok?: boolean;
  error?: string;
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}
