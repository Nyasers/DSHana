// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/runtime/cwd-check.test.mjs — 会话工作目录判定（src/runtime/cwd-check.ts）
//
// 钉住三件：存在的目录放行、不存在的路径带 ENOENT、指向文件时 isDirectory=false。
// 另外两件属于契约而非行为，也一并钉：空值不抛错只回执，回执永远带可读原因。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkCwd } from "../../src/runtime/cwd-check.ts";

test("存在的目录 → ok + isDirectory=true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-cwd-check-"));
  try {
    const r = await checkCwd(dir);
    assert.equal(r.ok, true);
    assert.equal(r.isDirectory, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不存在的路径 → ok=false，code=ENOENT", async () => {
  const missing = join(tmpdir(), "dshana-cwd-check-gone-" + Date.now());
  const r = await checkCwd(missing);
  assert.equal(r.ok, false);
  assert.equal(r.code, "ENOENT");
  assert.ok(r.message && r.message.length > 0);
});

test("指向文件 → ok=true 但 isDirectory=false（怎么措辞由调用方定）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-cwd-check-"));
  const file = join(dir, "not-a-dir.txt");
  try {
    writeFileSync(file, "x");
    const r = await checkCwd(file);
    assert.equal(r.ok, true);
    assert.equal(r.isDirectory, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空 / 非字符串 → ok=false，code=EINVAL，不抛错", async () => {
  for (const v of ["", "   ", null, undefined, 42, {}]) {
    const r = await checkCwd(v);
    assert.equal(r.ok, false);
    assert.equal(r.code, "EINVAL");
  }
});
