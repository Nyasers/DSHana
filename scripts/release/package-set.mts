// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/package-set.mts — 运行树包集清单（声明 + 校验），形状对齐上游 desktop 的
// `core-package-set`：根集 + 每个包的 name/version/file/bytes/sha512 + 构建身份。
//
// 为什么清单不能是白名单：根集由 **交付的 app-boot** 推导——`@deepseek-ai/dsh-app-boot` 的
// `PROFILE_TEMPLATES.dshana.bundles` ∪ `OPTIONAL_BUNDLES`，加我们的 `@dshana/*`（见 spec §6.4.1/§6.6）。
// 上游改了模板，我们的根集自然跟着改；维护式白名单会在每次 bump 时变成人工对账的负债。
//
// T5 步三起，"交付的 app-boot"字面成立：模板名是我们自己的 `dshana`（delta 加进上游那张表，随产物
// 进包），源也换成 **T1 缓存里的 tarball**（app-boot-probe.mts）——仓库 node_modules 那份是 registry
// 成品包、不含 delta。清单于是描述"交付树里真正会跑的那份 app-boot 给出什么根集"。
//
// 为什么记 sha512 而不声称逐字节可复现：tarball 里带时间戳/压缩实现细节，同一份源码在不同
// 时间或不同 pnpm 下打出来的字节未必相同（缓存键已含 pnpm 版本，见 scripts/vendor/build.mts）。
// 清单承诺的是「这份字节是哪一份」，不是「谁都能重打出这份字节」。
//
// 两个消费面：
//   · derive 的 package-set 任务 = 只读校验（现算根集/重算摘要，与落盘清单比对）；
//   · 构建期闸 = 包集刚打出来就校一遍（对应 desktop 的 verifyDesktopCorePackageSet）。
//
// 边界：本模块只**声明与校验**。树怎么物化是 T3（scripts/release/pack/materialize.mts）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT } from "../shared/root.mts";
import { dshanaPackageManifestRels } from "../shared/version.mts";
import { readTarMember } from "../vendor/tar-extract.mts";
import { currentBuildIdentity } from "../vendor/build.mts";
import { materializeDeliveredAppBoot } from "./app-boot-probe.mts";

/**
 * 清单在 T1 缓存条目里的**文件名**（与 build-recipe.json 同层）。
 *
 * B 节起清单归构建产物：键定了产物是谁，清单描述的就是那批字节。放进缓存条目而不是仓库里的
 * `packaging/`，是因为它与 `dist-npm/` 是同一件事的两面——换键即换清单，陈旧条目不可能被读到；
 * 而住仓库里时，"清单对的是哪次构建"要靠人记。
 */
export const PACKAGE_SET_FILENAME = "dsh-package-set.json";

/** 清单格式版本；字段语义变才 +1。 */
export const PACKAGE_SET_FORMAT = 1;

/** 根集里一个包的来源类别（清单里标注，便于 diff 时看懂为什么它在）。 */
export type PackageCategory = "profile-template" | "optional-bundle" | "dshana";

/**
 * 一条包记录：包集里**每一个** tarball 都有（不只是根集），因为物化时整批都要能验字节。
 * file 是 dist-npm 下的文件名，不是路径。
 */
export interface PackageRecord {
  name: string;
  version: string;
  file: string;
  bytes: number;
  /** `sha512-<base64>`，与 npm 的 integrity 同形。 */
  integrity: string;
}

/** 根集推导用到的上游标识（diff 清单时先看这几行）。 */
export interface RootSetUpstream {
  /** 提供模板与可选 bundle 名单的包。 */
  appBootPackage: string;
  appBootVersion: string;
  /** 该包所在 vendor 检出（= 包集构建源）的 commit。 */
  appBootCommit: string;
  /** 模板名（我们的 `dshana`；写进清单是为了钉住"只 boot 这一个预设"这条产品边界）。 */
  profileTemplate: string;
  /** 用到的模板 bundle 名单（原样照抄上游，便于比对）。 */
  templateBundles: string[];
  /** 用到的可选 bundle 名单（原样照抄上游）。 */
  optionalBundles: string[];
}

/** 构建身份：这份包集是从哪儿、用什么工具链打出来的。 */
export interface PackageSetBuild {
  tag: string;
  commit: string;
  /** T1 缓存的键（tag + 配方版本 + node + pnpm + lock 哈希，见 scripts/vendor/build.mts）。 */
  cacheKey: string;
  recipeVersion: string;
  node: string;
  /** **构建链**实际用的 pnpm（检出/vendor 里那份，上游 pin；进缓存键）。 */
  pnpm: string;
  builtAt: string;
}

/**
 * 一个根集条目：包名 + 它属于哪一类。
 *
 * `version` 只对 `dshana` 类有意义：上游根集包在 `packages` 里有完整记录（版本/字节/摘要），
 * 我们那批是我们自己的构建产物（dist/cordis），不来自 T1 包集，所以在这里记版本。
 */
export interface RootEntry {
  name: string;
  category: PackageCategory;
  version?: string;
}

export interface DshPackageSet {
  formatVersion: number;
  build: PackageSetBuild;
  upstream: RootSetUpstream;
  /** 按 name 排序；name 与 file 均唯一。 */
  packages: PackageRecord[];
  /** 根集（含来源类别），与构建期/derive 的现算结果比对。 */
  roots: RootEntry[];
}

/**
 * 我们自己那批 `@dshana/*` 包的**源码**位置，按包列举。
 *
 * 不在这里 glob 目录：子插件（`plugins/<名>/`）与我们的 bundle（`app/`）形状不同，就地 glob 要么
 * 漏掉 bundle、要么把 patch 文件当成包。名单的真源在 `scripts/shared/version.mts`
 *（`dshanaPackageManifestRels`）——版本同步目标读的是同一份，两处不会再分叉。
 */
const dshanaManifestRels = dshanaPackageManifestRels();

/** 算一个文件的 npm 形 integrity。 */
export function integrityOfFile(absolute: string): { bytes: number; integrity: string } {
  const body = fs.readFileSync(absolute);
  return { bytes: body.byteLength, integrity: `sha512-${crypto.createHash("sha512").update(body).digest("base64")}` };
}

/** T1 缓存条目目录：.cache/dsh-build/<key>。 */
export function cacheEntryDir(key: string): string {
  return path.join(ROOT, ".cache", "dsh-build", key);
}

/** 缓存条目里的清单路径（相对仓库根；日志与报错用它，别在调用处拼）。 */
export function packageSetRel(key: string): string {
  return path.join(".cache", "dsh-build", key, PACKAGE_SET_FILENAME);
}

/**
 * 现算"本机当前该命中的"缓存键——读清单的缺省键。
 *
 * 走 T1 自己的键推导（scripts/vendor/build.mts#currentBuildIdentity），**不读清单里记的键**：
 * 我们要的是"现在应该是谁"，读清单会让换了 tag/工具链之后永远照着老条目找。
 */
function currentCacheKey(): string {
  return currentBuildIdentity().key;
}

/** 我们的预设名（spec §6.6）；模板条目由 src-integrations/app-boot-profile 的 delta 加进上游那张表。 */
export const PROFILE_TEMPLATE_NAME = "dshana";

/**
 * 从**交付的** `@deepseek-ai/dsh-app-boot`（T1 产物）import 根集名单。
 *
 * 走 import 而不是正则读源码：名单是运行时真源，上游重排或改名会在 import 处当场失败，而不是
 * 让我们静默解读错。
 *
 * 读**我们的**模板（`dshana`），不是上游的 `web`：模板条目随产物进包，所以 import 到的就是
 * 我们自己那份表。于是「清单里记的根集」＝「运行时真正装载的预设」，不再从上游模板名推断——
 * 上游改 `web` 不会悄悄改变我们装什么。
 *
 * **源必须是 T1 产物**（见 app-boot-probe.mts）：仓库 node_modules 里那份是 registry 成品包，
 * 不含 delta，读它会找不到 `dshana`。
 *
 * @param appBootEntry - 摊开的交付 app-boot 包目录（deliveredAppBootDir 的产物）。
 * @returns 我们模板的 bundle 名单与可选 bundle 名单。
 */
export async function readUpstreamRootLists(appBootEntry: string): Promise<{
  templateBundles: string[];
  optionalBundles: string[];
}> {
  const moduleUrl = pathToFileURL(path.join(appBootEntry, "lib", "index.js")).href;
  const mod = (await import(moduleUrl)) as {
    PROFILE_TEMPLATES?: Record<string, { bundles?: unknown }>;
    OPTIONAL_BUNDLES?: unknown;
  };
  const template = mod.PROFILE_TEMPLATES?.[PROFILE_TEMPLATE_NAME];
  if (!template || !Array.isArray(template.bundles)) {
    throw new Error(
      `${appBootEntry} 的 PROFILE_TEMPLATES 里没有 ${PROFILE_TEMPLATE_NAME}.bundles：` +
        "模板条目没进产物（src-integrations/app-boot-profile 的 delta 没铺上？）——根集不能拍名单",
    );
  }
  const templateBundles = template.bundles.map((b) => String(b));
  if (!Array.isArray(mod.OPTIONAL_BUNDLES)) {
    throw new Error(`${appBootEntry} 未导出 OPTIONAL_BUNDLES：上游名单结构变了`);
  }
  return { templateBundles, optionalBundles: mod.OPTIONAL_BUNDLES.map((b) => String(b)) };
}

/**
 * 交付树的 app-boot 包目录：从 **T1 缓存的 tarball** 摊出来（见 app-boot-probe.mts）。
 *
 * 为什么不读仓库 node_modules 那份：那是 registry 成品包，**不含我们的 delta**（`dshana` 模板
 * 条目）。清单要描述的是交付树里真正会跑的那份，所以源必须是 T1 产物。
 *
 * @param key - T1 缓存键（= 这份清单要描述的包集）。
 * @returns 摊开的 app-boot 包目录。
 */
export function deliveredAppBootDir(key: string): string {
  return materializeDeliveredAppBoot(key);
}

/**
 * 我们自己的 `@dshana/*` 根集条目（带版本）。
 *
 * 读**源码**（`src-cordis/plugins/<包名>/package.json`，加 `src-cordis/app`）而不读构建产物
 *（`dist/cordis`）：那份身份就是构建组装时拷过去的原件（见 src-cordis/build.ts），而派生文件不该
 * 依赖构建产物——否则干净检出上 `derive` / `derive --check` 会无端要求先跑一次 `build`（CI 上
 * 这就是个死锁：清单对拍要 dist/cordis，而 build 排在它后面）。版本由 derive 的 cordis 任务同批
 * 同步，TASKS 里它在 package-set 之前，写回与校验两条路径读到的都是同一份。
 *
 * 这一族里可以有包**同时**出现在模板 bundles 里（`@dshana/app` 就是）；与上游名单的重叠由
 * {@link deriveRootSet} 合并处理，这里只管"这一族有哪些包"。
 */
function dshanaPackageEntries(): RootEntry[] {
  const out: RootEntry[] = [];
  for (const rel of dshanaManifestRels) {
    const manifest = path.join(ROOT, rel);
    if (!fs.existsSync(manifest)) throw new Error(`${rel} 不存在：源码树不完整`);
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
    if (typeof parsed.name !== "string" || !parsed.name.startsWith("@dshana/")) continue;
    out.push({
      name: parsed.name,
      category: "dshana",
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    });
  }
  if (!out.length) throw new Error("源码树里没有 @dshana/* 包：源码树不完整");
  return out;
}

/**
 * 现算根集（我们的 dshana 模板 ∪ 可选 bundle ∪ 我们那批）。
 *
 * **同一个包从两个来源进来是正常态，不是错误**：模板 bundles 里那三层中的 `@dshana/app` 同时也在
 * 我们的 `@dshana/*` 枚举里——前者答"默认装载哪些层"，后者答"我们这一族有哪些包"，两个问题。
 * 所以跨来源**合并去重**，而不是把新 bundle 从枚举里摘掉（那份枚举是这一族的唯一真源，见
 * scripts/shared/version.mts）：摘掉等于把真源改成"除模板里那些之外的 @dshana 包"，一个随模板内容
 * 而变的定义。
 *
 * **类别归属是契约，而且由我们的枚举赢**（不是去重时的无关细节）：`dshana` 类不在 T1 包集里
 *（见 buildPackageSet 的跳过与 checkPackageSet 的"根集包必须在 packages 里"），而 @dshana/app 与
 * 三个子插件都是我们自己的构建产物、确实不在那 318 个 tarball 里。所以重叠的名字**从上游名单里
 * 摘掉、按 dshana 类追加在后**；若让模板类赢，它会被要求"必须在 packages 里"而当场炸
 *（实测第一次去重就是这么炸的）。
 *
 * 摘掉不丢信息：模板原始名单仍逐字记在 `upstream.templateBundles` 里。
 *
 * @param appBootEntry - 已装的 app-boot 包目录。
 * @returns 按类别标注的根集，模板/可选 bundle 保上游顺序，`@dshana/*` 追加在后。
 */
export async function deriveRootSet(appBootEntry: string): Promise<{
  entries: RootEntry[];
  upstream: Omit<RootSetUpstream, "appBootCommit">;
}> {
  const { templateBundles, optionalBundles } = await readUpstreamRootLists(appBootEntry);
  const upstreamEntries: RootEntry[] = [
    ...templateBundles.map((name) => ({ name, category: "profile-template" as const })),
    ...optionalBundles.map((name) => ({ name, category: "optional-bundle" as const })),
  ];
  // 上游名单**内部**（含模板 ∩ 可选）不得重复：那是名单自相矛盾（同一层既是默认又是可选，或
  // 同一份列了两遍），不该用去重盖过去。跨来源重叠的豁免**只给我们的 @dshana 一族**（见下）。
  const seenUpstream = new Set<string>();
  for (const e of upstreamEntries) {
    if (seenUpstream.has(e.name)) {
      throw new Error(
        `上游根集名单里重复的包名：${e.name}（模板与可选 bundle 名单重叠，或同一份名单列了两遍？）` +
          "——这是上游名单自相矛盾，不是跨来源的正常重叠（后者由下面的 @dshana 合并处理）",
      );
    }
    seenUpstream.add(e.name);
  }
  // 重叠的名字一律按 dshana 类（我们的枚举赢），并从上游名单里摘掉——见上"类别归属是契约"。
  const ours = dshanaPackageEntries();
  const ourNames = new Set(ours.map((e) => e.name));
  const entries: RootEntry[] = [...upstreamEntries.filter((e) => !ourNames.has(e.name)), ...ours];
  const pkg = JSON.parse(fs.readFileSync(path.join(appBootEntry, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  return {
    entries,
    upstream: {
      appBootPackage: typeof pkg.name === "string" ? pkg.name : "@deepseek-ai/dsh-app-boot",
      appBootVersion: typeof pkg.version === "string" ? pkg.version : "（未知）",
      profileTemplate: PROFILE_TEMPLATE_NAME,
      templateBundles,
      optionalBundles,
    },
  };
}

/**
 * 读清单；不存在返回 null（derive 的 --check 用得到）。
 *
 * 位置由**现在的**缓存键决定（`currentBuildIdentity().key`）：清单描述的就是那份产物，所以没有
 * "去别的条目里找找"这条路——键变了就是没派生，调用方该报缺并让人重跑派生。
 *
 * @param key - T1 缓存键；缺省用现算的键（读"本机当前该有的那份"）。
 * @returns 清单对象；该条目里没有清单返回 null。
 */
export function readPackageSet(key: string = currentCacheKey()): DshPackageSet | null {
  const absolute = path.join(cacheEntryDir(key), PACKAGE_SET_FILENAME);
  if (!fs.existsSync(absolute)) return null;
  return JSON.parse(fs.readFileSync(absolute, "utf8")) as DshPackageSet;
}

/** 写清单（稳定格式：2 空格 + 末尾换行）；目标目录不存在时建出来（缓存条目可能只有 dist-npm）。 */
export function writePackageSet(set: DshPackageSet, key: string = set.build.cacheKey): void {
  const absolute = path.join(cacheEntryDir(key), PACKAGE_SET_FILENAME);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(set, null, 2)}\n`, "utf8");
}

/**
 * 校验清单：结构自洽、tarball 存在且逐字节对得上、根集与现算一致、身份字段与 T1 缓存一致。
 *
 * 只读；返回人类可读的差异清单（空数组 = 通过）。调用方决定是报错还是写回。
 *
 * @param set - 落盘清单。
 * @param distDir - 该包集的 dist-npm 目录（tarball 所在）。
 * @param expectedRoots - 现算根集；省略则跳过根集比对（清单自检用）。
 * @param options - `compareBytes: false` 时跳过逐包字节/摘要（结构仍全检）。什么时候该跳过见
 *   scripts/derive/package-set.mts 的 verifyPackageSet：tarball 字节不可跨机复现，只有两侧同源
 *   时逐字节对拍才有意义。
 */
export function checkPackageSet(
  set: DshPackageSet,
  distDir: string,
  expectedRoots?: readonly RootEntry[],
  options?: { compareBytes?: boolean },
): string[] {
  const diffs: string[] = [];
  if (set.formatVersion !== PACKAGE_SET_FORMAT) {
    diffs.push(`formatVersion ${set.formatVersion} ≠ ${PACKAGE_SET_FORMAT}`);
  }
  // 唯一性
  const names = new Set<string>();
  const files = new Set<string>();
  for (const p of set.packages) {
    if (names.has(p.name)) diffs.push(`包名重复：${p.name}`);
    if (files.has(p.file)) diffs.push(`文件名重复：${p.file}`);
    names.add(p.name);
    files.add(p.file);
  }
  // 目录里不多不少
  if (fs.existsSync(distDir)) {
    const actualFiles = fs.readdirSync(distDir).filter((n) => n.endsWith(".tgz")).sort();
    const expectedFiles = set.packages.map((p) => p.file).sort();
    const extra = actualFiles.filter((f) => !expectedFiles.includes(f));
    const missing = expectedFiles.filter((f) => !actualFiles.includes(f));
    for (const f of extra) diffs.push(`dist 里有清单未记录的 tarball：${f}`);
    for (const f of missing) diffs.push(`清单记录了但 dist 里没有的 tarball：${f}`);
  } else {
    diffs.push(`dist 目录不存在：${distDir}`);
  }
  // 逐包字节与摘要（可关：跨机的字节本来就对不上，见函数注释）
  if (options?.compareBytes !== false) {
    for (const p of set.packages) {
      const absolute = path.join(distDir, p.file);
      if (!fs.existsSync(absolute)) continue; // 上面已报 missing
      const actual = integrityOfFile(absolute);
      if (actual.bytes !== p.bytes || actual.integrity !== p.integrity) {
        diffs.push(`${p.file} 字节/摘要不符（清单 ${p.bytes}/${p.integrity.slice(0, 20)}…，实际 ${actual.bytes}/${actual.integrity.slice(0, 20)}…）`);
      }
    }
  }
  // 根集：名字与类别都要对（同一个包换了归类同样是漂移）
  if (expectedRoots) {
    const recorded = new Map(set.roots.map((r) => [r.name, r.category]));
    const expected = new Map(expectedRoots.map((r) => [r.name, r.category]));
    for (const [n, c] of expected) {
      if (!recorded.has(n)) diffs.push(`现算根集有、清单没记：${n}（${c}）`);
      else if (recorded.get(n) !== c) diffs.push(`${n} 的类别：清单 ${recorded.get(n)} ≠ 现算 ${c}`);
    }
    for (const n of recorded.keys()) {
      if (!expected.has(n)) diffs.push(`清单记了、现算根集没有：${n}`);
    }
    // 上游根集包（模板 + 可选 bundle）必须在 packages 里；`dshana` 类是我们自己的构建产物
    //（dist/cordis），只在根集里记名字与版本，不在 T1 包集里。
    const packageNames = new Set(set.packages.map((p) => p.name));
    for (const [n, c] of expected) {
      if (c !== "dshana" && !packageNames.has(n)) diffs.push(`根集包不在 packages 里：${n}`);
    }
  }
  return diffs;
}

/**
 * 校验清单的身份字段与 T1 缓存条目一致（tag/commit/key/recipeVersion/node/pnpm/builtAt）。
 *
 * @param set - 落盘清单。
 * @param recipe - 缓存条目的 build-recipe.json 内容。
 * @returns 差异清单（空 = 一致）。
 */
export function checkPackageSetBuild(
  set: DshPackageSet,
  recipe: {
    tag?: unknown;
    commit?: unknown;
    key?: unknown;
    recipeVersion?: unknown;
    node?: unknown;
    pnpm?: unknown;
    artifact?: { tarballs?: unknown; bytes?: unknown };
  },
): string[] {
  const diffs: string[] = [];
  const expect = (label: string, actual: unknown, want: unknown): void => {
    if (actual !== want) diffs.push(`${label}：清单 ${String(actual)} ≠ 缓存 ${String(want)}`);
  };
  expect("tag", set.build.tag, recipe.tag);
  expect("commit", set.build.commit, recipe.commit);
  expect("cacheKey", set.build.cacheKey, recipe.key);
  expect("recipeVersion", set.build.recipeVersion, recipe.recipeVersion);
  expect("node", set.build.node, recipe.node);
  expect("pnpm", set.build.pnpm, recipe.pnpm);
  if (typeof recipe.artifact?.tarballs === "number" && recipe.artifact.tarballs !== set.packages.length) {
    diffs.push(`包数：清单 ${set.packages.length} ≠ 缓存 recipe ${recipe.artifact.tarballs}`);
  }
  return diffs;
}
/** 构建期记的集成烘焙账（`build-recipe.json#integrations`；旧配方可能没有这个字段）。 */
export interface RecipeIntegrations {
  deltaHash?: unknown;
  stagedFiles?: unknown;
  packages?: Array<{ dir?: unknown; package?: unknown; files?: unknown }>;
}

/** T1 缓存条目的 build-recipe.json 形状（只读我们关心的字段）。 */
export interface BuildRecipe {
  tag?: unknown;
  commit?: unknown;
  key?: unknown;
  recipeVersion?: unknown;
  node?: unknown;
  pnpm?: unknown;
  createdAt?: unknown;
  artifact?: { tarballs?: unknown; bytes?: unknown; setDigest?: unknown };
  /** 这份包集烤进去的集成 delta（assert.mts 的集成烘焙对账要读它）。 */
  integrations?: RecipeIntegrations;
}

/** 读 T1 缓存条目的 recipe。 */
export function readBuildRecipe(key: string): BuildRecipe {
  const absolute = path.join(cacheEntryDir(key), "build-recipe.json");
  if (!fs.existsSync(absolute)) {
    throw new Error(`T1 缓存条目不存在：${path.relative(ROOT, cacheEntryDir(key))}（先跑 node scripts/vendor/build.mts）`);
  }
  return JSON.parse(fs.readFileSync(absolute, "utf8")) as BuildRecipe;
}

/** 从 tarball 自己的 manifest 取 name/version；读不出就当场报（别拿文件名反推）。 */
function packedIdentityOf(tarball: string): { name: string; version: string } {
  let body: Buffer | null;
  try {
    body = readTarMember(tarball, "package/package.json");
  } catch (error) {
    // 归档本身坏了（gzip 头被改、截断、半成品）：报成「这个文件读不出」而不是让 gunzip 的原始
    // 异常冒到顶——后者看不出是哪个 tarball、也看不出是缓存被换过。
    throw new Error(path.basename(tarball) + " 读不出（归档损坏？）：" + String(error));
  }
  if (body === null) throw new Error(`${path.basename(tarball)} 里没有 package/package.json`);
  const manifest = JSON.parse(body.toString("utf8")) as { name?: unknown; version?: unknown };
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`${path.basename(tarball)} 的 manifest 缺 name/version`);
  }
  return { name: manifest.name, version: manifest.version };
}

/**
 * 给一份 T1 包集配清单（整份重算，不做增量）。
 *
 * @param key - T1 缓存键（.cache/dsh-build/<key>）。根集从**该条目**的 app-boot 推导。
 * @returns 可直接落盘的清单对象。
 */
export async function buildPackageSet(key: string): Promise<DshPackageSet> {
  const recipe = readBuildRecipe(key);
  const distDir = path.join(cacheEntryDir(key), "dist-npm");
  if (!fs.existsSync(distDir)) throw new Error(`包集目录不存在：${path.relative(ROOT, distDir)}`);
  const { entries, upstream } = await deriveRootSet(deliveredAppBootDir(key));

  const packages: PackageRecord[] = [];
  for (const file of fs.readdirSync(distDir).filter((n) => n.endsWith(".tgz")).sort()) {
    const absolute = path.join(distDir, file);
    const { name, version } = packedIdentityOf(absolute);
    const { bytes, integrity } = integrityOfFile(absolute);
    packages.push({ name, version, file, bytes, integrity });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));

  // 上游根集（模板 + 可选 bundle）必须都在包集里；少一个说明上游模板引了我们没打出来的包
  //（bump 时最可能的信号）。`dshana` 类不在 T1 包集里——那是我们自己的构建产物（dist/cordis），
  // 由物化阶段打包，所以只记版本，不进 packages。
  const present = new Set(packages.map((p) => p.name));
  for (const e of entries) {
    if (e.category === "dshana") continue;
    if (!present.has(e.name)) throw new Error(`上游根集里的 ${e.name}（${e.category}）不在包集里：上游模板与包集不同步？`);
  }

  const recipeString = (v: unknown, fallback = "（未知）"): string => (typeof v === "string" && v ? v : fallback);
  return {
    formatVersion: PACKAGE_SET_FORMAT,
    build: {
      tag: recipeString(recipe.tag),
      commit: recipeString(recipe.commit),
      cacheKey: recipeString(recipe.key, key),
      recipeVersion: recipeString(recipe.recipeVersion),
      node: recipeString(recipe.node),
      pnpm: recipeString(recipe.pnpm),
      builtAt: recipeString(recipe.createdAt),
    },
    upstream: { ...upstream, appBootCommit: recipeString(recipe.commit) },
    packages,
    roots: entries,
  };
}
/**
 * 构建期闸：现算根集与落盘清单比对，不一致即抛（对应 desktop 的 verifyDesktopCorePackageSet）。
 *
 * 为什么值得单独一道：清单是**声明**，而根集的真源在上游源码里。上游改了 web 模板或可选 bundle
 * 名单后，清单不会自己变——没有这道闸，交付树会静默少掉/多出若干包，直到用户点开插件管理器
 * 才发现。这里让它在出包前就炸，并指出到底哪一边多了什么。
 *
 * 只读、不联网：只需 T1 缓存里的 app-boot 与清单本身，因此 CI 与出包机都能跑。
 * 根集从**清单自己记的那个缓存键**推导——校验的就是"这份清单描述的包集，其 app-boot 是否真给出
 * 这份根集"；另取一个键来推就成了拿别处的产物验这份清单。
 *
 * @throws 清单缺失、T1 缓存不在、或根集（名字或类别）与现算不一致时。
 */
export async function assertRootSetMatchesManifest(): Promise<void> {
  const set = readPackageSet();
  if (set === null) {
    throw new Error("找不到 " + packageSetRel(currentCacheKey()) + "：先 node scripts/derive/index.mts package-set 生成");
  }
  const { entries } = await deriveRootSet(deliveredAppBootDir(set.build.cacheKey));
  const diffs = checkPackageSet(set, path.join(ROOT, ".cache", "dsh-build", set.build.cacheKey, "dist-npm"), entries);
  // 只把根集相关的差异当闸拦下；字节差异由 verifyPackageSet（需要 T1 缓存）负责，出包机未必有。
  const rootDiffs = diffs.filter(
    (d) =>
      d.startsWith("现算根集有") ||
      d.startsWith("清单记了") ||
      d.startsWith("根集包不在") ||
      d.includes("的类别："),
  );
  if (rootDiffs.length) {
    throw new Error("包集根集与清单不一致：\n  - " + rootDiffs.join("\n  - "));
  }
}
