// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/build.ts — src-cordis 域构建入口（cordis 子插件包）
// 布局：领域专用随源码——cordis 域脚本/配置全在 src-cordis/（build/ preset + 每包
// cordis.config.mjs 描述），共享工具（rspack 本体解析/URL 回写/terser/assert + 共享
// minify-loader）在 scripts/build/。产物分两处：
//   dist/cordis/**：3 子插件（provider / theme / clipboard）：service 半 rspack（源 index.ts →
//     产物 index.js bundle），theme 与 clipboard 另出 client 半（client.ts → client.js，tsdown
//     closure-factory）；
//   dist/cordis.patch.yml：我们的 roster patch（对官方行的覆盖 + @dshana/* insert）——
//     profile 用官方随附的 `web`（DSH 首次加载时自建），我们不改数据目录里的任何东西，
//     这份文件由 runtime 经 runProfile 的 patchFiles 作**启动期 overlay** 传进去。
// node_modules/@dshana/**：把上面那份 scope 照原样再落一份——仓库树扮演「安装树」，
//   DSH 的 runtime 解析模式从安装树 + bundle 依赖图算解析代、不建链接。出包时 pack 作同样的事。
// 用法：node src-cordis/build.ts [RSPACK_ENV=<构建环境目录>]
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";
import { serviceBundle } from "./build/service-config.mts"; // preset 层（src-cordis/build/）
import { buildClientBundle } from "./build/client-config.mts";
import { collectSource, makeUrlRewriter, assertNoStaticFileUrl } from "../scripts/build/common.mts"; // scripts/build/ 共享
// 仅为加载 Node 版本断言（本入口以 TypeScript 直跑，依赖原生类型剥离）
import "../scripts/shared/root.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // src-cordis/ → 仓库根
const SRC_ROOT = join(ROOT, "src-cordis");

// rspack 解析（同 build-src：RSPACK_ENV 或本地 node_modules）
function resolveRspackEntry(coreDir) {
  const pkg = JSON.parse(fs.readFileSync(join(coreDir, "package.json"), "utf8"));
  const dot = pkg.exports?.["."];
  let entry: string | null = null;
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") entry = dot.default ?? dot.import ?? dot.require ?? null;
  return join(coreDir, entry || pkg.main || "dist/index.js");
}
let rspackPkg;
const envDir = process.env.RSPACK_ENV;
if (envDir) {
  rspackPkg = await import(
    pathToFileURL(resolveRspackEntry(join(envDir, "node_modules", "@rspack", "core"))).href,
  );
} else {
  rspackPkg = await import("@rspack/core");
}
const rspack = rspackPkg.rspack ?? rspackPkg.default?.rspack;

// cordis 域源码收集（plugins/**/*.js；cordis.config/build 为 .mjs 不收集）
const rewriter = makeUrlRewriter(collectSource(join(SRC_ROOT, "plugins")));

// 静态组装：子插件 package.json/client.js + dshana roster bundle
function buildCordisStatic(outRoot) {
  fs.removeSync(outRoot);
  fs.ensureDirSync(outRoot);
  const pluginsRoot = join(SRC_ROOT, "plugins");
  if (!fs.pathExistsSync(pluginsRoot)) throw new Error("src-cordis/plugins 缺失");
  const pkgNames: any[] = [];
  for (const name of fs.readdirSync(pluginsRoot)) {
    if (name.startsWith(".")) continue;
    const pkgSrc = join(pluginsRoot, name);
    if (!fs.statSync(pkgSrc).isDirectory()) continue;
    const pkgOut = join(outRoot, name);
    fs.ensureDirSync(pkgOut);
    pkgNames.push(name);
    for (const f of ["package.json"]) {
      const s = join(pkgSrc, f);
      if (!fs.pathExistsSync(s)) throw new Error(`cordis 插件文件缺失：${s}`);
      fs.copySync(s, join(pkgOut, f));
    }
    const clientSrc = join(pkgSrc, "client.js");
    if (fs.pathExistsSync(clientSrc)) fs.copySync(clientSrc, join(pkgOut, "client.js"));
  }
  // roster patch：不再是一个 bundle 包（profile 的 dsh.profile.bundles 里也不再有我们的
  // 名字），而是随包一份普通文件，runtime 经 patchFiles 作启动期 overlay 传进去。
  const patchSrc = join(SRC_ROOT, "cordis.patch.yml");
  if (!fs.pathExistsSync(patchSrc)) throw new Error(`roster patch 缺失：${patchSrc}`);
  fs.copySync(patchSrc, join(dirname(outRoot), "cordis.patch.yml"));
  console.log("cordis 静态组装 -> dist/cordis/（子插件 " + pkgNames.length + " 包）；roster patch -> dist/cordis.patch.yml");
}

// 每包构建描述加载
async function loadCordisPackageConfigs() {
  const pluginsRoot = join(SRC_ROOT, "plugins");
  const list: any[] = [];
  for (const name of fs.readdirSync(pluginsRoot)) {
    const pkgDir = join(pluginsRoot, name);
    if (!fs.statSync(pkgDir).isDirectory()) continue;
    const cfgPath = join(pkgDir, "cordis.config.mjs");
    if (!fs.pathExistsSync(cfgPath)) throw new Error(`cordis 包缺构建描述：${cfgPath}`);
    const mod = await import(pathToFileURL(cfgPath).href);
    list.push({ name, pkgDir, cfg: mod.default ?? {} });
  }
  return list;
}

// service 半（rspack 逐包）
async function buildServiceHalves(packages, outRoot) {
  let count = 0;
  for (const { name, pkgDir } of packages) {
    const cfg = serviceBundle({ name, pkgDir, outDir: join(outRoot, name) });
    await new Promise<void>((resolvePromise, reject) => {
      const compiler = rspack(cfg);
      compiler.run((err, stats) => {
        compiler.close(() => { });
        if (err) return reject(err);
        if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
        resolvePromise();
      });
    });
    count += 1;
  }
  console.log(`cordis service 半（rspack）-> ${outRoot}（${count} 个 ESM bundle）`);
}

// client 半（tsdown，有 client 描述字段的包）
async function buildClientHalves(packages, outRoot) {
  let count = 0;
  for (const { name, pkgDir, cfg } of packages) {
    if (!cfg.client) continue;
    await buildClientBundle({
      id: `@dshana/${name}`,
      pkgDir,
      outDir: join(outRoot, name),
      externals: cfg.client.externals,
      defines: cfg.client.defines,
    });
    count += 1;
  }
  console.log(`cordis client 半（tsdown）-> ${outRoot}（${count} 个 closure-factory bundle）`);
}

// 主流程
const outRoot = join(ROOT, "dist", "cordis");
const cordisPackages = await loadCordisPackageConfigs();
buildCordisStatic(outRoot);
await buildServiceHalves(cordisPackages, outRoot);
await buildClientHalves(cordisPackages, outRoot);
// cordis bundle URL 回写（dist/cordis 区）
rewriter(outRoot);
assertNoStaticFileUrl(join(ROOT, "dist"));
// 产物落位：仓库树要扮演「安装树」（runtime 解析模式从安装树算解析代、不建链接），所以把 scope
// 平铺照原样再放一份到 node_modules/@dshana，与 @deepseek-ai/* 做邻居。这份是一次构建的拷贝而
// 不是链接：pnpm install 会把它剪掉，重跑构建即回；出包时 pack 把同一份 dist/cordis 放进包内的
// node_modules/@dshana（那边是唯一形态）。
const scopeDir = join(ROOT, "node_modules", "@dshana");
fs.removeSync(scopeDir);
fs.copySync(outRoot, scopeDir);
console.log("cordis scope 落位 -> node_modules/@dshana（仓库树扮演安装树）");
console.log("build:cordis done ->", outRoot);
