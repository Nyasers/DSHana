// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/caller-model.ts — 工具建的 DSH 会话用哪个模型（按调用方角色卡补）
//
// 会话的模型跟着「谁开的」走：open 建的会话，缺省模型取调用方那张角色卡配的 models.chat，
// 与宿主 subagent 拿上一级的模型是同一个意思。App 设置里可以改成「自定义模型」（固定一条），
// 那时它优先——它是针对本 App 会话的更具体的选择。四种情况不补：
//   · 工具入参已经显式给了 provider/model（显式照旧）；
//   · App 设置是「自定义模型」且那条填好了（用它）；
//   · DSH settings 里已经有用户手设的默认模型（那是用户的话，对所有会话生效）；
//   · 调用方角色卡读不到，或它配的模型不在宿主目录里（补了也跑不动，让报错点到那个名字）。
//
// 只在 create 上补：send 的会话已经带着自己的选择（会话内的 durable 选择），不该因为换个
// agent 来续话就把模型换掉。

import { readCallerCardModel, type CardModel } from "#/lib/agent-models.ts";
import { readDshDefaultModel } from "#/lib/config.ts";
import { readSettingsSync } from "#/lib/data-source.ts";
import { errText } from "#/lib/err-text.ts";
import { servedHas, servedModels, type ServedModel } from "#/lib/host-models.ts";

/** 一条选择（provider + model 都非空才算数）。 */
export interface ModelPick {
  provider: string;
  model: string;
}

/** provider/model 都非空时归一化，否则 null。 */
export function pickOf(input: { provider?: unknown; model?: unknown } | null | undefined): ModelPick | null {
  const provider = input && typeof input.provider === "string" ? input.provider.trim() : "";
  const model = input && typeof input.model === "string" ? input.model.trim() : "";
  return provider && model ? { provider, model } : null;
}

/** 会话模型的一次决策：补哪一条，或者为什么不补。 */
export type CallerPlan =
  | { kind: "select"; provider: string; model: string; reasoningEffort?: string }
  | { kind: "skip"; reason: "explicit" | "user-default" | "no-card" | "card-not-served" | "custom-not-served" };

/** 一条会话模型设置（App 设置页的 global.sessionModel*）。 */
export interface SessionModelSetting {
  mode: "caller" | "custom";
  provider: string;
  model: string;
  /** 推理强度档位；空串 = 不指定，由 DSH 决定。 */
  reasoningEffort: string;
}

/**
 * 从 App 设置里取会话模型设置（纯函数）：模式只认 caller / custom，其余当缺省 caller；
 * custom 但 provider/model 没填全时也当 caller（界面上保存不了这种状态，读到脏值不拓）。
 * @param settings - App 设置对象（readSettingsSync 的产物）
 * @returns 归一化后的设置
 */
export function sessionModelSettingOf(settings: unknown): SessionModelSetting {
  const s = settings && typeof settings === "object" ? (settings as any) : {};
  const provider = typeof s.sessionModelProvider === "string" ? s.sessionModelProvider.trim() : "";
  const model = typeof s.sessionModelModel === "string" ? s.sessionModelModel.trim() : "";
  const reasoningEffort =
    typeof s.sessionModelReasoningEffort === "string" ? s.sessionModelReasoningEffort.trim() : "";
  const mode = s.sessionModelMode === "custom" && provider && model ? "custom" : "caller";
  return { mode, provider, model, reasoningEffort };
}

/**
 * 工具建的会话该不该按调用方角色卡补模型（纯函数）。
 * @param args - explicit：工具入参显式给的；appSetting：App 设置里的会话模型；
 *   stored：DSH settings 里用户手设的；card：调用方角色卡配的；served：宿主目录
 * @returns 决策（`select` 才随请求带上）
 */
export function planCallerSelection(args: {
  explicit?: { provider?: unknown; model?: unknown } | null;
  appSetting?: SessionModelSetting | null;
  stored?: { provider?: unknown; model?: unknown } | null;
  card?: CardModel | null;
  served: readonly ServedModel[];
}): CallerPlan {
  if (pickOf(args.explicit)) return { kind: "skip", reason: "explicit" };
  const setting = args.appSetting;
  if (setting && setting.mode === "custom") {
    if (servedHas(args.served, setting)) {
      return {
        kind: "select",
        provider: setting.provider,
        model: setting.model,
        ...(setting.reasoningEffort ? { reasoningEffort: setting.reasoningEffort } : {}),
      };
    }
    return { kind: "skip", reason: "custom-not-served" };
  }
  if (pickOf(args.stored)) return { kind: "skip", reason: "user-default" };
  const card = args.card;
  if (!card || !card.provider || !card.model) return { kind: "skip", reason: "no-card" };
  if (!servedHas(args.served, card)) return { kind: "skip", reason: "card-not-served" };
  return { kind: "select", provider: card.provider, model: card.model };
}

/** 读事实的边界（可注入：单测不碰宿主面）。 */
export interface CallerPlanDeps {
  card?: () => Promise<CardModel | null>;
  /** App 设置里的会话模型（缺省 = 复用调用方）。 */
  setting?: () => SessionModelSetting;
  stored?: () => { provider?: string; model?: string } | null;
  served?: () => Promise<ServedModel[]>;
}

/**
 * 取齐决策要的几件事实，给出决策。每一步取数失败都只记一行、按最保守的结果收场：
 * 设置/默认模型读不到 → 当成没设，目录取不到 → 当成空目录，角色卡取不到 → 当成没配。
 * @param explicit - 工具入参显式给的 provider/model
 * @param deps - 取数面（缺省：App 设置 / bus 读角色卡 / settings.yaml 读用户默认 / ctx.models.list）
 * @param note - 一行日志出口
 * @returns 决策
 */
export async function resolveCallerPlan(
  explicit: { provider?: unknown; model?: unknown } | null,
  deps: CallerPlanDeps = {},
  note: (msg: string) => void = () => {},
): Promise<CallerPlan> {
  if (pickOf(explicit)) return { kind: "skip", reason: "explicit" };
  let setting: SessionModelSetting | null = null;
  if (typeof deps.setting === "function") {
    try {
      setting = deps.setting();
    } catch (e) {
      note("读 App 设置里的会话模型失败（按复用调用方处理）：" + errText(e));
    }
  }
  const custom = setting && setting.mode === "custom" ? setting : null;
  let stored: { provider?: string; model?: string } | null = null;
  if (!custom && typeof deps.stored === "function") {
    try {
      stored = deps.stored();
    } catch (e) {
      note("读 DSH 设置里的默认模型失败（当成没设）：" + errText(e));
    }
  }
  const needCard = !custom && !pickOf(stored);
  let card: CardModel | null = null;
  if (needCard && typeof deps.card === "function") {
    try {
      card = await deps.card();
    } catch (e) {
      note("读调用方角色卡的模型失败（本次不补）：" + errText(e));
    }
  }
  let served: ServedModel[] = [];
  if (typeof deps.served === "function") {
    try {
      served = await deps.served();
    } catch (e) {
      note("读宿主模型目录失败（本次不补）：" + errText(e));
    }
  }
  const plan = planCallerSelection({ explicit, appSetting: setting, stored, card, served });
  if (plan.kind === "skip" && plan.reason === "card-not-served" && card) {
    note("调用方角色卡配的模型不在宿主目录里（本次不补）：" + card.provider + "/" + card.model);
  }
  if (plan.kind === "skip" && plan.reason === "custom-not-served" && custom) {
    note("设置里自定义的会话模型不在宿主目录里（本次不补）：" + custom.provider + "/" + custom.model);
  }
  return plan;
}

/**
 * 运行期取数面：App 设置（会话模型）+ bus 读调用方角色卡 + settings.yaml 读用户默认 + 目录。
 * @param ctx - 宿主 App ctx
 * @param dshHome - 当前源的 DSH_HOME（取不到时当成用户层为空）
 * @param dataDir - App 数据目录（读 App 设置文件）
 */
export function callerPlanDeps(ctx: unknown, dshHome: string | null | undefined, dataDir?: string | null): CallerPlanDeps {
  return {
    setting: () => sessionModelSettingOf(dataDir ? readSettingsSync(dataDir) : {}),
    card: () => readCallerCardModel(ctx),
    // dshHome 取不到（数据源未定）时当成用户层为空：不补，不是错误
    stored: () => (dshHome ? readDshDefaultModel(dshHome) : null),
    served: async () => {
      const listed: any = await (ctx as any)?.models?.list?.();
      return servedModels(listed && listed.models);
    },
  };
}
