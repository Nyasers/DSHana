// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/release/delivery-pnpm-section.test.mjs — packageManagerDependencies 指纹闸的单测
// （scripts/release/pnpm.mts 的 expectsPackageManagerDependencies / readPackageManagerDependency /
//   assertLockfilePnpmSection）
//
// 守的是这条洞：声明从 12.x 降回 11.x 时，旧锁里那段 12.x 的 packageManagerDependencies 会被 11.x
// **整个忽略**（11.x 早于这个机制），frozen 探针照旧放行——高版本那半段静默留下。lockfileVersion
// 区分不了（11/12 都写 9.0），所以拿「这一段在不在」当指纹，且**两个方向都判**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertLockfilePnpmSection,
  expectsPackageManagerDependencies,
  readPackageManagerDependency,
} from "../../scripts/release/pnpm.mts";

/** 造一份声明对象（只看 version/major，与 readPnpmDeclaration 的形状一致）。 */
const decl = (version) => ({ raw: "pnpm@" + version, version, major: Number(version.split(".")[0]) });

/** 一份带 packageManagerDependencies 段的锁文件片段（12.x 形状）。 */
const lockWithSection = (specifier) => [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    configDependencies: {}",
  "    packageManagerDependencies:",
  "      pnpm:",
  "        specifier: " + specifier,
  "        version: " + specifier,
  "",
  "packages:",
  "",
].join("\n");

/** 一份不带该段的锁文件片段（11.x 形状）。 */
const lockWithoutSection = ["lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", "", "packages:", ""].join("\n");

test("表：11.x 及更早不写该段，12.x 写（实测：11.7.0/11.24.0 无，12.6.0/12.8.2 有）", () => {
  assert.equal(expectsPackageManagerDependencies(9), false);
  assert.equal(expectsPackageManagerDependencies(10), false);
  assert.equal(expectsPackageManagerDependencies(11), false);
  assert.equal(expectsPackageManagerDependencies(12), true);
  // 表里没有的 major 一律报错（fail-closed，不默认通过）。
  assert.throws(() => expectsPackageManagerDependencies(99), /packageManagerDependencies/);
});

test("readPackageManagerDependency：有段读出 specifier，无段返回 null", () => {
  assert.equal(readPackageManagerDependency(lockWithSection("12.8.2")), "12.8.2");
  assert.equal(readPackageManagerDependency(lockWithSection("12.6.0")), "12.6.0");
  assert.equal(readPackageManagerDependency(lockWithoutSection), null);
  // 带引号也要读得出。
  assert.equal(readPackageManagerDependency(lockWithSection("'12.8.2'")), "12.8.2");
});

test("正向（声明 11.x · 不写该段）：锁里带该段即拒——降级静默残留的正面拦截", () => {
  const d = decl("11.7.0");
  assert.equal(assertLockfilePnpmSection(lockWithoutSection, d, "锁"), false, "无段应放行");
  assert.throws(() => assertLockfilePnpmSection(lockWithSection("12.8.2"), d, "锁"), /packageManagerDependencies/);
  assert.throws(() => assertLockfilePnpmSection(lockWithSection("12.6.0"), d, "锁"), /12\.6\.0/);
});

test("反向（声明 12.x · 应写该段）：锁里没有该段也拒，不默默放过", () => {
  const d = decl("12.8.2");
  assert.equal(assertLockfilePnpmSection(lockWithSection("12.8.2"), d, "锁"), true, "有段且相符应放行");
  assert.throws(() => assertLockfilePnpmSection(lockWithoutSection, d, "锁"), /packageManagerDependencies/);
});

test("有段但 specifier 与声明不符：拒（段在、版本错，同属要重派生）", () => {
  const d = decl("12.8.2");
  assert.throws(() => assertLockfilePnpmSection(lockWithSection("12.6.0"), d, "锁"), /12\.6\.0/);
});

test("真实树：仓根锁文件的指纹与当前声明相符（现读声明，不写死版本）", async () => {
  // 派生出来的交付锁已搬进 .cache/dsh-build/<键>/（B 节），不在工作树里；它的同一道指纹闸由
  // derive 的 package-lock 任务在消费侧做（inspect / repair）。
  const { readPnpmDeclaration } = await import("../../scripts/release/pnpm.mts");
  const d = readPnpmDeclaration();
  for (const rel of ["pnpm-lock.yaml"]) {
    const text = readFileSync(new URL("../../" + rel, import.meta.url), "utf8");
    // 不抛即通过；顺带把「段的有无」与期望对齐一次。
    assert.doesNotThrow(() => assertLockfilePnpmSection(text, d, rel));
    assert.equal(readPackageManagerDependency(text) !== null, expectsPackageManagerDependencies(d.major), rel);
  }
});
