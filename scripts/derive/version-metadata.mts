// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/version-metadata.mts — 主 package.json#version 的 build metadata 段（`+dsh-…`）
// 与交付面清单声明的 dsh 版本对齐。
//
// 为什么进派生表：这段值任何时刻都能从 packaging/package.json#dependencies[@deepseek-ai/dsh]
// 推出来，而 `pnpm version` 只是恰好会写它的那个入口。pin 一动、bump 还没到，树里的
// package.json 与 packages/app/src/manifest.json（宿主读的 App 版本）就报旧 dsh，pack 也可能落在这个窗口里。
// 挂进派生表之后 derive --check 成了闸：pin 动了而版号没跟上，CI 当场红。
//
// 与 version 钩子的分工：钩子在 bump 时经 shared/version.mts#fullVersion 拼回完整版（pnpm 算号
// 会剥掉 build 段，那是唯一能表达完整版的时机），本任务负责"平时也对"。写回只动主版本，
// 派生链（manifest / cordis / packaging）由同一次 derive 里排在后面的任务跟上——所以本任务
// 在 TASKS 里排第一。
import { fullVersion, readPkg, writePkg } from "../shared/version.mts";

/** 只读检查：主版本的 metadata 段与交付面 pin 是否一致（空数组 = 一致）。 */
export function inspect() {
  const { version } = readPkg("package.json");
  const want = fullVersion(version);
  return version === want ? [] : [`package.json#version 的 dsh 段没跟上交付面 pin：${version} ≠ ${want}`];
}

/** 修复：把主版本拼成完整版（派生链由后续任务刷）。 */
export function repair() {
  const pkg = readPkg("package.json");
  const want = fullVersion(pkg.version);
  if (pkg.version === want) return;
  pkg.version = want;
  writePkg("package.json", pkg);
}

/** derive 的 version-metadata 任务（形状与 derive 的 StateTask 一致，由 derive 侧标注类型）。 */
export const versionMetadataTask = {
  kind: "state" as const,
  name: "version-metadata",
  about: "packaging/package.json#dependencies[@deepseek-ai/dsh] → package.json#version 的 +dsh- 段",
  inspect,
  repair,
};
