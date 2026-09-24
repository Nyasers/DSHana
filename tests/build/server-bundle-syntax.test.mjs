// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/server-bundle-syntax.test.mjs — server 半产物语法闸（src-cordis/build/server-config.mts）单测
//
// 重点是「构建成功」与「node 读得进去」之间的那道缝：标准装饰器没被降级时产物照样被写出来，
// 只有 node parse 才看得见。这里钉住闸的两种反应（放过合法 ESM / 拦住装饰器残留）与现场清理。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertNoSourcePathLeak, assertParseableModule } from "../../src-cordis/build/server-config.mts";

/** 在临时目录里写一份产物跑闸；返回抛出的错误（没抛为 null）与闸留下的临时文件。 */
function runGate(name, text) {
  const dir = mkdtempSync(join(tmpdir(), "dshana-syntax-"));
  try {
    const file = join(dir, name);
    writeFileSync(file, text, "utf8");
    let error = null;
    try {
      assertParseableModule(file);
    } catch (e) {
      error = e;
    }
    const leftovers = readdirSync(dir).filter((f) => f.startsWith(".syntax-check-"));
    return { error, leftovers };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("合法 ESM 放过（import / export / class）", () => {
  const { error } = runGate(
    "ok.js",
    'import { join } from "node:path";\nexport class A { m() { return join("a", "b"); } }\n',
  );
  assert.equal(error, null);
});

test("标准装饰器残留（转译器没降级时的形状）被拒", () => {
  const { error } = runGate("bad.js", "export class ApiSessionController {\n  @(void 0)\n  list() {}\n}\n");
  assert.ok(error, "带装饰器残留的产物必须被拒");
  assert.match(String(error.message), /产物语法不合法/);
});

test("闸不留现场：无论过不过，查完的临时文件都被删掉", () => {
  assert.deepEqual(runGate("ok.js", "export const a = 1;\n").leftovers, []);
  assert.deepEqual(runGate("bad.js", "class A { @(void 0) m() {} }\n").leftovers, []);
});

test("路径泄漏闸：冻进产物的源码路径被拒，运行期形态放过", () => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-leak-"));
  try {
    const stage = join(dir, "integrations-src", "pkg");
    mkdirSync(stage, { recursive: true });
    // 泄漏形态：解析器把 import.meta.url 静态求值成源码文件 URL
    const leaked = join(dir, "leaked.js");
    writeFileSync(leaked, `const u = '${pathToFileURL(stage).href}/src/x.ts'\n`, "utf8");
    assert.throws(() => assertNoSourcePathLeak(leaked, stage), /产物含构建机源码路径/);
    // 运行期形态：路径元数据原样留给运行时
    const clean = join(dir, "clean.js");
    writeFileSync(clean, "const u = import.meta.url\n", "utf8");
    assert.equal(assertNoSourcePathLeak(clean, stage), undefined);
    // 只有相对路径片段（打包器的 CONCATENATED MODULE 注释）不算泄漏：绝对路径才算
    const relative = join(dir, "relative.js");
    writeFileSync(relative, "// CONCATENATED MODULE: ./.tmp/integrations-src/pkg/src/x.ts\n", "utf8");
    assert.equal(assertNoSourcePathLeak(relative, stage), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
