// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/agent-models.ts — 读宿主角色卡配的模型（agents/<id>/config.yaml 的 models.chat）
//
// 「这个 agent 用什么模型」宿主早有答案：每张角色卡自己配着 models.chat，主角色就是用户在用的
// 那个。本模块是这份事实的唯一读取口——bus 的 agent:list + agent:config（能力面 app/agents.read，
// manifest 已声明）。消费者两处：默认模型对账（model-default-guard）、工具建的会话
// （caller-model）。
//
// 读不到都不是错误：未授权、宿主没有这个面、形状不符、该卡没配，一律 null，调用方各自退到
// 它能做的选择。

/** 一张角色卡配的模型选择。 */
export interface CardModel {
  provider: string;
  model: string;
}

/**
 * 从角色卡配置里取聊天模型（`models.chat`，字段是 { provider, id }，也认 `model` 拼法）。
 * @param agentConfig - agent:config 返回的 config（宿主已抹掉凭据形状的字段）
 * @returns provider/model 都在时给选择，否则 null
 */
export function chatModelOf(agentConfig: unknown): CardModel | null {
  const models = agentConfig && typeof agentConfig === "object" ? (agentConfig as any).models : null;
  const chat = models && typeof models === "object" ? (models as any).chat : null;
  if (!chat || typeof chat !== "object") return null;
  const provider = typeof chat.provider === "string" ? chat.provider.trim() : "";
  const id = typeof chat.id === "string" ? chat.id.trim() : typeof chat.model === "string" ? chat.model.trim() : "";
  return provider && id ? { provider, model: id } : null;
}

/**
 * 挑一张角色卡。
 * @param agents - agent:list 的 agents
 * @param prefer - 优先看哪个标记：`current` = 调用方所在的那张（先 isCurrent 再 isPrimary），
 *   `primary` = 主角色（先 isPrimary 再 isCurrent）
 * @returns agentId（没有可用条目时是空串）
 */
export function pickRoleCardAgent(agents: unknown, prefer: "primary" | "current" = "primary"): string {
  const list = (Array.isArray(agents) ? agents : []).filter((a) => {
    const id = a && typeof (a as any).id === "string" ? (a as any).id : "";
    const state = a && typeof (a as any).state === "string" ? (a as any).state : "active";
    return !!id && state === "active";
  });
  const first = prefer === "current" ? "isCurrent" : "isPrimary";
  const second = prefer === "current" ? "isPrimary" : "isCurrent";
  const pick =
    list.find((a) => (a as any)[first] === true) ?? list.find((a) => (a as any)[second] === true) ?? list[0];
  return pick ? String((pick as any).id) : "";
}

/**
 * 读一张角色卡配的聊天模型。
 * @param ctx - 宿主 App ctx（要 ctx.bus）
 * @param agentId - 指定角色卡；缺省按 prefer 挑一张
 * @param prefer - 缺省角色卡时的优先标记
 * @returns 模型选择；读不到给 null（未授权 / 无此面 / 形状不符 / 该卡没配）
 */
export async function readAgentCardModel(
  ctx: unknown,
  agentId?: string,
  prefer: "primary" | "current" = "primary",
): Promise<CardModel | null> {
  const bus = (ctx as any)?.bus;
  if (!bus || typeof bus.request !== "function") return null;
  let id = String(agentId || "").trim();
  if (!id) {
    const listed: any = await bus.request("agent:list", { scope: "all", lifecycle: "active" });
    id = pickRoleCardAgent(listed && listed.agents, prefer);
  }
  if (!id) return null;
  const res: any = await bus.request("agent:config", { agentId: id, scope: "all" });
  if (!res || typeof res !== "object" || typeof res.error === "string") return null;
  return chatModelOf(res.config);
}

/** 调用方角色卡配的模型：先按 isCurrent 认调用方，认不出退主角色。 */
export function readCallerCardModel(ctx: unknown): Promise<CardModel | null> {
  return readAgentCardModel(ctx, undefined, "current");
}
