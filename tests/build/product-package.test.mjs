// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/product-package.test.mjs — 交付树 package.json 的字段契约
// （scripts/release/pack/assert.mts 的 assertProductPackage + 派生源 src/product-package.json）
//
// 守的是「构建面不进安装包」：仓库那份带着 scripts/devDependencies/packageManager/imports，
// 装机侧没有消费方，混进去只会让人读出错觉。
//
// T3 起交付面清单退成**铭牌**：物化输入由包集清单派生（install-source.mts），这份不再装依赖，
// 所以只有 name / type / version 三个键——**没有 dependencies**。旧测试还按"四件齐全"写，
// 正是本文件要防的那类"契约漂了而测试没跟上"，故一并收口。
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

test("交付树 package.json：三件齐全且版本一致时放行", () => {
  withDist({ name: "dshana", type: "module", version: VERSION }, (dir) => {
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
    withDist({ name: "dshana", type: "module", version: VERSION, ...extra }, (dir) => {
      assert.throws(() => assertProductPackage(dir, VERSION), /字段不对/, JSON.stringify(extra));
    });
  }
});

test("dependencies 不再允许（铭牌不装依赖：物化输入走包集清单）", () => {
  withDist({ name: "dshana", type: "module", version: VERSION, dependencies: { "@deepseek-ai/dsh": "0.1.6-alpha.2" } }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /字段不对/);
  });
});

test("缺必填键也拒包（version 不在 = 漏了派生同步）", () => {
  withDist({ name: "dshana", type: "module" }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /字段不对/);
  });
});

test("文件缺失 / 版本漂移 / type 不是 module 一律拒包", () => {
  withDist(undefined, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /缺失/);
  });
  withDist({ name: "dshana", type: "module", version: "1.0.0-rc.16" }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /≠ 本次出包版本/);
  });
  withDist({ name: "dshana", type: "commonjs", version: VERSION }, (dir) => {
    assert.throws(() => assertProductPackage(dir, VERSION), /type/);
  });
});

test("派生出的铭牌（src/product-package.json）就在白名单内，且与根 package.json 一致", async () => {
  // 铭牌整份由 derive 的 product-package 任务从根 package.json 派生——这里守"派生物没漂"：
  // 键集合逐字相符 + 三格的值都等于根的对应格。派生物漂了，断言 assertProductPackage 是查不出来的
  //（它只看形状与版本，不看来源）。
  const fs = await import("node:fs");
  const real = JSON.parse(fs.readFileSync(new URL("../../src/product-package.json", import.meta.url), "utf8"));
  const root = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(real).sort(), [...PRODUCT_PACKAGE_KEYS].sort());
  assert.equal(real.type, "module");
  assert.equal(real.name, root.name, "铭牌的 name 应等于根 package.json 的 name");
  assert.equal(real.version, root.version, "铭牌的 version 应等于根 package.json 的 version");
  assert.equal(real.type, root.type, "铭牌的 type 应等于根 package.json 的 type");
});
