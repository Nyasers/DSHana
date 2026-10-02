// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/clean-tmp.mts — 打包台清理（package.json 的 postpackage 钩子）
//
// 打包是一次运行内的流程：依赖物化工位（.cache/pkg-root/）与交付组装台（.cache/pkg/）里的东西都
// 可再生，真正的产物只有 releases/ 下的 zip + sha256。本脚本把它们清掉，别让它们跨次堆在 .cache 里。
//
// 为什么单独成脚本而不是内联在 pack 脚本尾部：
//   · 声明式——package.json 里一眼可见"打包后要清台子"这条纪律；
//   · 可复用——CI 里 pack 步骤失败后也能单独调它把残留清掉；
//   · scripts/release/pack/index.mts 只管出包，清理属生命周期职责。
//
// 用法：pnpm run package 时由 postpackage 钩子自动触发 / node scripts/release/clean-tmp.mts
import fs from "fs-extra";

import { PKG_DIR, STAGING_ROOT } from "../shared/paths.mts";

for (const [rel, abs] of [["pkg", PKG_DIR], ["pkg-root", STAGING_ROOT]]) {
  if (fs.pathExistsSync(abs)) {
    fs.removeSync(abs);
    console.log(`[clean-tmp] 已清理 .cache/${rel}`);
  }
}
console.log("[clean-tmp] 打包台干净（.cache/pkg、.cache/pkg-root）");
