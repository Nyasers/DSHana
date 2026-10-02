// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/app/src/cordis.ts — App 域的 cordis 子插件组装入口
//
// 子插件本身是 packages/ 下的包（`@dshana/clipboard` / `@dshana/provider` / `@dshana/theme`，判据：
// 包内有自持构建描述 `cordis.config.mjs`）；本文件是它们的组装器，归 `@dshana/app`。
//   .cache/cordis/**：3 子插件（provider / theme / clipboard）：service 半 rspack（源 index.ts →
//     产物 index.js bundle），theme 与 clipboard 另出 client 半（client.ts → client.js，tsdown
//     closure-factory）。
// 组合（roster 行、对官方行的取值、@dshana/* insert）不在这里：那是组合层包
// packages/bundle/dsh-app 的 cordis.patch.yml，随包由 profile 的层列选中（层列钉在
// packages/host/src/main.ts）。
// node_modules/@dshana/**：把上面那份 scope 照原样再落一份——仓库树扮演「安装树」，
//   DSH 的 runtime 解析模式从安装树 + bundle 依赖图算解析代、不建链接。出包时 pack 作同样的事。
// 用法：node packages/app/src/cordis.ts [RSPACK_ENV=<构建环境目录>]
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";

import fs from "fs-extra";
import { serviceBundle } from "./cordis/service-config.mts"; // preset 层（本目录 cordis/）
import { buildClientBundle } from "./cordis/client-config.mts";
import { collectSource, makeUrlRewriter, assertNoStaticFileUrl } from "../../../scripts/build/common.mts"; // scripts/build/ 共享
// 交付目录常量（dist、.cache/cordis）与 cordis 子插件包清单（本入口以 TypeScript 直跑，依赖原生类型剥离）
import { CORDIS_DIR, DIST_DIR } from "../../../scripts/shared/paths.mts";
import { cordisPkgDirs } from "../../../scripts/shared/version.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // packages/app/src → 仓库根

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

// cordis 子插件源码收集（各包下 *.ts/*.js；cordis.config.mjs 是构建描述，不收集）
const sourceUrls = new Map();
for (const rel of cordisPkgDirs()) {
  for (const [url, file] of collectSource(join(ROOT, rel))) sourceUrls.set(url, file);
}
const rewriter = makeUrlRewriter(sourceUrls);

// 静态组装：子插件 package.json/client.js + dshana roster bundle
function buildCordisStatic(outRoot) {
  fs.removeSync(outRoot);
  fs.ensureDirSync(outRoot);
  const dirs = cordisPkgDirs();
  if (dirs.length === 0) throw new Error("没找到 cordis 子插件包（判据：packages/*/cordis.config.mjs）");
  const pkgNames: string[] = [];
  for (const rel of dirs) {
    const name = basename(rel);
    const pkgSrc = join(ROOT, rel);
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
  console.log("cordis 静态组装 -> .cache/cordis/（子插件 " + pkgNames.length + " 包）");
}

// 每包构建描述加载（判据同 cordisPkgDirs：包内有 cordis.config.mjs）
async function loadCordisPackageConfigs() {
  const list: any[] = [];
  for (const rel of cordisPkgDirs()) {
    const pkgDir = join(ROOT, rel);
    const cfgPath = join(pkgDir, "cordis.config.mjs");
    if (!fs.pathExistsSync(cfgPath)) throw new Error(`cordis 包缺构建描述：${cfgPath}`);
    const mod = await import(pathToFileURL(cfgPath).href);
    list.push({ name: basename(rel), pkgDir, cfg: mod.default ?? {} });
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
const outRoot = CORDIS_DIR;
const cordisPackages = await loadCordisPackageConfigs();
buildCordisStatic(outRoot);
await buildServiceHalves(cordisPackages, outRoot);
await buildClientHalves(cordisPackages, outRoot);
// cordis bundle URL 回写（.cache/cordis 区）
rewriter(outRoot);
assertNoStaticFileUrl(outRoot);
assertNoStaticFileUrl(DIST_DIR);
// 产物落位：仓库树要扮演「安装树」（runtime 解析模式从安装树算解析代、不建链接），所以把 scope
// 平铺照原样再放一份到 node_modules/@dshana，与 @deepseek-ai/* 做邻居。这份是一次构建的拷贝而
// 不是链接：pnpm install 会把它剪掉，重跑构建即回；出包时 pack 把同一份 .cache/cordis 放进包内的
// node_modules/@dshana（那边是唯一形态）。
// 只按包名逐个替换：@dshana 这个 scope 下还住着 workspace 链接（@dshana/shared），整树清空会把
// 它们一起删掉，于是下一轮构建解析不到。
const scopeDir = join(ROOT, "node_modules", "@dshana");
fs.ensureDirSync(scopeDir);
for (const name of fs.readdirSync(outRoot)) {
  const dst = join(scopeDir, name);
  fs.removeSync(dst);
  fs.copySync(join(outRoot, name), dst);
}
console.log("cordis scope 落位 -> node_modules/@dshana（仓库树扮演安装树）");
console.log("build:cordis done ->", outRoot);
