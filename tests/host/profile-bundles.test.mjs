// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/host/profile-bundles.test.mjs — profile 层列表口径（packages/host/src/profile-bundles.ts）
//
// 为什么钉这里：`dsh.profile.bundles` 是用户与插件管理面的落点（打开可选 bundle、自装插件都写它）。
// 安装方只能做两件——建目录时写初始层列，以及把精确匹配的**退役元组**迁过来；多动一下就抹用户开关，
// 而这在单测外面很难发现（装的包还在、层列却少了它）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BASE_BUNDLE,
  OWN_BUNDLE,
  PROFILE_BUNDLES,
  RETIRED_TUPLES,
  migrateProfileBundles,
} from "../../packages/host/src/profile-bundles.ts";

const WEB_APP = "@deepseek-ai/dsh-web-app";

test("初始层列：底座在前，本层紧随", () => {
  assert.deepEqual(PROFILE_BUNDLES, [BASE_BUNDLE, OWN_BUNDLE]);
});

test("退役元组表里的正是早期那份 [底座, 官方 web 层]", () => {
  assert.deepEqual(RETIRED_TUPLES, [[BASE_BUNDLE, WEB_APP]]);
});

test("精确等于退役元组 → 迁到当前初始层列", () => {
  assert.deepEqual(migrateProfileBundles([BASE_BUNDLE, WEB_APP]), [BASE_BUNDLE, OWN_BUNDLE]);
});

test("当前初始层列本身 → 不迁（已是最新）", () => {
  assert.equal(migrateProfileBundles([BASE_BUNDLE, OWN_BUNDLE]), undefined);
});

test("用户打开的可选 bundle + 自装插件：一个字都不动", () => {
  assert.equal(
    migrateProfileBundles([BASE_BUNDLE, OWN_BUNDLE, "@deepseek-ai/dsh-experimental-schedule-bundle", "dsh-plugin-whale-pet"]),
    undefined,
  );
});

test("含着退役层但还夹了别的东西：不迁（那是用户的清单，不是整份我们的）", () => {
  assert.equal(migrateProfileBundles([BASE_BUNDLE, WEB_APP, "dsh-plugin-whale-pet"]), undefined);
});

test("空 / 缺失 / 非数组 / 夹非字符串条目：一律不碰", () => {
  assert.equal(migrateProfileBundles([]), undefined);
  assert.equal(migrateProfileBundles(undefined), undefined);
  assert.equal(migrateProfileBundles("dsh-base"), undefined);
  assert.equal(migrateProfileBundles([BASE_BUNDLE, 42]), undefined);
});
