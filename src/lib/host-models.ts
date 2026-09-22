// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/host-models.ts — 宿主模型目录（ctx.models.list）的归一化与查询
//
// 宿主目录是「这条路走不走得通」的唯一事实源：受管 runtime 里的 provider 路由由
// @dshana/provider 按它注册，目录里没有的 provider/model 选下去只会在提交时报
// model-unavailable。所以凡是要判断「这个模型能不能用」的地方（默认模型对账、按调用方角色卡
// 补会话模型）都读这一份。
//
// 只做归一化：目录条目形状可能变（缺字段、留空白），这里统一成 { provider, id }，
// 其余字段一概不参与判断。

/** 宿主目录里一条可服务的模型。 */
export interface ServedModel {
  provider: string;
  id: string;
}

/** 宿主目录归一化：provider/id 都非空的条目（其余形状不参与选择）。 */
export function servedModels(models: unknown): ServedModel[] {
  const out: ServedModel[] = [];
  for (const item of Array.isArray(models) ? models : []) {
    const provider = item && typeof (item as any).provider === "string" ? (item as any).provider.trim() : "";
    const id = item && typeof (item as any).id === "string" ? (item as any).id.trim() : "";
    if (provider && id) out.push({ provider, id });
  }
  return out;
}

/** 这条选择在目录里吗（provider 与 model 都要对上）。 */
export function servedHas(served: readonly ServedModel[], pick: { provider?: string; model?: string } | null | undefined): boolean {
  const provider = pick && typeof pick.provider === "string" ? pick.provider.trim() : "";
  const model = pick && typeof pick.model === "string" ? pick.model.trim() : "";
  if (!provider || !model) return false;
  return served.some((s) => s.provider === provider && s.id === model);
}
