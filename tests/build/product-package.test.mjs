// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/product-package.test.mjs — 交付树 package.json 的字段契约与生成器
// （scripts/release/pack/assert.mts 的 assertProductPackage + scripts/release/pack/ship-manifest.mts）
//
// 守的是「构建面不进安装包」：仓库那份带着 scripts/devDependencies/packageManager/imports，
// 装机侧没有消费方，混进去只会让人读出错觉。包根那份由 pack 现生成，只有 name / version / type——
// 内核声明住 host（@dshana/host 的 dependencies），交付树里不再抄第二份。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_PACKAGE_KEYS, assertProductPackage } from "../../scripts/release/pack/assert.mts";
import { shipManifest, stagingManifest } from "../../scripts/release/pack/ship-manifest.mts";

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

test("交付树 package.json：三件齐全且版本一致时放行", () => {
  withDist({ name: "dshana", version: VERSION, type: "module" }, (dir) => {
    assert.doesNotThrow(() => assertProductPackage(dir, VERSION));
  });
});

test("构建面字段混进来就拒包（scripts/devDependencies/packageManager/imports/private/dependencies）", () => {
  for (const extra of [
    { scripts: { build: "node packages/app/src/build.ts" } },
    { devDependencies: { typescript: "^7.0.2" } },
    { packageManager: "pnpm@12.3.4" },
    { imports: {} },
    { private: true },
    // 内核声明住 host：包根再抄一份 dependencies 也算构建面（它不是交付树要的字段）
    { dependencies: { "@deepseek-ai/dsh": "0.1.6-alpha.2" } },
  ]) {
    withDist({ name: "dshana", version: VERSION, type: "module", ...extra }, (dir) => {
      assert.throws(() => assertProductPackage(dir, VERSION), /字段不对/, JSON.stringify(extra));
    });
  }
});

test("缺必填键也拒包（name / type / version 少一个都不行）", () => {
  withDist({ name: "dshana", version: VERSION }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /字段不对/);
  });
});

test("文件缺失 / 版本漂移 / type 不是 module 一律拒包", () => {
  withDist(undefined, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /缺失/);
  });
  withDist({ name: "dshana", version: "1.0.0-rc.16", type: "module" }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /≠ 本次出包版本/);
  });
  withDist({ name: "dshana", version: VERSION, type: "commonjs" }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /type/);
  });
});

test("shipManifest 生成的就是白名单那几件，版本跟随入参", () => {
  const j = shipManifest(VERSION);
  assert.deepEqual(Object.keys(j).sort(), [...PRODUCT_PACKAGE_KEYS].sort());
  assert.equal(j.version, VERSION);
  assert.equal(j.type, "module");
  assert.equal(j.name, "dshana");
  assert.equal(j.dependencies, undefined, "包根不抄内核声明");
});

test("stagingManifest 带上 host 派生的运行时依赖（剔除 workspace 在仓项），其余字段与包根一致", async () => {
  const { dshPin, shipDependencies } = await import("../../scripts/shared/version.mts");
  const staging = stagingManifest(VERSION);
  const deps = shipDependencies();
  assert.deepEqual(staging.dependencies, deps);
  assert.ok(dshPin(), "host 应声明 @deepseek-ai/dsh");
  assert.equal(staging.dependencies["@deepseek-ai/dsh"], dshPin());
  for (const [name, spec] of Object.entries(deps)) {
    assert.ok(!String(spec).startsWith("workspace:"), `${name} 是 workspace 在仓项，不该进交付面`);
  }
  const { dependencies: _deps, ...rest } = staging;
  assert.deepEqual(rest, shipManifest(VERSION));
});
