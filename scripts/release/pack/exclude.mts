// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/exclude.mts — 交付树里不出现的包（其他表层与它们的私货）。
//
// 本 App 的 profile 层列只有两层：`@deepseek-ai/dsh-base` → `@dshana/dsh-app`。但交付树的依赖
// 真源是 host 声明的内核 `@deepseek-ai/dsh`（CLI），它自己的清单里还挂着 acp / headless / sdk
// 等表层 bundle 与 `dsh-skill-office`——照搬就会把用不到的包（含 Office 那 182MB 平台件）
// 一并装进产物。
//
// 保留名单**派生**而不是手写：
//   · `@deepseek-ai/dsh-base`——共享底座；
//   · 上游 `OPTIONAL_BUNDLES` 那四个——它们按设计就是「随安装走、默认关，由插件管理页打开」
//     （vendor 的 app-boot 源码里写着这句话），我们有选择地照搬这个语义。
// 排除名单同样是派生的：vendor checkout 里所有声明 `dsh.bundle` 的包减去上面那份保留名单，
// 再加一份显式「非 bundle 私货」（它们不声明 dsh.bundle，扫不到，但只被别的表层挂载）。
// 上游新增表层时我们自动把它挡在门外，而不是等它悄悄进包。
//
// 两道用法：
//   1) 物化前：把名单 override 成一个极小 stub（`file:` 指向本模块生成的空包）——pnpm 不会去
//      下载真件，也不改锁文件的语义；
//   2) 组装时：把 stub 目录从交付树里删掉——产物里既没有真件也没有占位。
import fs from "fs-extra";
import { join } from "node:path";

import { CACHE_DIR, ROOT } from "../../shared/paths.mts";
import { cordisPkgDirs, cordisPkgFullName } from "../../shared/version.mts";

/** 上游 app-boot 源码里那份「可选表层」名单（我们直接读它，不另维护一份）。 */
function upstreamOptionalBundles(): string[] {
  const file = join(ROOT, "vendor", "deepseek-harness", "packages", "boot", "app-boot", "src", "profile.ts");
  const text = fs.readFileSync(file, "utf8");
  const block = /export const OPTIONAL_BUNDLES[^=]*=\s*\[([\s\S]*?)\]/u.exec(text);
  if (block === null) {
    throw new Error(`${file} 里找不到 OPTIONAL_BUNDLES 的字面量（上游改了结构？）：保留名单不能拍`);
  }
  const names = [...block[1].matchAll(/'([^']+)'/gu)].map((m) => m[1]);
  // 解析为空 = 上游把字面量换成了别的写法（双引号、as const、嵌套…）：那时 keptBundles() 只剩
  // dsh-base，那四个可选 bundle 会被静默排除（本 PR 刚因为砍多了一次）。宁可当场报。
  if (names.length === 0) {
    throw new Error(`${file} 里的 OPTIONAL_BUNDLES 解析为空（上游改了写法？）：保留名单不能拍`);
  }
  return names;
}

/** 保留的表层：共享底座 + 上游那份可选名单（它们随安装走、默认关）。 */
export function keptBundles(): string[] {
  return ["@deepseek-ai/dsh-base", ...upstreamOptionalBundles()];
}

/**
 * 非 bundle 的私货：它们不声明 `dsh.bundle`，因此派生扫不到，但只被别的表层挂载。
 *   dsh-skill-office — Office 写作技能提供方（sdk 表层挂载；本形态的 Office 转换走宿主）。
 */
const STRAYS = ["@deepseek-ai/dsh-skill-office"];

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

/** 版本查表（stub 用真件的版本号，任何范围检查都成立）。 */
function versionOf(name: string): string {
  const found = upstreamBundles().find((b) => b.name === name);
  if (found !== undefined) return found.version;
  return "0.0.0";
}

/**
 * 交付树里不出现的包名（派生：上游表层 − 保留层；再加私货名单）。
 * @returns 包名数组（已去重排序）。
 */
export function excludedPackages(): string[] {
  const keep = new Set(keptBundles());
  const names = upstreamBundles()
    .map((b) => b.name)
    .filter((n) => !keep.has(n));
  return [...new Set([...names, ...STRAYS])].sort();
}

/** stub 目录（每个包一个子目录，包名里的 / 换成 __）。 */
function stubDirOf(name: string): string {
  return join(CACHE_DIR, "pkg-stubs", name.replace("/", "__"));
}

/**
 * 生成 stub 包并给出 pnpm overrides 表（`包名 → file:<绝对路径>`）。
 * @returns { overrides, stubs }：overrides 直接进工位的 pnpm-workspace.yaml。
 */
export function prepareStubs(): { overrides: Record<string, string>; stubs: string[] } {
  const overrides: Record<string, string> = {};
  const stubs: string[] = [];
  for (const name of excludedPackages()) {
    const dir = stubDirOf(name);
    fs.removeSync(dir);
    fs.ensureDirSync(dir);
    fs.writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: versionOf(name), private: true }, null, 2) + "\n",
      "utf8",
    );
    overrides[name] = `file:${dir.replace(/\\/gu, "/")}`;
    stubs.push(name);
  }
  return { overrides, stubs };
}

/**
 * 把被排除的包从交付树里删掉（包括上面那些 stub）。
 *
 * 为什么要删而不是留着 stub：产物里不该有"装着但永远不加载"的槽位。删完之后树里既没有真件也
 * 没有占位，而 pnpm 的账本早已随工位一起清掉（装机器不执行 install），所以缺这几个目录不会让
 * 任何东西解析失败——DSH 的解析代只走"被选中 bundle 的依赖图"。
 * @param nodeModulesDir 组装台里的 node_modules
 * @param names 要删的包名（默认取 excludedPackages()）
 * @returns 实际删掉的包名
 */
export function pruneExcluded(nodeModulesDir: string, names: string[] = excludedPackages()): string[] {
  const pruned: string[] = [];
  for (const name of names) {
    const dir = join(nodeModulesDir, name);
    if (fs.pathExistsSync(dir)) {
      fs.removeSync(dir);
      pruned.push(name);
    }
  }
  // scope 目录空了就一并收掉（@deepseek-ai 还有别的包，通常不会触发）
  const scope = join(nodeModulesDir, "@deepseek-ai");
  if (fs.pathExistsSync(scope) && fs.readdirSync(scope).length === 0) fs.removeSync(scope);
  return pruned;
}

/** 交付树里必须出现的包（fail-closed 断言的正面清单）。
 * 子插件名单派生自包现场（packages/dsh 下带 cordis.config.mjs 的包）：加一个自动纳入，
 * 下线一个不会留一条永远失败的断言。 */
export function requiredPackages(): string[] {
  const plugins = cordisPkgDirs().map((rel) => cordisPkgFullName(rel));
  return ["@deepseek-ai/dsh-base", "@dshana/dsh-app", ...plugins];
}
