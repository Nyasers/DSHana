// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/dev/overlay-deltas.mts — 把 integrations 与组合层里每一份「我们相对上游的改动」打成 unified diff。
//
// 为什么需要它：跟进上游时真正的活是 **rebase**——把我们的 delta 重放到新一版上游文件上。可 delta
// 平时只以「整文件 overlay」的形态存在，人读一份 2000 行的文件分不出哪几段是我们的。清单里的
// deltaSha256 只能回答「有没有漂」，回答不了「改了什么」。于是跟进前先把 delta 显式打出来。
//
// 口径：上游一侧一律从**镜像的 tag** 读（`git show <tag>:<path>`），与漂移闸、provenance 闸同一个
// 坐标；不读 npm 产物（npm 里没有 src/），也不读镜像工作树（那会随检出状态漂）。
//
// 用法：
//   node scripts/dev/overlay-deltas.mts                  # 用当前 pin 的 tag
//   node scripts/dev/overlay-deltas.mts 0.2.1-rc.3   # 指定 tag（预研下一版时用）
//   node scripts/dev/overlay-deltas.mts --bundle         # 只打组合层（packages/dsh/app 的 provenance 面）
//
// 产物落在 .tmp/overlay-deltas/<tag>/<集成名>/<文件>.diff（.tmp 已忽略，不进仓）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ROOT } from "../shared/root.mts";
import { isDirectRun } from "../shared/run.mts";
import { dshPin } from "../shared/version.mts";

const MIRROR = join(ROOT, "vendor", "deepseek-harness");
const OUT_ROOT = join(ROOT, ".tmp", "overlay-deltas");

/** 组合层包（它的派生面记在自己的 provenance.json 里，不在 integrations 清单里）。 */
const BUNDLE_PKG_REL = "packages/dsh/app";

/** 从镜像的某个 tag 读文件；不存在返回 null。 */
function readUpstream(repoRel: string, tag: string): string | null {
  try {
    return execFileSync("git", ["-C", MIRROR, "show", `${tag}:${repoRel}`], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * 去掉 git 为「特殊路径」加的双引号与 C 风格转义。
 * Windows 下 git 认为含反斜杠的路径需要引号，于是写出 `--- "a/C:\\x\\y\\.scratch\\a"`——
 * 引号里的路径不是原文，必须先还原再比对。
 */
function unquoteGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith('"') || !token.endsWith('"')) return token;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  const push = (s: string) => bytes.push(...Buffer.from(s, "utf8"));
  // 单趟扫描：\\t 是「反斜杠 + t」两个字符，不能先还原 \\ 再套 \t，否则变成真正的制表符——
  // 而 Windows 的 E:\tmp 这类路径正好含 \\t，一回错就再也对不上临时路径。
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      push(ch);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      push("\\");
      break;
    }
    const octal = /^[0-7]{3}$/.exec(body.slice(i + 1, i + 4));
    if (octal !== null) {
      // git 对非 ASCII 用八进制转义（\346\226\207…），合起来才是原来的 UTF-8 字节
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const mapped: Record<string, string> = { '"': '"', "\\": "\\", t: "\t", n: "\n", r: "\r", b: "\b", f: "\f", v: "\v", a: "\x07" };
    push(mapped[next] ?? `\\${next}`);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 路径含空白或引号时按 git 的规矩加引号，免得出现 "--- a/my file.ts" 这种半截头部。 */
function quoteGitPath(path: string): string {
  return /[\s"]/.test(path) ? `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : path;
}

/**
 * 只改写 git 生成的头部行（`diff --git` / `--- ` / `+++`），正文一行不动。
 *
 * 早先是对整份文本做 split(a).join(...)：label 里含 a/b 之类的字符会污染，正文里恰好出现临时
 * 路径字符串也会被改；而且一旦按整串替换，未加引号的 `a/E:\…` 根本匹配不上带引号的头部，
 * 等于什么都没换（Windows 上实测就是这样）。
 */
function relabelDiffPaths(text: string, a: string, b: string, label: string): string {
  const wanted: Record<"a" | "b", string> = { a, b };
  const side = (token: string, which: "a" | "b"): string | null => {
    const raw = unquoteGitPath(token);
    const target = wanted[which];
    const bare = raw === target ? raw : raw.startsWith(`${which}/`) && raw.slice(2) === target ? target : null;
    return bare === null ? null : quoteGitPath(`${which}/${label}`);
  };
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("--- ")) {
        const next = side(line.slice(4), "a");
        return next === null ? line : `--- ${next}`;
      }
      if (line.startsWith("+++ ")) {
        const next = side(line.slice(4), "b");
        return next === null ? line : `+++ ${next}`;
      }
      if (line.startsWith("diff --git ")) {
        // 两侧可能各自带引号，按 git 的引号规则切，别用 split(" ")
        const m = /^("(?:[^"\\]|\\.)*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)$/.exec(line.slice(11));
        if (m === null) return line;
        const left = side(m[1], "a");
        const right = side(m[2], "b");
        return left === null || right === null ? line : `diff --git ${left} ${right}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * 两段文本的 unified diff（-U6 给足上下文，重放到新上游时锚点更稳）。
 * 用 git diff --no-index 而不是手写差异：它给的是标准格式，能直接 `git apply` 试重放。
 */
function unifiedDiff(before: string, after: string, label: string, outDir: string): string {
  const scratch = join(outDir, ".scratch");
  mkdirSync(scratch, { recursive: true });
  const a = join(scratch, "a");
  const b = join(scratch, "b");
  writeFileSync(a, before, "utf8");
  writeFileSync(b, after, "utf8");
  let text = "";
  try {
    text = execFileSync("git", ["diff", "--no-index", "--no-color", "-U6", "--", a, b], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    // git diff 的退出码：0 无差异，1 有差异（stdout 里就是 diff），2 及以上是真出错。
    //
    // 但退出码 1 有两种含义，不能只看它：实测 Windows 下路径读不了时，git 报
    // `error: Could not access '…'` 而**退出码仍是 1、stdout 为空**。只看退出码会把这个当成
    // 「有差异但内容为空」，照样写出一份空 diff。所以再加一道：退出码 1 但 stdout 为空、
    // stderr 有内容时，仍然当出错。
    const { status, stdout, stderr } = e as { status?: unknown; stdout?: unknown; stderr?: unknown };
    const errText = typeof stderr === "string" ? stderr.trim() : "";
    const outText = typeof stdout === "string" ? stdout : "";
    if (status !== 1 || (outText.length === 0 && errText.length > 0)) {
      const detail = errText.length > 0 ? errText : "没有 stderr 输出";
      throw new Error(`git diff --no-index 失败（退出码 ${String(status ?? "未知")}）：${detail}（比对 ${label}）`);
    }
    text = outText;
  }
  return relabelDiffPaths(text, a, b, label);
}

/**
 * 数一份 diff 里新增/删除的行数。
 *
 * 只算 hunk 内（`@@` 行之后）行首恰为一个 `+` / `-` 的行：`---` / `+++` 文件头不在 hunk 里，
 * 天然被排除；正文里以 `++`、`--` 开头的真实变更行则照算——之前用 /^\+(?!\+\+)/ 会把这些
 * 真变更漏掉，计数偏小。
 */
function countChanges(diff: string): { adds: number; dels: number } {
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let adds = 0;
  let dels = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { adds, dels };
}

/** 集成清单：integrations 下每个子目录里的 integration.json。 */
function loadIntegrations(): Array<{ dir: string; upstreamDir: string; files: Array<{ path: string }> }> {
  const root = join(ROOT, "integrations");
  if (!existsSync(root)) return [];
  const out: Array<{ dir: string; upstreamDir: string; files: Array<{ path: string }> }> = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifest = join(root, ent.name, "integration.json");
    if (!existsSync(manifest)) continue;
    const it = JSON.parse(readFileSync(manifest, "utf8"));
    out.push({ dir: ent.name, upstreamDir: String(it.upstreamDir ?? ""), files: Array.isArray(it.files) ? it.files : [] });
  }
  return out;
}

/** 组合层的派生面（provenance.json 记的是相对上游 @deepseek-ai/dsh-web-app 的坐标）。 */
function bundleFaces(): Array<{ path: string }> {
  const provPath = join(ROOT, BUNDLE_PKG_REL, "provenance.json");
  if (!existsSync(provPath)) return [];
  const prov = JSON.parse(readFileSync(provPath, "utf8"));
  return Array.isArray(prov.files) ? prov.files : [];
}

function main(): void {
  const args = process.argv.slice(2);
  const onlyBundle = args.includes("--bundle");
  const tagArg = args.find((a) => !a.startsWith("--"));
  const pin = dshPin();
  const tag = tagArg ?? (pin ? `dsh-v${pin}` : null);
  if (tag === null) {
    console.error("[overlay-deltas] 未给 tag，且 packages/host/package.json 未声明 @deepseek-ai/dsh");
    process.exit(2);
  }
  if (readUpstream("package.json", tag) === null) {
    console.error(`[overlay-deltas] 镜像里没有 ${tag}。先 fetch：`);
    console.error(`  git -C vendor/deepseek-harness fetch origin tag ${tag}`);
    process.exit(2);
  }
  const outRoot = join(OUT_ROOT, tag);
  // 每次运行前清空本 tag 的产物目录，否则会混进上一次的结果：切到 --bundle 时上一轮的全量
  // diff 还留着，某个文件变成 MISS 时它的旧 diff 也不会消失——目录看起来「还是齐的」，其实不是。
  // 只清这一个 tag 的子目录，OUT_ROOT 下别的 tag 的结果要留着。
  rmSync(outRoot, { recursive: true, force: true });
  let count = 0;

  if (!onlyBundle) {
    for (const it of loadIntegrations()) {
      for (const f of it.files) {
        const upstreamRel = `${it.upstreamDir}/${f.path}`;
        const upstream = readUpstream(upstreamRel, tag);
        const overlayPath = join(ROOT, "integrations", it.dir, "files", f.path);
        if (upstream === null) {
          console.log(`MISS  ${it.dir}/${f.path}（镜像 ${tag} 下没有 ${upstreamRel}）`);
          continue;
        }
        if (!existsSync(overlayPath)) {
          console.log(`MISS  ${it.dir}/${f.path}（我们的 overlay 不在）`);
          continue;
        }
        const outDir = join(outRoot, it.dir);
        const diff = unifiedDiff(upstream, readFileSync(overlayPath, "utf8"), `${it.dir}/${f.path}`, outDir);
        const outPath = join(outDir, f.path.replace(/[\\/]/g, "_") + ".diff");
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, diff, "utf8");
        const { adds, dels } = countChanges(diff);
        console.log(`${it.dir.padEnd(24)} ${f.path.padEnd(44)} +${adds}/-${dels}`);
        count++;
      }
    }
  }

  if (onlyBundle || args.includes("--all")) {
    const prov = JSON.parse(readFileSync(join(ROOT, BUNDLE_PKG_REL, "provenance.json"), "utf8"));
    const upstreamDir = String(prov.upstreamDir ?? "packages/bundle/web-app");
    for (const f of bundleFaces()) {
      const upstreamRel = `${upstreamDir}/${f.path}`;
      const upstream = readUpstream(upstreamRel, tag);
      const localPath = join(ROOT, BUNDLE_PKG_REL, f.path);
      if (upstream === null) {
        console.log(`MISS  bundle/${f.path}（镜像 ${tag} 下没有 ${upstreamRel}）`);
        continue;
      }
      if (!existsSync(localPath)) {
        console.log(`MISS  bundle/${f.path}（本地不在）`);
        continue;
      }
      const outDir = join(outRoot, "bundle");
      const diff = unifiedDiff(upstream, readFileSync(localPath, "utf8"), `bundle/${f.path}`, outDir);
      const outPath = join(outDir, f.path.replace(/[\\/]/g, "_") + ".diff");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, diff, "utf8");
      const { adds, dels } = countChanges(diff);
      console.log(`bundle                   ${f.path.padEnd(44)} +${adds}/-${dels}`);
      count++;
    }
  }

  console.log(`\n${count} 份 delta → ${outRoot}`);
}

if (isDirectRun(import.meta.url)) main();
