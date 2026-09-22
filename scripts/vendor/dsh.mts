// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/vendor/dsh.mts — 让 vendor/deepseek-harness 站在 packaging/package.json 声明版本对应的 dsh tag 上。
//
// 为什么 gitlink 与工作树 HEAD 都要对：build 的上游源走 `git show <tag>`（tag），类型解析
// （mirrorPathEntries）走**工作树**。只对一条，就会重现「同一份上游被读成两个版本」那类
// 假阳性（曾报出 usePanelInfo / MainPanelId 一族）。
//
// 两个入口共用本实现：derive 的 vendor 任务（derive --check 门禁的一部分）与
// `pnpm run sync:vendor:dsh`。这里只导出「检查」与「修复」，调度、日志前缀与退出码归各自入口。
//
// repair 会 `checkout` 并 `git add`（后者把 gitlink 更新进 index），改的是仓库状态，所以只在
// apply 且确有差异时跑，--check 绝不碰。
//
// 用法：
//   pnpm run sync:vendor:dsh                  # 本脚本（sync:vendor 聚合入口会带上它）
//   node scripts/vendor/dsh.mts          # 同步
//   node scripts/vendor/dsh.mts --check  # 只校验，漂移则 exit 1
import { execSync } from "node:child_process";

import { ROOT } from "../shared/root.mts";
import { isDirectRun } from "../shared/run.mts";
import { dshPin } from "../shared/version.mts";

/** 一句话说明源 → 目标（derive 任务与 CLI 共用）。 */
export const ABOUT = "packaging/package.json#dependencies[@deepseek-ai/dsh] → vendor/deepseek-harness 的 checkout";

/** 读一条 git 输出（trim；失败返回 null）。 */
function gitOut(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "（无）");

/** 交付面声明的 dsh 版本对应的 tag 名（未声明则 null）。 */
function tagOf(): string | null {
  const dep = dshPin();
  return dep ? "dsh-v" + dep : null;
}

/** 只读检查：返回差异描述（空数组 = 一致）。 */
export function inspect(): string[] {
  const tag = tagOf();
  if (!tag) return ["packaging/package.json 未声明 dependencies['@deepseek-ai/dsh']"];
  // 用 refs/tags/ 全名：避免与同名分支歧义，也绕开 `^` 在 cmd 下是转义符的坑。
  const tagSha = gitOut(`git -C vendor/deepseek-harness rev-parse --verify --quiet refs/tags/${tag}`);
  if (!tagSha) return [`vendor/deepseek-harness 无 ${tag}（镜像未 fetch 到该 tag？）`];
  const out: string[] = [];
  // gitlink：父仓库 tree 记录的 submodule commit（.gitmodules 是配置，这个是"版本"）
  const linkLine = gitOut("git ls-tree HEAD -- vendor/deepseek-harness");
  const linkSha = linkLine ? linkLine.split(/\s+/)[2] : null;
  if (linkSha !== tagSha) out.push(`gitlink ${short(linkSha)} ≠ ${tag}（${short(tagSha)}）`);
  const headSha = gitOut("git -C vendor/deepseek-harness rev-parse HEAD");
  if (headSha !== tagSha) out.push(`工作树 HEAD ${short(headSha)} ≠ ${tag}（${short(tagSha)}）`);
  return out;
}

/** 修复：checkout 到 tag，并把 gitlink 更新进 index。 */
export function repair(): void {
  const tag = tagOf();
  if (!tag) throw new Error("packaging/package.json 未声明 dependencies['@deepseek-ai/dsh']");
  console.log(`[sync-vendor-dsh] git -C vendor/deepseek-harness checkout ${tag}`);
  execSync(`git -C vendor/deepseek-harness checkout ${tag}`, { cwd: ROOT, stdio: "inherit" });
  execSync("git add vendor/deepseek-harness", { cwd: ROOT, stdio: "inherit" });
  console.log("[sync-vendor-dsh] gitlink 已暂存——随下次 commit 带上（别让它悬着）");
}

/** derive 的 vendor 任务（形状与 derive 的 StateTask 一致，由 derive 侧标注类型）。 */
export const dshTask = { kind: "state" as const, name: "vendor", about: ABOUT, inspect, repair };

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const diff = inspect();
  if (!diff.length) {
    console.log(`[sync-vendor-dsh] 一致（${ABOUT}）`);
    return;
  }
  for (const d of diff) console.log(`[sync-vendor-dsh] ${d}`);
  if (checkOnly) {
    console.error(`[sync-vendor-dsh] 漂移 ${diff.length} 处——跑 node scripts/vendor/dsh.mts 修复`);
    process.exit(1);
  }
  repair();
  console.log("[sync-vendor-dsh] 已修复");
}

if (isDirectRun(import.meta.url)) main();
