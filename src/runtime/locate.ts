// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/locate.ts — DSH 依赖定位（受管 runtime 子进程侧，dsh-host 专用）
//
// depsRoot（默认 App dataDir
// runtime/node_modules）下定位
//   @deepseek-ai/dsh/lib/profile-boot-*.js（带构建 hash 产物名，枚举试 runProfile 导出）
//   @deepseek-ai/dsh-app-boot（createRequire 沿 dsh 包解析；回退 .pnpm 枚举）
// 与 v1 的差异只在「dsh 包根」从插件根 node_modules 换成受管 runtime 的 depsRoot；
// 动态 import 必须 /* webpackIgnore: true */（rspack 保留原生 import()，运行时绝对路径
// file:// URL 不经 bundler chunk runtime——与 v1 同注释纪律）。
import { createRequire } from "node:module";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { errText } from "#/lib/err-text.ts";

/** 读一个包目录的 package.json version；不存在/解析失败 → null。 */
export function readPkgVersion(pkgDir) {
  try {
    const p = join(pkgDir, "package.json");
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j.version === "string" && j.version ? j.version : null;
  } catch {
    return null;
  }
}

/**
 * 定位 DSH 运行入口（纯函数参数化，便于测试）：depsRoot 下的 pnpm 布局
 *（node_modules/@deepseek-ai/dsh + .pnpm 虚拟存储）。返回
 * { profileBoot, bootEntry, appBoot, appBootEntry, dshPkgDir, version }；
 * 缺包/无可用 profile-boot → throw 可读错误（分类由调用方转退出码）。
 */
export async function locateDsh({ depsRoot, log = (..._args) => {} }) {
  const dshPkg = join(depsRoot, "@deepseek-ai", "dsh");
  if (!existsSync(join(dshPkg, "package.json"))) {
    throw new Error(
      `DSH 包未就绪：${join(depsRoot, "@deepseek-ai", "dsh")} 不存在（depsRoot=${depsRoot}）。
依赖随包物化在安装目录 node_modules（depsRoot 默认指向）；
当前可用 --deps-root <dir> 覆盖（预置/调试场景）。`,
    );
  }
  const libDir = join(dshPkg, "lib");
  // ① profile-boot：优先稳定入口 profile-boot.js——哈希产物 profile-boot-<hash>.js 的导出名
  //    会被压缩成单字母，公开名（runProfile 等）只挂在稳定入口上；回退枚举 profile-boot-*.js
  //    试 runProfile，兼容只有哈希产物、导出名未压缩的旧包。
  let profileBoot = null;
  let bootEntry: string | null = null;
  let tried = 0;
  const candidates: string[] = [];
  const stableEntry = join(libDir, "profile-boot.js");
  if (existsSync(stableEntry)) candidates.push(stableEntry);
  try {
    for (const f of readdirSync(libDir)) {
      if (!f.startsWith("profile-boot-") || !f.endsWith(".js")) continue;
      candidates.push(join(libDir, f));
    }
  } catch (e) {
    throw new Error(`无法枚举 dsh profile-boot 模块（${libDir}）：${errText(e)}`);
  }
  for (const candidate of candidates) {
    tried += 1;
    try {
      const m = await import(/* webpackIgnore: true */ pathToFileURL(candidate).href);
      if (typeof m.runProfile === "function") {
        profileBoot = m;
        bootEntry = candidate;
        break;
      }
    } catch {
      /* 单个候选加载失败：继续（dsh 版本演进产物名变化） */
    }
  }
  if (!profileBoot) {
    throw new Error(`dsh 包无可用 profile-boot 模块（lib 下已检查 ${tried} 个候选：稳定入口与 profile-boot-*.js）`);
  }
  // ② app-boot 定位（双保险：createRequire 沿 dsh 包 → .pnpm 枚举）
  let appBootEntry: string | null = null;
  try {
    const dshRequire = createRequire(join(dshPkg, "package.json"));
    appBootEntry = dshRequire.resolve("@deepseek-ai/dsh-app-boot");
  } catch {
    appBootEntry = null;
  }
  if (appBootEntry === null) {
    const pnpmDir = join(depsRoot, ".pnpm");
    try {
      for (const d of readdirSync(pnpmDir)) {
        if (!d.startsWith("@deepseek-ai+dsh-app-boot@")) continue;
        const candidate = join(pnpmDir, d, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
        if (existsSync(candidate)) {
          appBootEntry = candidate;
          break;
        }
      }
    } catch {
      /* 枚举失败保持 null */
    }
  }
  if (appBootEntry === null) {
    throw new Error("无法解析 @deepseek-ai/dsh-app-boot（dsh 依赖缺失？createRequire 与 .pnpm 枚举均未命中）");
  }
  const appBoot = await import(/* webpackIgnore: true */ pathToFileURL(appBootEntry).href);
  if (typeof appBoot.loadLayeredEnv !== "function" || typeof appBoot.initProfile !== "function") {
    throw new Error(`@deepseek-ai/dsh-app-boot 缺 loadLayeredEnv/initProfile 导出（${appBootEntry}）`);
  }
  log(`dsh 定位：${bootEntry} + ${appBootEntry}`);
  return { profileBoot, bootEntry, appBoot, appBootEntry, dshPkgDir: dshPkg, version: readPkgVersion(dshPkg) };
}

/**
 * 子进程入口所在 App 安装根（向上找 manifest.json；与 v1 state.js PLUGIN_ROOT 同规则）。
 * @param entryFile 本 bundle 所在文件绝对路径（import.meta.url 解析后传入）
 */
export function resolveInstallRoot(entryFile: string): string {
  let dir = dirname(entryFile);
  for (;;) {
    if (existsSync(join(dir, "manifest.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`无法定位 App 安装根：从 ${entryFile} 向上未找到 manifest.json（安装包不完整？）`);
    }
    dir = parent;
  }
}
