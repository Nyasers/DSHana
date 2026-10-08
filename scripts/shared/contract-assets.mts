// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/contract-assets.mts — manifest 声明的契约件在源码侧的落位（单一事实源）。
//
// 为什么单独成文件：交付面里两个静态件的声明基址与源码位置都不是一回事——manifest.icon 是包根
// 相对路径、卡面是 ui/ 相对路径，而源码侧它们各自住在产出它的包里（身份图标归 App 域，卡面归 ui
// 域）。App 域构建摆位与投稿条目取图标都要这套映射，两处各写一份候选表就会出现"一边搬了、另一边
// 还在猜"的静默缺件：条目少一个 icon 字段，目录条目只是无声地没有图。收在这里，改布局只改一处。
//
// 与产物侧的关系：产物里 icon 在包根、卡面在 ui/；源码侧统一按"产出它的包 + 声明值"取。
import { join } from "node:path";

/** App 契约清单（manifest.json）的源码落位，相对仓库根（posix 形式，派生表的 rel 直接用它）。
 *  derive 写回、出包校验、投稿条目、构建拷贝、测试都取这一份——布局再动只改这一行。 */
export const MANIFEST_REL = "packages/app/src/manifest.json";

/** manifest 的绝对路径（按给定仓库根）。 */
export function manifestPath(repoRoot: string): string {
  return join(repoRoot, MANIFEST_REL);
}

/** 身份图标（manifest.icon）的源码落位：App 域。 */
export function contractAssetSource(repoRoot: string, rel: string): string {
  return join(repoRoot, "packages", "app", "src", rel);
}

/** 卡面图（contributes.cards[].face.image）的源码落位：ui 域（随 ui 整树产出）。 */
export function faceAssetSource(repoRoot: string, rel: string): string {
  return join(repoRoot, "packages", "ui", "src", rel);
}
