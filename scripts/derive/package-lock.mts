// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/package-lock.mts — 交付面锁文件的派生（与包集清单同层：T1 缓存条目里）。
//
// T3 换源后工位是「包集清单派生出来的安装输入」（见 scripts/release/pack/install-source.mts）：
// 根 = @deepseek-ai/dsh，每个 @deepseek-ai/* 包名 override 到 file:./packages/<file>。这份锁文件
// 就是把那个工位按 frozen 解析后的结果，供出包时直接消费——不重解析。
//
// B 节起它落进 `.cache/dsh-build/<键>/`（挨着 build-recipe.json / dist-npm / 清单）：这份锁只对
// 那个键对应的包集成立（file: 条目的 integrity 就是那批 tarball 的字节摘要），所以它**属于**那条
// 缓存条目，不该住仓库里靠"记得对上"来维持。
//
// **local tarball 派的 integrity 从哪来**（这刀的核心问题）：pnpm 自己算。它对 file: 依赖会在
// packages 段写下 resolution: {integrity: sha512-…, tarball: file:./packages/<file>}，那份 sha512
// 正是 tarball 的字节摘要。也就是说**锁文件里的 integrity 与 T2 清单里的 integrity 是同一种值**，
// 可以对拍（pack 的物化后校验就比版本；清单本身的 sha512 由 T2 的 verifyPackageSet 校）。
// 于是这条路不用我们手写哈希：改造（不是退役）。
//
// 派生规则：以仓库锁文件为种子，把「包集清单派生出来的工位 manifest」当唯一 manifest 重解析。
// 种子这一步很关键：从零解析会按 range 取最新（实测 koffi 3.3.0 → 3.3.1、rspack binding
// 2.2.5 → 2.2.6）；用仓库锁文件当种子，pnpm 复用已有解析，版本一个不动。
//
// 为什么把契约落在缓存条目里（而不是 .tmp 工位）：工位是临时的，但它的解析结果要**留得住**——
// 出包机不该在打包时解析依赖（会因 registry 状态漂移），而应消费一份审过的锁文件。
//
// 状态型任务（不是文件型）：产物由 pnpm 跑出来，不是我们算出来的。inspect 只读（拿已提交的
// 锁文件跑 frozen 探针，不动任何东西），repair 才在契约工位里重生成并写回。
import fs from "fs-extra";
import path, { join } from "node:path";

import { ROOT } from "../shared/root.mts";
import { packageSetRel, readPackageSet } from "../release/package-set.mts";
import { currentBuildIdentity } from "../vendor/build.mts";
import { assertLockfilesUnchanged, assertLockfilePnpmSection, assertLockfileVersion, lockfileSnapshot, readPnpmDeclaration, runDeliveryPnpm } from "../release/pnpm.mts";
import { PACKAGE_DIR, prepareInstallSource, verifyLockfileIntegrity } from "../release/pack/install-source.mts";
import { stagingWorkspaceYaml, UNIVERSAL_SPEC } from "../release/pack/targets.mts";

/** 锁文件在缓存条目里的文件名（与 build-recipe.json / dsh-package-set.json 同层）。 */
export const SHIP_LOCK_FILENAME = "pnpm-lock.yaml";
/** 派生工位（缓存区，跑完即清；与 pack 的物化节点分开，互不干扰）。 */
const WORK_DIR = join(ROOT, ".cache", "pkg-lock");

/** 锁文件相对仓库根的路径（缓存条目内；日志与报错用它）。 */
export function shipLockRel(key: string): string {
  return path.join(".cache", "dsh-build", key, SHIP_LOCK_FILENAME);
}

/** 一句话说明源 → 目标（日志与 --check 报告用）。 */
export const ABOUT = "包集清单派生出的工位（file: tarball）→ .cache/dsh-build/<键>/pnpm-lock.yaml";

/** 现算本机当前的 T1 缓存键（与清单读的是同一把，见 release/package-set.mts#readPackageSet）。 */
function currentCacheKey(): string {
  return currentBuildIdentity().key;
}

/**
 * 在工位里跑一次 pnpm（返回退出码与输出；实际版本由 runDeliveryPnpm 断言）。
 *
 * 目标用 `--dir` 钉在工位、cwd 留在仓根：pnpm 自带的版本管理因此读到**本仓** packageManager 声明
 * 的那一份（工位里那份清单会把向上查找截断，落回机器上的默认 pnpm，锁文件就会因机器而异）。
 * inspect 用 frozen、repair 不用；frozen 探针允许非零退出（调用方据退出码判漂移）。
 */
function pnpmInWorkDir(args: string[], label: string) {
  const res = runDeliveryPnpm(args, { projectDir: WORK_DIR, label, decl: readPnpmDeclaration(), allowFailure: true });
  const body = (res.stdout + res.stderr).trim();
  if (body !== "") console.log(body);
  return res.status;
}

/**
 * 起一个干净的工位：安装输入完全由包集清单派生（与出包时**同一条代码路径**），
 * 锁文件由调用方选来源。
 *
 * 与出包共用 prepareInstallSource 是有意的：派生锁文件的工位与真出包的工位一旦不同形，锁文件
 * 就对不上工位（frozen 安装会在出包时才炸）。
 *
 * @param lockFrom - 种子锁文件；null 表示重解析（repair 用仓库锁文件当种子）。
 * @param seedLock - 种子来源（仓库锁文件），lockFrom 为 null 时用。
 */
function prepareWorkDir({ lockFrom }: { lockFrom: string | null }) {
  const key = currentCacheKey();
  const set = readPackageSet(key);
  if (set === null) {
    throw new Error("找不到 " + packageSetRel(key) + "：先跑 node scripts/derive/index.mts package-set");
  }
  // 工位用全叉乘的平台块（锁要覆盖所有平台）；物化节点用**同一份**（那是这份 frozen 安装的原配）。
  prepareInstallSource(WORK_DIR, set, stagingWorkspaceYaml(UNIVERSAL_SPEC));
  fs.copySync(lockFrom ?? join(ROOT, "pnpm-lock.yaml"), join(WORK_DIR, "pnpm-lock.yaml"));
}

/** 工位清理（幂等）。 */
function cleanWorkDir() {
  fs.removeSync(WORK_DIR);
}

/**
 * 只读检查：拿**已提交的**锁文件跑 frozen 探针，不一致就是漂移。
 *
 * 两道，缺一不可：
 *   1. frozen 探针（pnpm）：证明这份锁文件仍满足工位 manifest（依赖图/平台块没变）。
 *   2. **本地 tarball integrity 对拍**（自己算）：证明锁文件记的字节就是**当前**包集的字节。
 *
 * 为什么第 2 道不能省（实测教训）：包集重编后文件名不变、spec 不变，只是 tarball 字节变了，
 * 而 `pnpm install --lockfile-only --frozen-lockfile` **不重新哈希本地 tarball**——第 1 道会照旧放行。
 * 漏掉第 2 道的后果在出包时才爆（pack 的 verifyLockfileIntegrity 拦下），报错点离成因很远。
 * 对拍用的是 pack 的同一份实现，口径不会分叉。
 */
export function inspect(): string[] {
  const key = currentCacheKey();
  const lockAbs = join(ROOT, shipLockRel(key));
  if (!fs.pathExistsSync(lockAbs)) {
    return [shipLockRel(key) + " 不存在（包集清单有了，锁文件还没派生）"];
  }
  const set = readPackageSet(key);
  if (set === null) {
    return ["找不到 " + packageSetRel(key) + "：先跑 node scripts/derive/index.mts package-set"];
  }
  // 第 2 道先做（纯读、不跑进程）：它拦的正是「包集重编了而锁文件没跟」这种静默漂移。
  try {
    verifyLockfileIntegrity(fs.readFileSync(lockAbs, "utf8"), set);
  } catch (error) {
    return [String(error instanceof Error ? error.message : error) + "——跑 node scripts/derive/index.mts package-lock 重生成"];
  }
  try {
    prepareWorkDir({ lockFrom: lockAbs });
    // 交叉校验两道（都纯读、都在跑 frozen 之前）：
    //   1. lockfileVersion 与声明版本的 pnpm 相符；
    //   2. packageManagerDependencies 指纹相符——**这道才是抓「声明降级、旧锁留下高版本半段」的**，
    //      frozen 探针看不见它（11.x 整个忽略该段，照旧放行）。
    try {
      const decl = readPnpmDeclaration();
      const label = shipLockRel(key);
      assertLockfileVersion(fs.readFileSync(lockAbs, "utf8"), decl, label);
      assertLockfilePnpmSection(fs.readFileSync(lockAbs, "utf8"), decl, label);
    } catch (error) {
      return [String(error instanceof Error ? error.message : error)];
    }
    const code = pnpmInWorkDir(["install", "--lockfile-only", "--frozen-lockfile"], "derive-lock-inspect");
    if (code !== 0) {
      return [shipLockRel(key) + " 与包集清单派生的工位不同步（pnpm install --frozen-lockfile 退出码 " + code + "）——跑 node scripts/derive/index.mts package-lock 重生成"];
    }
    return [];
  } finally {
    cleanWorkDir();
  }
}

/** 修复：以仓库锁文件为种子在工位里重解析，把结果写进 T1 缓存条目。 */
export function repair(): void {
  // 护栏：派生只许写缓存条目里那份。仓根 pnpm-lock.yaml 是构建链的输入，这里绝不许碰
  // （历史上隐式自换正是把它改掉的那个机制）。前后比一次，变了就拒。
  const key = currentCacheKey();
  const target = join(ROOT, shipLockRel(key));
  const locksBefore = lockfileSnapshot();
  try {
    prepareWorkDir({ lockFrom: null });
    const code = pnpmInWorkDir(["install", "--lockfile-only"], "derive-lock-repair");
    if (code !== 0) throw new Error("工位重生成 " + shipLockRel(key) + " 失败（pnpm 退出码 " + code + "）");
    const produced = join(WORK_DIR, "pnpm-lock.yaml");
    if (!fs.pathExistsSync(produced)) throw new Error("工位未产出锁文件：" + produced);
    // 写回前校验两道格式：产出的锁文件必须是声明版本那份形状（不随版本静默改格式，也不静默带/丢
    // packageManagerDependencies 段）。这一道防的是「新派生的锁本身就不符合声明」。
    const decl = readPnpmDeclaration();
    const label = shipLockRel(key);
    assertLockfileVersion(fs.readFileSync(produced, "utf8"), decl, "工位产出的 " + label);
    assertLockfilePnpmSection(fs.readFileSync(produced, "utf8"), decl, "工位产出的 " + label);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copySync(produced, target);
    console.log("[derive] " + label + " 已重生成（以仓库锁文件为种子）");
  } finally {
    // 那份缓存里的锁本来就会被本函数写，故只对**仓根**那份执法。
    assertLockfilesUnchanged(locksBefore.filter((s) => s.rel === "pnpm-lock.yaml"), "derive package-lock", ROOT);
    cleanWorkDir();
  }
}

/** derive 任务（状态型：inspect 只读、repair 才动）。 */
export const packageLockTask = {
  kind: "state" as const,
  name: "package-lock",
  about: ABOUT,
  inspect,
  repair,
};

/** 工位里包集 tarball 的子目录名（供测试与文档引用，值由 install-source 定）。 */
export { PACKAGE_DIR };
