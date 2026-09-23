// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/session-run.test.mjs — open 的 cwd 前置校验（src/lib/session-run.ts）
//
// 钉住四件事：绝对路径 / 存在 / 是目录 三条各自会被拒，合法目录放过。校验发生在提交前——
// 会话一旦建立，cwd 就是记录值，之后每次 spawn 都从它出发。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireUsableSessionCwd } from "../../src/lib/session-run.ts";

test("合法目录放过", () => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-cwd-"));
  try {
    assert.equal(requireUsableSessionCwd(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("相对路径被拒（App 与受管 runtime 的解析基准不同）", () => {
  assert.throws(() => requireUsableSessionCwd("workspace"), /必须是绝对路径/);
  assert.throws(() => requireUsableSessionCwd(".\\workspace"), /必须是绝对路径/);
});

test("不存在的绝对路径被拒", () => {
  const missing = join(tmpdir(), "dshana-cwd-missing-" + Date.now());
  assert.throws(() => requireUsableSessionCwd(missing), /cwd 不存在/);
});

test("指向文件的绝对路径被拒", () => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-cwd-"));
  const file = join(dir, "not-a-dir.txt");
  try {
    writeFileSync(file, "x");
    assert.throws(() => requireUsableSessionCwd(file), /cwd 不是目录/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
