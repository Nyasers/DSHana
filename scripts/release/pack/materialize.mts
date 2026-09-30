// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/materialize.mts — 生产依赖物化（逐目标干净安装）与源码层精简。
//
// **源**：T1 编出的包集（.cache/dsh-build/<key>/dist-npm 的 tarball），**准**：T2 的清单
// （packaging/dsh-package-set.json）。工位不再是「交付面自带的三件 → 从 registry 装
// @deepseek-ai/dsh 成品包」，而是由清单派生（见 install-source.mts）：
//
//   <dir>/package.json          根 = @deepseek-ai/dsh（A 口径，spec §6.4.2）
//   <dir>/packages/*.tgz        包集 tarball（清单逐个校过 sha512 再拷）
//   <dir>/pnpm-workspace.yaml   overrides: 每个 @deepseek-ai/* 包名 -> file:./packages/<file>
//                               + 按目标的 supportedArchitectures
//   <dir>/pnpm-lock.yaml        由 derive 的 package-lock 任务派生（file: 条目自带 integrity）
//
// 外部三方依赖（koffi / node-pty / @img/sharp / @octokit …）仍从 registry 取：包集只覆盖
// @deepseek-ai/* 那 318 个自己编的包，三方闭包从来不在我们的构建产物里。
//
// hoisted 布局：顶层真实目录、无软链接——软链进 zip 跨机解压即断。
// 隔离的理由：不触碰仓库 node_modules（dev+prod 混合树，且动它会触发 pnpm 重建——Windows 上
// 曾遇清理被拒导致树损坏）。
import { createRequire } from "node:module";
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../../shared/root.mts";
import { readPackageSet } from "../package-set.mts";
import { assertIntegrationTargets } from "./assert.mts";
import { prepareInstallSource, verifyLockfileIntegrity, verifyMaterializedModules } from "./install-source.mts";
import { stagingWorkspaceYaml } from "./targets.mts";

const require = createRequire(import.meta.url);

/** 依赖物化工位根（起手清残留、用完即清）。 */
export const STAGING_ROOT = join(ROOT, ".tmp", "pkg-root");

/**
 * 逐目标干净安装（各自暂存目录 + 各自 supportedArchitectures）。
 *
 * 安装输入由包集清单派生（不再复制交付面清单与它的锁文件）：先把工位搭出来（拷 tarball +
 * 写派生 manifest/overrides），再用**提交在册**的派生锁文件做 frozen 安装；装完按清单校版本。
 *
 * @param spec - 目标描述（os/cpu/libc/assets）。
 * @returns 该目标的 node_modules 路径。
 */
export function materializeProdDeps(spec) {
  const { spawnSync } = require("node:child_process");
  const set = readPackageSet();
  if (set === null) {
    throw new Error("找不到 packaging/dsh-package-set.json：先跑 node scripts/derive/index.mts package-set");
  }
  const dir = join(STAGING_ROOT, spec.name);
  const modules = join(dir, "node_modules");
  // 工位 = 清单派生的安装输入（tarball 已逐个校过 sha512）。
  const { packages } = prepareInstallSource(dir, set, stagingWorkspaceYaml(spec));
  // 锁文件由 derive 派生并提交（file: 条目带 integrity）；工位只消费，不重解析。
  const lockFrom = join(ROOT, "packaging", "pnpm-lock.yaml");
  if (!fs.pathExistsSync(lockFrom)) {
    throw new Error("交付面锁文件缺失：packaging/pnpm-lock.yaml（跑 node scripts/derive/index.mts package-lock 派生）");
  }
  fs.copySync(lockFrom, join(dir, "pnpm-lock.yaml"));
  // 物化前的第二道 sha512 校：锁文件里 pnpm 自己记的本地 tarball integrity 与清单对拍。
  // 第一道（verifyTarballs）证「拷进来的字节 == 清单」；这道证「pnpm 要装的那份 == 清单」。
  const lockChecked = verifyLockfileIntegrity(fs.readFileSync(lockFrom, "utf8"), set);
  console.log("[pack] " + spec.name + " 锁文件完整性：本地 tarball " + lockChecked + " 个 integrity 与清单一致");
  console.log(
    "[pack] 物化 " + spec.name + "（源 = 包集清单 " + packages + " 个 tarball，隔离目录 .tmp/pkg-root/" + spec.name + "）...",
  );
  const res = spawnSync("pnpm", ["install", "--prod", "--frozen-lockfile"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) throw new Error("生产依赖物化失败（" + spec.name + "，pnpm install --prod 退出码 " + res.status + "）");
  if (!fs.pathExistsSync(modules)) throw new Error("生产依赖物化失败（" + spec.name + "）：node_modules 未生成");
  // 物化**后**的校：装出来的 @deepseek-ai/* 版本必须与清单一致（override 漏了就会从 registry
  // 取同版成品，树看起来齐但源已经不是我们的包集了）。
  const checked = verifyMaterializedModules(modules, set);
  console.log("[pack] " + spec.name + " 物化后校验：清单内 @deepseek-ai/* " + checked + " 个版本一致");
  const missing = spec.assets.filter((a) => !fs.pathExistsSync(join(modules, a, "package.json")));
  if (missing.length) {
    throw new Error(spec.name + " 缺少平台资产（该平台的包会跑不起来）：\n  - " + missing.join("\n  - "));
  }
  console.log("[pack] " + spec.name + " 物化完成（平台资产 " + spec.assets.length + " 项齐备，集成目标 " + assertIntegrationTargets(modules, join(ROOT, "src-integrations")) + " 项）");
  const pruned = pruneNodeModules(modules, spec);
  if (pruned.files > 0) {
    console.log(
      "[pack] " + spec.name + " 源码层精简：删 " + pruned.files + " 项（释放未压缩 " + (pruned.bytes / 1e6).toFixed(1) + " MB）",
    );
  }
  return modules;
}

/**
 * 源码层精简：只删两类“没有运行期入口”的东西，其余一律留着。
 *   1. 非本平台的预编译产物（按目标平台筛：带平台名的目录 + prebuilds/bin/third_party 下的平台子目录）；
 *      这是体积的大头，也是唯一需要“选择”的一步。
 *   2. 四类扩展名：.pdb（调试符号）、.map（源码映射）、.d.ts/.d.mts/.d.cts（类型声明）、
 *      .md/.markdown（纯文档）——JS 不会 require 它们。
 *
 * 刻意**不**按目录名删东西（docs/tests/examples/fixtures 之类）：目录名不等于内容，
 * 包在那种目录里放运行期代码并不稀奇，而按名字猜的代价是装包后起不来。
 *
 * 返回 { files, bytes }；失败一律不阻断打包（删不掉就留着）。
 */
function pruneNodeModules(modules, spec) {
  const plat = new Set();
  for (const os of spec.os) for (const cpu of spec.cpu) plat.add(os + "-" + cpu);
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
