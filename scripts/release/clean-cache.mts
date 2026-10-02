// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/clean-cache.mts — 中间区清理（package.json 的 postpackage 钩子）
//
// .cache/ 是两条流水线的中途站：构建写它（.cache/{ui,cordis,integrations,integrations-src}），
// 打包也用它（.cache/{pkg,pkg-root}）。里面的东西全部可由下一次构建/打包再生，真正的产物只有
// dist/ 与 releases/ 下的 zip + sha256。出包之后整片清掉，让仓库里长期只剩源码与那两个落点。
//
// 为什么单独成脚本而不是内联在 pack 脚本尾部：
//   · 声明式——package.json 里一眼可见"打包后要清中间区"这条纪律；
//   · 可复用——CI 里 pack 步骤失败后也能单独调它把残留清掉；
//   · scripts/release/pack/index.mts 只管出包，清理属生命周期职责。
//
// 用法：pnpm run package 时由 postpackage 钩子自动触发 / node scripts/release/clean-cache.mts
import fs from "fs-extra";

import { CACHE_DIR } from "../shared/paths.mts";

if (fs.pathExistsSync(CACHE_DIR)) {
  fs.removeSync(CACHE_DIR);
  console.log("[clean-cache] 已清理 .cache/（下次构建/打包会重建）");
} else {
  console.log("[clean-cache] .cache/ 不存在，无需清理");
}
