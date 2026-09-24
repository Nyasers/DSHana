// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/package-lock.mts — 交付面锁文件（packaging/pnpm-lock.yaml）的派生。
//
// 交付面清单（packaging/package.json）的运行时依赖要有自己的锁文件：出包时工位就是一个独立
// 项目（`packaging/` 的清单 + 它的锁文件 + 按目标生成的 workspace yaml），`pnpm install --prod`
// 只装交付面的生产闭包——不需要把仓库根那份清单（构建面，带 devDependencies）搬进工位。
//
// 派生规则：以**仓库锁文件**为种子，把 `packaging/package.json` 当唯一 manifest 重解析。
// 种子这一步很关键：从零解析会按 range 取最新，把传递版本顶新（实测 koffi 3.3.0 → 3.3.1、
// rspack binding 2.2.5 → 2.2.6）；用仓库锁文件当种子，pnpm 复用已有解析，只剪掉交付面到不了的
// 分支（devDependencies 那一片），版本一个不动。
//
// 状态型任务（不是文件型）：产物由 pnpm 跑出来，不是我们算出来的。inspect 只读（拿已提交的
// 锁文件跑 frozen 探针，不动任何东西），repair 才在工位里重生成并写回。
import { spawnSync } from "node:child_process";
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../shared/root.mts";

/** 锁文件相对仓库根的路径（交付面清单的同层）。 */
export const SHIP_LOCK_REL = "packaging/pnpm-lock.yaml";
/** 派生工位（.tmp 下，跑完即清；与 pack 的 pkg-root 分开，互不干扰）。 */
const WORK_DIR = join(ROOT, ".tmp", "pkg-lock");

/** 一句话说明源 → 目标（日志与 --check 报告用）。 */
export const ABOUT = "packaging/package.json + 仓库锁文件的解析 → packaging/pnpm-lock.yaml";

/** 在工位里跑一次 pnpm（返回退出码；输出直通）。inspect 用 frozen，repair 不用。
 *   cwd 留在仓库根、用 `--dir` 指工位：corepack 因此读到根 `package.json#packageManager` 钉的
 *   pnpm 版本（工位里那份清单会把向上查找截断，落回机器上的默认 pnpm，锁文件就会因机器而异）。 */
function pnpmInWorkDir(args: string[]) {
  const res = spawnSync("pnpm", ["--dir", WORK_DIR, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return res.status ?? 1;
}

/** 起一个干净的工位：manifest 与 workspace yaml 固定，锁文件由调用方选来源。 */
function prepareWorkDir({ lockFrom }: { lockFrom: string }) {
  fs.removeSync(WORK_DIR);
  fs.ensureDirSync(WORK_DIR);
  fs.copySync(join(ROOT, "packaging", "package.json"), join(WORK_DIR, "package.json"));
  fs.copySync(lockFrom, join(WORK_DIR, "pnpm-lock.yaml"));
  // workspace yaml 用**交付面**那份（packaging/pnpm-workspace.yaml）原样：交付面的解析要在与真出包
  // 同一套配置（allowBuilds / supportedArchitectures）下做，否则锁文件与工位对不上。
  fs.copySync(join(ROOT, "packaging", "pnpm-workspace.yaml"), join(WORK_DIR, "pnpm-workspace.yaml"));
}

/** 工位清理（幂等）。 */
function cleanWorkDir() {
  fs.removeSync(WORK_DIR);
}

/** 只读检查：拿**已提交的**交付面锁文件跑 frozen 探针，不一致就是漂移。 */
export function inspect(): string[] {
  const lockAbs = join(ROOT, SHIP_LOCK_REL);
  if (!fs.pathExistsSync(lockAbs)) {
    return [`${SHIP_LOCK_REL} 不存在（交付面清单有了依赖，锁文件还没派生）`];
  }
  try {
    prepareWorkDir({ lockFrom: lockAbs });
    const code = pnpmInWorkDir(["install", "--lockfile-only", "--frozen-lockfile"]);
    if (code !== 0) {
      return [`${SHIP_LOCK_REL} 与 packaging/package.json 不同步（pnpm install --frozen-lockfile 退出码 ${code}）——跑 node scripts/derive/index.mts package-lock 重生成`];
    }
    return [];
  } finally {
    cleanWorkDir();
  }
}

/** 修复：以仓库锁文件为种子在工位里重解析，把结果写回交付面锁文件。 */
export function repair(): void {
  try {
    prepareWorkDir({ lockFrom: join(ROOT, "pnpm-lock.yaml") });
    const code = pnpmInWorkDir(["install", "--lockfile-only"]);
    if (code !== 0) throw new Error(`工位重生成 ${SHIP_LOCK_REL} 失败（pnpm 退出码 ${code}）`);
    const produced = join(WORK_DIR, "pnpm-lock.yaml");
    if (!fs.pathExistsSync(produced)) throw new Error(`工位未产出锁文件：${produced}`);
    fs.copySync(produced, join(ROOT, SHIP_LOCK_REL));
    console.log(`[derive] ${SHIP_LOCK_REL} 已重生成（以仓库锁文件为种子）`);
  } finally {
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
