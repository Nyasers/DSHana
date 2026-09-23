// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/product-package.test.mjs — 交付树 package.json 的字段契约
// （scripts/release/pack/assert.mts 的 assertProductPackage + packaging/package.json）
//
// 守的是「构建面不进安装包」：仓库那份带着 scripts/devDependencies/packageManager/imports，
// 装机侧没有消费方，混进去只会让人读出错觉。交付树那份只有 name/version/type + dependencies
// （后者是交付清单自己的运行时依赖声明，**唯一真源**；见 packaging/README.md）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_PACKAGE_KEYS, assertProductPackage } from "../../scripts/release/pack/assert.mts";

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

test("交付树 package.json：四件齐全且版本一致时放行", () => {
  withDist({ name: "dshana", version: VERSION, type: "module", dependencies: { "@deepseek-ai/dsh": "0.1.6-alpha.2" } }, (dir) => {
    assert.doesNotThrow(() => assertProductPackage(dir, VERSION));
  });
});

test("构建面字段混进来就拒包（scripts/devDependencies/packageManager/imports/private）", () => {
  for (const extra of [
    { scripts: { build: "node src/build.ts" } },
    { devDependencies: { typescript: "^7.0.2" } },
    { packageManager: "pnpm@12.3.4" },
    { imports: { "#/*": "./src/*" } },
    { private: true },
  ]) {
    withDist({ name: "dshana", version: VERSION, type: "module", dependencies: {}, ...extra }, (dir) => {
      assert.throws(() => assertProductPackage(dir, VERSION), /字段不对/, JSON.stringify(extra));
    });
  }
});

test("缺必填键也拒包（dependencies 不在 = 漏了交付面清单）", () => {
  withDist({ name: "dshana", version: VERSION, type: "module" }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /字段不对/);
  });
});

test("文件缺失 / 版本漂移 / type 不是 module 一律拒包", () => {
  withDist(undefined, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /缺失/);
  });
  withDist({ name: "dshana", version: "1.0.0-rc.16", type: "module", dependencies: {} }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /≠ 本次出包版本/);
  });
  withDist({ name: "dshana", version: VERSION, type: "commonjs", dependencies: {} }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /type/);
  });
});

test("packaging/package.json 自身就在白名单内（实体文件与契约同源）", async () => {
  const fs = await import("node:fs");
  const real = JSON.parse(fs.readFileSync(new URL("../../packaging/package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(real).sort(), [...PRODUCT_PACKAGE_KEYS].sort());
  assert.equal(real.type, "module");
});
