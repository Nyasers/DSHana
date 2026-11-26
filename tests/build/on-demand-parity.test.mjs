// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/on-demand-parity.test.mjs — 按需名单与上游 OPTIONAL_BUNDLES 的对账闸
//
// 两个方向都要钉住：少一个 = 那个 bundle 仍随包内置（漏改，出包时才炸）；多一个 = 我们造了
// 上游没有的按需项（catalog 里点安装会 404）。这里用临时仓库根喂名单，不依赖改真实 yaml。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertMatchesUpstreamOptional,
  onDemandBundles,
  upstreamOptionalBundles,
} from "../../scripts/shared/on-demand.mts";
import { verifyOnDemand } from "../../scripts/check/on-demand.mts";

/** 临时仓库根：只放一份带标记段的 pnpm-workspace.yaml。 */
function withYaml(names) {
  const dir = mkdtempSync(join(tmpdir(), "on-demand-parity-"));
  const block = [
    "overrides:",
    "  # >>> excluded-on-demand",
    ...names.map((n) => `  "${n}": "-"`),
    "  # <<< excluded-on-demand",
    "",
  ];
  writeFileSync(join(dir, "pnpm-workspace.yaml"), block.join("\n"));
  return dir;
}

test("仓库名单与上游 OPTIONAL_BUNDLES 一一对应", () => {
  const { ours, upstream, tag } = verifyOnDemand();
  assert.equal(ours, upstream, `名单 ${ours} 个、上游 ${tag} 里 ${upstream} 个`);
});

test("名单解析只认标记段里的「包名: -」", () => {
  const dir = withYaml(["@scope/a", "@scope/b"]);
  try {
    assert.deepEqual(onDemandBundles(dir), ["@scope/a", "@scope/b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("少一个就拦，并指名是哪一个", () => {
  const all = upstreamOptionalBundles();
  const dropped = all[all.length - 1];
  const dir = withYaml(all.slice(0, -1));
  try {
    assert.throws(
      () => assertMatchesUpstreamOptional(dir),
      (e) => e.message.includes("上游有而我们没改按需") && e.message.includes(dropped),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多一个也拦（上游没有的按需项装不回来）", () => {
  const dir = withYaml([...upstreamOptionalBundles(), "@scope/not-upstream"]);
  try {
    assert.throws(
      () => assertMatchesUpstreamOptional(dir),
      (e) => e.message.includes("我们有而上游没有") && e.message.includes("@scope/not-upstream"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("标记段读空时全部算漏（不静默放行）", () => {
  const dir = withYaml([]);
  try {
    assert.deepEqual(onDemandBundles(dir), []);
    assert.throws(() => assertMatchesUpstreamOptional(dir), /上游有而我们没改按需/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
