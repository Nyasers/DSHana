// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/market-pr-body.test.mjs — 投稿 PR 的标题与正文骨架（scripts/release/market-pr.mts）
//
// 守三件事：
//   1. 标题与正文首行的区间两端都是**完整 tag**，不是把 tag 截成版本号（`v1.2.1` 漏掉 `+dsh-…` 段
//      会和右端的完整 tag 对不上，维护者一眼能看出不一致）。
//   2. 正文只有脚本能自证的事实（Release / Package / SHA-256）+ 作者手写的 Changes + Changelog；
//      本地核对口径、分支怎么推、自测过程都不进正文——读者是市场维护者，不是自己人。
//   3. Changes 的内容由作者给，脚本只出标题与占位；没给时占位写成 HTML 注释，渲染不可见。
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEnrollmentBody, buildEnrollmentTitle } from "../../scripts/release/market-pr.mts";

const SINCE = "v1.2.1+dsh-0.2.1-rc.2";
const TAG = "v1.2.6+dsh-0.2.1-rc.5";
const CHANGELOG = { url: "https://github.com/Nyasers/DSHana/compare/x...y", body: "### Features\n\n* 一条改动 ([abc1234](https://x/abc1234))" };

const body = (over = {}) =>
  buildEnrollmentBody({
    tag: TAG,
    sinceTag: SINCE,
    zipName: "dshana-v1.2.6+dsh-0.2.1-rc.5.zip",
    releaseUrl: "https://github.com/Nyasers/DSHana/releases/tag/v1.2.6%2Bdsh-0.2.1-rc.5",
    sha256: "f6b54bb503ca5d60bc2d649d8112520831a434b71344328855ebb1edeeac38d9",
    changes: "- **Permissions**: 12 → 11",
    changelog: CHANGELOG,
    ...over,
  });

test("标题带区间时两端都是完整 tag", () => {
  assert.equal(buildEnrollmentTitle("app", "dshana", TAG, SINCE), `chore: approve app/dshana ${SINCE} -> ${TAG}`);
});

test("首次上架（没有已登记版本）标题只有目标 tag", () => {
  assert.equal(buildEnrollmentTitle("app", "dshana", TAG, null), `chore: approve app/dshana ${TAG}`);
});

test("正文首行是「旧 tag → 新 tag」，两端同样是完整 tag", () => {
  assert.equal(body().split("\n")[0], `## ${SINCE} → ${TAG}`);
  assert.equal(body({ sinceTag: null }).split("\n")[0], `## ${TAG}`);
});

test("元数据三行按 Release / Package / SHA-256 排列", () => {
  const lines = body().split("\n");
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(at("- Release: ") > 0);
  assert.equal(at("- Package: "), at("- Release: ") + 1);
  assert.equal(at("- SHA-256: "), at("- Package: ") + 1);
});

test("Changes 段用作者给的原文，不改写", () => {
  assert.match(body(), /## Changes\n\n- \*\*Permissions\*\*: 12 → 11\n/);
});

test("没给 Changes 时留 HTML 注释占位（渲染不可见）", () => {
  const b = body({ changes: null });
  assert.match(b, /## Changes\n\n<!--/);
  assert.doesNotMatch(b, /## Changes\n\n\n/);
});

test("正文不带本地核对口径、分支操作与自测过程", () => {
  const b = body();
  for (const banned of ["Local check", "不强推", "不重建", "install:local", "smoke:packed", "Approve the new"]) {
    assert.ok(!b.includes(banned), `正文不应出现「${banned}」`);
  }
});

test("Changelog 段跟在正文末尾，缺省时整段省略", () => {
  assert.ok(body().trimEnd().endsWith(CHANGELOG.body));
  assert.ok(!body({ changelog: null }).includes("## [Changelog]"));
});
