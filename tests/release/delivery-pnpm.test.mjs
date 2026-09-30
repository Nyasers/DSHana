// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/release/delivery-pnpm.test.mjs — 交付链 pnpm 的解析/断言/护栏（scripts/release/pnpm.mts）
//
// 守的是这条洞：交付链原先把版本交给「跑包的哪台机器」决定（裸名 pnpm + 仓内 cwd ⇒ 读到仓根
// packageManager 就自换）。这里把判据钉住——声明怎么读、实际版本怎么判、锁文件怎么护。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GUARDED_LOCKFILES,
  assertLockfileVersion,
  assertLockfilesUnchanged,
  deliveryPnpmEnv,
  expectedLockfileVersion,
  lockfileSnapshot,
  parseReportedPnpmVersion,
  readLockfileVersion,
  readPnpmDeclaration,
} from "../../scripts/release/pnpm.mts";

function fixture(manifest) {
  const dir = mkdtempSync(join(tmpdir(), "dshana-pnpm-"));
  if (manifest !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readPnpmDeclaration：读 packageManager 的版本段（忽略 +sha512 段）", () => {
  const { dir, done } = fixture({ packageManager: "pnpm@12.8.2+sha512.abc" });
  try {
    const d = readPnpmDeclaration(dir);
    assert.equal(d.raw, "pnpm@12.8.2+sha512.abc");
    assert.equal(d.version, "12.8.2");
    assert.equal(d.major, 12);
  } finally { done(); }
});

test("readPnpmDeclaration：缺声明 / 不是 pnpm / 版本读不出 → 一律拒绝（不退化到手边版本）", () => {
  for (const bad of [undefined, {}, { packageManager: "npm@11.0.0" }, { packageManager: "pnpm@latest" }]) {
    const { dir, done } = fixture(bad);
    try {
      assert.throws(() => readPnpmDeclaration(dir), /packageManager|pnpm/);
    } finally { done(); }
  }
});

test("parseReportedPnpmVersion：认收尾行 using pnpm vX，也认裸版本输出", () => {
  assert.equal(parseReportedPnpmVersion("Done in 20.1s using pnpm v12.8.2\n"), "12.8.2");
  assert.equal(parseReportedPnpmVersion("12.8.2\n"), "12.8.2");
  assert.equal(parseReportedPnpmVersion("Done in 1s\n"), null);
  assert.equal(parseReportedPnpmVersion(""), null);
});

test("expectedLockfileVersion：认识的 major 给值，不认识的当场报（fail-closed）", () => {
  assert.equal(expectedLockfileVersion(11), "9.0");
  assert.equal(expectedLockfileVersion(12), "9.0");
  assert.throws(() => expectedLockfileVersion(99), /lockfileVersion/);
});

test("readLockfileVersion：带引号的 9.0 也要读得出", () => {
  assert.equal(readLockfileVersion("lockfileVersion: 9.0\n"), "9.0");
  assert.equal(readLockfileVersion("lockfileVersion: '9.0'\n"), "9.0");
  assert.throws(() => readLockfileVersion("nothing here\n"), /lockfileVersion/);
});

test("assertLockfileVersion：格式与声明版本相符才放行，不符即拒", () => {
  const decl = { raw: "pnpm@12.8.2", version: "12.8.2", major: 12 };
  assert.equal(assertLockfileVersion("lockfileVersion: 9.0\n", decl, "锁"), "9.0");
  assert.throws(() => assertLockfileVersion("lockfileVersion: 8.0\n", decl, "锁"), /lockfileVersion/);
});

test("deliveryPnpmEnv：三条环境纪律齐上，且不改动其它变量", () => {
  const env = deliveryPnpmEnv({ KEEP: "1" });
  assert.equal(env.CI, "true");
  assert.equal(env.npm_config_verify_deps_before_run, "false");
  assert.equal(env.npm_config_manage_package_manager_versions, "false");
  assert.equal(env.KEEP, "1");
});

test("锁文件护栏：两份都在名单里；内容一变就拒，且报出是哪一份", () => {
  assert.deepEqual([...GUARDED_LOCKFILES], ["pnpm-lock.yaml", "packaging/pnpm-lock.yaml"]);
  const { dir, done } = fixture({});
  try {
    mkdirSync(join(dir, "packaging"), { recursive: true });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    writeFileSync(join(dir, "packaging", "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    const before = lockfileSnapshot(dir);
    assert.equal(before.length, 2);
    assert.doesNotThrow(() => assertLockfilesUnchanged(before, "pack", dir));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n# tampered\n");
    assert.throws(() => assertLockfilesUnchanged(before, "pack", dir), /pnpm-lock/);
  } finally { done(); }
});

test("锁文件护栏：文件从不存到存在也算变了（不是只看内容）", () => {
  const { dir, done } = fixture({});
  try {
    const before = lockfileSnapshot(dir);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    assert.throws(() => assertLockfilesUnchanged(before, "pack", dir), /不存在/);
  } finally { done(); }
});

test("交付链现读仓库声明：形如 pnpm@<版本>，且与 package.json 逐字一致", () => {
  const real = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const d = readPnpmDeclaration();
  assert.equal(d.raw, real.packageManager);
  assert.match(d.raw, /^pnpm@\d+\./);
  assert.ok(d.version.startsWith(String(d.major) + "."));
});

test("交叉校验的事实：仓库两份锁文件的 lockfileVersion 都等于声明版本的应有值", () => {
  const decl = readPnpmDeclaration();
  for (const rel of GUARDED_LOCKFILES) {
    const text = readFileSync(new URL("../../" + rel, import.meta.url), "utf8");
    assert.equal(readLockfileVersion(text), expectedLockfileVersion(decl.major), rel);
  }
});
