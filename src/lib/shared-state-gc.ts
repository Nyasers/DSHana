// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/shared-state-gc.ts — 回收 UI 跨面共享状态留在应用态存储里的陈旧键。
//
// 背景：ui/app-shell.ts 用应用态存储（hana.storage.global）做主卡与 FP 之间的共享通道，
// 键按卡片实例配对（`dshana.card.<cardInstanceId>.<kind>`，主卡与其 FP 同一实例 id）。卡片
// 下线时 UI 会删掉自己那把键，但进程被杀、页面被替换等情况下删不掉，旧键就留在存储里再没有
// 消费方（真机 10 天积了 139 个键、1226 次写入，逼近 1MB/应用 的配额）。
//
// 本模块在 App 加载时做一次回收：前缀匹配 + 快照时间（值的 at 字段）早于保留窗口的键删掉。
// 保留窗口比跨面配对的实际寿命宽得多（默认 1 小时），只清真正没人再读的；at<=0（UI 留下的
// 「已过期」标记）一律回收。
//
// 纯挑选逻辑（pickStaleSharedKeys）与副作用（pruneSharedState）分开：前者是单测面，后者只做
// 一次 getAll + 逐个 delete，任何失败只记数不抛——回收是维护动作，不影响 App 加载。

/** UI 共享通道的键前缀（与 ui/app-shell.ts 的 sharedKey 同源；改一处必须改两处）。 */
export const SHARED_KEY_PREFIX = "dshana.card.";

/** 保留窗口：快照时间在此窗口内的键不回收。 */
export const SHARED_KEY_KEEP_MS = 60 * 60 * 1000;

/**
 * 应用态存储的最小面（结构类型：不绑定 SDK 类型，单测可直接传假实现）。
 * 与宿主 `ctx.storage.global` 一致：getAll 回 `{ entries }`，delete 按键删。
 */
export interface SharedStateStore {
  getAll(): Promise<{ entries?: Record<string, unknown> } | undefined>;
  delete(key: string): Promise<unknown>;
}

/** 回收结果（诊断面用）。 */
export interface SharedStateGcResult {
  scanned: number;
  removed: number;
  failed: number;
}

/**
 * 从存储快照里挑出该回收的键（纯函数）。
 * @param entries getAll 的 entries（键 → 值）
 * @param now 当前时间戳（毫秒）
 * @param keepMs 保留窗口；at 在此窗口内视为活快照
 */
export function pickStaleSharedKeys(
  entries: Record<string, unknown> | null | undefined,
  now: number,
  keepMs: number = SHARED_KEY_KEEP_MS,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (!key.startsWith(SHARED_KEY_PREFIX)) continue;
    const at = value && typeof value === "object" ? (value as { at?: unknown }).at : undefined;
    const fresh = typeof at === "number" && at > 0 && now - at < keepMs;
    if (!fresh) out.push(key);
  }
  return out.sort();
}

/**
 * 扫一遍应用态存储，删掉陈旧的共享键。失败一律不抛（apply 成败不受回收影响）。
 * @param store 宿主 `ctx.storage.global`（缺失/形状不符即 no-op）
 * @param now 当前时间戳（毫秒）
 * @param keepMs 保留窗口
 */
export async function pruneSharedState(
  store: SharedStateStore | null | undefined,
  now: number = Date.now(),
  keepMs: number = SHARED_KEY_KEEP_MS,
): Promise<SharedStateGcResult> {
  const result: SharedStateGcResult = { scanned: 0, removed: 0, failed: 0 };
  if (!store || typeof store.getAll !== "function" || typeof store.delete !== "function") return result;
  let entries: Record<string, unknown>;
  try {
    const all = await store.getAll();
    entries = all && typeof all === "object" && all.entries ? all.entries : {};
  } catch {
    return result;
  }
  result.scanned = Object.keys(entries).length;
  for (const key of pickStaleSharedKeys(entries, now, keepMs)) {
    try {
      await store.delete(key);
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
