// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/pack-target-assets.test.mjs — 出包资产清单与仓库锁的一致性闸
//
// assets 只在真打包、依赖物化完之后被逐个断言存在，CI 上要到出包那一刻才碰得到。这里把清单
// 提前对齐到**仓库锁文件**（pnpm-lock.yaml）：交付面的物化以它为种子解析，它就是交付闭包的解析
// 记录；名字漂了（上游改包名、换平台切分，或我们写错一个字母）在 PR 上就拦住，不必等一次
// 完整出包才暴露。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { supportedTargetNames, targetSpec } from "../../scripts/release/pack/targets.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_LINES = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split(/\r?\n/);

/** Office 转换栈的名字根：那一条链（kit + 按平台切分的原生件）不进产物。 */
const LO_KIT = "@deepseek-ai/libreoffice-kit";

const targets = supportedTargetNames().map((name) => {
  const spec = targetSpec(name);
  assert.ok(spec, `目标表应能解析 ${name}`);
  return { name, spec };
});

/**
 * 锁里一个包的解析条目键名：`packages:` 段每条写作 `<名>@<版本>:`；scoped 名带引号，非 scoped 名
 * 不带。取法是抹掉引号后截到版本号那一节（scoped 名开头的 `@` 不算分隔符）。
 */
function lockKey(line) {
  const cleaned = line.replace(/'/g, "").trim();
  const at = cleaned.indexOf("@", 1);
  const colon = cleaned.indexOf(":");
  const cut = at > 1 && (colon < 0 || at < colon) ? at : colon;
  return cut < 0 ? cleaned : cleaned.slice(0, cut);
}

/**
 * 已解析包的名字集合：只取 `packages:` 段里 2 空格缩进的条目。
 * `importers:` / `snapshots:` 里那些 `<名>: <版本>` 是依赖引用，包被移除时引用可能还留着，
 * 只认解析条目才算「这个包真能装出来」。
 */
function resolvedPackageKeys(lines) {
  const keys = new Set();
  let inPackages = false;
  for (const line of lines) {
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages && (line === "snapshots:" || line === "---")) {
      inPackages = false;
      continue;
    }
    if (inPackages && /^ {2}\S.*:\s*$/.test(line)) keys.add(lockKey(line));
  }
  return keys;
}

const lockKeys = resolvedPackageKeys(LOCK_LINES);

/** 锁里是否有这个包的解析条目。 */
const inLock = (name) => lockKeys.has(name);

test("每个目标的资产清单内部无重复", () => {
  for (const { name, spec } of targets) {
    assert.equal(new Set(spec.assets).size, spec.assets.length, `${name} 的 assets 有重复`);
  }
});

test("清单里的每个资产在仓库锁里有条目", () => {
  for (const { name, spec } of targets) {
    for (const asset of spec.assets) {
      assert.ok(inLock(asset), `${name} 的资产 ${asset} 不在 pnpm-lock.yaml 里`);
    }
  }
});

test("universal 的清单盖住每个平台目标声明的全部资产", () => {
  const covered = new Set(targetSpec("universal").assets);
  for (const { name, spec } of targets) {
    if (name === "universal") continue;
    for (const asset of spec.assets) {
      assert.ok(covered.has(asset), `universal 缺了 ${name} 的资产 ${asset}`);
    }
  }
});

test("资产清单不声明 Office 转换栈：那一条链不进产物（转换交给宿主侧）", () => {
  for (const { name, spec } of targets) {
    const lo = spec.assets.filter((asset) => asset.startsWith(LO_KIT));
    assert.deepEqual(lo, [], `${name} 的资产清单还在声明 Office 转换栈：${lo.join(", ")}`);
  }
});

/** 发布流水线里与目标表重复的两份清单：矩阵目标名（平台目标）、必需资产循环里的目标名。 */
test("release.yml 的发布矩阵与必需资产清单跟目标表一致", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const names = supportedTargetNames();
  const platforms = names.filter((name) => name !== "universal");

  const matrix = /target: \[([^\]]+)\]/.exec(workflow);
  assert.ok(matrix, "release.yml 里找不到 package 矩阵的 target 列表");
  assert.deepEqual(
    matrix[1].split(",").map((name) => name.trim()).sort(),
    [...platforms].sort(),
    "发布矩阵只应列出平台目标：universal 与投稿条目走 universal-market 那条线（顺序不算契约）",
  );

  const loop = /for t in ([^;]+); do/.exec(workflow);
  assert.ok(loop, "release.yml 里找不到必需资产的 target 循环");
  assert.deepEqual(
    loop[1].trim().split(/\s+/).sort(),
    [...platforms].sort(),
    "必需资产的目标集与平台目标表不一致",
  );
  assert.match(workflow, /REQUIRED="\$REQUIRED dshana-v\$\{VER\}\.zip"/, "通用包的必需资产行缺失");
});

/**
 * 内联在 workflow 里的脚本没有任何静态检查（字符串，typecheck 与测试都碰不到）——已经因此有过一次
 * 只在 CI 上才暴露的错误。所以这里守着「脚本外置」这条口径。
 */
test("release.yml 不内联脚本，投稿条目与通用包在同一作业里派生", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.ok(!workflow.includes("node -e"), "workflow 里又出现内联 node 脚本：外置才能进 typecheck 与测试");
  assert.match(workflow, /pnpm run market:entry/, "通用包那条线没调 market:entry");
});

/**
 * 通用包与投稿条目合成一条线之后，事实就该在同一个作业里对刚出的包现算。跨作业的 pkg-facts
 * 小 artifact 一旦回来，就等于又出现一个可能与包对不上的中间物，或一个只为搬事实而存在的下载步骤。
 */
test("release.yml 不再经 pkg-facts 中转事实", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.ok(!workflow.includes("pkg-facts"), "workflow 里又出现 pkg-facts artifact");
  assert.ok(!workflow.includes("facts:record"), "workflow 里又在出包作业记事实小票");
  assert.ok(!workflow.includes("--facts-dir"), "market:entry 不该再从事实目录取数");
  assert.ok(!workflow.includes("download-artifact"), "workflow 里又出现跨作业的 artifact 下载");
  // 通用包那条线要出包、要派生条目、要在 tag 场景直传通用包与条目：三者同在一个作业里
  const from = workflow.indexOf("\n  universal-market:");
  assert.ok(from > 0, "找不到 universal-market 作业");
  const to = workflow.indexOf("\n  publish:", from);
  const universal = workflow.slice(from, to > 0 ? to : workflow.length);
  assert.match(universal, /run: pnpm run package --target=universal/, "universal-market 没出通用包");
  assert.match(universal, /releases\/dshana-v\*\.zip/, "universal-market 直传时没带上通用包");
  assert.match(universal, /releases\/app-\*\.entry\.json/, "universal-market 直传时没带上投稿条目");
});

/**
 * gh 默认靠工作树里的 .git 认仓库。收口作业不 checkout（它不碰工作树），所以它的每个 gh 调用都必须
 * 用 -R 显式给出仓库 —— 漏一个就是「failed to run git: not a git repository」，而且只到真发版才暴露。
 */
test("不 checkout 的作业里，每个 gh 调用都显式给出仓库", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const from = workflow.indexOf("\n  publish:");
  assert.ok(from > 0, "找不到 publish 作业");
  const to = workflow.indexOf("\n# 注入防护", from);
  const publish = workflow.slice(from, to > 0 ? to : workflow.length);

  assert.ok(!publish.includes("actions/checkout"), "publish 不应再引入 checkout（它只跑 gh）");
  const calls = publish.split("\n").filter((line) => /\bgh release (view|edit|upload|download)\b/.test(line));
  assert.ok(calls.length >= 2, `publish 里的 gh 调用只剩 ${calls.length} 处，闸失去意义`);
  for (const line of calls) {
    assert.match(line, /-R "\$REPO"/, `publish 的 gh 调用缺 -R "$REPO"：${line.trim()}`);
  }
});
