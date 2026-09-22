// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/model-catalog-view.ts — 宿主模型目录（ctx.models.list）→ 设置页要的分组视图
//
// 设置页的模型候选只认宿主目录：宿主目录是「这条路走不走得通」的唯一事实源（见 lib/host-models.ts），
// 页面按它列 provider / 模型 / 推理档，不读 DSH 自己的目录，也不依赖 DSH 运行。
//
// 目录条目是宿主的不透明投影（AppModelInfoV2 = Record<string, unknown>）：这里只取展示与选择用得上
// 的那几个字段，凭据、端点、计价一概不进浏览器。
//
// 推理档：宿主按模型声明 defaultThinkingLevel / xhigh / thinkingLevels / customThinkingLevels，
// 可用档取它与 off..max 词表的交集；一条都没声明但条目声明了 reasoning 时给保守面 [off, high]
// （DSH agent 的默认档 high 必须可被接受）。受管 runtime 侧 @dshana/provider 的 lib/catalog.ts
// 持有同一套词表与优先序——两份实现分属 App 主进程与 cordis 子插件两个 bundle，不能互相 import。

/** 宿主与 pi-ai 共用的推理档词表（off..max 升序）。 */
export const CANONICAL_EFFORT_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 一个推理档（id 是传给宿主的词，name 是页面显示的字）。 */
export interface CatalogEffort {
  id: string;
  name: string;
}

/** 一条可选模型。 */
export interface CatalogModel {
  id: string;
  name: string;
  /** 该模型能接受的推理档；空/缺省 = 不支持显式档位，页面不画那一行。 */
  efforts?: CatalogEffort[];
  /** 该模型的默认档（在 efforts 内）；缺省 = 页面上留空，由 DSH 决定。 */
  defaultEffort?: string;
}

/** 一组同类模型（按 provider 分组）。 */
export interface CatalogGroup {
  id: string;
  name: string;
  models: CatalogModel[];
}

/** 档位字段的形状不定（数组 / 对象 / {level|id} 条目），统一收成字符串集合。 */
function asStringSet(value: unknown): Set<string> {
  const set = new Set<string>();
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string" && v) set.add(v);
      else if (v && typeof v === "object" && typeof (v as any).level === "string" && (v as any).level) set.add((v as any).level);
      else if (v && typeof v === "object" && typeof (v as any).id === "string" && (v as any).id) set.add((v as any).id);
    }
    return set;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (v === true || v === undefined) set.add(k);
      else if (typeof v === "string" && v) set.add(v);
    }
  }
  return set;
}

/**
 * 一条目录项的可用推理档（升序、去重；空 = 模型不支持显式档位）。
 * 来源优先级：defaultThinkingLevel / xhigh / thinkingLevels / customThinkingLevels。
 */
export function supportedEfforts(entry: unknown): string[] {
  const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
  if (item.reasoning !== true) return [];
  const raw = new Set<string>();
  if (typeof item.defaultThinkingLevel === "string" && item.defaultThinkingLevel) raw.add(item.defaultThinkingLevel);
  if (item.xhigh === true) raw.add("xhigh");
  for (const s of asStringSet(item.thinkingLevels)) raw.add(s);
  for (const s of asStringSet(item.customThinkingLevels)) raw.add(s);
  const inter = CANONICAL_EFFORT_IDS.filter((id) => raw.has(id));
  return inter.length > 0 ? [...inter] : ["off", "high"];
}

/** 档位显示名：与 DSH 侧注册的档位名同款（id 首字母大写）。 */
function effortLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** 该目录项的默认档：声明值在可用档内取之，否则 high，再否则第一档。 */
function defaultEffortOf(item: Record<string, unknown>, efforts: readonly string[]): string | undefined {
  if (efforts.length === 0) return undefined;
  const declared = typeof item.defaultThinkingLevel === "string" ? item.defaultThinkingLevel : "";
  if (declared && efforts.includes(declared)) return declared;
  return efforts.includes("high") ? "high" : efforts[0];
}

/**
 * 宿主目录 → 设置页的分组视图：按 provider 成组（组名就用 provider id），组内按模型显示名排序。
 * provider/id 缺一的条目跳过（不成组、也不可选）；同一 provider 里 id 重复只留第一条。
 * @param models - ctx.models.list() 的 models
 * @returns 分组视图（目录空或形状不符时是空数组，页面画成「宿主没有可选模型」）
 */
export function groupHostCatalog(models: unknown): CatalogGroup[] {
  const byProvider = new Map<string, Map<string, CatalogModel>>();
  for (const entry of Array.isArray(models) ? models : []) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const provider = typeof item.provider === "string" ? item.provider.trim() : "";
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!provider || !id) continue;
    let group = byProvider.get(provider);
    if (!group) {
      group = new Map<string, CatalogModel>();
      byProvider.set(provider, group);
    }
    if (group.has(id)) continue;
    const efforts = supportedEfforts(item);
    const model: CatalogModel = {
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : id,
    };
    if (efforts.length > 0) {
      model.efforts = efforts.map((e) => ({ id: e, name: effortLabel(e) }));
      const def = defaultEffortOf(item, efforts);
      if (def) model.defaultEffort = def;
    }
    group.set(id, model);
  }
  return [...byProvider.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, models]) => ({
      id,
      name: id,
      models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    }));
}
