// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/ship-manifest.mts — 交付面两份 package.json 的生成（包根清单 + 工位清单）。
//
// 交付面两份 package.json 都在 pack 时算出来，没有手写清单文件。
//   · 包根清单（shipManifest）：拷进 zip 根那份，只带 name / version / type。内核 @deepseek-ai/dsh
//     的声明住 host（见 scripts/shared/version.mts#dshPin），交付树里没有第二份；type: module
//     不能少——包根 index.js 是 ESM，Node 按「最近一份 package.json 的 type」判定模块类型。
//   · 工位清单（stagingManifest）：驱动工位那次干净安装，运行时依赖从 host 的内核声明派生
//     （shipDependencies，剔除 workspace 在仓项）。它只活在工位里，装完随工位一起清掉，不进包。
import { shipDependencies } from "../../shared/version.mts";

/** 交付包根的名字（装机侧读 manifest.json 与本份的 type，名字只作记录）。 */
const PKG_NAME = "dshana";

/** 包根 package.json 的内容：实体字段 + 主版本。 */
export function shipManifest(version: string): Record<string, unknown> {
  return { name: PKG_NAME, version, type: "module" };
}

/**
 * 工位清单 = 包根字段 + 运行时依赖。锁文件不在这里给：工位里跑一次
 * `pnpm install --lockfile-only`，以仓库锁文件为种子重解析出交付面的生产闭包。
 */
export function stagingManifest(version: string): Record<string, unknown> {
  return { ...shipManifest(version), dependencies: shipDependencies() };
}
