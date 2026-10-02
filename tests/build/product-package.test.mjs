// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/product-package.test.mjs — 交付树的包清单契约
// （scripts/release/pack/assert.mts 的 assertNoProductPackage + scripts/release/pack/ship-manifest.mts
//  的 stagingManifest）
//
// 守两件事。其一：安装树里不得出现 package.json——App 入口是 index.mjs，Node 按扩展名就判 ESM，
// 包根没有需要它定 type 的地方；它出现只可能是构建面字段（scripts / devDependencies /
// packageManager / imports / 内核声明）混进交付。其二：工位清单只活在 .tmp/pkg-root/ 那次干净
// 安装里，字段是实体三项 + host 派生的运行时依赖（内核声明住 host，不抄第二份）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoProductPackage } from "../../scripts/release/pack/assert.mts";
import { stagingManifest } from "../../scripts/release/pack/ship-manifest.mts";

const VERSION = "1.0.0-rc.17+dsh-0.1.6-alpha.2";

function withDist(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), "dshana-pkg-"));
  try {
    if (contents !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify(contents, null, 2));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("交付树没有 package.json（App 安装树形态）：放行", () => {
  withDist(undefined, (dir) => {
    assert.doesNotThrow(() => assertNoProductPackage(dir));
  });
});

test("交付树出现 package.json 就拒包（无论字段是构建面还是实体项）", () => {
  for (const contents of [
    { name: "dshana", version: VERSION, type: "module" },
    { name: "dshana", version: VERSION, type: "module", scripts: { build: "node packages/app/src/build.ts" } },
    { devDependencies: { typescript: "^7.0.2" }, packageManager: "pnpm@12.3.4" },
    { version: VERSION, type: "module", dependencies: { "@deepseek-ai/dsh": "0.1.6-alpha.2" } },
  ]) {
    withDist(contents, (dir) => {
      assert.throws(() => assertNoProductPackage(dir), /出现了 package\.json/, JSON.stringify(contents));
    });
  }
});

test("stagingManifest：实体三项 + host 派生的运行时依赖，版本跟随入参", async () => {
  const { dshPin, shipDependencies } = await import("../../scripts/shared/version.mts");
  const staging = stagingManifest(VERSION);
  assert.deepEqual(Object.keys(staging).sort(), ["dependencies", "name", "type", "version"]);
  assert.equal(staging.name, "dshana");
  assert.equal(staging.version, VERSION);
  assert.equal(staging.type, "module", "工位里 pnpm 与 node 都按 ESM 读它");
  assert.deepEqual(staging.dependencies, shipDependencies());
  assert.ok(dshPin(), "host 应声明 @deepseek-ai/dsh");
  assert.equal(staging.dependencies["@deepseek-ai/dsh"], dshPin(), "工位清单的内核声明从 host 派生");
});

test("stagingManifest 的依赖剔除 workspace 在仓项（交付面只留发布版号）", async () => {
  const { shipDependencies } = await import("../../scripts/shared/version.mts");
  for (const [name, spec] of Object.entries(shipDependencies())) {
    assert.ok(!String(spec).startsWith("workspace:"), `${name} 是 workspace 在仓项，不该进交付面`);
  }
  const staging = stagingManifest(VERSION);
  assert.ok(staging.dependencies && Object.keys(staging.dependencies).length > 0, "工位清单不能没有依赖");
});
