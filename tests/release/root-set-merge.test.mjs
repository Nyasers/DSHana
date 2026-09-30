// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/release/root-set-merge.test.mjs — 根集合并去重与"上游名单自相矛盾"的边界
// （scripts/release/package-set.mts 的 deriveRootSet）
//
// 背景（实测踩到）：根集 = 模板 bundles ∪ 可选 bundle 名单 ∪ 我们的 @dshana/* 枚举。把
// @dshana/app 加进模板后，同一个包从两个合法来源进来，旧的"重复即 throw"当场炸。这里把修正后的
// 语义钉住：**跨来源合并去重，且我们的枚举赢类别**；上游名单内部重复仍然报。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveRootSet } from "../../scripts/release/package-set.mts";

/**
 * 造一份"已装的 app-boot"：一份 package.json + 一份能被 import 的 lib/index.js。
 *
 * 走真 import 而不是塞替身：deriveRootSet 读的就是**交付产物导出的**那张表（这正是"清单描述的
 * 是交付树里会跑的那份"这条口径的落点），用替身就把要测的东西换掉了。
 */
async function withAppBoot({ templates, optionalBundles }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "dshana-appboot-"));
  try {
    mkdirSync(join(dir, "lib"), { recursive: true });
    // type: module —— 否则 node 每次都要重新判定 lib/index.js 的模块类型（刷一屏 MODULE_TYPELESS
    // 警告），真实 app-boot 也是 ESM。
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-app-boot", version: "0.0.0-test", type: "module" }) + "\n",
    );
    writeFileSync(
      join(dir, "lib", "index.js"),
      `export const PROFILE_TEMPLATES = ${JSON.stringify(templates)}\n` +
        `export const OPTIONAL_BUNDLES = ${JSON.stringify(optionalBundles)}\n`,
    );
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("跨来源重叠（模板里的 @dshana/app 同时在我们的枚举里）合并不报，且类别归 dshana", async () => {
  await withAppBoot(
    { templates: { dshana: { bundles: ["@deepseek-ai/dsh-base", "@dshana/app"] } }, optionalBundles: [] },
    async (dir) => {
      const { entries, upstream } = await deriveRootSet(dir);
      const byName = new Map(entries.map((e) => [e.name, e.category]));
      // 去重：名字只出现一次。
      assert.equal(entries.filter((e) => e.name === "@dshana/app").length, 1, "@dshana/app 重复了");
      // 类别归 dshana——这是契约：dshana 类不在 T1 包集里，若归 profile-template 会被
      // checkPackageSet 的"根集包必须在 packages 里"当场判漂。
      assert.equal(byName.get("@dshana/app"), "dshana", "@dshana/app 的类别必须归 dshana（我们的枚举赢）");
      // 我们真实的 @dshana/* 一族都在（真源是 src-cordis 的 package.json，不是替身）。
      for (const name of ["@dshana/app", "@dshana/clipboard", "@dshana/provider", "@dshana/theme"]) {
        assert.equal(byName.get(name), "dshana", name + " 不在 dshana 类里");
      }
      // 上游名单照旧逐字记着（摘掉重叠不丢信息——模板原始三层的证据在 upstream 里）。
      assert.deepEqual(upstream.templateBundles, ["@deepseek-ai/dsh-base", "@dshana/app"]);
    },
  );
});

test("上游名单内部重复（模板 ∩ 可选）仍然报——那是名单自相矛盾，不是跨来源重叠", async () => {
  await withAppBoot(
    {
      templates: { dshana: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-experimental-auto-review"] } },
      optionalBundles: ["@deepseek-ai/dsh-experimental-auto-review"],
    },
    async (dir) => {
      await assert.rejects(
        () => deriveRootSet(dir),
        /上游根集名单里重复的包名/,
        "同一层既在模板又在可选名单里：必须报，不能被去重盖过去",
      );
    },
  );
});

test("同一份模板名单里列了两遍：同样报", async () => {
  await withAppBoot(
    { templates: { dshana: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-base"] } }, optionalBundles: [] },
    async (dir) => {
      await assert.rejects(() => deriveRootSet(dir), /上游根集名单里重复的包名/);
    },
  );
});

test("模板里没有我们的模板条目时点名报（不能让根集拍名单）", async () => {
  await withAppBoot({ templates: { web: { bundles: ["@deepseek-ai/dsh-base"] } }, optionalBundles: [] }, async (dir) => {
    await assert.rejects(() => deriveRootSet(dir), /没有 dshana\.bundles/);
  });
});

test("类别保序：上游名单在前（保序），dshana 一族追加在后", async () => {
  await withAppBoot(
    {
      templates: { dshana: { bundles: ["@deepseek-ai/dsh-base", "@dshana/app"] } },
      optionalBundles: ["@deepseek-ai/dsh-experimental-auto-review"],
    },
    async (dir) => {
      const { entries } = await deriveRootSet(dir);
      const names = entries.map((e) => e.name);
      // 上游顺序没被我们的去重打乱：base 在前、可选紧随；我们的族在最后。
      assert.equal(names[0], "@deepseek-ai/dsh-base");
      assert.equal(names[1], "@deepseek-ai/dsh-experimental-auto-review");
      assert.deepEqual(names.slice(2), ["@dshana/app", "@dshana/clipboard", "@dshana/provider", "@dshana/theme"]);
    },
  );
});
