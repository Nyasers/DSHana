// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/ship-manifest.mts — 工位清单的生成（交付树不带包清单）。
//
// 交付树里没有 package.json：App 入口是 bin/app.mjs，Node 按扩展名就判 ESM，不需要「最近一份
// package.json 的 type」；包清单留在包根只会是构建面字段（scripts / devDependencies /
// packageManager / imports）混进安装包的通道，pack 起手断言它不存在（见 assert.mts）。
//   · 工位清单（stagingManifest）：驱动 .tmp/pkg-root/ 里那次干净安装，运行时依赖从 host 的
//     内核声明派生（shipDependencies，剔除 workspace 在仓项）。它只活在工位里，装完随工位一起
//     清掉，不进包。
import { readPkg, shipDependencies } from "../../shared/version.mts";

/** 工位项目的名字（只为 pnpm 记名；装机侧读的是 manifest.json）。 */
const PKG_NAME = "dshana";

/**
 * 工位清单 = 实体字段 + 运行时依赖。锁文件不在这里给：工位里跑一次
 * `pnpm install --lockfile-only`，以仓库锁文件为种子重解析出交付面的生产闭包。
 *
 * **必须带上 packageManager**：工位里那次 install 以 `--dir` 从仓库根起跳，pnpm 按
 * 「工作目录 → 向上找到的第一份 package.json」取版本；工位清单里有这个字段，corepack 才会拉
 * 仓库钉的那一版；缺了它就落到宿主机全局 pnpm（本机是 12.x），而 12.x 与 11.x 对
 * `overrides` 的语法与 hoisted 行为并不等同——构建机换一台、CI 与本地就可能装出两棵不同的树，
 * 而这棵树是直接进 zip 的。
 */
export function stagingManifest(version: string): Record<string, unknown> {
  return { name: PKG_NAME, version, type: "module", packageManager: repoPackageManager(), dependencies: shipDependencies() };
}

/** 仓库根的 packageManager 声明（全链唯一的 pnpm 版本事实源）。 */
function repoPackageManager(): string {
  const value = readPkg("package.json")?.packageManager;
  if (typeof value !== "string" || !/^pnpm@\d/u.test(value)) {
    throw new Error(`仓库 package.json 没有合法的 packageManager（${value ?? "undefined"}）：工位不能拍一个 pnpm 版本`);
  }
  return value;
}
