// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/materialize.mts — 生产依赖物化（**一个节点、一次安装**）与源码层精简。
//
// **源**：T1 编出的包集（.cache/dsh-build/<key>/dist-npm 的 tarball），**准**：同一条目里的清单
// （dsh-package-set.json）。工位由清单派生（见 install-source.mts）：
//
//   <dir>/package.json          根 = @deepseek-ai/dsh（A 口径，spec §6.4.2）
//   <dir>/packages/*.tgz        包集 tarball（清单逐个校过 sha512 再拷）
//   <dir>/pnpm-workspace.yaml   overrides: 每个 @deepseek-ai/* 包名 -> file:./packages/<file>
//                               + **全叉乘** supportedArchitectures
//   <dir>/pnpm-lock.yaml        由 derive 的 package-lock 任务派生（file: 条目自带 integrity）
//
// **一个节点，键不含 target**：装一次全叉乘的超集，各目标只从它上面剪枝（pruneNodeModules）。
// 为什么这样对：交付锁是按全叉乘 workspace 派生的（derive/package-lock.mts），所以只有
// 「全叉乘 workspace + 这份锁」才是那份 frozen 安装的原配；逐目标装等于拿一份锁去解五个不同的图。
// 分平台的重复工作因此收在这一个节点里做完，各目标只剩剪枝 + 组装 + 压缩。
//
// 外部三方依赖（koffi / node-pty / @img/sharp / @octokit …）仍从 registry 取：包集只覆盖
// @deepseek-ai/* 那 318 个自己编的包，三方闭包从来不在我们的构建产物里。
//
// hoisted 布局：顶层真实目录、无软链接——软链进 zip 跨机解压即断。
// 隔离的理由：不触碰仓库 node_modules（dev+prod 混合树，且动它会触发 pnpm 重建——Windows 上
// 曾遇清理被拒导致树损坏）。
import { createHash } from "node:crypto";
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../../shared/root.mts";
import { packageSetRel, readPackageSet } from "../package-set.mts";
import { assertLockfilesUnchanged, assertLockfilePnpmSection, assertLockfileVersion, lockfileSnapshot, readPnpmDeclaration, runDeliveryPnpm } from "../pnpm.mts";
import { currentBuildIdentity } from "../../vendor/build.mts";
import { shipLockRel } from "../../derive/package-lock.mts";
import { assertIntegrationTargets } from "./assert.mts";
import { prepareInstallSource, verifyLockfileIntegrity, verifyMaterializedModules } from "./install-source.mts";
import { stagingWorkspaceYaml, UNIVERSAL_SPEC } from "./targets.mts";

/**
 * 依赖物化节点（缓存区）。住 `.cache` 而不是 `.tmp`：这是**可复用、可校验**的中间产物
 * （判据见 DESIGN.md 的口径）——装一次全叉乘超集约等于一次完整 install，出包矩阵里每个目标都跑
 * 一遍纯属重复。正确性由节点里的 recipe 守着（见 materializeNodeKey）。
 */
export const MATERIALIZE_ROOT = join(ROOT, ".cache", "pkg-root");

/**
 * 物化配方版本：改动物化步骤/布局口径就 +1，历史节点随即失效。
 *
 * 为什么要有它（而不是只靠包集键）：节点里的树是**装出来的**，正确性依赖安装输入（清单/锁/
 * workspace 模板）与安装方式（pnpm、nodeLinker）。这些任一变了，超集树就该重装；只盯包集键会
 * 安静地复用一棵"输入已经换过"的树。
 */
export const MATERIALIZE_RECIPE_VERSION = "1";

/** 物化节点的 recipe 文件名（判命中与校验用）。 */
const NODE_RECIPE = "pkg-root-recipe.json";

/**
 * 物化节点的键：**不含 target**（这正是"一个节点"的含义），含所有决定结果的输入。
 *
 * 七项：包集键 + 清单的包摘要 + 交付锁内容 + node + pnpm + 物化配方版本 + workspace 模板。
 * 为什么不直接复用包集键：包集键只描述 tarball 那批字节，而这棵树还依赖「用哪份清单、哪份锁、
 * 哪个 node/pnpm、哪种 workspace 模板」——任一不同的树都不该被当成同一棵。
 *
 * @param set - 落盘清单。
 * @param lockText - 交付锁内容。
 * @returns 16 位十六进制键。
 */
export function materializeNodeKey(set, lockText: string): string {
  const identity = currentBuildIdentity();
  const material = [
    set.build.cacheKey,
    JSON.stringify(set.packages.map((p) => [p.name, p.version, p.file, p.integrity])),
    lockText,
    identity.node,
    identity.pnpm,
    MATERIALIZE_RECIPE_VERSION,
    stagingWorkspaceYaml(UNIVERSAL_SPEC),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** 读节点 recipe；读不到或形状不对返回 null（当成未命中）。 */
function readNodeRecipe(dir: string): Record<string, unknown> | null {
  const p = join(dir, NODE_RECIPE);
  if (!fs.pathExistsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 准备物化节点的安装输入（一次，与目标无关）。
 *
 * 三道校都在装之前：锁文件的本地 tarball integrity 对清单、锁格式与 pnpm 声明相符——这份锁若不合
 * 声明，就不该拿它装出任何交付树。
 *
 * @returns 清单、锁内容与其完整性校验数。
 */
function prepareNodeInput() {
  const key = currentBuildIdentity().key;
  const set = readPackageSet(key);
  if (set === null) {
    throw new Error("找不到 " + packageSetRel(key) + "：先跑 node scripts/derive/index.mts package-set");
  }
  const lockFrom = join(ROOT, shipLockRel(key));
  if (!fs.pathExistsSync(lockFrom)) {
    throw new Error("交付锁缺失：" + shipLockRel(key) + "（跑 node scripts/derive/index.mts package-lock 派生）");
  }
  const lockText = fs.readFileSync(lockFrom, "utf8");
  const lockChecked = verifyLockfileIntegrity(lockText, set);
  const lockDecl = readPnpmDeclaration();
  const label = shipLockRel(key);
  assertLockfileVersion(lockText, lockDecl, label);
  assertLockfilePnpmSection(lockText, lockDecl, label);
  return { set, lockText, lockChecked, lockFrom, label };
}

/**
 * 物化**一个**节点：全叉乘 workspace 的一次干净安装，各目标共用。
 *
 * 命中即复用（键见 materializeNodeKey），未命中才真装。命中判定要求 node_modules 在位**且**
 * recipe 的键与现算相符——只看目录在不在，会把一棵"输入已经换过"的旧树当成命中。
 *
 * @returns 节点的 node_modules 路径与其是否复用。
 */
export function materializeNode() {
  const { set, lockText, lockChecked, lockFrom, label } = prepareNodeInput();
  const key = materializeNodeKey(set, lockText);
  const dir = join(MATERIALIZE_ROOT, key);
  const modules = join(dir, "node_modules");
  const recipe = readNodeRecipe(dir);
  if (recipe !== null && recipe.key === key && fs.pathExistsSync(modules)) {
    console.log("[pack] 物化节点命中缓存 .cache/pkg-root/" + key + "（键不含 target：全叉乘超集，各目标剪枝）");
    return { modules, dir, key, set, reused: true };
  }
  // 未命中：清掉这个键下的残树（可能是半成品）再搭工位。
  fs.removeSync(dir);
  const { packages } = prepareInstallSource(dir, set, stagingWorkspaceYaml(UNIVERSAL_SPEC));
  fs.copySync(lockFrom, join(dir, "pnpm-lock.yaml"));
  console.log(
    "[pack] 物化节点 " + key + "：源 = 包集清单 " + packages + " 个 tarball（" + label + " 本地 tarball " + lockChecked +
      " 个 integrity 与清单一致），全叉乘 workspace，隔离目录 .cache/pkg-root/" + key + " ...",
  );
  // 交付链 pnpm：版本由本仓 packageManager 声明决定（见 scripts/release/pnpm.mts）。裸名 + shell 是
  // **故意**的——那正是「声明决定版本」那条机制；版本已在 index.mts 开工前断言过，这里再断言一次
  // 实际收尾行，防中途被换。
  const decl = readPnpmDeclaration();
  const locksBefore = lockfileSnapshot();
  const res = runDeliveryPnpm(["install", "--prod", "--frozen-lockfile"], {
    projectDir: dir,
    label: "materialize-node",
    decl,
    log: () => {},
  });
  assertLockfilesUnchanged(locksBefore, "物化节点 " + key, ROOT);
  console.log("[pack] 物化节点用 pnpm " + res.reportedVersion + "（= 声明 " + decl.version + "）");
  if (!fs.pathExistsSync(modules)) throw new Error("生产依赖物化失败（节点 " + key + "）：node_modules 未生成");
  // 物化**后**的校：装出来的 @deepseek-ai/* 版本必须与清单一致（override 漏了就会从 registry
  // 取同版成品，树看起来齐但源已经不是我们的包集了）。
  const checked = verifyMaterializedModules(modules, set);
  console.log("[pack] 物化节点物化后校验：清单内 @deepseek-ai/* " + checked + " 个版本一致");
  const targets = assertIntegrationTargets(modules, join(ROOT, "src-integrations"));
  // recipe 最后写：它是"这棵树装成了"的凭据，中途失败就不该留下可命中的痕迹。
  fs.writeFileSync(
    join(dir, NODE_RECIPE),
    JSON.stringify(
      {
        key,
        recipeVersion: MATERIALIZE_RECIPE_VERSION,
        packageSetKey: set.build.cacheKey,
        lockFile: label,
        profile: UNIVERSAL_SPEC.name,
        os: UNIVERSAL_SPEC.os,
        cpu: UNIVERSAL_SPEC.cpu,
        packages: set.packages.length,
        integrationTargets: targets,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log("[pack] 物化节点完成（集成目标 " + targets + " 项齐备），recipe 已写 .cache/pkg-root/" + key);
  return { modules, dir, key, set, reused: false };
}

/**
 * 逐目标从物化节点剪枝得到该目标的依赖树。
 *
 * 为什么剪枝而不是复制：pruneNodeModules 就是"删掉非本平台的预编译产物与四类无运行期入口的
 * 扩展名"，它**只删不动**——所以先整棵复制一份到组装台、再就地对组装台剪，节点本身保持完整，
 * 下一个目标照旧从同一棵超集剪。这与旧实现（逐目标各装一次）给出的结果一致，只是把安装那半
 * 收成了一个节点。
 *
 * @param spec - 目标描述（os/cpu/libc/assets）。
 * @param intoDir - 组装台（该目标的包目录）。
 * @returns 剪枝统计。
 */
export function materializeProdDeps(spec, intoDir) {
  const node = materializeNode();
  const modules = join(intoDir, "node_modules");
  fs.copySync(node.modules, modules);
  const missing = spec.assets.filter((a) => !fs.pathExistsSync(join(modules, a, "package.json")));
  if (missing.length) {
    throw new Error(spec.name + " 缺少平台资产（该平台的包会跑不起来）：\n  - " + missing.join("\n  - "));
  }
  const pruned = pruneNodeModules(modules, spec);
  if (pruned.files > 0) {
    console.log(
      "[pack] " + spec.name + " 源码层精简：删 " + pruned.files + " 项（释放未压缩 " + (pruned.bytes / 1e6).toFixed(1) + " MB）",
    );
  }
  return modules;
}

/**
 * 源码层精简：只删三类“没有运行期入口”的东西，其余一律留着。
 *   1. 非本平台的预编译产物（带平台名的目录、包名以平台二元组结尾的**独立包**、以及
 *      prebuilds/bin/third_party 下的平台子目录）；这是体积的大头，也是唯一需要“选择”的一步。
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
  // 跨平台物化之后，别的平台的东西还会以**独立包**的形式留在树里：@img/sharp-darwin-arm64、
  // @rollup/rollup-win32-x64-msvc、@deepseek-ai/node-addon-system-linux-arm64、@esbuild/win32-x64。
  // 包名以平台二元组结尾，只认平台**目录名**的规则看不见它们，于是整包（含全部平台的二进制）
  // 一起出货——实测把 zip 从 126 MB 顶到 480 MB，并撞上宿主 512 MiB 的解包上限。
  // 匹配 `-<os>-<cpu>` 结尾（包里也可能出现裸的 `<os>-<cpu>` 目录，一并覆盖）；平台中立的件
  // （*-wasm 之类）不匹配这个形状，照旧留下。
  const PLATFORM_PACKAGE = /(?:^|-)(win32|win10|darwin|linux|linuxmusl)-(x64|arm64|arm|ia32|riscv64)(?:-[a-z0-9.]+)?$/i;

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
        const platPkg = PLATFORM_PACKAGE.exec(e.name);
        if (platPkg !== null && !plat.has(normalizePlat(platPkg[1] + "-" + platPkg[2]))) {
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
