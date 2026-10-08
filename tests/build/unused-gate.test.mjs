// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/unused-gate.test.mjs — 未使用声明闸的两半必须在位
//
// 闸由两半合成：域 tsconfig 的 noUnusedLocals 决定 tsc 报不报，ts-diagnostics 的 FAIL_CODES
// 决定报出来拦不拦。任一被关掉，未使用导入就会重新静静淤积（有过一次：15 个死导入没人发现）。
// 这里把两半钉住——本文件不跑 tsc，只断言开关与清单本身。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FAIL_CODES } from "../../scripts/shared/ts-diagnostics.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("每个域配置都开着 noUnusedLocals（tsc 才会上报）", () => {
  const configs = readdirSync(ROOT).filter((name) => /^tsconfig\..+\.json$/.test(name));
  assert.ok(configs.length >= 10, `域配置数量异常（${configs.length}）：${configs.join(", ")}`);
  for (const name of [...configs, "tsconfig.json"]) {
    const text = readFileSync(join(ROOT, name), "utf8");
    assert.match(text, /"noUnusedLocals"\s*:\s*true/, `${name} 的 noUnusedLocals 不是 true（闸的一半没了）`);
  }
});

test("未使用家族进了失败清单（报出来就拦）", () => {
  for (const code of ["TS6133", "TS6192", "TS6196"]) {
    assert.ok(FAIL_CODES.has(code), `${code} 不在 FAIL_CODES：报出来也只会计入不拦`);
  }
});
