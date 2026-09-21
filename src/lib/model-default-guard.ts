// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/model-default-guard.ts — 用户设的默认模型不能指向没人服务的路由（对账 + 就地修）
//
// DSH 的 `agent-default-model` 分两层：base 层由 DSH 自己的配置给（官方 adapter 那条路由
// `deepseek-official/deepseek-flash`），用户层来自「在 models 页选过模型」。本形态里 llm 路由
// 只有一个来源（宿主目录，官方那两行 adapter 被 roster patch 停掉了），所以用户选定的那条路由
// 有可能哪天从宿主目录里消失（换提供商/删凭据），留下一个跑不通的默认。
//
// 本模块只管这一件事：**用户层有值**且它不在宿主目录里时换一条可服务的。用户层为空一律不动手
// ——工具建的会话由 caller-model 按调用方角色卡补，界面里开的会话用不用默认是用户的事。
//
// 换哪一条按这个优先序（见 planDefaultRepair）：同 provider 里换（保住原选择的方向）→ 宿主角色卡
// （主角色优先）配的 `models.chat` → 目录第一条。角色卡那一格是「跟着宿主走」的正解：每张卡
// 自己配着模型（agents/<id>/config.yaml），读它要 `app/agents.read`（manifest 已声明），
// 没授权就退到目录第一条。
//
// 写回走 lib/model-settings.ts 的既有路径（带 revision 闸，冲突由 DSH 拒），每次都记日志。
// 时机：受管 runtime 就绪那一次（apply 自动链完成时），以及宿主 `models-changed` 之后。
// runtime 未就绪、宿主目录取不到、段只读时一律只记日志——不重试、不阻塞 App 加载。
import { readAgentCardModel, type CardModel } from "#/lib/agent-models.ts";
import { bridgeAccess } from "#/lib/managed-runtime.ts";
import { readDefaultModel, writeDefaultModel } from "#/lib/model-settings.ts";
import { isModelsChangedEvent } from "#/lib/model-sync.ts";
import { errText } from "#/lib/err-text.ts";
import { servedModels, type ServedModel } from "#/lib/host-models.ts";

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
  preferred?: CardModel | null,
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
  readAgentModel?: () => Promise<CardModel | null>;
  /** 宿主代发 fetch（ctx.network.fetch）——读 DSH settings 段要用它。 */
  fetchFn?: unknown;
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
 * 对一次账：用户设的默认模型不在宿主目录里就换一条可服务的（换哪一条见 planDefaultRepair 的优先序）。
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
  // 只看用户层：base 层那份缺省不是我们的（工具建的会话由 caller-model 按调用方角色卡补），
  // 用户层为空就不动手——这格没被设过，没有「不可服务」可言。
  const current = view && (view as any).stored;
  if (!current || typeof current !== "object") return { status: "no-change", current: null };
  // 角色卡只是「换哪一条」的参考：读不到（未授权/宿主无此面）不影响对账本身。
  let preferred: CardModel | null = null;
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
    readAgentModel: () => readAgentCardModel(ctx),
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
