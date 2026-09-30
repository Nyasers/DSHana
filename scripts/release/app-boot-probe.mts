// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/app-boot-probe.mts — 从 **T1 缓存里的** app-boot 读 PROFILE_TEMPLATES。
//
// 为什么不读仓库 node_modules 里那份：那份是 **registry 的成品包**，而 delta（我们的 `dshana`
// 模板条目）是在**构建期**铺进检出、烤进 T1 产物里的。于是：
//   · registry 那份只有上游模板表 → 拿它推导我们的根集当场失败（找不到 dshana）；
//   · T1 那份才是**交付树里真正会跑**的 app-boot → 清单必须描述它。
// 模板还叫 `web` 时这个区别看不出来（两边都有、内容相同），是 §6.6 让它显形：
// 「清单里记的根集就是我们的预设」这句话，只有在读**交付的那份** app-boot 时才为真。
//
// 读法：把 T1 的 app-boot tarball 摊进 .tmp 的隔离目录，再 import 它的 lib/index.js。
// 直接摊开 import 会失败——bundle 是单文件，但 import 了 js-yaml / semver / cordis 等外部包，
// 而隔离目录向上既走不到仓库 node_modules，也走不到 pnpm 的扁平存储。于是按 app-boot 自己的
// dependencies + peerDependencies 建一层 junction 桥。**realpath 是关键**：pnpm 存储里的条目是
// 相对符号链接，隔着 junction 访问会解析到错位置的父目录（实测 existsSync=false）。
// 换绝对真路径后，package 自己的 node_modules 也跟着来，传递依赖照常解析，故只需桥直接依赖。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

import { ROOT } from "../shared/root.mts";
import { extractTar, readTarMember } from "../vendor/tar-extract.mts";

/**
 * 摊开交付 app-boot 的隔离目录。**按缓存键分目录**：ESM 的模块缓存以 URL 为键，若所有键共用
 * 一条路径，同一进程里第二次 import 会把第一份模块还回来（换键校验就永远看的是旧那份）。
 * 每次现建，可反复调用。
 */
function scratchDirOf(key: string): string {
  return path.join(ROOT, ".tmp", "app-boot-probe", key);
}
/**
 * T1 缓存条目目录。**在这里内联**（不 import package-set.mts 的 cacheEntryDir）：package-set.mts 反过来
 * import 本模块（要 materializeDeliveredAppBoot），两边互引会成环。ESM 能容忍这个环，但那是靠"函数声明
 * 提升 + 调用期才取值"的巧合，属latent hazard——一个跨模块的常量或类字段就会让它变成运行时 undefined。
 */
function cacheEntryDir(key: string): string {
  return path.join(ROOT, ".cache", "dsh-build", key);
}

/** 交付 app-boot 的包名。 */
const APP_BOOT_PACKAGE = "@deepseek-ai/dsh-app-boot";
/** 仓库已装包的两处包位（解析直接依赖用）。 */
const FLAT_STORE = path.join(ROOT, "node_modules", ".pnpm", "node_modules");
const TOP_STORE = path.join(ROOT, "node_modules");

/**
 * T1 缓存条目里的 app-boot tarball 路径。
 *
 * 先按文件名筛（`*dsh-app-boot*.tgz`），再**读它的 manifest 核对包名**——文件名是线索不是证据，
 * 上游改了打包命名时宁可报错，也不要静默拿错包。
 *
 * @param key - T1 缓存键。
 * @returns tarball 绝对路径。
 */
export function deliveredAppBootTarball(key: string): string {
  const distDir = path.join(cacheEntryDir(key), "dist-npm");
  if (!fs.existsSync(distDir)) {
    throw new Error("T1 包集目录不存在：" + path.relative(ROOT, distDir) + "（先跑 node scripts/vendor/build.mts）");
  }
  const candidates = fs.readdirSync(distDir).filter((n) => n.endsWith(".tgz") && n.includes("dsh-app-boot"));
  for (const file of candidates) {
    const absolute = path.join(distDir, file);
    try {
      const body = readTarMember(absolute, "package/package.json");
      if (body !== null && JSON.parse(body.toString("utf8")).name === APP_BOOT_PACKAGE) return absolute;
    } catch {
      /* 归档坏了/读不出：换下一个候选；都没有时下面的报错会说清 */
    }
  }
  throw new Error(
    "T1 缓存 " + key + " 的 dist-npm 里找不到 " + APP_BOOT_PACKAGE + " 的 tarball" +
      (candidates.length ? "（文件名像的有 " + candidates.length + " 个，manifest 都不匹配）" : "") +
      "：包集不完整，根集无法推导（不能拍名单）",
  );
}

/**
 * 把 T1 的 app-boot 摊到隔离目录，并按它自己的直接依赖建 junction 桥。
 *
 * @param key - T1 缓存键。
 * @returns 摊开后的包目录（含 package.json 与 lib/index.js）。
 */
export function materializeDeliveredAppBoot(key: string): string {
  const tarball = deliveredAppBootTarball(key);
  const scratch = scratchDirOf(key);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const bare = path.join(scratch, "app-boot.tar");
  fs.writeFileSync(bare, zlib.gunzipSync(fs.readFileSync(tarball)));
  extractTar(bare, scratch);
  fs.rmSync(bare, { force: true });
  const pkgDir = path.join(scratch, "package");
  const manifestPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(path.join(pkgDir, "lib", "index.js"))) {
    throw new Error("摊开的交付 app-boot 不完整（缺 package.json 或 lib/index.js）：" + tarball);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const names = [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])];
  bridgeDependencies(names, path.join(scratch, "node_modules"));
  return pkgDir;
}

/** 解析一个包的真实目录；两处包位都不命中返回 null。 */
function resolveRealDir(name: string): string | null {
  for (const root of [FLAT_STORE, TOP_STORE]) {
    const candidate = path.join(root, name, "package.json");
    if (fs.existsSync(candidate)) return path.dirname(fs.realpathSync(candidate));
  }
  return null;
}

/**
 * 为一批包名建真路径 junction——解析环境取自仓库已装的那份 DSH。
 *
 * 三处都解析不到就**点名报错**：静默少桥一个包，后面只会报"找不到某某包"，看不出成因在这里。
 *
 * @param names - 包名（app-boot 的直接依赖与 peer）。
 * @param destDir - 桥的目标 node_modules 目录。
 */
function bridgeDependencies(names: string[], destDir: string): void {
  const missing: string[] = [];
  for (const name of names) {
    const real = resolveRealDir(name);
    if (real === null) { missing.push(name); continue; }
    const target = path.join(destDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.symlinkSync(real, target, "junction");
  }
  if (missing.length) {
    throw new Error(
      "交付 app-boot 的直接依赖在仓库里解析不到：" + missing.join("、") +
        "（先 pnpm install；根集推导要用这些包把 app-boot import 起来）",
    );
  }
}

/**
 * 交付 app-boot 的 PROFILE_TEMPLATES 与 OPTIONAL_BUNDLES（import 它的 lib/index.js）。
 *
 * @param key - T1 缓存键。
 * @returns app-boot 导出的两份名单（原始形状，语义校验由调用方做）。
 */
export async function readDeliveredAppBootExports(key: string): Promise<{
  templates: Record<string, { bundles?: unknown }> | undefined;
  optionalBundles: unknown;
  packageDir: string;
}> {
  const pkgDir = materializeDeliveredAppBoot(key);
  const moduleUrl = pathToFileURL(path.join(pkgDir, "lib", "index.js")).href;
  const mod = (await import(moduleUrl)) as {
    PROFILE_TEMPLATES?: Record<string, { bundles?: unknown }>;
    OPTIONAL_BUNDLES?: unknown;
  };
  return { templates: mod.PROFILE_TEMPLATES, optionalBundles: mod.OPTIONAL_BUNDLES, packageDir: pkgDir };
}

