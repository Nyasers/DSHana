// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/dev/dsh-bump.mts — 把仓库里钉在旧内核版本上的声明统一换到目标版本。
//
// 跟进上游时机械的那一段分两类：
//   ① 精确版本串：内核 pin 散在三份清单里（宿主声明、根 devDependencies、组合层 package.json），
//      组合层那 120 多条 `@deepseek-ai/dsh-*` 逐条精确固定，靠手改必漏。
//   ② vendor 线的范围串：cordis / schemastery / loader 等以 `^`/`~` 声明，范围下界跟不上新内核
//      声明的版本时会同时装进两份（cordis 是单例运行时，撞上就起不来）。
//
// 两类都按事实源取：①以当前 pin 为旧值，②以上游目标 tag 里 vendor/<包>/package.json 的 version
// 为准。范围串保持原有前缀（`^` 或 `~`），只把主次段换过去——`~4.1.0` 与 `^4.1.0` 都能容纳
// 4.1.x，这样不必在新内核发补丁版时反复改。
//
// **不碰 integrations 的 overlay**。上游文件一变，overlay 的 upstreamSha256 就对不上，那是
// delta rebase 的活（`dsh-overlay-rebase.mts` 做三方重放）。
//
// 用法：
//   node scripts/dev/dsh-bump.mts --to 0.2.2-rc.2 --check   # 只报要改什么，不写回
//   node scripts/dev/dsh-bump.mts --to 0.2.2-rc.2           # 写回
//
// 退出码：0 正常；1 参数缺失或目标与当前一致；2 出错。
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../shared/root.mts";
import { isDirectRun } from "../shared/run.mts";
import { readPkg, writePkg } from "../shared/version.mts";

/** 三份清单：内核 pin 的全部落点。 */
const TARGETS = ["package.json", "packages/host/package.json", "packages/dsh/app/package.json"];

/** 依赖字段（含可选开发/对等，命中即换）。 */
const FIELDS = ["dependencies", "devDependencies", "peerDependencies"] as const;

const MIRROR = join(ROOT, "vendor", "deepseek-harness");

type Field = (typeof FIELDS)[number];
type Pkg = Record<Field, Record<string, string> | undefined>;

interface Hit {
  file: string;
  field: Field;
  name: string;
  spec: string;
}

/** 取 `--name value` 形式的参数。 */
function argValue(argv: string[], name: string): string | null {
  const at = argv.indexOf(name);
  if (at < 0) return null;
  const v = argv[at + 1];
  return v && !v.startsWith("--") ? v : null;
}

/** 当前内核 pin（以宿主声明为准，它是全链的唯一编程入口）。 */
function currentPin(): string {
  const pin = readPkg("packages/host/package.json")?.dependencies?.["@deepseek-ai/dsh"];
  if (typeof pin !== "string" || !pin) {
    throw new Error("packages/host/package.json 未声明 dependencies['@deepseek-ai/dsh']");
  }
  return pin;
}

/**
 * 扫三份清单，找出值精确等于 from 的条目。
 * 只认精确相等：`^`/`~` 范围与非版本串（workspace:、file:）天然不命中。
 */
export function scan(from: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of TARGETS) {
    const pkg = readPkg(file) as Pkg | undefined;
    if (!pkg) continue;
    for (const field of FIELDS) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (spec === from) hits.push({ file, field, name, spec });
      }
    }
  }
  return hits;
}

/** 同一批清单里带范围符的 @deepseek-ai/* 条目。 */
export function ranged(): Hit[] {
  const hits: Hit[] = [];
  for (const file of TARGETS) {
    const pkg = readPkg(file) as Pkg | undefined;
    if (!pkg) continue;
    for (const field of FIELDS) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (name.startsWith("@deepseek-ai/") && /^[\^~]/.test(spec)) hits.push({ file, field, name, spec });
      }
    }
  }
  return hits;
}

/** 镜像里有没有这个 tag（没有就先跑 sync:vendor:dsh）。 */
function tagExists(tag: string): boolean {
  try {
    execFileSync("git", ["-C", MIRROR, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 上游该 tag 下 vendor/ 各包的 包名 → 版本。
 * vendor 目录里住的是 cordis / schemastery / loader 这些独立版本线的包，它们的目录名与包名
 * 不一致（`loader` 是 `@deepseek-ai/cordis-plugin-loader`），所以按 package.json 的 name 建映射。
 */
function vendorVersions(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  let dirs: string[] = [];
  try {
    // 用 `<tag>:vendor` 这种 tree-ish 形式：直接给路径会只列出 vendor 这一项本身。
    // -d 只留目录：vendor 下还躺着 AGENTS.md / README.md 这类文件。
    dirs = execFileSync("git", ["-C", MIRROR, "ls-tree", "-d", "--name-only", `${tag}:vendor`], {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    try {
      const raw = execFileSync("git", ["-C", MIRROR, "show", `${tag}:vendor/${dir}/package.json`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const j = JSON.parse(raw) as { name?: string; version?: string };
      if (j.name && j.version) out.set(j.name, j.version);
    } catch {
      // 该目录没有 package.json：不是可发布的包，跳过
    }
  }
  return out;
}

interface RangePlan extends Hit {
  action: "keep" | "update" | "unknown";
  to: string;
  note: string;
}

/**
 * 范围串的更新计划：主次段跟上游走，前缀保留。
 * 判定「要不要改」只看主次段：`~4.1.0` 与上游 4.1.2 属于同一线，不必动。
 */
function planRanges(versions: Map<string, string>): RangePlan[] {
  return ranged().map((h) => {
    const want = versions.get(h.name);
    if (!want) {
      return { ...h, action: "unknown", to: h.spec, note: "上游 vendor 线里没有这个包，保持原样" };
    }
    const prefix = h.spec[0];
    const [mj, mn] = want.split(".");
    const current = h.spec.slice(1).split(".").slice(0, 2).join(".");
    if (current === `${mj}.${mn}`) return { ...h, action: "keep", to: h.spec, note: `已是 ${mj}.${mn} 线` };
    return { ...h, action: "update", to: `${prefix}${mj}.${mn}.0`, note: `上游 ${want}` };
  });
}

/** 写回：按文件分次写，避免同文件多次读写。 */
function applyPrecise(hits: Hit[], from: string, to: string): void {
  const byFile = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  for (const [file, list] of byFile) {
    const pkg = readPkg(file) as Pkg;
    for (const h of list) {
      const deps = pkg[h.field];
      if (deps?.[h.name] === from) deps[h.name] = to;
    }
    writePkg(file, pkg);
  }
}

/** 写回范围串（只写 action=update 的）。 */
function applyRanges(plans: RangePlan[]): void {
  const byFile = new Map<string, RangePlan[]>();
  for (const p of plans) {
    if (p.action !== "update") continue;
    const list = byFile.get(p.file) ?? [];
    list.push(p);
    byFile.set(p.file, list);
  }
  for (const [file, list] of byFile) {
    const pkg = readPkg(file) as Pkg;
    for (const p of list) {
      const deps = pkg[p.field];
      if (deps?.[p.name] === p.spec) deps[p.name] = p.to;
    }
    writePkg(file, pkg);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const to = argValue(argv, "--to");
  const check = argv.includes("--check");
  if (!to) {
    console.error("[dsh-bump] 缺 --to <版本>（例：--to 0.2.2-rc.2）");
    process.exit(1);
  }
  const from = currentPin();
  if (from === to) {
    console.error(`[dsh-bump] 目标与当前 pin 相同（${from}），没有可换的条目`);
    process.exit(1);
  }

  console.log(`[dsh-bump] ${from} → ${to}${check ? "（--check，不写回）" : ""}`);

  // ① 精确版本串
  const hits = scan(from);
  if (hits.length === 0) {
    console.log("[dsh-bump] 没有值等于旧 pin 的条目。");
  } else {
    const byFile = new Map<string, Hit[]>();
    for (const h of hits) {
      const list = byFile.get(h.file) ?? [];
      list.push(h);
      byFile.set(h.file, list);
    }
    for (const [file, list] of byFile) {
      console.log(`\n[dsh-bump] ${file}：${list.length} 条`);
      for (const h of list) console.log(`  ${h.field}["${h.name}"]`);
    }
  }

  // ② vendor 线的范围串
  const tag = `dsh-v${to}`;
  if (!tagExists(tag)) {
    console.log(`\n[dsh-bump] 镜像里没有 ${tag}，跳过传递依赖核对（先跑 pnpm run sync:vendor:dsh）`);
  } else {
    const plans = planRanges(vendorVersions(tag));
    const updates = plans.filter((p) => p.action === "update");
    const keeps = plans.filter((p) => p.action === "keep");
    const unknowns = plans.filter((p) => p.action === "unknown");
    console.log(`\n[dsh-bump] 传递依赖（vendor 线）：${updates.length} 条要改，${keeps.length} 条已在目标线`);
    for (const p of updates) console.log(`  ${p.file} ${p.field}["${p.name}"] ${p.spec} → ${p.to}（${p.note}）`);
    for (const p of unknowns) console.log(`  ${p.file} ${p.field}["${p.name}"] 保持 ${p.spec}（${p.note}）`);
    if (!check) applyRanges(plans);
  }

  console.log(
    "\n[dsh-bump] 换完之后还要跑：pnpm install → pnpm run sync:vendor:dsh → "
      + "node scripts/dev/dsh-overlay-rebase.mts --to " + to + " → pnpm run derive → pnpm run verify:integrations",
  );

  if (!check && hits.length > 0) {
    applyPrecise(hits, from, to);
    console.log(`[dsh-bump] 已写回 ${hits.length} 条精确版本串。`);
  }
}

if (isDirectRun(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`[dsh-bump] ${(e as Error).message}`);
    process.exit(2);
  }
}
