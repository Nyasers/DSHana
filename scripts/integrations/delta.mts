// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/delta.mts — 算一份 overlay 相对上游改了什么（口径交给 git，指纹自己算）。
//
// 为什么要有它：覆盖层是「上游该文件 + 我们的 delta」的**整文件拷贝**。两件事因此没人守：
//   ① review 分不清哪几行是我们写的、哪几行是上游原文（PR #300 四条评里三条在审上游代码）；
//   ② rebase 时把 delta 弄丢，现有哈希闸看不出来——它记的是**上游**的 sha256，只证明「贴的是
//      这一版上游」，不证明「delta 还在」。
//
// 口径：diff 本身**不自研**。行对齐有多条等长解（Myers / histogram / LCS 各自的 tie-break 都会
// 给出不同但同样正确的 hunk），自己实现一套就等于和 review 工具吵「哪几行算我们改的」。这里直接
// 跑 `git diff --no-index -U0` 并解析它的 +/- 行，与 GitHub / CodeRabbit 看到的是同一个口径。
//
// 为什么不把行区间写进 integration.json：行号每次随上游漂，手写就是第二事实源（与本仓
// integration.json 不得带 upstreamVersion / revision 是同一条纪律）。写进清单的是这个 diff 的
// 指纹 deltaSha256——只由「改动的行内容」算出、不含行号，rebase 时 delta 丢了就对不上。人读的
// 区间由 `integrations delta` 现场算，不落盘。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 一段连续改动（行号是 overlay 侧，1 起、闭区间）。 */
export interface DeltaHunk {
  /** overlay 文件里的起始行。 */
  readonly start: number;
  /** overlay 文件里的结束行（含）。 */
  readonly end: number;
}

export interface DeltaResult {
  /** 我们写进 overlay 的行区间（按行号升序）。 */
  readonly hunks: readonly DeltaHunk[];
  /** 我们新增/改写的行（overlay 侧 + 行）。 */
  readonly added: number;
  /** 上游有、我们删掉的行（- 行）。 */
  readonly removed: number;
  /** 这份 delta 的指纹（由 + / - 行的内容算出，不含行号）。 */
  readonly sha256: string;
}

/**
 * 跑这两个函数的容器：单测注入假实现，生产走真 git。返回 git diff 的 stdout。
 * @param upstream - 上游该版本文件内容。
 * @param overlay - 我们的整文件拷贝。
 * @param gitArgv - 供假实现判断是否按预期调用。
 */
export type DiffRunner = (upstream: string, overlay: string) => string;

/**
 * 默认 runner：两个临时文件 + `git diff --no-index -U0`。
 * `--no-index` 在「两边相同」时退出码是 0、有差异是 1，两者都不是错误。
 * @param upstream - 上游该版本文件内容。
 * @param overlay - 我们的整文件拷贝。
 * @returns unified diff 文本。
 */
export const gitDiffRunner: DiffRunner = (upstream, overlay) => {
  const dir = mkdtempSync(join(tmpdir(), "hana-delta-"));
  try {
    const a = join(dir, "upstream");
    const b = join(dir, "overlay");
    writeFileSync(a, upstream, "utf8");
    writeFileSync(b, overlay, "utf8");
    const r = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U0", "--", a, b],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    // 0 = 无差异，1 = 有差异；其余是真失败（git 不在、参数不认）。
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(`git diff 失败（status ${String(r.status)}）：${String(r.stderr || "").trim()}`);
    }
    return String(r.stdout || "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** 解析 `@@ -a,b +c,d @@` 里 overlay 侧（+）的起点与行数。 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * 从 unified diff 里取 overlay 侧的改动区间与 +/- 行内容。
 * 只看 `+` 侧：`-` 侧行号是上游坐标，对「我们这几行的 overlay 位置」没有意义。
 * @param diff - unified diff 文本。
 * @returns 区间（按出现顺序）与全部 + / - 行的内容。
 */
function parseDiff(diff: string): { hunks: DeltaHunk[]; plus: string[]; minus: string[] } {
  const hunks: DeltaHunk[] = [];
  const plus: string[] = [];
  const minus: string[] = [];
  for (const line of diff.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      // -U0 下 count 0 表示这段只有删除、overlay 侧没有行：不算我们的区间
      if (count > 0) hunks.push({ start, end: start + count - 1 });
      continue;
    }
    if (line.startsWith("+")) plus.push(line.slice(1));
    else if (line.startsWith("-")) minus.push(line.slice(1));
  }
  return { hunks, plus, minus };
}

/**
 * 算一份 overlay 相对上游的 delta。
 * @param upstream - 上游该版本文件内容。
 * @param overlay - 我们的整文件拷贝。
 * @param run - diff 实现（默认真 git；单测可注入）。
 * @returns 行区间、计数与指纹。
 */
export function deltaOf(upstream: string, overlay: string, run: DiffRunner = gitDiffRunner): DeltaResult {
  const { hunks, plus, minus } = parseDiff(run(upstream, overlay));
  // 指纹取内容不取行号：同一份 delta 在上游小改动后行号会漂，内容不变则指纹不变；
  // 而 delta 被冲掉、改错或顺手删掉，内容必变。
  const payload = JSON.stringify({ plus, minus });
  return {
    hunks,
    added: plus.length,
    removed: minus.length,
    sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}

/** 人读的一行摘要（`delta` 子命令与闸的报错共用）。 */
export function describeDelta(result: DeltaResult): string {
  if (result.hunks.length === 0 && result.removed === 0) return "无 delta（与上游逐字相同）";
  const spans = result.hunks.map((h) => (h.start === h.end ? String(h.start) : `${h.start}-${h.end}`)).join(", ");
  return `+${result.added}/-${result.removed}，overlay 行 ${spans || "（只有删除）"}`;
}
