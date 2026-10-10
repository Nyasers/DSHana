// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/materialize.mts — 生产依赖物化（逐目标干净安装）与源码层精简。
//
// 生产依赖物化（自包含打包）：逐目标在各自的隔离暂存目录里做**干净安装**，得到只含该平台资产的
// node_modules（hoisted 布局：顶层真实目录、无软链接——软链进 zip 跨机解压即断）。
// 工位是一个独立项目，三件都现生成：清单（工位清单，运行时依赖来自 host 的内核声明）、按目标替换
// 过平台块的 workspace yaml、从仓库锁文件长出来的锁——先 `install --lockfile-only` 以仓库锁为种子
// 重解析出交付面的生产闭包，再 `install --prod --frozen-lockfile` 按它装。仓库根那份清单（构建面，
// 带 devDependencies）不进工位。
// 实测（Windows + 热缓存）：单目标安装 8.4s / 210 MB，且不含其他平台的边角；「通用树裁剪
// 派生」会留残留且更大。
// 隔离的理由：不触碰仓库 node_modules（dev+prod 混合树，动它会触发 pnpm 重建；Windows 上
// 清理被拒会损坏树）。
import { createRequire } from "node:module";
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../../shared/root.mts";
import { STAGING_ROOT } from "../../shared/paths.mts";
import { dshPin } from "../../shared/version.mts";
import { dropStaleLibc, platformAssetsFor, scanPlatformTree } from "./assets.mts";
import { assertIntegrationTargets } from "./assert.mts";
import { stagingManifest } from "./ship-manifest.mts";
import { stagingWorkspaceYaml } from "./targets.mts";

const require = createRequire(import.meta.url);

/** 逐目标干净安装（各自暂存目录 + 各自 supportedArchitectures）；返回该目标的 node_modules 路径。 */
export function materializeProdDeps(spec, version: string) {
  const dir = join(STAGING_ROOT, spec.name);
  const modules = join(dir, "node_modules");
  fs.removeSync(dir);
  fs.ensureDirSync(dir);
  // 工位三件：现生成的清单（内核声明派生）+ 按目标替换过平台块的 workspace yaml + 仓库锁文件当种子。
  fs.writeFileSync(join(dir, "package.json"), JSON.stringify(stagingManifest(version), null, 2) + "\n");
  fs.copySync(join(ROOT, "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"));
  fs.writeFileSync(join(dir, "pnpm-workspace.yaml"), stagingWorkspaceYaml(spec), "utf8");
  // 本地替身包（vendor/stubs/*，由 pnpm-workspace.yaml 的 file: overrides 指过来）必须跟着进工位：
  // 工位是一次**干净安装**，`file:` 路径按工位目录解析，不带过去就是 ENOENT。
  // 只有运行时闭包里的替身会在这里被解析（@hana/* 那几条是开发面依赖，工位里用不到）。
  const stubs = join(ROOT, "vendor", "stubs");
  if (fs.pathExistsSync(stubs)) fs.copySync(stubs, join(dir, "vendor", "stubs"));
  console.log(`[pack] 物化 ${spec.name}（干净安装，隔离目录 .cache/pkg-root/${spec.name}）...`);
  // 锁以仓库锁文件为种子重解析（工位是独立项目，锁得按工位清单重算），再按它做 frozen 安装。
  runPnpm(dir, ["install", "--lockfile-only"], spec.name);
  runPnpm(dir, ["install", "--prod", "--frozen-lockfile"], spec.name);
  if (!fs.pathExistsSync(modules)) throw new Error(`生产依赖物化失败（${spec.name}）：node_modules 未生成`);
  // 平台资产**从物化后的锁派生**，不手写名单：工位锁是这次干净安装的解析记录（只含生产闭包），
  // 带 os/cpu/libc 的条目就是按平台切分的包。判据而非名单——上游换包名、加新平台件自动跟上，
  // 也不会因为漏写一行而静默放过一个跑不起来的包。
  const assets = platformAssetsFor(fs.readFileSync(join(dir, "pnpm-lock.yaml"), "utf8"), spec);
  const missing = assets.filter((a) => !fs.pathExistsSync(join(modules, a, "package.json")));
  if (missing.length) {
    throw new Error(`${spec.name} 缺少平台资产（该平台的包会跑不起来）：\n  - ${missing.join("\n  - ")}`);
  }
  // 反向闸一：os/cpu 不相容的包不该被装出来。物化按目标窄化这两个维度，混进来即窄化失效，拒包。
  // 反向闸二：libc 不相容的变体（glibc 目标下的 musl 件）当删不当拒——pnpm 的
  // supportedArchitectures.libc 在 hoisted 布局下不作用于 optional 传递树（sharp 把 musl 变体
  // 列在 optionalDependencies 里），它们对目标无用且体量不小（libvips 一对约 36 MB）。
  const scan = scanPlatformTree(modules, spec);
  if (scan.foreign.length) {
    throw new Error(`${spec.name} 物化树里混进了别的 os/cpu 的包（supportedArchitectures 窄化没生效）：\n  - ${scan.foreign.join("\n  - ")}`);
  }
  const droppedLibc = dropStaleLibc(modules, scan.staleLibc);
  if (droppedLibc.files > 0) {
    console.log(`[pack] ${spec.name} 清掉 ${droppedLibc.files} 个 libc 不相容变体（释放未压缩 ${(droppedLibc.bytes / 1e6).toFixed(1)} MB）`);
  }
  console.log(`[pack] ${spec.name} 物化完成（平台资产 ${assets.length} 项齐备，内核 ${assertKernelAtPin(modules)}，集成目标 ${assertIntegrationTargets(modules, join(ROOT, "integrations"))} 项）`);
  const pruned = pruneNodeModules(modules, spec);
  if (pruned.files > 0) {
    console.log(
      `[pack] ${spec.name} 源码层精简：删 ${pruned.files} 项（释放未压缩 ${(pruned.bytes / 1e6).toFixed(1)} MB）`,
    );
  }
  return modules;
}

/** 工位里跑一次 pnpm（cwd 留仓库根，用 --dir 指工位：corepack 因此读到根 package.json#packageManager
 *  钉的 pnpm 版本，工位里向上找会被那份生成的清单截断）。退出码非 0 即抛。 */
function runPnpm(dir: string, args: string[], target: string): void {
  const { spawnSync } = require("node:child_process");
  const res = spawnSync("pnpm", ["--dir", dir, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) throw new Error(`生产依赖物化失败（${target}，pnpm ${args.join(" ")} 退出码 ${res.status}）`);
}

/**
 * 物化出的内核必须就是 host 声明的那一版：交付面的 runtime 依赖没有别的来源，这一版对不上就是
 * 工位的解析出了岔子（清单写错、种子锁不匹配之类）。返回实际版本供日志。
 */
function assertKernelAtPin(modules: string): string {
  const manifest = join(modules, "@deepseek-ai", "dsh", "package.json");
  if (!fs.pathExistsSync(manifest)) throw new Error("物化树里没有内核（@deepseek-ai/dsh 缺失）：拒绝出包");
  const installed = fs.readJsonSync(manifest).version;
  const pin = dshPin();
  if (installed !== pin) {
    throw new Error(`物化出的内核 ${installed} ≠ host 声明的 ${pin}（工位清单或种子锁不对）：拒绝出包`);
  }
  return String(installed);
}

/**
 * 源码层精简：只删两类“没有运行期入口”的东西，其余一律留着。
 *   1. 非本平台的预编译产物（按目标平台筛：带平台名的目录 + prebuilds/bin/third_party 下的平台子目录）；
 *      这是体积的大头，也是唯一需要“选择”的一步。
 *   2. 四类扩展名：`.pdb`（调试符号）、`.map`（源码映射）、`.d.ts/.d.mts/.d.cts`（类型声明）、
 *      `.md/.markdown`（纯文档）——JS 不会 require 它们。
 *
 * 刻意**不**按目录名删东西（`docs`/`tests`/`examples`/`fixtures` 之类）：目录名不等于内容，
 * 包在那种目录里放运行期代码并不稀奇，而按名字猜的代价是装包后起不来。
 *
 * 返回 { files, bytes }；失败一律不阻断打包（删不掉就留着）。
 */
function pruneNodeModules(modules: string, spec: { os: string[]; cpu: string[] }): { files: number; bytes: number } {
  const plat = new Set();
  for (const os of spec.os) for (const cpu of spec.cpu) plat.add(`${os}-${cpu}`);
  const normalizePlat = (name) => name.replace(/^win10-/, "win32-");
  const out = { files: 0, bytes: 0 };
  const PRUNABLE_FILE = /(\.pdb|\.map|\.d\.ts|\.d\.mts|\.d\.cts|\.md|\.markdown)$/i;
  const PLATFORM_DIR = /^(win32|win10|darwin|linux)-[a-z0-9]+$/i;
  const PRECOMPILED_DIR = /^(prebuilds|bin|third_party)$/;

  const listDir = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  const dropTree = (p) => {
    const size = dirSize(p);
    try {
      fs.removeSync(p);
      out.files += 1;
      out.bytes += size;
    } catch {
      /* 删不掉就留着 */
    }
  };

  const walk = (dir) => {
    for (const e of listDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (PLATFORM_DIR.test(e.name) && !plat.has(normalizePlat(e.name))) {
          dropTree(p);
          continue;
        }
        if (PRECOMPILED_DIR.test(e.name)) {
          for (const sub of listDir(p)) {
            if (sub.isDirectory() && PLATFORM_DIR.test(sub.name) && !plat.has(normalizePlat(sub.name))) {
              dropTree(join(p, sub.name));
            }
          }
          walk(p);
          continue;
        }
        walk(p);
        continue;
      }
      if (!PRUNABLE_FILE.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        fs.removeSync(p);
        out.files += 1;
        out.bytes += st.size;
      } catch {
        /* 删不掉就留着 */
      }
    }
  };
  walk(modules);
  return out;
}

/** 目录内所有文件的字节合计（用于统计被删目录的体量）。 */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* 忽略 */
      }
    }
  }
  return total;
}
