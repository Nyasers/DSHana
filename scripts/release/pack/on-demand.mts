// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/on-demand.mts — 把上游「内置」的实验性 bundle 改成「按需安装」。
//
// 上游对可选 bundle 有两种交付口径，插件管理页据此显示两种状态：
//   · 内置（shipped）：包在内核 @deepseek-ai/dsh 的 dependencies 里 → 页面标「内置」，不可移除；
//   · 按需（on-demand）：不在内核 dependencies 里，但在 OFFICIAL_ON_DEMAND_CATALOG 里
//     → 页面标「未安装」，给一个安装按钮，点了从 registry 装（与 claude-code / codex 同一条路）。
//
// 本文件把上游 OPTIONAL_BUNDLES 那 12 个实验 bundle 从第一条挪到第二条。
//
// 为什么值得挪：上游给这 12 个的语义是「随安装走、默认关，由插件管理页打开」，但它们的包全在
// 内核 dependencies 里，于是**每一个安装都揣着这 46 MB 从不加载的代码**（语音输入 24 MB，其中
// 22 MB 是 sherpa 语音模型；inspector 24 MB，其中 22 MB 是整份 DevTools 前端）。用户点了才下载，
// 不点零成本——这才是「默认关」。
//
// 三处必须同时成立，缺一个就是假活：
//   ① 包不在交付树里：走 exclude.mts 那条既有通道（override 成 stub → 真件不下载 → 组装时删掉
//      占位），连它们的传递依赖都进不来（stub 不声明依赖）。做成「先装再删」是不行的：那等于
//      构建期照样下载 46 MB 的东西再扔掉。
//   ② 内核 package.json 的 dependencies 里没有它：shipped 判定只读这一处
//      （plugin-manager 的 `Object.hasOwn(installation.dependencies, name)`），不摘掉的话包已经
//      不在树里了、页面照旧标「内置」。
//   ③ OFFICIAL_ON_DEMAND_CATALOG 里有它：listBundles 的名单是
//      `selected ∪ dependencies ∪ installation.dependencies ∪ catalog.keys()`，不在任何一处就
//      根本列不出来，用户再也装不回来。
// ②③ 是一件事的两面：上游生成 catalog 的脚本里有条硬检查
// 「on-demand providers must not be installed by the DSH distribution」，顺序反了连上游自己都不认。
import fs from "fs-extra";
import { join } from "node:path";

import { listMirrorFiles, readUpstreamFromMirror, MIRROR } from "../../integrations/mirror.mts";
import { dshPin } from "../../shared/version.mts";

/** 安装锚点（内核包）：交付面依赖与 shipped 判定都读它。 */
const ANCHOR_PACKAGE = "@deepseek-ai/dsh";
/** 浏览器插件的 loader 装配面（上游发布时打包成单文件，catalog 常量就在那里面）。 */
const APP_BOOT_PACKAGE = "@deepseek-ai/dsh-app-boot";

/**
 * 改成按需安装的实验性 bundle。名单必须与上游 OPTIONAL_BUNDLES 一一对应，
 * 少了或多了都在打包时当场报（见 assertMatchesUpstreamOptional）。
 */
export const ON_DEMAND_BUNDLES: readonly string[] = [
  "@deepseek-ai/dsh-experimental-session-search",
  "@deepseek-ai/dsh-experimental-ralph-bundle",
  "@deepseek-ai/dsh-experimental-terminal-bundle",
  "@deepseek-ai/dsh-experimental-badge-skill-bundle",
  "@deepseek-ai/dsh-experimental-session-titles-bundle",
  "@deepseek-ai/dsh-experimental-agent-team-profile",
  "@deepseek-ai/dsh-experimental-voice-input-bundle",
  "@deepseek-ai/dsh-experimental-cot-translation-bundle",
  "@deepseek-ai/dsh-experimental-auto-review",
  "@deepseek-ai/dsh-experimental-inspector-profile",
  "@deepseek-ai/dsh-experimental-plugin-market-bundle",
  "@deepseek-ai/dsh-experimental-tool-worktree",
];

/** 上游 app-boot 源码里那份 OPTIONAL_BUNDLES（判据来源，不另维护第二份名单）。 */
export function upstreamOptionalBundles(): string[] {
  const file = join(MIRROR, "packages", "boot", "app-boot", "src", "profile.ts");
  const text = fs.readFileSync(file, "utf8");
  const block = /export const OPTIONAL_BUNDLES[^=]*=\s*\[([\s\S]*?)\]/u.exec(text);
  if (block === null) throw new Error(`${file} 里找不到 OPTIONAL_BUNDLES 的字面量（上游改了结构？）`);
  const names = [...block[1].matchAll(/'([^']+)'/gu)].map((m) => m[1]);
  if (names.length === 0) throw new Error(`${file} 里的 OPTIONAL_BUNDLES 解析为空（上游改了写法？）`);
  return names;
}

/**
 * 名单必须与上游 OPTIONAL_BUNDLES **完全一致**：少一个 = 那个 bundle 仍随包内置（漏改），
 * 多一个 = 我们造了个上游没有的按需项（catalog 里点安装会 404）。
 */
export function assertMatchesUpstreamOptional(): void {
  const upstream = new Set(upstreamOptionalBundles());
  const ours = new Set(ON_DEMAND_BUNDLES);
  const missing = [...upstream].filter((n) => !ours.has(n));
  const extra = [...ours].filter((n) => !upstream.has(n));
  if (missing.length || extra.length) {
    throw new Error(
      "按需名单与上游 OPTIONAL_BUNDLES 不一致：\n"
        + (missing.length ? `  上游有而我们没改按需：${missing.join(", ")}\n` : "")
        + (extra.length ? `  我们有而上游没有：${extra.join(", ")}\n` : ""),
    );
  }
}

/**
 * 从内核清单的 dependencies 摘掉按需面（只动交付树那一份，不碰 vendor 源）。
 *
 * 这是 ② 那一步：不摘掉的话 shipped 恒为 true，页面把「树里根本没有」的包显示成「内置」。
 * fail-closed：一个都没摘到说明上游已经把它们移出安装面，那时本步骤与 catalog 注入的关系变了，
 * 要人看一眼，不静默放过。
 * @param nodeModulesDir 交付树的 node_modules
 * @returns 摘掉的包名
 */
export function unshipFromAnchor(nodeModulesDir: string): string[] {
  const manifestPath = join(nodeModulesDir, ANCHOR_PACKAGE, "package.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`安装锚点不在交付树里：${manifestPath}`);
  const manifest = fs.readJSONSync(manifestPath);
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const dropped: string[] = [];
  for (const name of ON_DEMAND_BUNDLES) {
    if (dependencies[name] === undefined) continue;
    delete dependencies[name];
    dropped.push(name);
  }
  if (dropped.length === 0) {
    throw new Error(
      `${ANCHOR_PACKAGE} 的 dependencies 里一个按需 bundle 都没有：上游已经把它们移出安装面？`
        + "先对账，再决定这一步还要不要",
    );
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }, null, 2) + "\n");
  console.log(`[pack] 内核依赖摘掉 ${dropped.length} 个按需 bundle（shipped 判定由此转 false）`);
  return dropped;
}

/**
 * 断言按需面真的不在交付树里（① 那一步由 exclude.mts 的 stub 通道完成，这里只核实）。
 *
 * 为什么核实而不是删：删是「装完再扔」（构建期照样下载），stub 是「根本不下载」。既然走了 stub，
 * 这里唯一要防的就是「stub 通道漏了几条」——那时包会真被装进树里，而页面又因为 ②③ 说它「未安装」，
 * 变成装着不认的怪状态。
 * @param nodeModulesDir 交付树的 node_modules
 */
export function assertNotDelivered(nodeModulesDir: string): void {
  const present = ON_DEMAND_BUNDLES.filter((n) => fs.pathExistsSync(join(nodeModulesDir, n, "package.json")));
  if (present.length > 0) {
    throw new Error(
      `按需 bundle 仍在交付树里（stub 通道漏了这几条）：${present.join("、")}\n`
        + "  它们该在 exclude.mts 的 excludedPackages() 里，物化前就 override 成 stub。",
    );
  }
}

/** 镜像 tag 下包名 → 包目录（一次扫全；镜像里的目录名与包名不同名，只能反查）。 */
let mirrorDirCache: { tag: string; map: Map<string, string> } | null = null;

function mirrorPackageDirs(tag: string): Map<string, string> {
  if (mirrorDirCache !== null && mirrorDirCache.tag === tag) return mirrorDirCache.map;
  const map = new Map<string, string>();
  for (const rel of listMirrorFiles(tag, "packages")) {
    if (!rel.endsWith("/package.json")) continue;
    const buf = readUpstreamFromMirror(rel, tag);
    if (buf === null) continue;
    try {
      const name = JSON.parse(buf.toString("utf8")).name;
      if (typeof name === "string") map.set(name, rel.slice(0, -"/package.json".length));
    } catch {
      /* 不是包清单，跳过 */
    }
  }
  mirrorDirCache = { tag, map };
  return map;
}

/**
 * 从上游镜像读一个 bundle 的展示元数据（双语标题/简介 + 图标）。
 *
 * 从镜像而不是交付树读：交付树里这批包已经被 stub 掉了，而镜像按 tag 只读，与检出状态无关
 * （与 integrations 取源同一条纪律）。
 * @param name 包名
 * @param tag 镜像 tag
 */
function metaOf(name: string, tag: string): { title: Record<string, string>; description: Record<string, string>; icon: string } {
  const dir = mirrorPackageDirs(tag).get(name);
  if (dir === undefined) throw new Error(`镜像 ${tag} 里找不到包 ${name} 的目录（按 package.json 反查）`);
  const readJson = (rel: string) => {
    const buf = readUpstreamFromMirror(rel, tag);
    if (buf === null) throw new Error(`镜像 ${tag} 里没有 ${rel}`);
    return JSON.parse(buf.toString("utf8"));
  };
  const title: Record<string, string> = {};
  const description: Record<string, string> = {};
  for (const lang of ["en", "zh"]) {
    const meta = readJson(`${dir}/locale/${lang}.json`).meta ?? {};
    if (typeof meta.title !== "string" || meta.title.trim() === "") {
      throw new Error(`${name}: locale/${lang}.json 缺 meta.title（catalog 条目要求双语标题）`);
    }
    if (typeof meta.description !== "string" || meta.description.trim() === "") {
      throw new Error(`${name}: locale/${lang}.json 缺 meta.description（catalog 条目要求双语简介）`);
    }
    title[lang] = meta.title;
    description[lang] = meta.description;
  }
  const icon = readUpstreamFromMirror(`${dir}/icon.svg`, tag);
  if (icon === null) throw new Error(`${name}: 镜像里没有 icon.svg（catalog 条目要求图标）`);
  return { title, description, icon: `data:image/svg+xml;base64,${icon.toString("base64")}` };
}

/**
 * 从 `[` 起做括号配平，返回数组右括号下标。
 *
 * 不按 `}];` 或注释锚点定位：catalog 里装着 base64 图标字面量，任何按文本片段找的锚点都可能被
 * 图标内容骗到；配平只看括号本身，且跳过字符串内部。
 */
function findArrayEnd(text: string, openIndex: number): number {
  if (text[openIndex] !== "[") throw new Error(`锚点不是数组起点（${openIndex}）：${text.slice(openIndex, openIndex + 40)}`);
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("catalog 数组没有配平的右括号（生成物被改过？）");
}

/**
 * 把按需面注入 app-boot 的离线 catalog（③ 那一步）。
 *
 * 为什么改产物而不是改源码：app-boot 的 lib/index.js 是上游**发布时**打好的单文件（23 个源文件
 * 的打包结果），从源码重打要先摊整棵树、再对齐装饰器与 externals，代价远大于这一步的风险。
 * 判据与 integrations 的 generatedPatches 同一条：按锚点定位，找不到就抛，绝不静默跳过——静默
 * 跳过的后果是「页面里根本没有这 12 个」而包已经不在树里，用户再也装不回来。
 * @param nodeModulesDir 交付树的 node_modules
 * @param tag 镜像 tag（默认取内核 pin）
 * @returns 注入的条目数
 */
export function injectOnDemandCatalog(nodeModulesDir: string, tag = `dsh-v${dshPin()}`): number {
  const target = join(nodeModulesDir, APP_BOOT_PACKAGE, "lib", "index.js");
  if (!fs.existsSync(target)) throw new Error(`${APP_BOOT_PACKAGE} 的产物不在交付树里：${target}`);
  const text = fs.readFileSync(target, "utf8");
  const marker = "const OFFICIAL_ON_DEMAND_CATALOG = ";
  const at = text.indexOf(marker);
  if (at < 0) {
    throw new Error(
      `${APP_BOOT_PACKAGE} 产物里找不到 ${marker.trim()} 锚点——上游换了常量名或不再是数组字面量。`
        + "按需面注入要重新对账；找不到就注入不了，页面里那 12 个会整个消失。",
    );
  }
  const openIndex = text.indexOf("[", at + marker.length);
  const endIndex = findArrayEnd(text, openIndex);
  const existing = text.slice(openIndex, endIndex + 1);
  const already = ON_DEMAND_BUNDLES.filter((n) => existing.includes(`"${n}"`));
  if (already.length > 0) {
    throw new Error(`catalog 里已经有按需 bundle（${already.join("、")}）：上游把它们收进 catalog 了，本步骤该撤。`);
  }
  const entries = ON_DEMAND_BUNDLES.map((name) => {
    const meta = metaOf(name, tag);
    return `{\n\tpackageName: ${JSON.stringify(name)},\n\tmeta: {\n\t\ttitle: ${JSON.stringify(meta.title)},\n\t\tdescription: ${JSON.stringify(meta.description)},\n\t\ticon: ${JSON.stringify(meta.icon)}\n\t}\n}`;
  });
  const injected = `${existing.slice(0, -1)}, ${entries.join(", ")}]`;
  fs.writeFileSync(target, text.slice(0, openIndex) + injected + text.slice(endIndex + 1));
  console.log(`[pack] 按需面注入 app-boot 离线 catalog：${entries.length} 个条目（页面据此显示「未安装」并给安装按钮）`);
  return entries.length;
}
