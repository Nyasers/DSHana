// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/clean-tmp.mts — 打包临时目录清理（package.json 的 postpackage 钩子）
//
// 打包的中间原料（.tmp/pkg/ 铺平目录）、依赖暂存树（.tmp/pkg-root/）与锁文件派生工位
// （.tmp/pkg-lock/）都可再生，真正的产物只有 releases/ 下的 zip + sha256。本脚本把它们清掉。
//
// 为什么单独成脚本而不是内联在 pack 脚本尾部：
//   · 声明式——package.json 里一眼可见"打包后要清临时目录"这条纪律；
//   · 可复用——CI 里 pack 步骤失败后也能单独调它把残留清掉；
//   · scripts/release/pack/index.mts 只管出包，清理属生命周期职责。
//
// 用法：pnpm run package 时由 postpackage 钩子自动触发 / node scripts/release/clean-tmp.mts
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../shared/root.mts";

for (const rel of [join(".tmp", "pkg"), join(".tmp", "pkg-root"), join(".tmp", "pkg-lock")]) {
  const abs = join(ROOT, rel);
  if (fs.pathExistsSync(abs)) {
    fs.removeSync(abs);
    console.log(`[clean-tmp] 已清理 ${rel.replace(/\\/g, "/")}`);
  }
}
console.log("[clean-tmp] 临时目录干净（.tmp/pkg、.tmp/pkg-root、.tmp/pkg-lock）");
