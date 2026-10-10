// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/pack-target-assets.test.mjs — 打包目标矩阵与平台资产派生的一致性闸
//
// 平台资产由 assets.mts 从**物化后的锁**派生（pack 时那份只含生产闭包），不手写名单。这份测试在
// PR 阶段守三件事：
//   1. 解析器对锁的 `packages:` 段认得出平台切分条目（拿一段内联夹具当样本，不依赖仓库锁的形态）；
//   2. 目标矩阵的三种粒度是同一份矩阵的投影——平台包并集 = 双架构包并集 = 通用包；
//   3. 目标矩阵与 release.yml 的矩阵/必需清单两处各自表达，仍要对得上。
// 注：仓库锁含 devDependencies（rspack / rolldown / typescript / @pnpm/exe 同样按平台切分），
// 所以它只当「任意一份形态真实的输入」用——真正随包的资产由 pack 那一刻的物化锁决定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dropStaleLibc, entryMatchesTarget, lockPlatformEntries, packageManagerClosure, platformAssetsFor, scanPlatformTree } from "../../scripts/release/pack/assets.mts";
import { platformTargetNames, supportedTargetNames, targetSpec } from "../../scripts/release/pack/targets.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_TEXT = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");

/** 内联夹具：锁的 `packages:` 段形态（含内联数组、块数组、无平台字段、负向声明几种写法）。 */
const FIXTURE = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    packageManagerDependencies:",
  "      pnpm:",
  "        specifier: 12.6.0",
  "        version: 12.6.0",
  "",
  "packages:",
  "",
  "  '@img/sharp-win32-x64@0.35.5':",
  "    resolution: {integrity: sha512-AAA}",
  "    engines: {node: '>=18'}",
  "    os: [win32]",
  "    cpu: [x64]",
  "",
  "  '@img/sharp-linux-x64@0.35.5':",
  "    resolution: {integrity: sha512-BBB}",
  "    os:",
  "      - linux",
  "    cpu:",
  "      - x64",
  "    libc:",
  "      - glibc",
  "",
  "  plain-js-package@1.0.0:",
  "    resolution: {integrity: sha512-CCC}",
  "",
  "  'negated@2.0.0':",
  "    os:",
  "      - '!win32'",
  "",
  "  '@pnpm/exe.win32-x64@12.6.0':",
  "    cpu: [x64]",
  "    os: [win32]",
  "",
  "snapshots:",
  "",
  "  pnpm@12.6.0:",
  "    optionalDependencies:",
  "      '@pnpm/exe.win32-x64': 12.6.0",
  "",
  "  '@img/sharp-win32-x64@0.35.5': {}",
  "",
].join("\n");

test("解析器认得出内联数组、块数组与负向声明三种写法", () => {
  const entries = lockPlatformEntries(FIXTURE);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual(byName["@img/sharp-win32-x64"], { name: "@img/sharp-win32-x64", os: ["win32"], cpu: ["x64"] });
  assert.deepEqual(byName["@img/sharp-linux-x64"], { name: "@img/sharp-linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"] });
  assert.deepEqual(byName["negated"], { name: "negated", os: ["!win32"] });
  assert.ok(!("plain-js-package" in byName), "无平台字段的包不该进平台条目");
});

test("相容判定：缺省维度不设限，负向声明保守地不纳入", () => {
  const win64 = targetSpec("win32-x64");
  const linuxGl = targetSpec("linux-x64");
  assert.ok(entryMatchesTarget({ name: "x", os: ["win32"], cpu: ["x64"] }, win64));
  assert.ok(!entryMatchesTarget({ name: "x", os: ["linux"], cpu: ["x64"] }, win64));
  assert.ok(!entryMatchesTarget({ name: "x", os: ["!win32"] }, win64), "负向声明应保守排除");
  assert.ok(entryMatchesTarget({ name: "x", os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, linuxGl));
  assert.ok(!entryMatchesTarget({ name: "x", os: ["linux"], cpu: ["x64"], libc: ["musl"] }, linuxGl));
  assert.ok(entryMatchesTarget({ name: "x", os: ["linux"], cpu: ["x64"] }, linuxGl), "不声明 libc 的包对 glibc 目标相容");
});

test("目标名按 `-` 走矩阵：零段整棵树、一段一行、两段一个叶子", () => {
  assert.deepEqual(targetSpec("universal").cpu, ["x64", "arm64"]);
  assert.deepEqual(targetSpec("win32").os, ["win32"]);
  assert.deepEqual(targetSpec("win32").cpu, ["x64", "arm64"]);
  assert.deepEqual(targetSpec("win32-x64").cpu, ["x64"]);
  assert.deepEqual(targetSpec("linux").libc, ["glibc"]);
  assert.equal(targetSpec("win32-ia32"), null, "矩阵外的 cpu 不该解析成目标");
  assert.equal(targetSpec("freebsd"), null, "矩阵外的 os 不该解析成目标");
});

test("每个目标的资产清单内部无重复", () => {
  for (const name of supportedTargetNames()) {
    const assets = platformAssetsFor(LOCK_TEXT, targetSpec(name));
    assert.equal(new Set(assets).size, assets.length, `${name} 的资产有重复`);
  }
});

test("三种粒度是同一份矩阵的投影：平台包并集 = 双架构包并集 = 通用包", () => {
  const union = (names) => {
    const set = new Set();
    for (const n of names) for (const a of platformAssetsFor(LOCK_TEXT, targetSpec(n))) set.add(a);
    return [...set].sort();
  };
  const platforms = platformTargetNames();
  const rows = supportedTargetNames().filter((n) => n !== "universal" && !platforms.includes(n));
  const universal = platformAssetsFor(LOCK_TEXT, targetSpec("universal")).sort();

  assert.deepEqual(union(rows), universal, "双架构包的资产并集应等于通用包");
  assert.deepEqual(union(platforms), universal, "平台包的资产并集应等于通用包");
  assert.ok(rows.length > 0, "双架构包一个都没有：矩阵的行投影失效了");
});

test("packageManager 链：pnpm 本体及其传递依赖（@pnpm/exe.*）不进树，不当资产", () => {
  const pm = packageManagerClosure(FIXTURE);
  assert.ok(pm.has("pnpm"), "应认出 packageManagerDependencies 里的 pnpm");
  // 仓库锁里 @pnpm/exe.win32-x64 是 pnpm 的 optionalDependencies，应在闭包内
  const repoPm = packageManagerClosure(LOCK_TEXT);
  assert.ok(repoPm.has("@pnpm/exe.win32-x64"), "@pnpm/exe.* 应被归入 packageManager 链");
  const assets = platformAssetsFor(LOCK_TEXT, targetSpec("win32-x64"));
  assert.ok(!assets.some((a) => a.startsWith("@pnpm/exe")), "@pnpm/exe.* 不该出现在随包资产里");
});

test("每个平台的资产集合非空：判据对 win32/darwin/linux 都得有命中", () => {
  for (const name of platformTargetNames()) {
    const assets = platformAssetsFor(LOCK_TEXT, targetSpec(name));
    assert.ok(assets.length > 0, `${name} 派生出的资产为空：判据没命中这个平台`);
  }
});

test("三族已知的原生加载链都被派生覆盖（回归：判据没漏掉起不来必炸的那几族）", () => {
  const universal = new Set(platformAssetsFor(LOCK_TEXT, targetSpec("universal")));
  for (const must of [
    "@koromix/koffi-win32-x64",
    "@img/sharp-win32-x64",
    "node-addon-require-builtin-win32-x64-msvc",
  ]) {
    assert.ok(universal.has(must), `通用包派生漏了 ${must}`);
  }
});

test("平台树扫描：musl 变体归入 staleLibc（libc 不相容），不进 foreign", () => {
  const glibc = targetSpec("linux-x64");
  const muslVariant = { name: "@img/sharp-libvips-linuxmusl-x64", os: ["linux"], cpu: ["x64"], libc: ["musl"] };
  const glibcVariant = { name: "@img/sharp-libvips-linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"] };
  const foreignOs = { name: "@img/sharp-darwin-arm64", os: ["darwin"], cpu: ["arm64"] };
  // 直接验相容判据：musl 变体对 glibc 目标 libc 不相容，但 os/cpu 相容
  assert.ok(entryMatchesTarget(muslVariant, glibc) === false, "musl 变体不该与 glibc 目标相容");
  assert.ok(entryMatchesTarget(glibcVariant, glibc) === true, "glibc 变体应与 glibc 目标相容");
  assert.equal(entryMatchesTarget(foreignOs, glibc), false, "别的 os 不该与 linux 目标相容");
});

/** 在临时目录里铺一棵依赖树：顶层 + 嵌套（版本冲突时包被压在依赖者下面）。 */
function makeTree(pkgs) {
  const root = mkdtempSync(join(tmpdir(), "pack-assets-"));
  for (const [rel, manifest] of Object.entries(pkgs)) {
    const dir = join(root, "node_modules", ...rel.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

/**
 * 扫描必须覆盖嵌套 node_modules：hoisted 布局下版本冲突会把包压在依赖者自己的 node_modules 下
 * （顶层一份都没有），只看顶层就会漏掉——漏掉的 foreign 是静默放过别的平台的原生件，漏掉的
 * staleLibc 是白带的载荷。这里两类各钉一个嵌套样本，并验删完真的从盘上消失。
 */
test("平台树扫描下探嵌套 node_modules，dropStaleLibc 按真实路径删除", () => {
  const glibc = targetSpec("linux-x64");
  const root = makeTree({
    // 顶层：该删的 musl 与该留的 glibc
    "@img/sharp-libvips-linuxmusl-x64": { os: ["linux"], cpu: ["x64"], libc: ["musl"] },
    "@img/sharp-libvips-linux-x64": { os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
    // 嵌套：dsh-app-boot 自己的 node_modules（顶层没有同名包，正是扫描失明的形态）
    "@deepseek-ai/dsh-app-boot/node_modules/node-addon-require-builtin-linux-x64-musl": {
      os: ["linux"],
      cpu: ["x64"],
      libc: ["musl"],
    },
    "@deepseek-ai/dsh-app-boot/node_modules/node-addon-require-builtin-linux-x64-gnu": {
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    },
    "@deepseek-ai/dsh-app-boot/node_modules/node-addon-require-builtin-darwin-arm64": {
      os: ["darwin"],
      cpu: ["arm64"],
    },
    // 无平台字段的普通包：两列都不该出现
    "@deepseek-ai/dsh-app-boot/node_modules/plain-js": { name: "plain-js" },
  });
  try {
    const modulesDir = join(root, "node_modules");
    const scan = scanPlatformTree(modulesDir, glibc);
    const nestedMusl = "@deepseek-ai/dsh-app-boot/node_modules/node-addon-require-builtin-linux-x64-musl";
    assert.deepEqual(
      [...scan.staleLibc].sort(),
      ["@img/sharp-libvips-linuxmusl-x64", nestedMusl].sort(),
      "顶层与嵌套的 musl 变体都该归入 staleLibc",
    );
    assert.deepEqual(
      scan.foreign,
      ["@deepseek-ai/dsh-app-boot/node_modules/node-addon-require-builtin-darwin-arm64"],
      "嵌套里别的 os 的包该归入 foreign（顶层无同名包，只有下探才看得见）",
    );
    assert.ok(
      !scan.staleLibc.some((n) => n.endsWith("-gnu")),
      "glibc 变体不该被当成 staleLibc",
    );

    const dropped = dropStaleLibc(modulesDir, scan.staleLibc);
    assert.equal(dropped.files, 2, "顶层与嵌套各删一个");
    for (const rel of scan.staleLibc) {
      assert.ok(
        !existsSync(join(modulesDir, ...rel.split("/"), "package.json")),
        `${rel} 删除后不该还在盘上`,
      );
    }
    // 该留的还在
    assert.ok(
      existsSync(join(modulesDir, "@img/sharp-libvips-linux-x64", "package.json")),
      "glibc 变体不该被误删",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("平台资产不包含构建面工具：rspack / rolldown / typescript 的平台件只该出现在仓库锁里", () => {
  // 这条闸是「派生必须以物化锁为源」的反向证据：仓库锁含 devDeps，直接拿它派生会把这些收进来。
  // 真出包时源是物化锁（只含生产闭包），它们不在；这里钉住这个差别，防止有人把源换回仓库锁。
  const universal = new Set(platformAssetsFor(LOCK_TEXT, targetSpec("universal")));
  for (const buildOnly of ["@rspack/binding-win32-x64-msvc", "@typescript/typescript-win32-x64"]) {
    assert.ok(universal.has(buildOnly), `${buildOnly} 应能被仓库锁派生出来（说明派生源是仓库锁会误收）`);
  }
});

/** 发布流水线里与目标矩阵重复的两份清单：矩阵目标名（平台目标）、必需资产循环里的目标名。 */
test("release.yml 的发布矩阵与必需资产清单跟平台目标一致", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const platforms = platformTargetNames();

  const matrix = /target: \[([^\]]+)\]/.exec(workflow);
  assert.ok(matrix, "release.yml 里找不到 package 矩阵的 target 列表");
  assert.deepEqual(
    matrix[1].split(",").map((name) => name.trim()).sort(),
    [...platforms].sort(),
    "发布矩阵只应列出平台目标（叶子）：通用包与双架构包不进 CI 矩阵（顺序不算契约）",
  );

  const loop = /for t in ([^;]+); do/.exec(workflow);
  assert.ok(loop, "release.yml 里找不到必需资产的 target 循环");
  assert.deepEqual(
    loop[1].trim().split(/\s+/).sort(),
    [...platforms].sort(),
    "必需资产的目标集与平台目标不一致",
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
