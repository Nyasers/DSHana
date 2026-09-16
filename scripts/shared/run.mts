// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/run.mts — "本文件是否被直接运行"的判定（CLI 入口守卫共用一份）。
//
// 为什么不能只看文件名后缀：域名目录下会有同名文件（各域的 index.mts），后缀判定会互相
// 误命中；这里比绝对路径。Windows 盘符与路径大小写不敏感，比较前归一。
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 传入 import.meta.url：`node <本文件>` 直接运行时为 true，被 import 时为 false。 */
export function isDirectRun(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = path.resolve(fileURLToPath(importMetaUrl));
  const target = path.resolve(entry);
  return process.platform === "win32" ? self.toLowerCase() === target.toLowerCase() : self === target;
}
