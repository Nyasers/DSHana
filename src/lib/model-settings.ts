// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/model-settings.ts — 默认模型：经 DSH 自己的 settings 服务读写（App 侧薄封装）
//
// 这份值的正主是 DSH：settings 段 `agent-default-model`（持有者 @deepseek-ai/dsh-agent-default-model）。
// 我们只过手——**不在 config.json 存副本**，也**不碰 DSH_HOME/settings.yaml**（两个写者会互打）；
// 读回来的是 DSH 的权威值 + 段 revision，写回时把读到的 revision 交回去，落后了由 DSH 拒。
//
// 通道与 session/cancel 同一条：App 主进程经中继（serviceBase + bridge 鉴权头）打 DSH 的
// /api 网关一元 RPC。用到的两条方法是 settings/describe 与 settings/replace（参数名
// ns/section/expectedRevision），候选在 session/modelCatalog——那是无参方法，信封不包
// session 家族的 request 层（见 rpc-envelope 的 bare）。三条都在真 DSH 上探测过：
// describe 的段视图带 value+revision，写回带当前 revision 成功且 revision 前进，
// 带过期 revision 被拒并且错误码是 settings/conflict（对应 App 层的 409）。
import { serviceBase, serviceFetch } from "#/lib/service-base.ts";
import {
  AGENT_DEFAULT_MODEL_NS,
  isSettingsConflict,
  rpcModelCatalog,
  rpcSettingsDescribe,
  rpcSettingsReplace,
  settingsViewOf,
} from "#/lib/dsh-rpc.ts";
import { errText } from "#/lib/err-text.ts";

/** 归一化模型选择：provider/model 必填，reasoningEffort 可选。 */
function normalizeSelection(input) {
  const provider = typeof input?.provider === "string" ? input.provider.trim() : "";
  const model = typeof input?.model === "string" ? input.model.trim() : "";
  if (!provider || !model) throw new Error("模型选择需要 provider 与 model（都是非空字符串）");
  const out: { provider: string; model: string; reasoningEffort?: string } = { provider, model };
  const effort = typeof input?.reasoningEffort === "string" ? input.reasoningEffort.trim() : "";
  if (effort) out.reasoningEffort = effort;
  return out;
}

/** 候选目录瘦身：只留页面要用的字段（描述类长文本不进浏览器）。 */
function trimCatalog(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  return {
    default: catalog?.default && typeof catalog.default === "object" ? { ...catalog.default } : null,
    routableProviders: Array.isArray(catalog?.routableProviders) ? [...catalog.routableProviders] : [],
    groups: groups.map((g) => ({
      id: String(g?.id ?? ""),
      name: String(g?.name ?? g?.id ?? ""),
      models: (Array.isArray(g?.models) ? g.models : []).map((m) => {
        const entry: { id: string; name: string; efforts?: { id: string; name: string }[]; defaultEffort?: string } = {
          id: String(m?.id ?? ""),
          name: String(m?.name ?? m?.id ?? ""),
        };
        const efforts = m?.reasoning?.efforts;
        if (Array.isArray(efforts) && efforts.length) {
          entry.efforts = efforts
            .map((e) => ({ id: String(e?.id ?? ""), name: String(e?.name ?? e?.id ?? "") }))
            .filter((e) => e.id);
          if (typeof m?.reasoning?.defaultEffort === "string") entry.defaultEffort = m.reasoning.defaultEffort;
        }
        return entry;
      }),
    })),
    failures: (Array.isArray(catalog?.failures) ? catalog.failures : []).map((f) => ({
      id: String(f?.id ?? ""),
      name: String(f?.name ?? f?.id ?? ""),
      message: String(f?.message ?? ""),
    })),
  };
}

/**
 * 读当前默认模型 + 候选目录。候选取不到不算读失败：当前值照常返回，catalogError 带上原因
 * （设置页可以把这一节画成"候选暂不可用"，而不是整页报错）。
 * `current` 是解析后的值（默认值 → 组合 base 层 → 用户层），`stored` 只取用户层——「这格被谁
 * 设过」只能看 stored：用户层为空时 current 仍会回落到 base 层的默认。
 */
export async function readDefaultModel(fetchFn) {
  const base = serviceBase();
  const doFetch = serviceFetch(fetchFn);
  const described = await rpcSettingsDescribe(doFetch, base);
  const view = settingsViewOf(described, AGENT_DEFAULT_MODEL_NS);
  if (!view) throw new Error(`DSH 没有 ${AGENT_DEFAULT_MODEL_NS} 段（settings/describe 里找不到）`);
  let catalog: ReturnType<typeof trimCatalog> | null = null;
  let catalogError: string | null = null;
  try {
    catalog = trimCatalog(await rpcModelCatalog(doFetch, base));
  } catch (e) {
    catalogError = errText(e);
  }
  return {
    current: view.value && typeof view.value === "object" ? { ...view.value } : null,
    stored: view.user && typeof view.user === "object" ? { ...view.user } : null,
    revision: typeof view.revision === "number" ? view.revision : null,
    applies: typeof view.applies === "string" ? view.applies : null,
    writable: described?.writable !== false,
    catalog,
    catalogError,
  };
}

/**
 * 写默认模型（整段替换）。未给 expectedRevision 时先读一次现值与 revision：
 * · revision 交给 DSH 做并发闸；
 * · reasoningEffort 未指定时保留段里原有值——replace 是整段替换，不保留就真丢了。
 * 冲突（段已被别处改过）统一抛 code=SETTINGS_CONFLICT，由路由层映射 409。
 */
export async function writeDefaultModel(fetchFn, patch) {
  const base = serviceBase();
  const doFetch = serviceFetch(fetchFn);
  const next = normalizeSelection(patch);
  let expectedRevision = typeof patch?.expectedRevision === "number" ? patch.expectedRevision : undefined;
  if (expectedRevision === undefined || next.reasoningEffort === undefined) {
    const described = await rpcSettingsDescribe(doFetch, base);
    const view = settingsViewOf(described, AGENT_DEFAULT_MODEL_NS);
    if (!view) throw new Error(`DSH 没有 ${AGENT_DEFAULT_MODEL_NS} 段（settings/describe 里找不到）`);
    if (expectedRevision === undefined && typeof view.revision === "number") expectedRevision = view.revision;
    if (next.reasoningEffort === undefined) {
      const effort = view.value && typeof view.value.reasoningEffort === "string" ? view.value.reasoningEffort : "";
      if (effort) next.reasoningEffort = effort;
    }
  }
  try {
    const view = await rpcSettingsReplace(doFetch, base, {
      ns: AGENT_DEFAULT_MODEL_NS,
      section: next,
      expectedRevision,
    });
    return {
      current: view && view.value && typeof view.value === "object" ? { ...view.value } : next,
      revision: typeof view?.revision === "number" ? view.revision : null,
    };
  } catch (e) {
    if (isSettingsConflict(e)) {
      const conflict = new Error("默认模型已被别处改过（段 revision 前进），请刷新后重试") as Error & { code: string };
      conflict.code = "SETTINGS_CONFLICT";
      conflict.cause = e;
      throw conflict;
    }
    throw e;
  }
}

export { AGENT_DEFAULT_MODEL_NS, isSettingsConflict };

/**
 * 清掉 settings 里的用户默认模型（整段替换成空对象）：用户层清空后值回落到 base 层，
 * 也就是「这一格没被谁设过」。
 *
 * 用处是「按调用方角色卡补完会话模型」之后收尾：DSH 的 session/selectModel 顺带 saveSelection
 * （那是它给「页面上选模型」的语义），那份写入会把我们按角色卡补的值变成全局默认，下次换个
 * agent 调用时就被当成用户设的。用户层本来就空时不动它。
 * @param fetchFn - 宿主代发 fetch
 * @returns true = 清了一次；false = 用户层本来就空（没动）
 */
export async function clearStoredDefaultModel(fetchFn) {
  const base = serviceBase();
  const doFetch = serviceFetch(fetchFn);
  const described = await rpcSettingsDescribe(doFetch, base);
  const view = settingsViewOf(described, AGENT_DEFAULT_MODEL_NS);
  if (!view) return false;
  const user = view.user;
  if (!user || typeof user !== "object" || Object.keys(user).length === 0) return false;
  const expectedRevision = typeof view.revision === "number" ? view.revision : undefined;
  await rpcSettingsReplace(doFetch, base, { ns: AGENT_DEFAULT_MODEL_NS, section: {}, expectedRevision });
  return true;
}
