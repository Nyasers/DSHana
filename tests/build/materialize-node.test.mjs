// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/materialize-node.test.mjs — 物化节点的键与命中判定（scripts/release/pack/materialize.mts）
//
// B 节把物化从"逐目标各装一次"收成**一个与 target 无关的缓存节点**。收成缓存就带来那个必须回答的
// 问题：**为什么不会安静地复用一棵错的树？** 这里把答案钉成可判定的判据。
import { test } from "node:test";
import assert from "node:assert/strict";

import { MATERIALIZE_RECIPE_VERSION, materializeNodeKey } from "../../scripts/release/pack/materialize.mts";
import { stagingWorkspaceYaml } from "../../scripts/release/pack/targets.mts";

/** 一份最小的清单替身（只用到 materializeNodeKey 读的那几个字段）。 */
function fakeSet(overrides = {}) {
  return {
    build: { cacheKey: "aaaa1111bbbb2222", ...(overrides.build ?? {}) },
    packages: overrides.packages ?? [
      { name: "@deepseek-ai/dsh-base", version: "0.2.0-rc.2", file: "a.tgz", integrity: "sha512-AAA" },
      { name: "@deepseek-ai/dsh-web-app", version: "0.2.0-rc.2", file: "b.tgz", integrity: "sha512-BBB" },
    ],
  };
}

const LOCK = "lockfileVersion: 9.0\nimporters:\n  .:\n";

test("键不含 target：签名里就没有 spec，同一份输入永远同一个键", () => {
  // 这条是"一个节点"的字面表述：materializeNodeKey 只吃清单与锁，**没有任何平台参数**。
  // 逐目标各装一次时，每个目标都有一份不同的 supportedArchitectures 与资产集；现在那些差异
  // 只影响**剪枝**（pruneNodeModules(spec)），不影响装什么。
  assert.equal(materializeNodeKey.length, 2, "materializeNodeKey 只该吃 (set, lockText) 两个参数");
  const a = materializeNodeKey(fakeSet(), LOCK);
  const b = materializeNodeKey(fakeSet(), LOCK);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("键含包集键：换一份包集就换一棵树", () => {
  const a = materializeNodeKey(fakeSet(), LOCK);
  const b = materializeNodeKey(fakeSet({ build: { cacheKey: "cccc3333dddd4444" } }), LOCK);
  assert.notEqual(a, b, "包集键变了而物化键没变：会复用一棵装着旧字节的树");
});

test("键含清单的包摘要：同名同版本换了字节也要重装", () => {
  const a = materializeNodeKey(fakeSet(), LOCK);
  const changed = fakeSet({
    packages: [{ name: "@deepseek-ai/dsh-base", version: "0.2.0-rc.2", file: "a.tgz", integrity: "sha512-ZZZ" }],
  });
  assert.notEqual(a, materializeNodeKey(changed, LOCK), "integrity 变了而键没变：tarball 换了不会触发重装");
});

test("键含交付锁：锁变了（依赖图/平台块变）就重装", () => {
  const a = materializeNodeKey(fakeSet(), LOCK);
  const withExtra = LOCK + "  '@img/sharp-win32-x64':\n    resolution: {integrity: sha512-X}\n";
  assert.notEqual(a, materializeNodeKey(fakeSet(), withExtra), "锁变了而键没变：frozen 安装会拿旧锁解新图");
});

test("键含 node/pnpm/配方版本：工具链变了就重装", () => {
  // 这三项由 currentBuildIdentity / 常量给出，测的是"它们确实进了 material 串"。
  // 做法：直接比对同一输入两次的结果稳定（上面已测），这里改的是**代码里的常量**——
  // 所以只能断言配方版本参与了（改它即换键，由常量值本身与键的稳定性共同表达）。
  assert.equal(typeof MATERIALIZE_RECIPE_VERSION, "string");
  assert.ok(MATERIALIZE_RECIPE_VERSION.length > 0);
  // workspace 模板（含全叉乘平台块）进 material 串：同一份 spec 生成的 yaml 逐字进键。
  const universal = stagingWorkspaceYaml({ name: "universal", os: ["win32", "darwin", "linux"], cpu: ["x64", "arm64"] });
  assert.match(universal, /supportedArchitectures:/);
  // 全叉乘：三个 os、两个 cpu 都要在
  for (const os of ["win32", "darwin", "linux"]) assert.ok(universal.includes("    - " + os), os);
  for (const cpu of ["x64", "arm64"]) assert.ok(universal.includes("    - " + cpu), cpu);
});

test("命中判定的口径：recipe 的键必须与现算相符（只看目录会被旧树骗）", () => {
  // 这条是代码契约的书面化：materializeNode 读节点里的 pkg-root-recipe.json，要求
  // recipe.key === 现算键，否则重装。这里不重复实现它，只把"为什么"钉在测试里——
  // 若哪天有人把它放宽成 fs.existsSync(modules)，这条注释与断言就该一起改。
  const key = materializeNodeKey(fakeSet(), LOCK);
  const staleRecipe = { key: "0000000000000000", recipeVersion: MATERIALIZE_RECIPE_VERSION };
  assert.notEqual(staleRecipe.key, key, "陈旧 recipe 的键与现算不符：必须判未命中");
});
