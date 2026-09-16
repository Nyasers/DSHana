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

/**
 * Node 版本断言：本仓脚本全部以 `node <file>.mts` 直跑（package.json 的 scripts 都这么调），
 * 靠 Node 原生类型剥离（22.18 / 23.6 起默认启用，此前需 --experimental-strip-types）。低于下界时
 * 报错发生在运行期，typecheck 管不到；所以在共享入口断言一次，主要入口 import 本模块就会
 * 拿到可读的失败，而不是 .mts 的语法错。
 *
 * package.json 的 engines.node 是同一份声明的机器可读面；pnpm 对**根项目**的 engines 不做强制
 * （实测即便 --engine-strict 也照常安装），所以真正的拦在这里。
 */
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split(".").map(Number);
const NODE_OK =
  (NODE_MAJOR === 22 && NODE_MINOR >= 18) || (NODE_MAJOR === 23 && NODE_MINOR >= 6) || NODE_MAJOR >= 24;
if (!NODE_OK) {
  throw new Error(
    `本仓脚本需要 Node ^22.18.0 || >=23.6.0（当前 ${process.versions.node}）：` +
      "scripts 以 .mts 直跑，依赖 Node 原生类型剥离。",
  );
}

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
