// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/version-metadata.test.mjs — 版号 buildup 段的规则与「当前树已经对上」这两件事。
//
// 规则本体是 scripts/shared/version.mts#fullVersion（version 钩子与 derive 的
// version-metadata 任务共用一份实现）；末一条顺带把闸照进单测：树的 version 段与交付面 pin
// 不一致时，`pnpm test` 也当场看得见（CI 的主闸是 derive --check）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { fullVersion, cleanVersion, dshPin } from "../../scripts/shared/version.mts";
import { inspect } from "../../scripts/derive/version-metadata.mts";

test("完整版号：主号 + +dsh-<pin>", () => {
  assert.equal(fullVersion("1.0.0-rc.26", "0.1.7-rc.2"), "1.0.0-rc.26+dsh-0.1.7-rc.2");
});

test("完整版号：既有 build 段被剥掉重拼（不叠加）", () => {
  assert.equal(fullVersion("1.0.0-rc.26+dsh-0.1.7-rc.1", "0.1.7-rc.2"), "1.0.0-rc.26+dsh-0.1.7-rc.2");
  assert.equal(fullVersion("1.0.0-rc.26+sha.abc", "0.1.7-rc.2"), "1.0.0-rc.26+dsh-0.1.7-rc.2");
});

test("完整版号：pin 未声明时只剩主号", () => {
  assert.equal(fullVersion("1.0.0-rc.26+dsh-0.1.7-rc.1", ""), "1.0.0-rc.26");
});

test("完整版号幂等：拿已完整的版号再拼一次不变", () => {
  const once = fullVersion("1.0.0-rc.26", "0.1.7-rc.2");
  assert.equal(fullVersion(once, "0.1.7-rc.2"), once);
  assert.equal(cleanVersion(once), "1.0.0-rc.26");
});

test("当前树的 version metadata 段与交付面 pin 一致（derive --check 的同一条判断）", () => {
  assert.ok(dshPin(), "packaging/package.json 未声明 dependencies['@deepseek-ai/dsh']");
  assert.deepEqual(inspect(), []);
});
