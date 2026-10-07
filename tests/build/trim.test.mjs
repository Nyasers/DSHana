// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/trim.test.mjs — 交付面裁剪（scripts/release/pack/trim.mts）
//
// 要钉住两层口径：规则命中的运行时不读文件确实被裁掉；以及三类不能动的——没有编译产物的包
// （源码就是运行入口）、package.json 与许可文件（合规与包解析）、以及依赖树之外的 App 交付面。
// 最后一条靠「只扫 node_modules 且跳过 @dshana」这条边界保住，测试同时验证这条边界。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeTrim, trimDeliveryTree } from "../../scripts/release/pack/trim.mts";

/** 临时包根；用 finally 里的 done() 收。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dshana-trim-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 写一个文件，自动建目录。 */
function put(root, rel, content = "x") {
  const abs = join(root, ...rel.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** 一套覆盖三类情形的假包根。 */
function sample(root) {
  // App 交付面（在 node_modules 之外）
  put(root, "manifest.json", "{}");
  put(root, "bin/index.mjs");
  put(root, "ui/app.js");
  // foo：有编译产物，所以源码与类型都是可裁的
  put(root, "node_modules/foo/package.json", "{}");
  put(root, "node_modules/foo/index.js");
  put(root, "node_modules/foo/LICENSE");
  put(root, "node_modules/foo/src/index.ts");
  put(root, "node_modules/foo/types/index.d.ts");
  put(root, "node_modules/foo/test/foo.test.js");
  put(root, "node_modules/foo/docs/readme.md");
  put(root, "node_modules/foo/.yarn/plugin.cjs");
  put(root, "node_modules/foo/data.json", "{}");
  // bar：只有源码，没有编译产物，不能裁
  put(root, "node_modules/bar/package.json", "{}");
  put(root, "node_modules/bar/index.ts");
  // @dshana：我们自己的产物，整片跳过
  put(root, "node_modules/@dshana/dsh-app/package.json", "{}");
  put(root, "node_modules/@dshana/dsh-app/src/patch.ts");
}

test("规则命中的依赖树文件被裁掉，清单与许可留下", () => {
  const { dir, done } = fixture();
  try {
    sample(dir);
    const report = trimDeliveryTree(dir);
    const gone = [
      "node_modules/foo/src/index.ts",
      "node_modules/foo/types/index.d.ts",
      "node_modules/foo/test/foo.test.js",
      "node_modules/foo/docs/readme.md",
      "node_modules/foo/.yarn/plugin.cjs",
    ];
    for (const rel of gone) assert.equal(existsSync(join(dir, ...rel.split("/"))), false, `${rel} 应被裁掉`);
    const kept = [
      "node_modules/foo/package.json",
      "node_modules/foo/index.js",
      "node_modules/foo/LICENSE",
      "node_modules/foo/data.json",
    ];
    for (const rel of kept) assert.equal(existsSync(join(dir, ...rel.split("/"))), true, `${rel} 应保留`);
    assert.equal(report.files, 5, "本样本应裁掉 5 个文件");
    assert.ok(report.byRule["包内源码与类型声明"]?.files === 2, "源码与类型声明各记一条");
    assert.ok(report.byRule["测试目录"]?.files === 1, "测试文件记一条");
    assert.ok(report.byRule["文档与示例"]?.files === 1, "文档记一条");
    assert.ok(report.byRule["构建与仓库元数据"]?.files === 1, ".yarn 记一条");
  } finally {
    done();
  }
});

test("没有编译产物的包不裁源码（否则包会失去运行入口）", () => {
  const { dir, done } = fixture();
  try {
    sample(dir);
    trimDeliveryTree(dir);
    assert.equal(existsSync(join(dir, "node_modules", "bar", "index.ts")), true, "只发源码的包必须整包保留");
  } finally {
    done();
  }
});

test("不碰依赖树之外的交付面与 @dshana 产物", () => {
  const { dir, done } = fixture();
  try {
    sample(dir);
    trimDeliveryTree(dir);
    for (const rel of ["manifest.json", "bin/index.mjs", "ui/app.js", "node_modules/@dshana/dsh-app/src/patch.ts"]) {
      assert.equal(existsSync(join(dir, ...rel.split("/"))), true, `${rel} 不应被动`);
    }
  } finally {
    done();
  }
});

test("裁剪报告给出总量与按规则明细", () => {
  const { dir, done } = fixture();
  try {
    sample(dir);
    const report = trimDeliveryTree(dir);
    assert.ok(report.bytes > 0, "报告应带字节数");
    const text = describeTrim(report, "[test]");
    assert.match(text, /^\[test\] 交付面裁剪：5 个文件/, "摘要首行给出总量");
    assert.match(text, /包内源码与类型声明/, "摘要列出规则明细");
  } finally {
    done();
  }
});

test("node_modules 不存在时返回空报告（不抛）", () => {
  const { dir, done } = fixture();
  try {
    const report = trimDeliveryTree(dir);
    assert.deepEqual(report, { files: 0, bytes: 0, byRule: {} });
  } finally {
    done();
  }
});
