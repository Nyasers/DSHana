// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/release/pnpm-chains-unified.test.mjs — 跨链 pnpm 相等不变量（scripts/release/pnpm.mts
// 的 assertPnpmChainsUnified）
//
// 「两条链统一到一个 pnpm」若只靠各自「实际 == 自己的声明」，只能证明各自自洽：检出 pin 是 11.7.0、
// 本仓声明是 12.x 时，两条都自洽却不统一，而交付树的形状是两者合起来的结果。这里把相等钉成**被
// 检查的不变量**，让「统一」可验证。
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertPnpmChainsUnified } from "../../scripts/release/pnpm.mts";

test("相等：两条链同为 11.7.0 时放行，并回传该版本", () => {
  assert.equal(assertPnpmChainsUnified("11.7.0", "11.7.0"), "11.7.0");
  assert.equal(assertPnpmChainsUnified("12.8.2", "12.8.2"), "12.8.2");
});

test("不等即拒：报出两边的值，并说明「上游 pin 一动、声明也得跟」这条代价", () => {
  assert.throws(
    () => assertPnpmChainsUnified("11.7.0", "12.8.2"),
    (error) => {
      assert.match(error.message, /11\.7\.0/);
      assert.match(error.message, /12\.8\.2/);
      assert.match(error.message, /构建链/);
      assert.match(error.message, /交付链/);
      // 代价要写在错误信息里（提示修法），而不只是判"不等"。
      assert.match(error.message, /packageManager/);
      return true;
    },
  );
});

test("反向不等也拒（不是只判一个方向）", () => {
  assert.throws(() => assertPnpmChainsUnified("12.8.2", "11.7.0"), /12\.8\.2/);
});

test("清单里缺构建链版本：拒（不能因为读不出就默认通过）", () => {
  assert.throws(() => assertPnpmChainsUnified("", "11.7.0"), /build\.pnpm/);
  assert.throws(() => assertPnpmChainsUnified(undefined, "11.7.0"), /build\.pnpm/);
});

test("真实仓库：当前声明与清单的 build.pnpm 一致——本仓此刻确实「统一」", async () => {
  const { readPnpmDeclaration } = await import("../../scripts/release/pnpm.mts");
  const { readPackageSet } = await import("../../scripts/release/package-set.mts");
  const set = readPackageSet();
  assert.notEqual(set, null, "包集清单应存在");
  const decl = readPnpmDeclaration();
  // 交付链实际版本无从在纯单测里解析（要起进程），但本仓现态是「声明 == 清单构建链版本」，
  // 故这条等价于「清单的那一格 == 声明」。真正的「实际」断言由 pack 的 1.9 用实际解析值做。
  assert.equal(set.build.pnpm, decl.version, "build.pnpm 应与本仓 packageManager 一致");
  assert.equal(assertPnpmChainsUnified(set.build.pnpm, decl.version), decl.version);
});
