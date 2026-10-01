// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/paths.mts — 仓内构建产物的路径常量（单一事实源）。
//
// 两个临时区的分工，按「这份东西是不是每轮重来」划线：
//   · .cache/：带键的、可再生的中间产物。按产物种类分键，跨次复用，构建不清它。
//   · .tmp/：每次重来的草稿。依赖物化工位、打包组装台、集成摊源树都属这类，用完即清。
// .cache 下的键按**产物种类**分：dist 对齐安装态（App 安装目录形态，roster patch 与
// manifest.json 并排）；host 是受管 runtime 入口 bundle（自己一个键，由 App 域的构建拷进
// dist/runtime）；ui 是壳的文档侧（页面脚本 bundle + 静态面，自己一个键，由 App 域的构建
// 拷进 dist/ui）；cordis 子插件包不是安装态里的东西——pack 按 bundle 认领规则把它们落进
// 包内 node_modules/@dshana，另成一个键。
import path from "node:path";

import { ROOT } from "./root.mts";

export { ROOT };

const CACHE = ".cache";

/** 某仓库根下的交付目录（脚本与测试按自己的仓库根问这一份，不各自拼字面量）。 */
export function distDirOf(repoRoot: string): string {
  return path.join(repoRoot, CACHE, "dist");
}

/** App 交付目录：dist 根 = App 安装目录形态（含 cordis.patch.yml），pack 逐份拷进包根。 */
export const DIST_DIR = distDirOf(ROOT);

/** 受管 runtime 入口 bundle 目录（packages/host 构建产出；App 域构建把它拷进 dist/runtime）。 */
export function hostDirOf(repoRoot: string): string {
  return path.join(repoRoot, CACHE, "host");
}

export const HOST_DIR = hostDirOf(ROOT);

/** 壳的文档侧产物目录（packages/ui 构建产出；App 域构建把它拷进 dist/ui）。 */
export function uiDirOf(repoRoot: string): string {
  return path.join(repoRoot, CACHE, "ui");
}

export const UI_DIR = uiDirOf(ROOT);

/** cordis 子插件包（provider / theme / clipboard）：pack 落进包内 node_modules/@dshana。 */
export const CORDIS_DIR = path.join(ROOT, CACHE, "cordis");
