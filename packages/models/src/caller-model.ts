// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/models/src/caller-model.ts — 工具建的 DSH 会话用哪个模型（跟着调用方走）
//
// 会话的模型跟着「谁开的」走：open 建的会话，缺省模型取调用方**当前实际在用的**那条
// （调用方会话的会话选择：provider + model + 推理强度），与宿主 subagent 拿上一级的模型
// 是同一个意思。App 设置里可以改成「自定义模型」（固定一条），那时它优先——它是针对本
// App 会话的更具体的选择。三种情况不补：
//   · 工具入参已经显式给了 provider/model（显式照旧）；
//   · App 设置是「自定义模型」且那条填好了（用它）；
//   · 调用方会话读不到，或它用的模型不在宿主目录里（补了也跑不动，让报错点到那个名字）。
//
// 为什么读会话而不是角色卡：角色卡是**静态配置**，会话是**实际在用的**——会话开跑后
// 用户可能在会话里换过模型，那份变更只记在会话自己的事件流里，角色卡上读不到。

import { readSettingsSync } from "@dshana/runtime/data-source.ts";
import { errText } from "@dshana/shared/err-text.ts";
import { servedHas, servedModels, type ServedModel } from "./host-models.ts";

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
  | { kind: "skip"; reason: "explicit" | "no-session" | "session-not-served" | "custom-not-served" };

/** 调用方会话当前的选择（provider/model 必填，推理强度可选）。 */
export interface SessionSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

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
 * 工具建的会话该不该补模型、补哪一条（纯函数）。
 * @param args - explicit：工具入参显式给的；appSetting：App 设置里的会话模型；
 *   session：调用方会话当前的选择；served：宿主目录
 * @returns 决策（`select` 才随请求带上）
 */
export function planCallerSelection(args: {
  explicit?: { provider?: unknown; model?: unknown } | null;
  appSetting?: SessionModelSetting | null;
  session?: SessionSelection | null;
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
  // caller 模式：跟随调用方会话实际在用的那条。读不到（或它不在宿主目录里）就不补——
  // 不换成别的来源：跟随调用方是这一模式的实义，拿角色卡上的静态配置充数就是答非所问。
  const session = args.session;
  if (!session) return { kind: "skip", reason: "no-session" };
  if (!servedHas(args.served, session)) return { kind: "skip", reason: "session-not-served" };
  return {
    kind: "select",
    provider: session.provider,
    model: session.model,
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
  };
}

/** 读事实的边界（可注入：单测不碰宿主面）。 */
export interface CallerPlanDeps {
  /** App 设置里的会话模型（缺省 = 复用调用方）。 */
  setting?: () => SessionModelSetting;
  /** 调用方会话当前的选择。 */
  session?: () => Promise<SessionSelection | null>;
  served?: () => Promise<ServedModel[]>;
}

/**
 * 取齐决策要的几件事实，给出决策。每一步取数失败都只记一行、按最保守的结果收场：
 * 设置读不到 → 当成没设，目录取不到 → 当成空目录，会话读不到 → 当成没有来源（不补）。
 * @param explicit - 工具入参显式给的 provider/model
 * @param deps - 取数面（缺省：App 设置 / 调用方会话 / ctx.models.list）
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
  let served: ServedModel[] = [];
  if (typeof deps.served === "function") {
    try {
      served = await deps.served();
    } catch (e) {
      note("读宿主模型目录失败（本次不补）：" + errText(e));
    }
  }
  let session: SessionSelection | null = null;
  if (!custom && typeof deps.session === "function") {
    try {
      session = await deps.session();
    } catch (e) {
      note("读调用方会话的模型失败（本次不补）：" + errText(e));
    }
  }
  const plan = planCallerSelection({ explicit, appSetting: setting, session, served });
  if (plan.kind === "skip" && plan.reason === "session-not-served" && session) {
    note("调用方会话用的模型不在宿主目录里（本次不补）：" + session.provider + "/" + session.model);
  }
  if (plan.kind === "skip" && plan.reason === "custom-not-served" && custom) {
    note("设置里自定义的会话模型不在宿主目录里（本次不补）：" + custom.provider + "/" + custom.model);
  }
  return plan;
}

/**
 * 运行期取数面：App 设置（会话模型）+ 调用方会话当前选择 + 宿主目录。
 * @param ctx - 宿主 App ctx
 * @param dataDir - App 数据目录（读 App 设置文件）
 * @param callerSessionId - 调用方会话 id（宿主任务记录的 parentSessionId）
 */
export function callerPlanDeps(ctx: unknown, dataDir?: string | null, callerSessionId?: string | null): CallerPlanDeps {
  return {
    setting: () => sessionModelSettingOf(dataDir ? readSettingsSync(dataDir) : {}),
    session: () => readCallerSessionSelection(ctx, callerSessionId),
    served: async () => {
      const listed: any = await (ctx as any)?.models?.list?.();
      return servedModels(listed && listed.models);
    },
  };
}

/**
 * 读调用方会话当前的选择（provider + model + 推理强度）。
 *
 * 「跟随调用方」跟的是**实际在用的**那条，不是角色卡上的静态配置：会话开跑后用户可能在
 * 会话里换过模型，那份变更只记在会话自己的事件流里，角色卡上读不到。
 *
 * 经宿主的 session:context 读——那是为「读某个会话当前状态」造的口，一次把 model 与
 * thinkingLevel 都给全；自己解析会话文件要拿「发生过什么」的流水反推「现在是什么」，
 * 两串事件（model_change / thinking_level_change）各自独立，反推容易错。调用方会话不属于
 * 本 App，所以要 scope:"all" 与 app/sessions.read。
 *
 * 寻址用 sessionId：session:context 的归属判定走会话 manifest，它只认 sessionId 或
 * legacySessionPath（一条 path 单独交出去解析不出来）。调用方会话的 id 就写在宿主任务记录的
 * parentSessionId 里（见 session-run 的取数），不用另找。
 *
 * 读不到一律 null（不抛）：没有 id、未授权、会话不在，都归为「调用方当前选择未知」，
 * 由调用方按不补收场（不换来源充数）。
 */
async function readCallerSessionSelection(ctx: unknown, sessionId?: string | null): Promise<SessionSelection | null> {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const bus = (ctx as any)?.bus;
  if (!bus || typeof bus.request !== "function") return null;
  const res: any = await bus.request("session:context", { sessionId: id, scope: "all" });
  const model = res && res.model;
  const provider = model && typeof model.provider === "string" ? model.provider.trim() : "";
  const modelId = model && typeof model.id === "string" ? model.id.trim() : "";
  if (!provider || !modelId) return null;
  const effort = typeof res.thinkingLevel === "string" ? res.thinkingLevel.trim() : "";
  return { provider, model: modelId, ...(effort ? { reasoningEffort: effort } : {}) };
}
