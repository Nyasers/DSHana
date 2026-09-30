// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/app-bundle.test.mjs — 我们自己的 bundle @dshana/app 的两道闸
// （scripts/release/pack/app-bundle.mts）
//
// 为什么需要它：上游的 verify-cordis-config 用 glob \`packages/*/*/package.json\` 找 bundle，只认
// vendor 那棵树；我们的 bundle 住 src-cordis/app，它扫不到。于是「patch 里的裸行名必须由该 bundle
// 自己声明依赖」这条规则在我们身上**没人执行**——而行名写错/漏声明时构建与出包全绿，真机 boot 时
// 那一行静默不落地。这里把那套判据钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appBundlePatchErrors,
  readPatchRefs,
  readUpstreamRowPackages,
  rowPackagesOf,
} from "../../scripts/release/pack/app-bundle.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_DIR = join(ROOT, "src-cordis", "app");
const PATCH = readFileSync(join(APP_DIR, "cordis.patch.yml"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8"));
const VENDOR = join(ROOT, "vendor", "deepseek-harness");

test("readPatchRefs：带 name 的行与只带 id 的行分开收（嵌套与平铺两种写法）", () => {
  const nested = readPatchRefs([
    "- id: llm-pi-ai",
    "  disabled: true",
    "- insert:",
    "    - id: '@dshana/theme'",
    "      name: '@dshana/theme'",
    "- id: web-runtime",
    "  config:",
    "    printUrl: false",
    "",
  ].join("\n"));
  assert.deepEqual(nested.named, ["@dshana/theme"]);
  assert.deepEqual(nested.ids, ["llm-pi-ai", "web-runtime"]);

  // 注释、空行、以及 config 里恰好叫 name 的键都不该被当成引用。
  const noisy = readPatchRefs([
    "# - id: fake-in-comment",
    "- id: real-row",
    "  config:",
    "    name: not-a-plugin",
    "",
  ].join("\n"));
  assert.deepEqual(noisy.named, []);
  assert.deepEqual(noisy.ids, ["real-row"]);
});

test("readPatchRefs：去掉引号；重复的引用去重保序", () => {
  const refs = readPatchRefs([
    "- insert:",
    "    - id: a",
    "      name: \"@dshana/a\"",
    "    - id: b",
    "      name: '@dshana/b'",
    "    - id: a2",
    "      name: '@dshana/a'",
    "",
  ].join("\n"));
  assert.deepEqual(refs.named, ["@dshana/a", "@dshana/b"]);
});

test("rowPackagesOf：从上游层 patch 抽 行名 → 包名", () => {
  const rows = rowPackagesOf([
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    "- id: no-name-row",
    "  disabled: true",
    "",
  ].join("\n"));
  assert.equal(rows.get("llm-pi-ai"), "@deepseek-ai/dsh-llm-pi-ai");
  assert.equal(rows.has("no-name-row"), false, "没有 name 的行不该进表（它以 id 身份被引用）");
});

test("readUpstreamRowPackages：上游两层的落点表读得出，四个已知行指向那四个包", () => {
  const rows = readUpstreamRowPackages(VENDOR);
  assert.ok(rows.size > 100, "上游行表过小：glob 或解析坏了");
  // 任务书里那四条映射（行名 → 包名）——它们是我们 patch 的落点，写错一个字就是静默无操作。
  assert.equal(rows.get("llm-deepseek"), "@deepseek-ai/dsh-llm-deepseek-api-key");
  assert.equal(rows.get("llm-pi-ai"), "@deepseek-ai/dsh-llm-pi-ai");
  assert.equal(rows.get("ui-settings-models"), "@deepseek-ai/dsh-client-ui-settings-models");
  assert.equal(rows.get("web-runtime"), "@deepseek-ai/dsh-web-app");
});

test("真实 src-cordis/app：patch 与自己的 dependencies 自洽", () => {
  const refs = readPatchRefs(PATCH);
  const rows = readUpstreamRowPackages(VENDOR);
  assert.deepEqual(appBundlePatchErrors(refs, MANIFEST.dependencies, rows), []);
  // 我们确实覆盖了那四条、插入三个子插件（写死是故意的：这份清单变了就该有人看一眼）。
  assert.deepEqual(refs.ids.sort(), ["llm-deepseek", "llm-pi-ai", "ui-settings-models", "web-runtime"]);
  assert.deepEqual(refs.named.sort(), ["@dshana/clipboard", "@dshana/provider", "@dshana/theme"]);
});

test("负向：insert 引用了 dependencies 里没有的包 → 报（上游 verify-cordis-config 的规则）", () => {
  const refs = readPatchRefs(PATCH);
  const deps = { ...MANIFEST.dependencies };
  delete deps["@dshana/theme"];
  const problems = appBundlePatchErrors(refs, deps, readUpstreamRowPackages(VENDOR));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@dshana\/theme/);
  assert.match(problems[0], /dependencies/);
});

test("负向：覆盖了一个不存在的行名 → 报（那条 patch 永远无操作）", () => {
  const problems = appBundlePatchErrors(
    { named: [], ids: ["ui-plan-typo"] },
    MANIFEST.dependencies,
    readUpstreamRowPackages(VENDOR),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ui-plan-typo/);
  assert.match(problems[0], /无操作/);
});

test("负向：B 节的 bundle 形状本身也是契约（declares dsh.bundle.patch + 是 @dshana/app）", () => {
  assert.equal(MANIFEST.name, "@dshana/app");
  assert.equal(MANIFEST.type, "module");
  assert.equal(MANIFEST.dsh?.bundle?.patch, "./cordis.patch.yml", "缺了它，dshana 预设的 bundles 末层贡献不了任何层");
  // patch 文件必须真的在包里（它随包分发到 node_modules/@dshana/app）。
  assert.ok(readFileSync(join(APP_DIR, "cordis.patch.yml"), "utf8").length > 0);
});

test("负向：version 由 derive 同步（不是手写第二份事实源）", () => {
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(MANIFEST.version, root.version, "改了主版本要跑 node scripts/derive/index.mts cordis");
});
