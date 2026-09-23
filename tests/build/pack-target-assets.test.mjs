// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/pack-target-assets.test.mjs — 出包资产清单与交付锁的一致性闸
//
// assets 只在真打包、依赖物化完之后被逐个断言存在，CI 上要到出包那一刻才碰得到。这里把清单
// 提前对齐到 packaging/pnpm-lock.yaml：名字漂了（上游改包名、换平台切分、或我们写错一个字母）
// 在 PR 上就拦住，不必等一次完整出包才暴露。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { supportedTargetNames, targetSpec } from "../../scripts/release/pack/targets.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_LINES = readFileSync(join(ROOT, "packaging", "pnpm-lock.yaml"), "utf8").split(/\r?\n/);

/** LibreOffice 转换栈的名字根与四个原生 kit；Linux 没有原生形态，那条是 wasm。 */
const LO_KIT = "@deepseek-ai/libreoffice-kit";
const LO_NATIVE = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"];

const targets = supportedTargetNames().map((name) => {
  const spec = targetSpec(name);
  assert.ok(spec, `目标表应能解析 ${name}`);
  return { name, spec };
});

/**
 * 一行的键名：锁里包条目写作 `<名>@<版本>:`、依赖引用写作 `<名>: <版本>`；scoped 名带引号，
 * 非 scoped 名不带。统一的取法是抹掉引号后按第一个分隔符截断，scoped 名跳过开头的 `@`。
 */
function lockKey(line) {
  const cleaned = line.replace(/'/g, "").trim();
  const at = cleaned.indexOf("@", 1);
  const colon = cleaned.indexOf(":");
  const cut = at > 1 && (colon < 0 || at < colon) ? at : colon;
  return cut < 0 ? cleaned : cleaned.slice(0, cut);
}

const lockKeys = new Set(LOCK_LINES.map(lockKey));

/** 锁里是否有这个包的条目。 */
const inLock = (name) => lockKeys.has(name);

test("每个目标的资产清单内部无重复", () => {
  for (const { name, spec } of targets) {
    assert.equal(new Set(spec.assets).size, spec.assets.length, `${name} 的 assets 有重复`);
  }
});

test("清单里的每个资产在交付锁里有条目", () => {
  for (const { name, spec } of targets) {
    for (const asset of spec.assets) {
      assert.ok(inLock(asset), `${name} 的资产 ${asset} 不在 packaging/pnpm-lock.yaml 里`);
    }
  }
});

test("universal 的清单盖住每个平台目标声明的全部资产", () => {
  const covered = new Set(targetSpec("universal").assets);
  for (const { name, spec } of targets) {
    if (name === "universal") continue;
    for (const asset of spec.assets) {
      assert.ok(covered.has(asset), `universal 缺了 ${name} 的资产 ${asset}`);
    }
  }
});

test("LibreOffice 转换栈按平台声明：linux 走 wasm，其余各带本平台原生 kit", () => {
  for (const { name, spec } of targets) {
    const lo = spec.assets.filter((asset) => asset.startsWith(LO_KIT));
    assert.ok(lo.includes(LO_KIT), `${name} 缺 LibreOffice wrapper`);
    if (name === "universal") {
      for (const kit of LO_NATIVE) assert.ok(lo.includes(`${LO_KIT}-${kit}`), `universal 缺原生 kit ${kit}`);
      assert.ok(lo.includes(`${LO_KIT}-wasm`), "universal 缺 wasm kit");
      continue;
    }
    if (spec.os.includes("linux")) {
      assert.deepEqual(lo, [LO_KIT, `${LO_KIT}-wasm`], `${name} 的转换栈应只有 wasm 形态`);
      continue;
    }
    const platform = `${spec.os[0]}-${spec.cpu[0]}`;
    assert.ok(LO_NATIVE.includes(platform), `${name} 的平台不在原生 kit 清单里`);
    assert.deepEqual(lo, [LO_KIT, `${LO_KIT}-${platform}`], `${name} 的转换栈应是原生 ${platform}`);
  }
});
