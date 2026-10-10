// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/market-pr-changelog.test.mjs — 投稿 PR 正文的 Changelog 段拼装（scripts/release/market-pr.mts）
//
// 守两件事：Changelog 段取的是 **市场当前版本 → 仓库 Latest** 这个区间（不是单版本段），
// 且区间两端都取自外部事实。
// 市场只按 approvals 的记录读 Release，上次登记之后直接跳过的那几版从没进过任何 PR 正文，
// 只列本次会把它们丢掉（上游 #30 就是把 v1.0.3 并进 v1.0.4 那段）。
// 这条只有「跳版本」时才看得出差别，所以夹具必须跨版本；不依赖仓库当前版本恰好没跳。
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChangelogSection } from "../../scripts/release/market-pr.mts";

const REPO = "Nyasers/DSHana";
const cmp = (from, to) => `https://github.com/${REPO}/compare/v${from.replace(/\+/g, "%2B")}...v${to.replace(/\+/g, "%2B")}`;

/** 一份形态与真实 CHANGELOG.md 相同的夹具：新版本在前，段内分节、条目带提交链接。 */
const CHANGELOG = [
  "# Changelog",
  "",
  "## [1.0.5+dsh-0.2.0-rc.2](https://github.com/Nyasers/DSHana/compare/v1.0.4%2Bdsh-0.2.0-rc.2...v1.0.5%2Bdsh-0.2.0-rc.2) (2026-10-10)",
  "",
  "### Features",
  "",
  "* **theme:** 强制跟随面改为可配置 ([aaa1111](https://x/aaa1111))",
  "",
  "### Bug Fixes",
  "",
  "* **pack:** 平台扫描下探嵌套 node_modules ([bbb2222](https://x/bbb2222))",
  "",
  "## [1.0.4+dsh-0.2.0-rc.2](https://github.com/Nyasers/DSHana/compare/v1.0.3%2Bdsh-0.2.0-rc.2...v1.0.4%2Bdsh-0.2.0-rc.2) (2026-10-08)",
  "",
  "### Bug Fixes",
  "",
  "* **market:** 图标与卡面各归其域 ([ccc3333](https://x/ccc3333))",
  "",
  "## [1.0.3+dsh-0.2.0-rc.2](https://github.com/Nyasers/DSHana/compare/v1.0.2%2Bdsh-0.2.0-rc.2...v1.0.3%2Bdsh-0.2.0-rc.2) (2026-10-08)",
  "",
  "### Bug Fixes",
  "",
  "* **client-hmr:** /plugins/events 补周期心跳 ([ddd4444](https://x/ddd4444))",
  "",
  "## [1.0.2+dsh-0.2.0-rc.2](https://github.com/Nyasers/DSHana/compare/v1.0.1%2Bdsh-0.2.0-rc.2...v1.0.2%2Bdsh-0.2.0-rc.2) (2026-10-07)",
  "",
  "### Bug Fixes",
  "",
  "* **market:** 按 review 意见修三处 ([eee5555](https://x/eee5555))",
  "",
].join("\n");

test("跳版本时并入中间各版本：市场当前到仓库 Latest 之间的段合成一条", () => {
  // 市场已上架 1.0.2，仓库 Latest 是 1.0.5 → 中间跳了 1.0.3、1.0.4，三段都要进
  const got = buildChangelogSection(CHANGELOG, "1.0.5+dsh-0.2.0-rc.2", "1.0.2+dsh-0.2.0-rc.2", REPO);
  assert.ok(got, "应产出 Changelog 段");
  for (const commit of ["aaa1111", "bbb2222", "ccc3333", "ddd4444"]) {
    assert.ok(got.body.includes(commit), `跳过的版本段条目应并入：${commit} 不在正文里`);
  }
  assert.ok(!got.body.includes("eee5555"), "市场当前版本的段不该再进（它是区间起点，不是区间内容）");
});

test("跳版本时 compare 链接按区间拼，不照抄相邻版本", () => {
  const got = buildChangelogSection(CHANGELOG, "1.0.5+dsh-0.2.0-rc.2", "1.0.2+dsh-0.2.0-rc.2", REPO);
  assert.equal(got.url, cmp("1.0.2+dsh-0.2.0-rc.2", "1.0.5+dsh-0.2.0-rc.2"));
});

test("同一分节跨版本归并成一个标题，条目从新到旧", () => {
  const got = buildChangelogSection(CHANGELOG, "1.0.5+dsh-0.2.0-rc.2", "1.0.2+dsh-0.2.0-rc.2", REPO);
  assert.equal((got.body.match(/^### Bug Fixes$/gm) || []).length, 1, "Bug Fixes 只该出一个标题");
  const order = ["bbb2222", "ccc3333", "ddd4444"].map((c) => got.body.indexOf(c));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "条目应按版本从新到旧排列");
  assert.ok(got.body.indexOf("### Features") < got.body.indexOf("### Bug Fixes"), "Features 在 Bug Fixes 之前");
});

test("未跳版本时只取 Latest 那一段，链接用 CHANGELOG 自己的那对相邻版本", () => {
  const got = buildChangelogSection(CHANGELOG, "1.0.5+dsh-0.2.0-rc.2", "1.0.4+dsh-0.2.0-rc.2", REPO);
  assert.ok(got.body.includes("aaa1111") && got.body.includes("bbb2222"));
  assert.ok(!got.body.includes("ccc3333"), "1.0.4 段是区间起点，不该并入");
  assert.equal(got.url, cmp("1.0.4+dsh-0.2.0-rc.2", "1.0.5+dsh-0.2.0-rc.2"));
});

test("首次上架（市场无已上架版本）只取 Latest 那一段", () => {
  const got = buildChangelogSection(CHANGELOG, "1.0.5+dsh-0.2.0-rc.2", null, REPO);
  assert.ok(got.body.includes("aaa1111") && !got.body.includes("ccc3333"));
  assert.equal(got.url, cmp("1.0.4+dsh-0.2.0-rc.2", "1.0.5+dsh-0.2.0-rc.2"));
});

test("Latest 段不在 CHANGELOG 里时返回 null（调用方省掉该段）", () => {
  assert.equal(buildChangelogSection(CHANGELOG, "9.9.9+dsh-0.2.0-rc.2", "1.0.2+dsh-0.2.0-rc.2", REPO), null);
});
