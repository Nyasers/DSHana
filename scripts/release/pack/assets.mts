// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/assets.mts — 随包平台资产的派生（不手写名单）。
//
// 交付树里那些按平台切分的包（koffi / sharp / ripgrep / sherpa / node-addon-* 这些）不在这里
// 枚举，而是从**物化后的锁文件**派生：锁是那一次干净安装的解析记录，带 os/cpu/libc 字段的条目就是
// 按平台切分的包。判据而不是名单，上游换包名、加新平台件时自动跟上，也不会因为漏写一行而静默放过。
//
// 为什么用物化后的锁而不是仓库锁：仓库锁是构建面，含 devDependencies——rspack / rolldown /
// typescript 同样按平台切分，照搬会把它们当成必须随包的资产，出包时当场拒包。物化后的锁只含该
// 目标的生产闭包，正是交付面的解析记录。
import fs from "fs-extra";
import { join } from "node:path";

import type { TargetSpec } from "./targets.mts";

/** 锁里一个按平台切分的包条目。字段缺省表示该维度不设限。 */
export interface PlatformEntry {
  name: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

/** 去掉引号与尾冒号；snapshots 段的键可能带 peer 后缀（`a@1(b@2)`），截到 `(` 之前。 */
function lockKeyOf(line: string): string {
  const body = line.trim().replace(/'/g, "").split("(")[0].replace(/:\s*$/, "");
  const at = body.lastIndexOf("@");
  return at > 0 ? body.slice(0, at) : body;
}

/** 行内数组 `[darwin]` / `[darwin, arm64]` 的元素。 */
function splitInline(body: string): string[] {
  return body
    .split(",")
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
    .filter((v) => v.length > 0);
}

/**
 * 解析锁的 `packages:` 段，取出所有带 os/cpu/libc 字段的条目（即按平台切分的包）。
 * 只认 `packages:` 段 2 空格缩进的条目：`importers:` / `snapshots:` 里的同名行是依赖引用，
 * 包被移除时引用可能还留着，不算「这个包真能装出来」。
 */
export function lockPlatformEntries(lockText: string): PlatformEntry[] {
  const lines = lockText.split(/\r?\n/);
  const out: PlatformEntry[] = [];
  let inPackages = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages && (line === "snapshots:" || line === "---")) {
      inPackages = false;
      continue;
    }
    if (!inPackages || !/^ {2}\S.*:\s*$/.test(line)) continue;
    const entry: PlatformEntry = { name: lockKeyOf(line) };
    for (let k = i + 1; k < lines.length; k += 1) {
      const inner = lines[k];
      if (/^ {2}\S/.test(inner)) break;
      const inline = /^\s+(os|cpu|libc):\s*\[(.*)\]\s*$/.exec(inner);
      if (inline) {
        entry[inline[1] as "os" | "cpu" | "libc"] = splitInline(inline[2]);
        continue;
      }
      const head = /^\s+(os|cpu|libc):\s*$/.exec(inner);
      if (head) {
        const list: string[] = [];
        for (let m = k + 1; m < lines.length; m += 1) {
          const item = /^\s+-\s*(.+?)\s*$/.exec(lines[m]);
          if (!item) break;
          list.push(item[1].replace(/^['"]|['"]$/g, ""));
        }
        entry[head[1] as "os" | "cpu" | "libc"] = list;
      }
    }
    if (entry.os || entry.cpu || entry.libc) out.push(entry);
  }
  return out;
}

/**
 * 一个平台字段是否不排除本目标。缺省或空表示该维度不设限；出现负向声明（`!win32`）时判据不成立，
 * 保守地不纳入断言（宁可少断言一项，也不误拒一个包）。
 */
function admits(declared: string[] | undefined, wanted: string[] | undefined): boolean {
  if (!declared || declared.length === 0) return true;
  if (declared.some((v) => v.startsWith("!"))) return false;
  if (!wanted || wanted.length === 0) return true;
  return declared.some((v) => wanted.includes(v));
}

/** 该条目是否与本目标相容（os/cpu/libc 三个维度都不排除）。 */
export function entryMatchesTarget(entry: PlatformEntry, spec: TargetSpec): boolean {
  return admits(entry.os, spec.os) && admits(entry.cpu, spec.cpu) && admits(entry.libc, spec.libc);
}

/**
 * 锁里的 packageManager 依赖：`importers.` 的 `packageManagerDependencies` 段点名的包（pnpm 本体）。
 * 它们只在锁里记着，pnpm 不解包进 `node_modules`，属工具链元数据而非产品依赖。
 */
export function packageManagerDependencies(lockText: string): Set<string> {
  const lines = lockText.split(/\r?\n/);
  const out = new Set<string>();
  let inImporters = false;
  let inPmDeps = false;
  let pmIndent = -1;
  for (const line of lines) {
    if (line === "importers:") {
      inImporters = true;
      continue;
    }
    if (inImporters && (line === "packages:" || line === "snapshots:")) break;
    if (!inImporters) continue;
    const indent = line.length - line.trimStart().length;
    if (inPmDeps && line.trim().length > 0 && indent <= pmIndent) inPmDeps = false;
    if (/^\s+packageManagerDependencies:\s*$/.test(line)) {
      inPmDeps = true;
      pmIndent = indent;
      continue;
    }
    if (inPmDeps) {
      const m = /^\s+['"]?([^'"\s:]+)['"]?:\s*(.*)$/.exec(line);
      if (m && m[1] !== "specifier" && m[1] !== "version") out.add(m[1]);
    }
  }
  return out;
}

/**
 * 锁里的 packageManager 链：`packageManagerDependencies` 点名的包及其全部传递依赖。
 * 这条链上的包不进 `node_modules`，因此不属于交付树，也不能当成必须随包的资产——否则「树里没有」
 * 会被误报成缺包（`@pnpm/exe.*` 就是这么冒出来的）。
 */
export function packageManagerClosure(lockText: string): Set<string> {
  const roots = packageManagerDependencies(lockText);
  const out = new Set<string>(roots);
  if (roots.size === 0) return out;
  const lines = lockText.split(/\r?\n/);
  const start = lines.indexOf("snapshots:");
  if (start < 0) return out;
  const edges = new Map<string, string[]>();
  let cur: string | null = null;
  // snapshots 段里每个包块的直接依赖：只认包块顶层的依赖段（dependencies / optionalDependencies 等）
  // 之下的条目。字段名本身（`dependencies:` 这些）与更深一层的 `resolution` / `engines` 不是依赖。
  const DEP_SECTIONS = /^\s+(dependencies|optionalDependencies|peerDependencies|packageManagerDependencies):\s*$/;
  let inDeps = false;
  let depsIndent = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {2}\S.*:\s*$/.test(line)) {
      cur = lockKeyOf(line);
      edges.set(cur, []);
      inDeps = false;
      continue;
    }
    if (cur === null) continue;
    const indent = line.length - line.trimStart().length;
    if (inDeps && line.trim().length > 0 && indent <= depsIndent) inDeps = false;
    if (DEP_SECTIONS.test(line)) {
      inDeps = true;
      depsIndent = indent;
      continue;
    }
    if (!inDeps) continue;
    const m = /^\s+['"]?([^'"\s:(]+)['"]?:\s*/.exec(line);
    if (m) edges.get(cur)!.push(m[1]);
  }
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop()!;
    for (const dep of edges.get(name) ?? []) {
      if (out.has(dep)) continue;
      out.add(dep);
      queue.push(dep);
    }
  }
  return out;
}

/**
 * 某目标应随包的平台资产：锁里与本目标相容、且不在 packageManager 链上的按平台切分条目（按名去重）。
 *
 * 只排掉一类：`packageManagerDependencies`（pnpm 本体）及其传递依赖——pnpm 只把它们记进锁、
 * 不解包进 `node_modules`。留下的集合就是**必须真在树里**的，调用方对它严格断言存在（不做
 * "树里没有就滤掉"的过滤，否则真资产缺失会被静默放过、断言失去意义）。
 *
 * @param lockText 物化后的锁文本（只含该目标的生产闭包）
 * @param spec 目标描述
 */
export function platformAssetsFor(lockText: string, spec: TargetSpec): string[] {
  const pmChain = packageManagerClosure(lockText);
  const names = lockPlatformEntries(lockText)
    .filter((e) => entryMatchesTarget(e, spec))
    .map((e) => e.name)
    .filter((n) => !pmChain.has(n));
  return [...new Set(names)].sort();
}

/**
 * 扫交付树里与目标不相容的按平台切分包，分两类：
 *
 *   · foreign —— os 或 cpu 不匹配。物化按目标窄化这两个维度，出现即「窄化没生效」，
 *     产物里混了别的平台的原生件，调用方应当拒包。
 *   · staleLibc —— os/cpu 相容但 libc 不匹配。pnpm 的 supportedArchitectures.libc 在 hoisted
 *     布局下不作用于 optional 传递树（sharp 把 musl 变体列在 optionalDependencies 里，照样被解包
 *     进 node_modules），它们对 glibc 目标无用，调用方应当删掉。
 *
 * 分开报而不是合成一类：两者成因不同（前者是我们的窄化没生效，后者是 pnpm 的能力边界），
 * 处理方式也不同（拒包 vs 补删）。
 *
 * **整棵树都扫**：hoisted 布局下版本冲突会把包压在依赖者自己的 `node_modules` 下（顶层一份都没有），
 * 只看顶层会漏掉它们——漏掉的 foreign 是静默放过一个别的平台的原生件，漏掉的 staleLibc 是一份白带
 * 的载荷。返回的每一项是相对 `modulesDir` 的路径（`@scope/name`，或嵌套时的
 * `@scope/name/node_modules/@scope/name`），调用方据此定位。
 */
export function scanPlatformTree(modulesDir: string, spec: TargetSpec): { foreign: string[]; staleLibc: string[] } {
  const foreign: string[] = [];
  const staleLibc: string[] = [];
  /** 某个 `node_modules` 目录下的包目录：scoped 包下钻一层，点号条目（pnpm 的账本）不是包。 */
  const childPackages = (dir: string): { dir: string; name: string }[] => {
    const out: { dir: string; name: string }[] = [];
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      if (dirent.name.startsWith("@")) {
        const scope = join(dir, dirent.name);
        let subs: fs.Dirent[];
        try {
          subs = fs.readdirSync(scope, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subs) {
          if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
          out.push({ dir: join(scope, sub.name), name: `${dirent.name}/${sub.name}` });
        }
        continue;
      }
      out.push({ dir: join(dir, dirent.name), name: dirent.name });
    }
    return out;
  };
  const visit = (dir: string, prefix: string): void => {
    for (const child of childPackages(dir)) {
      const label = prefix ? `${prefix}/node_modules/${child.name}` : child.name;
      const manifest = join(child.dir, "package.json");
      if (fs.pathExistsSync(manifest)) {
        let pkg: { os?: string[]; cpu?: string[]; libc?: string[] } | null = null;
        try {
          pkg = fs.readJsonSync(manifest);
        } catch {
          pkg = null;
        }
        if (pkg && (pkg.os || pkg.cpu || pkg.libc)) {
          const entry: PlatformEntry = { name: label, os: pkg.os, cpu: pkg.cpu, libc: pkg.libc };
          if (!admits(entry.os, spec.os) || !admits(entry.cpu, spec.cpu)) foreign.push(label);
          else if (!admits(entry.libc, spec.libc)) staleLibc.push(label);
        }
      }
      visit(join(child.dir, "node_modules"), label);
    }
  };
  visit(modulesDir, "");
  return { foreign, staleLibc };
}

/**
 * 删掉 libc 不相容的平台变体（glibc 目标下的 musl 件）。`paths` 是 scanPlatformTree 报出的相对路径
 * （可含嵌套层），据此定位真实目录。返回删除计数与释放的未压缩字节，供日志。
 *
 * 删除失败不吞：删不掉意味着产物里躺着一个不该在的件，此时出一份「看起来成功」的包比不出包更坏。
 * 工位在起手处已清空重建（见 index.mts 的打包台纪律），这里面对的是本次刚装出来的树，失败属真异常。
 */
export function dropStaleLibc(modulesDir: string, paths: string[]): { files: number; bytes: number } {
  const out = { files: 0, bytes: 0 };
  for (const rel of paths) {
    const dir = join(modulesDir, ...rel.split("/"));
    if (!fs.pathExistsSync(dir)) continue;
    out.bytes += dirSize(dir);
    fs.removeSync(dir);
    out.files += 1;
  }
  return out;
}

/** 目录内所有文件的字节合计。 */
function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
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
