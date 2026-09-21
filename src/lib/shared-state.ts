// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/shared-state.ts — UI 跨面共享通道的键前缀与生命周期收尾。
//
// 通道：应用态存储（hana.storage.global → <dataDir>/storage/global.json）。主卡与 FP 用它对齐
// 视图状态：boot 快照、设置视图、会话选中、主面板选中（见 ui/app-shell.ts）。
//
// 键形如 `dshana.<kind>`，**不带卡片实例**：本 App 单 DSH 源、单主卡，宿主给主卡与其 FP 同一个
// cardInstanceId，按实例分段没有区分度。于是这批键的寿命就是一次 App 生命周期——没有哪一个键
// 该活过它。
//
// 收尾因此只有一件事：每次 apply 把这批键清空（renewSharedState）。进程被杀、页面被替换时，
// 页面来不及删自己的键，而上次生命周期留下的键没有消费方：按前缀一次清空，不看键里的值。
//
// 纯挑选逻辑（listSharedKeys）与副作用（renewSharedState）分开：前者是单测面，后者只做一次
// getAll + 逐个 delete，任何失败只记数不抛——收尾是维护动作，不影响 App 加载。
// 广播键 `dshana:settings` 不在此列（冒号而非点号，且它是设置 revision 的广播面，不是视图状态）。

/** UI 共享通道的键前缀（与 ui/app-shell.ts 的 sharedKey 同源；改一处必须改两处）。 */
export const SHARED_KEY_PREFIX = "dshana.";

/** 应用态存储的最小面（结构类型：不绑定 SDK 类型，单测可直接传假实现）。
 * 与宿主 `ctx.storage.global` 一致：getAll 回 `{ entries }`，delete 按键删。 */
export interface SharedStateStore {
  getAll(): Promise<{ entries?: Record<string, unknown> } | undefined>;
  delete(key: string): Promise<unknown>;
}

/** 收尾结果（诊断面用）。 */
export interface SharedStateRenewResult {
  scanned: number;
  removed: number;
  failed: number;
}

/**
 * 从存储快照里挑出本通道的键（纯函数）。
 * @param entries getAll 的 entries（键 → 值）
 */
export function listSharedKeys(entries: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const key of Object.keys(entries ?? {})) {
    if (key.startsWith(SHARED_KEY_PREFIX)) out.push(key);
  }
  return out.sort();
}

/**
 * 清空本通道在应用态存储里留下的键（每次 App apply 调用）。失败一律不抛。
 * @param store 宿主 `ctx.storage.global`（缺失/形状不符即 no-op）
 */
export async function renewSharedState(
  store: SharedStateStore | null | undefined,
): Promise<SharedStateRenewResult> {
  const result: SharedStateRenewResult = { scanned: 0, removed: 0, failed: 0 };
  if (!store || typeof store.getAll !== "function" || typeof store.delete !== "function") return result;
  let entries: Record<string, unknown>;
  try {
    const all = await store.getAll();
    entries = all && typeof all === "object" && all.entries ? all.entries : {};
  } catch {
    return result;
  }
  result.scanned = Object.keys(entries).length;
  for (const key of listSharedKeys(entries)) {
    try {
      await store.delete(key);
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
