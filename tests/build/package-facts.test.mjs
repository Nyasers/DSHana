// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/package-facts.test.mjs — 产物事实的记录与合并（scripts/release/facts.mts）
//
// 这两步存在的理由是「清单作业不该为取 size 把上百 MB 的包搬第二遍」，而它们的出错方式都很隐蔽：
// 量到 artifact 归档的 size（不是包的大小）、按固定层级找小票、或拿 fs-extra 的 API 去调 node:fs。
// 这里把口径钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeFacts, recordFacts, writeFacts } from "../../scripts/release/facts.mts";

/** 临时目录；用 finally 里的 done() 收。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dshana-facts-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("recordFacts 记下 zip 的字节数与归一化的小写 sha256，缺 .sha256 的 zip 跳过", () => {
  const { dir, done } = fixture();
  try {
    writeFileSync(join(dir, "a.zip"), "x".repeat(1234));
    writeFileSync(join(dir, "a.zip.sha256"), "ABCDEF01\n");
    writeFileSync(join(dir, "b.zip"), "y"); // 没有配套 .sha256
    writeFileSync(join(dir, "note.txt"), "不是产物");
    const facts = recordFacts(dir);
    assert.deepEqual(Object.keys(facts), ["a.zip"]);
    assert.equal(facts["a.zip"].size, 1234);
    assert.equal(facts["a.zip"].sha256, "abcdef01");
  } finally {
    done();
  }
});

test("recordFacts 对不存在的目录返回空表（不抛）", () => {
  assert.deepEqual(recordFacts(join(tmpdir(), "dshana-facts-missing-xyz")), {});
});

test("mergeFacts 递归合并各层的 package-facts.json，同名之外的文件不参与", () => {
  const { dir, done } = fixture();
  try {
    mkdirSync(join(dir, "pkg-facts-win32-x64"), { recursive: true });
    mkdirSync(join(dir, "deeper", "pkg-facts-linux-arm64"), { recursive: true });
    writeFileSync(join(dir, "pkg-facts-win32-x64", "package-facts.json"),
      JSON.stringify({ "w.zip": { size: 1, sha256: "aa" } }));
    writeFileSync(join(dir, "deeper", "pkg-facts-linux-arm64", "package-facts.json"),
      JSON.stringify({ "l.zip": { size: 2, sha256: "bb" } }));
    writeFileSync(join(dir, "deeper", "notes.json"), JSON.stringify({ "x.zip": { size: 9, sha256: "cc" } }));
    const merged = mergeFacts(dir);
    assert.deepEqual(Object.keys(merged).sort(), ["l.zip", "w.zip"]);
    assert.equal(merged["l.zip"].size, 2);
    assert.equal(merged["w.zip"].sha256, "aa");
  } finally {
    done();
  }
});

test("mergeFacts 对不存在的目录返回空表（不抛）", () => {
  assert.deepEqual(mergeFacts(join(tmpdir(), "dshana-facts-missing-xyz")), {});
});

test("writeFacts 落盘为可读 JSON、带末尾换行", () => {
  const { dir, done } = fixture();
  try {
    const out = join(dir, "package-facts.json");
    writeFacts(out, { "a.zip": { size: 3, sha256: "dd" } });
    const text = readFileSync(out, "utf8");
    assert.ok(text.endsWith("\n"), "末尾应有换行");
    assert.deepEqual(JSON.parse(text), { "a.zip": { size: 3, sha256: "dd" } });
  } finally {
    done();
  }
});
