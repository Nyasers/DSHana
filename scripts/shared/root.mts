// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/root.mts — 仓库根（脚本域共用一份）。
//
// 为什么不数 ".." 的层数：脚本按域分在 scripts/<域>/ 下，各自到根的深度不再一致，
// 数层数会随下一次搬家再错一遍。这里向上找最近的 package.json。
// 脚本只会待在 scripts/ 下（其子目录不含 package.json），所以第一个命中的就是仓库根。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 从给定文件向上找最近的含 package.json 的目录。 */
export function findRepoRoot(from: string): string {
  let dir = path.dirname(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`找不到仓库根：${from} 向上没有 package.json`);
    dir = up;
  }
}

export const ROOT = findRepoRoot(fileURLToPath(import.meta.url));
