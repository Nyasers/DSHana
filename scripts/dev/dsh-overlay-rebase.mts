// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/dev/dsh-overlay-rebase.mts — 把 integrations 的整文件 overlay 迁到新的上游 tag 上。
//
// overlay 是「上游某版该文件 + 我们的 delta」的整文件拷贝，升级内核时上游一变，清单里的
// upstreamSha256 立刻对不上。重放的语义是标准三方合并：
//   base  = 旧 tag 的上游文件
//   ours  = 当前 overlay（旧上游 + 我们的 delta）
//   their = 新 tag 的上游文件
// 合并干净时，我们的 delta 内容不变，于是 deltaSha256 天然对上（它只由 +/- 行内容算、不含行号），
// 只需把 upstreamSha256 换成新上游的哈希。这一步不需要人来判断，脚本代劳。
//
// 冲突的份数不猜：原样保留 overlay、把冲突记进报告，留给人看。真正要判断的是「上游这段改成了
// 什么、我们当初为什么这么改」，合并算法给不出这个答案。
//
// 用法：
//   node scripts/dev/dsh-overlay-rebase.mts --to 0.2.2-rc.2 --dry   # 只报结论，不写回
//   node scripts/dev/dsh-overlay-rebase.mts --to 0.2.2-rc.2         # 写回干净的那批
//
// 退出码：0 全部干净或没有需要重放的项；1 有冲突项（已写回干净的，冲突待处理）；2 出错。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deltaOf } from "../integrations/delta.mts";
import { sha256, tagForVersion } from "../integrations/verify.mts";
import { ROOT } from "../shared/root.mts";
import { isDirectRun } from "../shared/run.mts";
import { dshPin } from "../shared/version.mts";

const MIRROR = join(ROOT, "vendor", "deepseek-harness");
const INTEGRATIONS = join(ROOT, "integrations");

/** 从镜像读某个 tag 下的文件；不存在返回 null。 */
function readUpstream(tag: string, repoRel: string): string | null {
  try {
    return execFileSync("git", ["-C", MIRROR, "show", `${tag}:${repoRel}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * 三方合并。有冲突时 git 的退出码是冲突数（不是错误），stdout 里是带冲突标记的合并结果。
 * 用 --diff3 让冲突段落里同时出现 base 一侧，人接手时能直接看出上游改了什么。
 */
function mergeThreeWay(ours: string, base: string, theirs: string): { text: string; conflicts: number } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-overlay-rebase-"));
  try {
    const cur = join(dir, "current");
    const bas = join(dir, "base");
    const oth = join(dir, "other");
    writeFileSync(cur, ours, "utf8");
    writeFileSync(bas, base, "utf8");
    writeFileSync(oth, theirs, "utf8");
    try {
      const out = execFileSync("git", ["merge-file", "-p", "--diff3", cur, bas, oth], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return { text: out, conflicts: 0 };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { text: String(err.stdout ?? ""), conflicts: Number(err.status) || 1 };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Outcome {
  integration: string;
  path: string;
  state: "untouched" | "rebased" | "conflict" | "missing";
  conflicts: number;
  detail: string;
}

/** 把一份 integration.json 里某个文件的哈希改写回清单。 */
function writeManifest(manifestPath: string, manifest: any, filePath: string, upstreamSha: string, deltaSha: string): void {
  const entry = (manifest.files ?? []).find((f: any) => f?.path === filePath);
  if (!entry) return;
  entry.upstreamSha256 = upstreamSha;
  entry.deltaSha256 = deltaSha;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function rebaseAll(to: string, dry: boolean): Outcome[] {
  const from = dshPin();
  if (!from) throw new Error("packages/host/package.json 未声明 dependencies['@deepseek-ai/dsh']");
  const oldTag = tagForVersion(from);
  const newTag = tagForVersion(to);
  const outcomes: Outcome[] = [];

  for (const ent of readdirSync(INTEGRATIONS, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifestPath = join(INTEGRATIONS, ent.name, "integration.json");
    let manifest: any;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue; // 没有清单的目录（如 tsconfig.paths.json 所在层）不是集成
    }
    for (const f of manifest.files ?? []) {
      const rel = String(f?.path ?? "");
      if (!rel) continue;
      const upstreamRel = `${manifest.upstreamDir}/${rel}`;
      const overlayPath = join(INTEGRATIONS, ent.name, "files", rel);

      let ours: string;
      try {
        ours = readFileSync(overlayPath, "utf8");
      } catch {
        outcomes.push({ integration: ent.name, path: rel, state: "missing", conflicts: 0, detail: "读不到 overlay" });
        continue;
      }
      const base = readUpstream(oldTag, upstreamRel);
      const theirs = readUpstream(newTag, upstreamRel);
      if (base === null || theirs === null) {
        outcomes.push({
          integration: ent.name,
          path: rel,
          state: "missing",
          conflicts: 0,
          detail: `上游缺文件（${base === null ? oldTag : newTag}）`,
        });
        continue;
      }
      if (base === theirs) {
        outcomes.push({ integration: ent.name, path: rel, state: "untouched", conflicts: 0, detail: "上游未变" });
        continue;
      }

      const merge = mergeThreeWay(ours, base, theirs);
      if (merge.conflicts > 0) {
        outcomes.push({
          integration: ent.name,
          path: rel,
          state: "conflict",
          conflicts: merge.conflicts,
          detail: `${merge.conflicts} 处冲突，未写回`,
        });
        continue;
      }
      const upstreamSha = sha256(theirs);
      const deltaSha = deltaOf(theirs, merge.text).sha256;
      if (!dry) {
        writeFileSync(overlayPath, merge.text, "utf8");
        writeManifest(manifestPath, manifest, rel, upstreamSha, deltaSha);
      }
      outcomes.push({
        integration: ent.name,
        path: rel,
        state: "rebased",
        conflicts: 0,
        detail: `upstreamSha256 → ${upstreamSha.slice(0, 12)}…`,
      });
    }
  }
  return outcomes;
}

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--to");
  const to = at >= 0 ? argv[at + 1] : null;
  const dry = argv.includes("--dry");
  if (!to || to.startsWith("--")) {
    console.error("[overlay-rebase] 缺 --to <目标版本>（例：--to 0.2.2-rc.2）");
    process.exit(2);
  }
  const from = dshPin();
  console.log(`[overlay-rebase] ${from} → ${to}${dry ? "（--dry，不写回）" : ""}`);

  const outcomes = rebaseAll(to, dry);
  const by = (s: Outcome["state"]) => outcomes.filter((o) => o.state === s);
  const rebased = by("rebased");
  const conflicts = by("conflict");
  const untouched = by("untouched");
  const missing = by("missing");

  console.log(`[overlay-rebase] 共 ${outcomes.length} 份 overlay：上游变了 ${rebased.length + conflicts.length} 份`);
  if (rebased.length) {
    console.log(`\n[dsh] 干净重放 ${rebased.length} 份${dry ? "（未写回）" : "（已写回）"}：`);
    for (const o of rebased) console.log(`  ${o.integration} :: ${o.path}`);
  }
  if (conflicts.length) {
    console.log(`\n[dsh] 冲突 ${conflicts.length} 份，需要人看：`);
    for (const o of conflicts) console.log(`  ${o.integration} :: ${o.path} —— ${o.detail}`);
  }
  if (missing.length) {
    console.log(`\n[dsh] 异常 ${missing.length} 份：`);
    for (const o of missing) console.log(`  ${o.integration} :: ${o.path} —— ${o.detail}`);
  }
  console.log(`\n[overlay-rebase] 上游未变 ${untouched.length} 份。`);
  if (conflicts.length > 0 || missing.length > 0) {
    console.log("[overlay-rebase] 冲突项需要按 --diff3 标记判断上游改动与我们的意图，重放后记得跑 verify:integrations。");
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[overlay-rebase] ${(e as Error).message}`);
    process.exit(2);
  }
}
