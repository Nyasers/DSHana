// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/app-bundle.mts — 我们自己的 bundle @dshana/app 的两道闸。
//
// 为什么需要本模块（上游那道闸够不着我们）：
//   vendor 的 verify-cordis-config 用 bundleManifestPaths() = glob `packages/*/*/package.json`
//   找 bundle，只认上游那棵树；我们的 bundle 住 src-cordis/app，它扫不到，于是「patch 里的裸行名
//   必须由该 bundle 自己声明依赖」这条规则在我们身上**没人执行**。它扫 cordis YAML 的 glob 是
//   `**/*cordis*.yml`（排除 node_modules/ vendor/），所以我们的 patch **会被读到、但不会被校验**——
//   最坏的情况：行名写错/漏声明，构建与出包全绿，真机 boot 时那一行静默不落地。
//
// 所以这里把规则按它自己的口径复刻一遍，并加一条它做不到的：反向查落点。
//
// 两类行，两种判法：
//   1. **带 name 的行**（我们 insert 的插件）：包名必须在**本 bundle 的 dependencies** 里
//      ——这正是上游 bundlePluginDependencyErrors 的判据（它只对 name 行、只对本 bundle 的 patch 文件）。
//   2. **只带 id 的行**（我们对官方行的覆盖 / disable）：行名指向的是**下层 bundle 已声明的行**，
//      所以判据不是「我们有没有声明它」，而是「它真的落在某个存在的包上」——从上游两层
//      （dsh-base / dsh-web-app 的 cordis.patch.yml）反查 id → 包名，再断言该包在物化树里在位。
//      查不到 id 说明我们在 disable 一个**不存在的行**（上游改了行名，或者我们打错字），
//      那种 patch 永远静默无操作，正是这条闸要拦的。
//
// 依赖解析口径（与 DSH runtime 同源）：@dshana/app 的 dependencies 既是 CPU 认领表
// （collectInstallationScopePackages 走它把 @dshana/* 带进解析代），也是这里的声明表。两处一份
// 声明，就不会出现「进了解析代但没声明」或反过来。
import fs from "fs-extra";
import { join } from "node:path";

/** patch 里一行引用：带 name 的（插入插件）与只带 id 的（覆盖/disable 下层行）。 */
export interface PatchRefs {
  /** 带 name 的行引用的包名（顺序即文件顺序，重复已去）。 */
  named: string[];
  /** 只带 id 的行名（顺序即文件顺序，重复已去）。 */
  ids: string[];
}

/** 去掉 YAML 标量两侧的引号（我们两处都写单引号，但不假定）。 */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

/** 一行内容的缩进（空格数；tab 按 1 计——我们两处都用空格，只作对齐比较）。 */
function indentOf(raw: string): number {
  const m = /^(\s*)/u.exec(raw);
  return m === null ? 0 : m[1].replace(/\t/gu, " ").length;
}

/**
 * 从一份 cordis patch 源码里抽出两类引用（**行级 + 缩进**解析，不引 YAML 依赖）。
 *
 * 为什么行级够用：Loader patch 的形状是固定的两条——`- id: <名>`（可再带 config/disabled）
 * 与 `- insert:`（其下嵌套若干 `- id: <名>`）。于是「每见到 `- id:` / `- insert:` 就把上一个
 * 条目结账，其后的 `name:` 归最近这个条目」——对嵌套版与平铺版都成立。
 * 本仓既有的 yaml 读取（src/lib/config.ts）同样是行级零依赖，口径一致。
 *
 * **缩进必须判**（实测踩到）：插件的 config 里可以有恰好叫 `name` 的键
 * （`config: { name: something }`）。只看"最近一行 name:"会把它当成被引用的包名，于是闸拿一个
 * 配置值去查依赖表——报出与真实成因无关的"漏声明"。所以只有落在**条目直属子级**那一层的
 * `name:` 才算引用；更深的都在 config 里，与依赖声明无关。
 *
 * @param patchText - patch 文件内容。
 * @returns 带 name 的包名与只带 id 的行名。
 */
export function readPatchRefs(patchText: string): PatchRefs {
  const named: string[] = [];
  const ids: string[] = [];
  let current: { id: string | null; name: string | null; childIndent: number } | null = null;
  const flush = (): void => {
    if (current === null) return;
    if (current.name !== null) named.push(current.name);
    else if (current.id !== null) ids.push(current.id);
    current = null;
  };
  for (const raw of String(patchText).split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const indent = indentOf(raw);
    const entry = /^-\s+(id|insert):\s*(.*)$/u.exec(line);
    if (entry !== null) {
      flush();
      current = {
        id: entry[1] === "id" ? unquote(entry[2]) : null,
        name: null,
        // 条目的直属子级比它的 `-` 深 2（`- id: x` → `  name: y`）。
        childIndent: indent + 2,
      };
      continue;
    }
    const name = /^name:\s*(.+)$/u.exec(line);
    if (name !== null && current !== null && indent === current.childIndent && current.name === null) {
      current.name = unquote(name[1]);
    }
  }
  flush();
  // 去重保序：同一个包被 insert 两次是错的，但那由别处判（这里只做集合语义）。
  return { named: [...new Set(named)], ids: [...new Set(ids)] };
}

/**
 * 判据（纯函数）：本 bundle 的 patch 引用与本 bundle 的声明 / 上游行表是否自洽。
 *
 * @param refs - readPatchRefs 的结果。
 * @param dependencies - 本 bundle manifest 的 dependencies。
 * @param upstreamRowPackages - 上游各层 patch 的 行名 → 包名（id 落点反查表）。
 * @returns 差异描述（空 = 自洽）。
 */
export function appBundlePatchErrors(
  refs: PatchRefs,
  dependencies: Record<string, string>,
  upstreamRowPackages: Map<string, string>,
): string[] {
  const problems: string[] = [];
  // 1) 带 name 的行：包名必须由本 bundle 声明（上游 bundlePluginDependencyErrors 的本地复刻）。
  for (const pkg of refs.named) {
    if (!(pkg in dependencies)) {
      problems.push(`insert 的行引用了 ${pkg}，但 @dshana/app 的 dependencies 里没有它——该行不从此 bundle 解析（上游 verify-cordis-config 的规则）`);
    }
  }
  // 2) 只带 id 的行：必须能反查到一个真实存在的下层行（否则是一条永远无操作的 patch）。
  for (const id of refs.ids) {
    if (!upstreamRowPackages.has(id)) {
      problems.push(`覆盖/disable 的行名 ${id} 在下层（dsh-base / dsh-web-app）的 patch 里找不到——这条 patch 永远无操作（行名改了还是打错了？）`);
    }
  }
  return problems;
}

/** 一个 bundle patch 里 行名 → 包名 的表（只收带 name 的行）。 */
export function rowPackagesOf(patchText: string): Map<string, string> {
  const out = new Map<string, string>();
  let currentId: string | null = null;
  for (const raw of String(patchText).split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const entry = /^-\s+id:\s*(.+)$/u.exec(line);
    if (entry !== null) { currentId = unquote(entry[1]); continue; }
    const name = /^name:\s*(.+)$/u.exec(line);
    if (name !== null && currentId !== null) out.set(currentId, unquote(name[1]));
  }
  return out;
}

/** 上游两层 bundle 的 patch 文件（相对仓库根）；顺序即层序。 */
export const UPSTREAM_LAYER_PATCHES = [
  join("packages", "bundle", "base", "cordis.patch.yml"),
  join("packages", "bundle", "web-app", "cordis.patch.yml"),
];

/**
 * 读上游两层的 行名 → 包名 表（id 落点反查的真源）。
 *
 * 为什么不写死映射：写死就得跟着上游改行名维护，而且失效时表现为「闸照过」。读上游源码则
 * 上游一改、这里立刻跟着变，查不到的 id 会当场报——那正是我们想知道的。
 *
 * @param vendorDir - vendor/deepseek-harness 目录。
 * @returns 行名 → 包名。
 */
export function readUpstreamRowPackages(vendorDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of UPSTREAM_LAYER_PATCHES) {
    const absolute = join(vendorDir, rel);
    if (!fs.existsSync(absolute)) {
      throw new Error(`上游层 patch 缺失：${absolute}（vendor 镜像不完整；行落点无法反查）`);
    }
    for (const [id, pkg] of rowPackagesOf(fs.readFileSync(absolute, "utf8"))) out.set(id, pkg);
  }
  if (out.size === 0) throw new Error(`上游两层的 patch 里一行 name 都没有：${vendorDir}（结构变了？）`);
  return out;
}

/**
 * 出包期驱动：断言交付树里 @dshana/app 的两件在位、patch 与声明自洽、且每个落点行都真的有包。
 *
 * fail-closed 三件：
 *   · 两件随包文件在位（缺了 profile 少一层、或层里没有 patch）；
 *   · patch 自洽（带 name 的行有声明、只带 id 的行有落点）；
 *   · 落点行的包与 dependencies 里 @dshana/* 的包**都在物化树里**（行落不到包上 = 那行静默无操作）。
 *
 * @param nodeModulesDir - 组装台里的 node_modules（交付树）。
 * @param vendorDir - vendor/deepseek-harness（上游行表）。
 * @returns 认领的子插件、覆盖的行数与覆盖到的包（日志用）。
 */
export function assertAppBundle(nodeModulesDir: string, vendorDir: string): {
  claimed: string[];
  overridden: string[];
  named: string[];
} {
  const appDir = join(nodeModulesDir, "@dshana", "app");
  const manifestPath = join(appDir, "package.json");
  const patchPath = join(appDir, "cordis.patch.yml");
  for (const p of [manifestPath, patchPath]) {
    if (!fs.pathExistsSync(p)) {
      throw new Error(`@dshana/app 随包文件缺失：${p}（拒绝出包；先跑 pnpm run build 再打包）`);
    }
  }
  const manifest = fs.readJsonSync(manifestPath) as {
    name?: unknown;
    dsh?: { bundle?: { patch?: unknown } };
    dependencies?: Record<string, string>;
  };
  if (manifest.name !== "@dshana/app") {
    throw new Error(`@dshana/app 的包名不对：${String(manifest.name)}（这层必须是我们自己的 bundle）`);
  }
  // 它得真的是个 bundle 层：没有 dsh.bundle.patch，dshana 预设的 bundles 末层就会把它判成
  // 「不声明 dsh.bundle」而静默 skip——我们的行变更整层丢掉。
  if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") {
    throw new Error(`@dshana/app 未声明 dsh.bundle.patch = "./cordis.patch.yml"（实际 ${JSON.stringify(manifest.dsh?.bundle?.patch)}）：它能进 bundles 但贡献不了层`);
  }
  const dependencies = manifest.dependencies ?? {};
  const refs = readPatchRefs(fs.readFileSync(patchPath, "utf8"));
  const upstreamRows = readUpstreamRowPackages(vendorDir);
  const problems = appBundlePatchErrors(refs, dependencies, upstreamRows);
  if (problems.length) {
    throw new Error(`@dshana/app 的 patch 与声明不一致（拒绝出包）：\n` + problems.map((p) => "  - " + p).join("\n"));
  }
  // 覆盖/disable 的行必须真的落在物化树里那个包上（反查得到的包名 + 树里在位）。
  const overridden: string[] = [];
  for (const id of refs.ids) {
    const pkg = upstreamRows.get(id);
    if (pkg === undefined) continue; // 上面已经报过
    if (!fs.pathExistsSync(join(nodeModulesDir, pkg, "package.json"))) {
      throw new Error(`我们覆盖的行 ${id} 指向 ${pkg}，但物化树里没有它：${join(nodeModulesDir, pkg)}（包集与该层不同步？）`);
    }
    overridden.push(id);
  }
  // 声明里 @dshana/* 的包是"由本 bundle 认领"的那批：它们必须真在树里（不然解析代里挂空）。
  const claimed = Object.keys(dependencies).filter((n) => n.startsWith("@dshana/"));
  const missing = claimed.filter((n) => !fs.pathExistsSync(join(nodeModulesDir, n, "package.json")));
  if (missing.length) {
    throw new Error(`@dshana/app 声明但物化树里没有的包（拒绝出包）：\n  - ` + missing.join("\n  - "));
  }
  if (claimed.length === 0) throw new Error("@dshana/app 一个 @dshana/* 都没声明：随包子插件进不了解析代（拒绝出包）");
  return { claimed, overridden, named: refs.named };
}
