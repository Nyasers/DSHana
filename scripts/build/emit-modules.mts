// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/build/emit-modules.mts — 把 src 域按**文件**emit 成 .mjs 模块树（不再打单文件 bundle）。
//
// 为什么模块化：交付树与源文件一一对应，审得出每一段代码；按需 import 的模块才解析（见
// src/tools/index.ts 的装配）。为什么是 .mjs：扩展名自己说明模块类型，不依赖交付面 package.json
// 的 type（那份是"铭牌"，字段白名单另有 assertProductPackage 守着）。根入口 index.js 是例外——
// manifest.entry 钉死了这个名字，它由壳承担，本脚本只负责把它摆到根上（保持 .js）。
//
// 三步（都在**产物**上做，源码不动）：
//   1) tsc 逐文件转译：noEmit:false + rewriteRelativeImportExtensions（相对 .ts → .js）；
//   2) 改名 .js → .mjs，相对 import 里的 .js specifier 同步改写成 .mjs；
//   3) `#/*` 别名改写成本文件相对的 .mjs specifier——tsc 不解析别名（TS2877），别名在源码里有 156 处，
//      规则只有这一条（src 里没有相对 .ts import）。
//
// 用法：node scripts/build/emit-modules.mts --out <目录> [--keep-js <相对路径…>]
//   --out      产物根（会先清空）
//   --keep-js  保持 .js 的产物（相对 --out；默认 "index.js"——manifest 钉死的入口壳）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP_DIR = path.join(ROOT, ".tmp");
const EMIT_STAGE = path.join(TMP_DIR, "emit-src");

/** `#/*` 别名的根（与仓库 package.json#imports 一致）。 */
const ALIAS_PREFIX = "#/";
/** 要 emit 的源码域（相对 src/）。构建面（build.ts / rspack.config.mts）、ui 与静态面不在此列。 */
const EMIT_UNITS = ["lib", "routes", "tools", "types", "runtime"];
/** 两个入口的落位：`src/index.ts` 是实现入口（.mjs），`src/shell.ts` 是 manifest 钉死的根入口（保 .js）。 */
const ENTRY_MAP = { "index.js": "impl.js", "shell.js": "shell.js" };

/** 读参数：`--out` 必填，`--keep-js` 可多次。 */
function parseArgs() {
  const argv = process.argv.slice(2);
  let out = null;
  const keepJs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--keep-js") keepJs.push(argv[++i]);
    else throw new Error("未知参数：" + argv[i]);
  }
  if (!out) throw new Error("缺 --out <目录>");
  return { out: path.isAbsolute(out) ? out : path.join(ROOT, out), keepJs: new Set(keepJs) };
}

/** 收集目录下所有文件（相对 base 的路径）。 */
function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, base, acc);
    else acc.push(path.relative(base, p).replaceAll("\\", "/"));
  }
  return acc;
}

/** specifier → 改写后的 specifier（`#/*` 与相对 .ts/.js 两种形态）。 */
function rewriteSpecifier(specifier, fromRel) {
  const fromDir = path.posix.dirname(fromRel);
  if (specifier.startsWith(ALIAS_PREFIX)) {
    const target = specifier.slice(ALIAS_PREFIX.length).replace(/\.tsx?$/u, ".mjs");
    let rel = path.posix.relative(fromDir === "." ? "" : fromDir, target);
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel;
  }
  if (/^\.\.?\//u.test(specifier)) return specifier.replace(/\.tsx?$/u, ".mjs").replace(/\.js$/u, ".mjs");
  return specifier;
}

/** 改写一份产物里的 import/export 说明符（只动字符串字面量形态）。 */
function rewriteFile(absPath, relPath) {
  const code = fs.readFileSync(absPath, "utf8");
  const next = code
    .replace(/(\bfrom\s*)(["'])([^"']+)\2/gu, (_m, head, quote, spec) => head + quote + rewriteSpecifier(spec, relPath) + quote)
    .replace(/(\bimport\s*\(\s*)(["'])([^"']+)\2(\s*\))/gu, (_m, head, quote, spec, tail) => head + quote + rewriteSpecifier(spec, relPath) + quote + tail)
    .replace(/(\bimport\s+)(["'])([^"']+)\2/gu, (_m, head, quote, spec) => head + quote + rewriteSpecifier(spec, relPath) + quote);
  if (next !== code) fs.writeFileSync(absPath, next, "utf8");
}

/** 主流程。 */
function main() {
  const { out, keepJs } = parseArgs();

  // 1) tsc 逐文件转译到暂存区（配置放 .tmp：路径相对它解析，不污染仓库根）
  fs.rmSync(EMIT_STAGE, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const cfgPath = path.join(TMP_DIR, "tsconfig.emit.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        extends: "../tsconfig.src.json",
        compilerOptions: {
          noEmit: false,
          outDir: path.relative(TMP_DIR, EMIT_STAGE).replaceAll("\\", "/"),
          rootDir: "../src",
          rewriteRelativeImportExtensions: true,
          declaration: false,
          sourceMap: false,
        },
        include: [
          "../src/index.ts",
          "../src/shell.ts",
          ...EMIT_UNITS.map((u) => `../src/${u}/**/*.ts`),
          ...EMIT_UNITS.map((u) => `../src/${u}/**/*.tsx`),
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const run = spawnSync(process.execPath, [tsc, "-p", cfgPath, "--pretty", "false"], { cwd: ROOT, encoding: "utf8" });
  const diagnostics = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  // 只容忍"构建面文件不在 rootDir 内"这类与本次 emit 无关的报错之外的一切？不——一律报出来，
  // 人工判读；转译本身失败时下面会因产物缺失而炸。
  if (diagnostics) console.log("[emit] tsc 诊断：\n" + diagnostics);

  // 2) 摆放：要 emit 的域 + 入口文件 → out；其余（构建面/ui/静态面）丢掉
  fs.rmSync(out, { recursive: true, force: true });
  const staged = walk(EMIT_STAGE);
  const placed = [];
  for (const rel of staged) {
    const isUnit = EMIT_UNITS.some((u) => rel.startsWith(u + "/"));
    const destRel = ENTRY_MAP[rel] ?? (isUnit ? rel : null);
    if (!destRel) continue;
    const abs = path.join(out, destRel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(path.join(EMIT_STAGE, rel), abs);
    placed.push(destRel);
  }

  // 3) 改名 + 改写（keep-js 里的产物保持原名）
  const renames = [];
  for (const rel of placed) {
    if (!rel.endsWith(".js")) continue;
    if (keepJs.has(rel)) continue;
    renames.push([rel, rel.replace(/\.js$/u, ".mjs")]);
  }
  for (const [from, to] of renames) fs.renameSync(path.join(out, from), path.join(out, to));
  const finalList = placed.map((rel) => keepJs.has(rel) ? rel : rel.replace(/\.js$/u, ".mjs"));
  for (const rel of finalList) rewriteFile(path.join(out, rel), rel);

  const bytes = finalList.reduce((sum, rel) => sum + fs.statSync(path.join(out, rel)).size, 0);
  console.log(`[emit] ${finalList.length} 个模块 / ${(bytes / 1024).toFixed(1)} KB → ${path.relative(ROOT, out)}`);
  console.log("[emit] 保持 .js：" + [...keepJs].join(", "));
}

main();
