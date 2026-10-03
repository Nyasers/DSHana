// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/face-addresses.ts — 面的**地址词表**（单点）。
//
// 单独成文件是为了避开一个循环：跨面意图的**描述符**（shared-state.ts）要说"这条意图参与哪些面"，
// 而承载（同页广播）要说“这条帧投给谁”——两边都要这套词，词住在这里两边都只是引用。
//
// 面地址 = face-role.ts 发布给 DSH 侧的角色词（workspace / navigation / stream / standalone）。
// 扇出地址是投递语义，不是面：others = 除发射的那份文档以外；* = 含发射面。

/** 面地址（= face-role.ts 的角色词）：投递的收件人。 */
export const FACE_ADDRESSES = ["workspace", "navigation", "stream", "standalone"] as const;

/** 一个面地址。 */
export type FaceAddress = (typeof FACE_ADDRESSES)[number];

/** 扇出地址：others = 除发射面以外的同作用域诸面；* = 含发射面。 */
export const FACE_FANOUT = ["others", "*"] as const;

/** 一条帧的收件人：面地址或扇出地址。 */
export type FaceTarget = FaceAddress | (typeof FACE_FANOUT)[number];

/** 认面地址（词表外的值当场拒）。 */
export function isFaceAddress(value: unknown): value is FaceAddress {
  return typeof value === "string" && (FACE_ADDRESSES as readonly string[]).includes(value);
}

/** 认收件人（面地址或扇出）。 */
export function isFaceTarget(value: unknown): value is FaceTarget {
  return isFaceAddress(value) || (typeof value === "string" && (FACE_FANOUT as readonly string[]).includes(value));
}

/** 认一组面地址（缺省/空/含词表外的值都当"没声明"→ null）。 */
export function asFaceList(value: unknown): readonly FaceAddress[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: FaceAddress[] = [];
  for (const item of value) {
    if (!isFaceAddress(item)) return null;
    out.push(item);
  }
  return out;
}

/** 认作用域（卡片实例戳；缺戳时用占位，作用域照样隔离）。 */
export const CHANNEL_SCOPE_FALLBACK = "-";

/** 归一作用域戳。 */
export function normalizeScope(card: unknown): string {
  return typeof card === "string" && card.trim() ? card.trim() : CHANNEL_SCOPE_FALLBACK;
}
