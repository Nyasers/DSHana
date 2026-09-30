// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/package-set-digest.mts — 包集"这一批字节"的指纹。
//
// 用途：判断"清单描述的那批 tarball"与"本机缓存里这批"是不是同一次构建。`release:pack` 的
// tarball 字节**不可跨机复现**（win32 的 CRLF 对 linux 的 LF、gzip mtime 各有差异），所以逐字节
// 对拍只在两侧同源时才有意义：先比指纹，指纹不同就只校结构。
//
// 两个消费者共用同一份实现（scripts/vendor/build.mts 构建期写进缓存档案、release/package-set.mts
// 读清单现算），口径逐字相同才判得准。
import { createHash } from "node:crypto";

/** 一条 tarball 的身份：文件名 + `sha512-<base64>`（与 npm integrity 同形）。 */
export interface SetMember {
  file: string;
  integrity: string;
}

/**
 * 算一批 tarball 的指纹（排序后逐条 `file\0integrity` 再 sha256，取前 16 位十六进制）。
 *
 * 只吃文件名与摘要：不吃顺序、不吃 mtime、不吃路径，所以同一批字节在任何机器上算出来都一样。
 *
 * @param members - 这一批 tarball 的身份。
 * @returns 指纹。
 */
export function packageSetDigest(members: readonly SetMember[]): string {
  const lines = members.map((m) => `${m.file}\u0000${m.integrity}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * 清单与 T1 缓存档案是不是同一次构建（字节对拍的前提）。
 *
 * 构建期把这一批的指纹写进缓存档案的 `artifact.setDigest`，清单侧现算同一个值：相等即同源，
 * 逐字节对拍才有意义；不同源（含档案里没有指纹的旧条目）只校在不在与结构。
 *
 * @param members - 清单里那批 tarball 的身份。
 * @param recipe - 缓存条目的 build-recipe.json 内容；读不到传 null。
 * @returns 是否同源。
 */
export function isSameOriginAsSet(members: readonly SetMember[], recipe: unknown): boolean {
  const recorded = (recipe as { artifact?: { setDigest?: unknown } } | null | undefined)?.artifact?.setDigest;
  return typeof recorded === "string" && recorded === packageSetDigest(members);
}
