// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/clean-tmp.mts — 交付链收尾：清**.tmp 草稿**，留**.cache 缓存**。
//
// 口径（B 节）：\`.cache/\` 住带键的、可复用、可校验的中间产物；\`.tmp/\` 住每次重来的草稿。
// 所以本脚本只动 \`.tmp\` 下那几个可再生的草稿目录，**绝不碰 \`.cache\`**——那里的 T1 包集、物化节点、
// 集成 stage/build 都带着自己的键与 recipe，删掉就得重花十几分钟装回来，而且下次还会被命中判定当成
// "没有"（正确但慢）。真正的产物只有 releases/ 下的 zip + sha256。
//
// 清什么：
//   · .tmp/pkg         交付组装台（每个目标用完即删，这里是残留兜底）；
//   · .tmp/dsh-build   树外构建的 scratch 检出（build.mts 自己会清，这里是失败后的兜底）；
//   · .tmp/pnpm-logs   交付链 pnpm 的落盘日志（受限沙箱里管道 stdio 会被拒，故统一走文件）；
//   · .tmp/tsc-*.txt、.tmp/tests 等测试/调试产物。
//
// 为什么单独成脚本而不是内联在 pack 脚本尾部：
//   · 声明式——package.json 里一眼可见"打包后要清草稿"这条纪律；
//   · 可复用——CI 里 pack 步骤失败后也能单独调它把残留清掉；
//   · scripts/release/pack/index.mts 只管出包，清理属生命周期职责。
//
// 用法：pnpm run package 时由 postpackage 钩子自动触发 / node scripts/release/clean-tmp.mts
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../shared/root.mts";

/** 每次重来的草稿目录（相对仓库根）。留缓存：.cache/** 一个都不在这里。 */
const DRAFTS = [
  join(".tmp", "pkg"),
  join(".tmp", "dsh-build"),
  join(".tmp", "pnpm-logs"),
  // 旧形态（B 节之前的落点）：已经不写，但上次运行可能留下，一并清掉。
  join(".tmp", "pkg-root"),
  join(".tmp", "pkg-lock"),
  join(".tmp", "app-boot-probe"),
  join(".tmp", "integrations"),
  join(".tmp", "integrations-src"),
  join(".tmp", "integrations-built"),
];

for (const rel of DRAFTS) {
  const abs = join(ROOT, rel);
  if (fs.pathExistsSync(abs)) {
    fs.removeSync(abs);
    console.log(`[clean-tmp] 已清理 ${rel.replace(/\\/g, "/")}`);
  }
}
console.log("[clean-tmp] .tmp 草稿已清；.cache 下的带键缓存（T1 包集 / 物化节点 / 集成 stage）保留");
