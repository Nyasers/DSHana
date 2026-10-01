// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/shared-state.ts — UI 跨面共享通道的纯词表（键前缀、值构造、读侧挑选）。
//
// 通道：应用态存储（hana.storage.global → <dataDir>/storage/global.json）。主卡与 FP 用它对齐
// 视图状态：boot 快照、设置视图、会话选中、主面板选中（读写实现见 ui/surface-bridge.ts）。
//
// 键形如 `dshana.<kind>`，**不带卡片实例**：本 App 单 DSH 源、单主卡，宿主给主卡与其 FP 同一个
// cardInstanceId，按实例分段没有区分度。于是这批键的寿命就是一次 App 生命周期——没有哪一个键
// 该活过它。
//
// 纯挑选逻辑（listSharedKeys）与副作用（App 侧的 renewSharedState）分开：前者是单测面，后者
// 只做一次 getAll + 逐个 delete。广播键 `dshana:settings` 不在此列（冒号而非点号，且它是设置
// revision 的广播面，不是视图状态）。

/** UI 共享通道的键前缀（页面侧拼键与应用侧收尾共用；改一处必须改两处）。 */
export const SHARED_KEY_PREFIX = "dshana.";

/** 跨面共用的当前选中会话（写侧：壳页在本地选中变化时写；读侧：FP 与主卡的对齐，
 * 以及 DSH 侧 ui-session 在「本面没钉住 sid」时跟随它）。消费方见 ui/surface-bridge.ts 与
 * src-integrations/ui-session。会话卡不写也不读它——那张卡钉自己那一段。 */
export const SELECTION_SHARED_KEY = SHARED_KEY_PREFIX + "selection";

/** 会话选中的写入值：意见带写入时刻 at（消费侧只采纳比自己动手更新的）。 */
export function selectionSharedValue(sessionId: string | null, at = Date.now()): { sessionId: string | null; at: number } {
  return { sessionId: typeof sessionId === "string" && sessionId ? sessionId : null, at };
}

/** 应用态存储的最小面（结构类型：不绑定 SDK 类型，单测可直接传假实现）。
 * 与宿主 `ctx.storage.global` 一致：getAll 回 `{ entries }`，delete 按键删。 */
export interface SharedStateStore {
  getAll(): Promise<{ entries?: Record<string, unknown> } | undefined>;
  delete(key: string): Promise<unknown>;
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
