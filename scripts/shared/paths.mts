// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/paths.mts — 仓内构建产物的路径常量（单一事实源）。
//
// 三个区按「谁写它、谁清它」划线：
//   · dist/（仓库根）：交付树（App 安装目录形态）。构建每轮先清再写，pack 从它出 zip。
//   · releases/（仓库根）：出包产物（zip + sha256），只增不改。
//   · .cache/：构建与打包两条流水线的中间态，一个区收口：
//       build   → .cache/{ui,cordis,bundle,integrations,integrations-src} → dist/
//       package → .cache/{pkg,pkg-root}                           → releases/
//     里面的东西全部可由下一次构建/打包再生：构建重写自己那几个键，出包后由 postpackage 钩子
//     （scripts/release/clean-cache.mts）整片清掉——仓库里长期只剩源码、dist/ 与 releases/。
//   · .tmp/：其他临时物（不属两条流水线：集成的 stage 落盘、smoke 的数据目录等）。
// dist 内部：manifest.json 在根（宿主读它 + entry），代码在 bin/；ui 是壳的文档侧，
// 由 @dshana/ui 构建产出 .cache/ui，再由 App 域的构建整树拷进 dist/ui。cordis 是子插件包（不进安装态
// 的安装面，pack 按 bundle 认领规则落进包内 node_modules/@dshana）；integrations 是集成层编译出的
// 补丁包（每个集成一个子目录，pack 按 integration.json 的 package 字段覆盖进交付树）；
// integrations-src 是它们编译前的摊源树（上游 src 全量 + 我们的 overlay，每轮重摊）。
import path from "node:path";

import { ROOT } from "./root.mts";

export { ROOT };

const CACHE = ".cache";

/** 构建与打包的中间区（两条流水线的中途站；出包后由 postpackage 钩子整片清掉）。 */
export const CACHE_DIR = path.join(ROOT, CACHE);

/** 某仓库根下的交付目录（脚本与测试按自己的仓库根问这一份，不各自拼字面量）。 */
export function distDirOf(repoRoot: string): string {
  return path.join(repoRoot, "dist");
}

/** App 交付目录：dist 根 = App 安装目录形态（契约件在根，代码在 bin/），pack 逐份拷进包根。 */
export const DIST_DIR = distDirOf(ROOT);

/** 壳的文档侧产物目录（packages/ui 构建产出；App 域构建把它拷进 dist/ui）。 */
export function uiDirOf(repoRoot: string): string {
  return path.join(repoRoot, CACHE, "ui");
}

export const UI_DIR = uiDirOf(ROOT);

/** cordis 子插件包（provider / theme / clipboard）：pack 落进包内 node_modules/@dshana。 */
export const CORDIS_DIR = path.join(ROOT, CACHE, "cordis");

/** 组合层包（packages/dsh/app）的构建产物：pack 落进包内 node_modules/@dshana。 */
export const BUNDLE_DIR = path.join(ROOT, CACHE, "bundle", "dsh-app");

/** 集成层编译出的补丁包目录（每个集成一个子目录，见 integrations/README.md）。 */
export function integrationsDirOf(repoRoot: string): string {
  return path.join(repoRoot, CACHE, "integrations");
}

export const INTEGRATIONS_DIR = integrationsDirOf(ROOT);

/** 集成编译前的摊源树（上游 src 全量 + 我们的 overlay；每轮重摊，见 integrations/build.mts）。 */
export function integrationsSrcDirOf(repoRoot: string): string {
  return path.join(repoRoot, CACHE, "integrations-src");
}

/** 交付组装台（pack：只放要进包的东西，出包即删）。 */
export const PKG_DIR = path.join(ROOT, CACHE, "pkg");

/** 依赖物化工位（pack：一个像独立项目的目录，在里面跑一次干净 pnpm install；用完即清）。 */
export const STAGING_ROOT = path.join(ROOT, CACHE, "pkg-root");
