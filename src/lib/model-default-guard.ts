// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/model-default-guard.ts — 默认模型必须落在宿主目录里（对账 + 就地修）
//
// DSH 的 `agent-default-model` 有它自己的缺省（base 层配置给的是官方 adapter 那条路由
// `deepseek-official/deepseek-flash`），而本形态里 llm 路由只有一个来源：宿主目录
// （官方那两行 adapter 被 roster patch 停掉）。缺省值是新会话、以及没有历史选择的会话唯一的
// 模型来源，指向一条没人服务的路由等于开箱即失败。
//
// 为什么不在 roster patch 里把缺省写死成某个宿主模型：宿主配了哪些提供商、它们叫什么名字，
// 是每台 Hana 各自的配置，写死一个 provider/model 只在写它的那一台上成立。所以这里按运行时
// 事实对账——读宿主目录（`ctx.models.list()`），现值不在目录里就换一条可服务的。换哪一条，
// 按这个优先序（见 planDefaultRepair）：现值还在就什么都不动 → 同 provider 里换（保住原选择
// 的方向）→ 宿主角色卡（主角色优先）配的 `models.chat` → 目录第一条。
//
// 角色卡那一格是「跟着宿主走」的正解：宿主的每张角色卡都配着自己的模型（agents/<id>/
// config.yaml 的 models.chat），主角色就是用户在用的那个。读它要 `app/agents.read`
// （`agent:list` scope=all + `agent:config`，manifest 里已声明）；没授权/读不到就退到目录第一条。
//
// 这份值的正主仍是 DSH 的 settings 段，写回走 lib/model-settings.ts 的既有路径（带 revision
// 闸，冲突由 DSH 拒），本模块只在它指向不可服务的路由时改写，并把改写给日志。
//
// 时机：受管 runtime 就绪那一次（apply 自动链完成时），以及宿主 `models-changed` 之后。
// runtime 未就绪、宿主目录取不到、段只读时一律只记日志——不重试、不阻塞 App 加载。
import { bridgeAccess } from "#/lib/managed-runtime.ts";
import { readDefaultModel, writeDefaultModel } from "#/lib/model-settings.ts";
import { isModelsChangedEvent } from "#/lib/model-sync.ts";
import { errText } from "#/lib/err-text.ts";

/** 宿主目录里一条可服务的路由坐标（只取路由与选择要用的两格）。 */
export interface ServedModel {
  provider: string;
  id: string;
}

/** 对账结论：换成哪一条，以及为什么换。 */
export interface DefaultRepair {
  provider: string;
  model: string;
  /**
   * `provider-kept` = 原 provider 还在、只是模型不在；`agent-model` = 宿主角色卡配的模型；
   * `catalog-first` = 目录第一条。
   */
  reason: "provider-kept" | "agent-model" | "catalog-first";
}

/** 一条模型选择（provider + model）。 */
export interface ModelSelection {
  provider: string;
  model: string;
}

/** 宿主目录归一化：provider/id 都非空的条目（其余形状不参与选择）。 */
export function servedModels(models: unknown): ServedModel[] {
  const out: ServedModel[] = [];
  for (const item of Array.isArray(models) ? models : []) {
    const provider = item && typeof item.provider === "string" ? item.provider.trim() : "";
    const id = item && typeof item.id === "string" ? item.id.trim() : "";
    if (provider && id) out.push({ provider, id });
  }
  return out;
}

/**
 * 默认模型该不该改、改成什么（纯函数）。
 * @param served - 宿主目录（servedModels 的产物）
 * @param current - DSH 当前默认模型（{ provider, model }，字段可能缺）
 * @param preferred - 宿主角色卡配的模型（读不到给 null）
 * @returns null = 保持现值（现值在目录里，或目录为空——空目录无从挑）；否则给出替代选择
 */
export function planDefaultRepair(
  served: readonly ServedModel[],
  current: unknown,
  preferred?: ModelSelection | null,
): DefaultRepair | null {
  if (!Array.isArray(served) || served.length === 0) return null;
  const provider = current && typeof (current as any).provider === "string" ? (current as any).provider.trim() : "";
  const model = current && typeof (current as any).model === "string" ? (current as any).model.trim() : "";
  const present = (p: string, m: string): boolean => served.some((s) => s.provider === p && s.id === m);
  if (provider && model && present(provider, model)) return null;
  // provider 还在、只是模型不在：留在该 provider 里换（保住用户在 DSH 侧选定的方向）
  const sameProvider = provider ? served.filter((s) => s.provider === provider) : [];
  if (sameProvider.length > 0) {
    return { provider: sameProvider[0].provider, model: sameProvider[0].id, reason: "provider-kept" };
  }
  // 角色卡配的模型（主角色优先）在目录里就用它：跟着宿主走，而不是跟着目录顺序走
  if (preferred && preferred.provider && preferred.model && present(preferred.provider, preferred.model)) {
    return { provider: preferred.provider, model: preferred.model, reason: "agent-model" };
  }
  return { provider: served[0].provider, model: served[0].id, reason: "catalog-first" };
}

/**
 * 从宿主角色卡的配置里取聊天模型（`models.chat.{provider,id}`，容忍 `model` 拼法）。
 * @param agentConfig - `agent:config` 返回的 config（宿主已抹掉凭据形状的字段）
 * @returns provider/model 都在时给选择，否则 null
 */
export function chatModelOf(agentConfig: unknown): ModelSelection | null {
  const models = agentConfig && typeof agentConfig === "object" ? (agentConfig as any).models : null;
  const chat = models && typeof models === "object" ? (models as any).chat : null;
  if (!chat || typeof chat !== "object") return null;
  const provider = typeof chat.provider === "string" ? chat.provider.trim() : "";
  const id = typeof chat.id === "string" ? chat.id.trim() : typeof chat.model === "string" ? chat.model.trim() : "";
  return provider && id ? { provider, model: id } : null;
}

/**
 * 选哪张角色卡当参考：主角色优先，其次当前角色，再次第一张在场的。
 * @param agents - `agent:list` 的 agents
 * @returns agentId（没有可用条目时是空串）
 */
export function pickRoleCardAgent(agents: unknown): string {
  const list = (Array.isArray(agents) ? agents : []).filter((a) => {
    const id = a && typeof (a as any).id === "string" ? (a as any).id : "";
    const state = a && typeof (a as any).state === "string" ? (a as any).state : "active";
    return !!id && state === "active";
  });
  const pick = list.find((a) => (a as any).isPrimary === true)
    ?? list.find((a) => (a as any).isCurrent === true)
    ?? list[0];
  return pick ? String((pick as any).id) : "";
}

/** 现值的一句话描述（日志用）。 */
function describeSelection(current: unknown): string {
  const provider = current && typeof (current as any).provider === "string" ? (current as any).provider : "";
  const model = current && typeof (current as any).model === "string" ? (current as any).model : "";
  if (!provider && !model) return "（未设置）";
  return (provider || "?") + "/" + (model || "?");
}

/** 对账依赖（可注入：单测传假实现，运行期取 ctx 面）。 */
export interface DefaultGuardDeps {
  /** 宿主目录读取（ctx.models.list）。 */
  listModels?: () => Promise<{ models?: unknown } | null | undefined>;
  /** 宿主角色卡配的模型读取（bus 的 agent:list + agent:config）。 */
  readAgentModel?: () => Promise<ModelSelection | null>;
  /** 宿主代发 fetch（ctx.network.fetch）——读 DSH settings 段要用它。 */
  fetchFn?: unknown;
}

/** 读宿主角色卡（主角色优先）配的聊天模型；没授权/读不到/形状不符一律 null。 */
async function readRoleCardModel(ctx): Promise<ModelSelection | null> {
  const bus = ctx && ctx.bus;
  if (!bus || typeof bus.request !== "function") return null;
  const listed: any = await bus.request("agent:list", { scope: "all", lifecycle: "active" });
  const agentId = pickRoleCardAgent(listed && listed.agents);
  if (!agentId) return null;
  const res: any = await bus.request("agent:config", { agentId, scope: "all" });
  if (!res || typeof res !== "object" || typeof res.error === "string") return null;
  return chatModelOf(res.config);
}

/** 对账结果（诊断面/单测用）。 */
export interface DefaultGuardResult {
  status:
    | "runtime-not-ready"
    | "deps-missing"
    | "catalog-unavailable"
    | "settings-unreadable"
    | "no-change"
    | "repaired"
    | "write-failed";
  current?: unknown;
  next?: { provider: string; model: string };
  reason?: DefaultRepair["reason"];
}

/**
 * 对一次账：默认模型不在宿主目录里就换一条可服务的（换哪一条见 planDefaultRepair 的优先序）。
 * @param deps - { listModels, readAgentModel, fetchFn }
 * @param log - (level, message) 日志出口
 * @returns 结论（不抛：失败都落成 status）
 */
export async function reconcileDefaultModel(deps: DefaultGuardDeps, log = (_level: string, _msg: string) => {}): Promise<DefaultGuardResult> {
  const access = bridgeAccess();
  if (!access || !access.runtimeId) return { status: "runtime-not-ready" };
  if (!deps || typeof deps.listModels !== "function" || typeof deps.fetchFn !== "function") {
    return { status: "deps-missing" };
  }
  let served: ServedModel[];
  try {
    const listed = await deps.listModels();
    served = servedModels(listed && (listed as any).models);
  } catch (e) {
    log("warn", "默认模型对账：宿主目录取不到（保留现值）：" + errText(e));
    return { status: "catalog-unavailable" };
  }
  let view;
  try {
    view = await readDefaultModel(deps.fetchFn as never);
  } catch (e) {
    log("warn", "默认模型对账：DSH 的 agent-default-model 段读不到（保留现值）：" + errText(e));
    return { status: "settings-unreadable" };
  }
  const current = view && (view as any).current;
  // 角色卡只是「换哪一条」的参考：读不到（未授权/宿主无此面）不影响对账本身。
  let preferred: ModelSelection | null = null;
  if (typeof deps.readAgentModel === "function") {
    try {
      preferred = await deps.readAgentModel();
    } catch (e) {
      log("info", "默认模型对账：读不到宿主角色卡的模型（退到目录顺序）：" + errText(e));
    }
  }
  const repair = planDefaultRepair(served, current, preferred);
  if (!repair) return { status: "no-change", current };
  const next = { provider: repair.provider, model: repair.model };
  try {
    await writeDefaultModel(deps.fetchFn as never, next);
  } catch (e) {
    log(
      "warn",
      "默认模型对账：改写失败（" + describeSelection(current) + " → " + next.provider + "/" + next.model
        + "，" + repair.reason + "）：" + errText(e),
    );
    return { status: "write-failed", next, reason: repair.reason };
  }
  log(
    "info",
    "默认模型对账：" + describeSelection(current) + " 不在宿主目录里（" + repair.reason + "）→ 改为 "
      + next.provider + "/" + next.model,
  );
  return { status: "repaired", next, reason: repair.reason };
}

/** 按 ctx 面跑一次对账（缺 network/models 面时按 deps-missing 收场）。 */
export function runModelDefaultGuard(ctx, log = (_level: string, _msg: string) => {}): Promise<DefaultGuardResult> {
  const deps: DefaultGuardDeps = {
    listModels: ctx && ctx.models && typeof ctx.models.list === "function" ? ctx.models.list.bind(ctx.models) : undefined,
    readAgentModel: () => readRoleCardModel(ctx),
    fetchFn: ctx && ctx.network && typeof ctx.network.fetch === "function" ? ctx.network.fetch.bind(ctx.network) : undefined,
  };
  return reconcileDefaultModel(deps, log).catch((e) => {
    log("warn", "默认模型对账异常（忽略）：" + errText(e));
    return { status: "catalog-unavailable" as const };
  });
}

/**
 * 安装默认模型对账：宿主 `models-changed`（提供商/凭据/目录变更）之后跑一次。
 * runtime 就绪的那一次由 apply 自动链在 ensureManagedRuntime 之后调 runModelDefaultGuard。
 * @param ctx - 宿主 App ctx（要 ctx.bus 与 ctx.models / ctx.network）。
 * @param log - (level, message) 日志出口。
 * @returns 退订函数；宿主没有订阅面时是 no-op。
 */
export function installModelDefaultGuard(ctx, log = (_level: string, _msg: string) => {}): () => void {
  const bus = ctx && ctx.bus;
  if (!bus || typeof bus.subscribe !== "function") {
    log("info", "宿主无 ctx.bus.subscribe：默认模型对账只在 runtime 就绪时跑一次");
    return () => {};
  }
  try {
    const off = bus.subscribe((event) => {
      if (!isModelsChangedEvent(event)) return;
      void runModelDefaultGuard(ctx, log);
    }, { types: ["app_event"] });
    return typeof off === "function" ? off : () => {};
  } catch (e) {
    log("warn", "默认模型对账订阅安装失败（只在 runtime 就绪时跑一次）：" + errText(e));
    return () => {};
  }
}
