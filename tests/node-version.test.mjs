// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/node-version.test.mjs — Node 下界断言的解析与覆盖（scripts/shared/root.mts）
// 重点：范围语法只认本仓会写的那几种（认识不了就抛，不静默放行），且每个 CLI 入口都真的
// 加载了这条断言（否则「新增入口忘了 import」会一路无人发现）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { satisfiesNodeRange } from "../scripts/shared/root.mts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_MODULE = join(REPO, "scripts", "shared", "root.mts");

test("satisfiesNodeRange：本仓范围的边界", () => {
  const range = "^22.22.2 || ^24.15.0 || ^26.8.1";
  for (const ok of ["22.22.2", "22.30.0", "24.15.0", "24.20.1", "26.8.1", "26.9.0"]) {
    assert.equal(satisfiesNodeRange(range, ok), true, `应满足：${ok}`);
  }
  for (const bad of ["20.19.0", "22.21.0", "23.0.0", "24.14.9", "25.0.0", "27.0.0"]) {
    assert.equal(satisfiesNodeRange(range, bad), false, `应拒绝：${bad}`);
  }
});

test("satisfiesNodeRange：三种写法各自的语义（支持集是契约）", () => {
  assert.equal(satisfiesNodeRange("22.18.0", "22.18.0"), true);
  assert.equal(satisfiesNodeRange("22.18.0", "22.18.1"), false);
  assert.equal(satisfiesNodeRange(">=22.18.0", "23.0.0"), true);
  assert.equal(satisfiesNodeRange(">=22.18.0", "22.17.9"), false);
  assert.equal(satisfiesNodeRange("^22.18.0", "22.19.0"), true);
  assert.equal(satisfiesNodeRange("^22.18.0", "23.0.0"), false);
});

test("satisfiesNodeRange：不认识的写法当场抛错（不静默放行）", () => {
  assert.throws(() => satisfiesNodeRange("~22.18.0", "26.8.1"), /不支持的写法/);
  assert.throws(() => satisfiesNodeRange(">=22.18.0 <24", "26.8.1"), /不支持的写法/);
  assert.throws(() => satisfiesNodeRange("", "26.8.1"), /空范围/);
});

function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  const patterns = [
    /from\s+"(\.[^"]+)"/g,
    /import\s+"(\.[^"]+)"/g,
    /import\(\s*"(\.[^"]+)"\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

function reachesRootModule(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  if (file === ROOT_MODULE) return true;
  for (const spec of importsOf(file)) {
    const next = resolve(dirname(file), spec);
    if (next === ROOT_MODULE) return true;
    if (existsSync(next) && reachesRootModule(next, seen)) return true;
  }
  return false;
}

test("每个 CLI 入口的 import 闭包都触达 shared/root.mts（版本断言覆盖完整）", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const entries = new Set();
  for (const cmd of Object.values(pkg.scripts)) {
    for (const m of String(cmd).matchAll(/node\s+((?:src|src-cordis|scripts)\/[\w./-]+\.(?:ts|mts))/g)) {
      entries.add(m[1]);
    }
  }
  assert.ok(entries.size >= 10, `入口枚举过少（${entries.size} 条），正则或 scripts 结构变了？`);
  const missing = [...entries].filter((rel) => !reachesRootModule(join(REPO, rel)));
  assert.deepEqual(
    missing,
    [],
    `这些入口的 import 闭包到不了 scripts/shared/root.mts，Node 版本断言覆盖不到：\n  ${missing.join("\n  ")}`,
  );
});
