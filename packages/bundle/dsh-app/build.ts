// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/bundle/dsh-app/build.ts — 组合层包（@dshana/dsh-app）的构建入口
//
// 产物是一个能被 profile 选中的 bundle 包（形态与上游 packages/bundle/web-app 同形）：
//   lib/index.js            粘合插件（dist 服务、信任采样、提示段落、bash 变量、URL 行）
//   lib/startup.js          web-startup 提供方（--host / --port / --trusted-host / --no-open）
//   cordis.patch.yml        本层的组合补丁（行、与上游两份的差异见该文件头）
//   presets/*.patch.yml     随发行版交付的 preset 声明
//   package.json            dsh.bundle.patch 指向上面 5 份
// 依赖一律**外部化**：lib 里保留原生 import，树的解析代由本包 package.json 的 dependencies 声明，
// 不内联也不打包——补丁里那些 name 行能不能解析，正是靠那份声明说了算。
//
// 用 tsdown（Rolldown 系）而不是 rspack：本包的源码直接来自上游，那两处 ESM 写法
// （`new URL('../../../..', import.meta.url)`、`import.meta.resolve('open')`）在 rspack 下会被
// 构建期接管（前者被当资源引用去解析、后者被判定为不支持的直接访问），而 tsdown 原样留给运行时。
// 保留上游原文 = fork 的 delta 少两处。
//
// 落点两处：
//   .cache/bundle/dsh-app/        构建产物（pack 从这里放进安装树 node_modules/@dshana）
//   node_modules/@dshana/dsh-app  仓库树扮演安装树（与 cordis 子插件同款落位，见 packages/app/src/cordis.ts）
// 用法：node packages/bundle/dsh-app/build.ts
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";

import fs from "fs-extra";
import { build } from "tsdown";

import { BUNDLE_DIR, ROOT } from "../../../scripts/shared/paths.mts";

const PKG_DIR = dirname(fileURLToPath(import.meta.url)); // packages/bundle/dsh-app/
/** 随包原样带走的静态件（进产物根）。 */
const STATIC = ["package.json", "cordis.patch.yml", "presets"];

async function buildLib() {
  await build({
    name: "@dshana/dsh-app",
    entry: { index: join(PKG_DIR, "src", "index.ts"), startup: join(PKG_DIR, "src", "startup.ts") },
    outDir: join(BUNDLE_DIR, "lib"),
    format: "esm",
    platform: "node",
    dts: false,
    clean: true,
    sourcemap: false,
    minify: true,
    // 非相对、非绝对、非 node: 的说明符一律保持外部：树里由 dependencies 声明的那批包按原样 import。
    deps: { neverBundle: (spec: string) => !spec.startsWith(".") && !isAbsolute(spec) },
    outputOptions: { entryFileNames: "[name].js" },
  });
  console.log(`build:bundle lib/（tsdown，2 个入口，依赖外部化）-> ${BUNDLE_DIR}`);
}

fs.removeSync(BUNDLE_DIR);
fs.ensureDirSync(BUNDLE_DIR);
await buildLib();
for (const rel of STATIC) {
  fs.copySync(join(PKG_DIR, rel), join(BUNDLE_DIR, rel), { overwrite: true });
}

// 交付形态的清单：workspace 协议在安装树里没有意义（那边没有 workspace），把 @dshana/* 的
// `workspace:*` 改写成指向同锚点真实目录的 file: 形式——与 pack 认领随包插件时写的值一致。
const artifactPkgPath = join(BUNDLE_DIR, "package.json");
const artifactPkg = JSON.parse(fs.readFileSync(artifactPkgPath, "utf8"));
for (const [name, spec] of Object.entries(artifactPkg.dependencies ?? {})) {
  if (typeof spec === "string" && spec.startsWith("workspace:") && name.startsWith("@dshana/")) {
    artifactPkg.dependencies[name] = `file:../../${name}`;
  }
}
fs.writeFileSync(artifactPkgPath, JSON.stringify(artifactPkg, null, 2) + "\n", "utf8");

// 仓库树扮演安装树：runtime 从安装树的解析代里取本包（同 cordis 子插件的落位口径）。
const landed = join(ROOT, "node_modules", "@dshana", "dsh-app");
fs.removeSync(landed);
fs.copySync(BUNDLE_DIR, landed);
console.log("build:bundle 落位 -> node_modules/@dshana/dsh-app");
