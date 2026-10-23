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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    // 有差异时退出码是 1，输出仍在 stdout；无差异时是空串
    const stdout = (e as { stdout?: unknown }).stdout;
    text = typeof stdout === "string" ? stdout : "";
  }
  // 把临时路径换成有意义的名字，diff 才读得懂
  return text.split(a).join(`a/${label}`).split(b).join(`b/${label}`);
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
        const adds = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
        const dels = (diff.match(/^-(?!--)/gm) ?? []).length;
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
      const adds = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
      const dels = (diff.match(/^-(?!--)/gm) ?? []).length;
      console.log(`bundle                   ${f.path.padEnd(44)} +${adds}/-${dels}`);
      count++;
    }
  }

  console.log(`\n${count} 份 delta → ${outRoot}`);
}

if (isDirectRun(import.meta.url)) main();
