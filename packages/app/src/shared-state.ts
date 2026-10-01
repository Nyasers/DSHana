// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/app/src/shared-state.ts — UI 跨面共享通道在 App 侧的收尾（每次 apply 清空整批键）。
//
// 词表（键前缀、值构造、读侧挑选）在 @dshana/shared/shared-state.ts，页面侧与 App 侧共用；
// 这里只放副作用那一半，由 packages/app/src/app.ts 的 apply 调用。
//
// 收尾只有一件事：每次 apply 把这批键清空。进程被杀、页面被替换时，页面来不及删自己的键，
// 而上次生命周期留下的键没有消费方：按前缀一次清空，不看键里的值。
//
// 实现只做一次 getAll + 逐个 delete，任何失败只记数不抛——收尾是维护动作，不影响 App 加载。
import { listSharedKeys, type SharedStateStore } from "@dshana/shared/shared-state.ts";

/** 收尾结果（诊断面用）。 */
export interface SharedStateRenewResult {
  scanned: number;
  removed: number;
  failed: number;
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
