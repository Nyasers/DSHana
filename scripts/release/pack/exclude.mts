// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/exclude.mts — 交付树里不出现的包（其他表层、私货，与剥离面）。
//
// 本 App 的 profile 层列只有两层：`@deepseek-ai/dsh-base` → `@dshana/dsh-app`。但交付树的依赖
// 真源是 host 声明的内核 `@deepseek-ai/dsh`（CLI），它自己的清单里还挂着 acp / headless / sdk
// 等表层 bundle 与 `dsh-skill-office`——照搬就会把用不到的包（含 Office 那 182MB 平台件）
// 一并装进产物。
//
// **名单的事实源是仓库根的 `pnpm-workspace.yaml`。** 那里已经写着本形态不交付的每一个包
// （`overrides` 下的 `"-"`），本地开发 install 与交付树用的是同一份。本文件只补它表达不了的
// 两类，其余一律不再手写 —— 两处各写一份必然会漂，而漂了没人看得出。
//
// 本文件补的两类：
//   ① 派生的表层：vendor checkout 里所有声明 `dsh.bundle` 的包减去保留层。上游新增 bundle 时
//      自动挡住，不必等人往 yaml 里加一条；
//   ④ `ON_DEMAND`：本形态改成按需安装的实验性 bundle（名单在上游 `OPTIONAL_BUNDLES` 里）。
//
// 根 yaml 里能查、但**推不出来**的是那批手写的剥离面（账号 / 反馈 / 遥测 / 会话日志上传 /
// 官方 LLM adapter）：它们不是表层、不在上游可选名单里，只是本形态决定不做这一面。
//
// 用法：`removalOverrides()` 把合并后的名单写成 pnpm 的移除符号 `"-"`。这是依赖图层面的删除，
// 不是“装一个空壳”：包不会被下载、不会被解包，它自己的依赖也不会被拉进来（语音模型、DevTools
// 前端那一大块因此一并消失）。
//
// 与组合层是成对的：包里不留件，`packages/dsh/app/cordis.patch.yml` 就必须把引用它的行按 id
// 关掉，`integrations/api-remotes` 要把模块级 import 删干净，base 那份 patch 的对应行由
// `prune-mirror.mts` 剃掉。包不在树里而行还在，就是 boot 期 ERR_MODULE_NOT_FOUND。
import fs from "fs-extra";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { ROOT } from "../../shared/paths.mts";
import { cordisPkgDirs, cordisPkgFullName } from "../../shared/version.mts";

/** 保留的表层：只有共享底座（上游那 12 个可选 bundle 已改成按需，见 on-demand.mts）。 */
export function keptBundles(): string[] {
  return ["@deepseek-ai/dsh-base"];
}

/**
 * 仓库根 `pnpm-workspace.yaml` 的 `overrides` 里写成 `"-"` 的包名。
 *
 * 这是本形态「不交付」的唯一手写处：本地开发 install 与交付树共用同一份，改一处两边同时生效。
 * @param rootDir - 仓库根（测试可换）
 * @returns 包名数组（保持文件里的顺序）
 */
export function declaredRemovals(rootDir = ROOT): string[] {
  const file = join(rootDir, "pnpm-workspace.yaml");
  const doc = parseYaml(fs.readFileSync(file, "utf8"));
  const overrides = doc?.overrides;
  if (overrides === null || typeof overrides !== "object") return [];
  const out: string[] = [];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === "-") out.push(name);
  }
  return out;
}

/** vendor checkout 里声明 dsh.bundle 的包（表层）。 */
function upstreamBundles() {
  const packagesDir = join(ROOT, "vendor", "deepseek-harness", "packages");
  const out: { name: string; version: string }[] = [];
  for (const group of fs.readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!fs.statSync(groupDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(groupDir)) {
      const manifestPath = join(groupDir, entry, "package.json");
      if (!fs.pathExistsSync(manifestPath)) continue;
      let manifest: { name?: string; version?: string; dsh?: { bundle?: unknown } };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        continue;
      }
      if (typeof manifest.name !== "string" || manifest.dsh?.bundle === undefined) continue;
      out.push({ name: manifest.name, version: String(manifest.version ?? "0.0.0") });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * 交付树里不出现的包名：根 yaml 声明的全部 `"-"` ∪ 派生的表层（减保留层）。
 *
 * 按需 bundle 也已在根 yaml 的 `excluded-on-demand` 段里，`declaredRemovals()` 一并读到，
 * 不必在这里再并一次。
 * @param rootDir - 仓库根（测试可换）
 * @returns 包名数组（已去重排序）。
 */
export function excludedPackages(rootDir = ROOT): string[] {
  const keep = new Set(keptBundles());
  const derived = upstreamBundles()
    .map((b) => b.name)
    .filter((n) => !keep.has(n));
  return [...new Set([...declaredRemovals(rootDir), ...derived])].sort();
}

/**
 * 工位 overrides：包名 → `"-"`（pnpm 的依赖移除符号）。
 *
 * 为什么是 `-` 而不是 `file:` 指向空包：两者都让 pnpm 不去下载真件，但 `-` 让这个包在依赖图里
 * **不存在**，而空包是一个能被解析的东西：谁按名字 import 它就拿到一个什么都不做的模块，安装
 * 成功、行为静默缺失。本仓要的是“不交付”，不是“交付一个假的”。
 * @param rootDir - 仓库根（测试可换）
 * @returns overrides 表，直接进工位的 pnpm-workspace.yaml。
 */
export function removalOverrides(rootDir = ROOT): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const name of excludedPackages(rootDir)) overrides[name] = "-";
  return overrides;
}

/** 交付树里必须出现的包（fail-closed 断言的正面清单）。
 * 子插件名单派生自包现场（packages/dsh 下带 cordis.config.mjs 的包）：加一个自动纳入，
 * 下线一个不会留一条永远失败的断言。 */
export function requiredPackages(): string[] {
  const plugins = cordisPkgDirs().map((rel) => cordisPkgFullName(rel));
  return ["@deepseek-ai/dsh-base", "@dshana/dsh-app", ...plugins];
}