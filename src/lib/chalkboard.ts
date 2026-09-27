// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/chalkboard.ts — 把一段会话放到黑板上（入口卡与设置页共用的那一步）。
//
// 黑板卡不是 App 自己开的窗口：App 在 manifest 里声明一张卡（contributes.cards），
// 然后请宿主把它放上黑板（UI 面的 hana.cards.open(cardId)）。位置、外框、关闭按钮与
// surface 凭据都归宿主——App 只说「我要这张卡」。
//
// 一张声明卡在黑板上只有一份：宿主已有就揭示它，不再开第二份（见宿主 cards.open 的
// 实现：按 (pluginId, cardId) 找实例）。所以这张卡跟随「跨面共用的当前选中」，而不是
// 自带坐标：放置前先把目标会话写进共享选中，卡挂上去时读到的就是它。
//
// SDK 由调用方注入（与 ui/dsh-inject.ts 同一纪律）：本模块不 import SDK，单测直接传假实现。
import { SELECTION_SHARED_KEY, selectionSharedValue } from "./shared-state.ts";

/** 黑板上那张 DSH 会话卡（manifest contributes.cards 里的 id）。 */
export const SESSION_CARD_ID = "session";

/** 本模块用到的最小 SDK 面（结构类型：不绑定 SDK 类型）。 */
export interface ChalkboardSdk {
  readonly storage?: { readonly global?: unknown } | undefined;
  readonly cards?: { open(cardId: string): Promise<unknown> } | undefined;
}

/** 取应用态存储面（SDK 里即可调用对象、也可能是工厂，两边兼容地取）。 */
function globalStore(sdk: ChalkboardSdk | null | undefined): { set(key: string, value: unknown): Promise<unknown> } | null {
  const raw = sdk && sdk.storage ? sdk.storage.global : null;
  const store = typeof raw === "function" ? (raw as () => unknown)() : raw;
  const candidate = store as { set?: unknown } | null | undefined;
  return candidate && typeof candidate.set === "function"
    ? (candidate as { set(key: string, value: unknown): Promise<unknown> })
    : null;
}

/**
 * 把一段会话放到黑板上。
 * 两步：写跨面共用选中（黑板卡读它）→ 请宿主放置本 App 声明的那张卡。
 * @param sdk - 壳页的宿主 UI SDK（hana）
 * @param sessionId - 要放到黑板上的 DSH 会话 id
 */
export async function placeSessionOnChalkboard(
  sdk: ChalkboardSdk | null | undefined,
  sessionId: string,
): Promise<void> {
  const sid = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!sid) throw new Error("没有可放到黑板的会话（缺 sessionId）");
  const store = globalStore(sdk);
  if (!store) throw new Error("hana.storage.global 不可用");
  const open = sdk && sdk.cards && typeof sdk.cards.open === "function" ? sdk.cards.open.bind(sdk.cards) : null;
  if (!open) throw new Error("hana.cards.open 不可用（宿主未提供卡片放置面）");
  await store.set(SELECTION_SHARED_KEY, selectionSharedValue(sid));
  await open(SESSION_CARD_ID);
}
