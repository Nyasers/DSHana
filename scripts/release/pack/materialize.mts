// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/materialize.mts — 生产依赖物化（逐目标干净安装）与源码层精简。
//
// 生产依赖物化（自包含打包）：逐目标在各自的隔离暂存目录里做**干净安装**，得到只含该平台资产的
// node_modules（hoisted 布局：顶层真实目录、无软链接——软链进 zip 跨机解压即断）。
// 工位就是一个独立项目：交付面自带的两份（`packaging/package.json` + `packaging/pnpm-lock.yaml`）
// + 按目标替换过平台块的 workspace yaml；`pnpm install --prod` 因此只装交付面的生产闭包，仓库根
// 那份清单（构建面，带 devDependencies）不进工位。
// 实测（Windows + 热缓存）：单目标安装 8.4s / 210 MB，且不含其他平台的边角；而「通用树裁剪
// 派生」会留残留且更大（见 specs §11）。
// 隔离的理由：不触碰仓库 node_modules（dev+prod 混合树，且动它会触发 pnpm 重建——Windows 上
// 曾遇清理被拒导致树损坏）。
import { createRequire } from "node:module";
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../../shared/root.mts";
import { assertIntegrationTargets } from "./assert.mts";
import { stagingWorkspaceYaml } from "./targets.mts";

const require = createRequire(import.meta.url);

/** 依赖物化工位根（起手清残留、用完即清）。 */
export const STAGING_ROOT = join(ROOT, "_tmp", "pkg-root");

/** 逐目标干净安装（各自暂存目录 + 各自 supportedArchitectures）；返回该目标的 node_modules 路径。 */
export function materializeProdDeps(spec) {
  const { spawnSync } = require("node:child_process");
  const dir = join(STAGING_ROOT, spec.name);
  const modules = join(dir, "node_modules");
  fs.removeSync(dir);
  fs.ensureDirSync(dir);
  // 工位 = 交付面自带的两份（清单 + 它的锁文件）+ 按目标替换过平台块的 workspace yaml。
  fs.copySync(join(ROOT, "packaging", "package.json"), join(dir, "package.json"));
  fs.copySync(join(ROOT, "packaging", "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"));
  fs.writeFileSync(join(dir, "pnpm-workspace.yaml"), stagingWorkspaceYaml(spec), "utf8");
  console.log(`[pack] 物化 ${spec.name}（干净安装，隔离目录 _tmp/pkg-root/${spec.name}）...`);
  const res = spawnSync("pnpm", ["install", "--prod", "--frozen-lockfile"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) throw new Error(`生产依赖物化失败（${spec.name}，pnpm install --prod 退出码 ${res.status}）`);
  if (!fs.pathExistsSync(modules)) throw new Error(`生产依赖物化失败（${spec.name}）：node_modules 未生成`);
  const missing = spec.assets.filter((a) => !fs.pathExistsSync(join(modules, a, "package.json")));
  if (missing.length) {
    throw new Error(`${spec.name} 缺少平台资产（该平台的包会跑不起来）：\n  - ${missing.join("\n  - ")}`);
  }
  console.log(`[pack] ${spec.name} 物化完成（平台资产 ${spec.assets.length} 项齐备，集成目标 ${assertIntegrationTargets(modules, join(ROOT, "src-integrations"))} 项）`);
  const pruned = pruneNodeModules(modules, spec);
  if (pruned.files > 0) {
    console.log(
      `[pack] ${spec.name} 源码层精简：删 ${pruned.files} 项（释放未压缩 ${(pruned.bytes / 1e6).toFixed(1)} MB）`,
    );
  }
  return modules;
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
function pruneNodeModules(modules, spec) {
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
