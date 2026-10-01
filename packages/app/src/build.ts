// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/app/src/build.ts — 主 bundle（app 域）构建入口（App 交付形态）
// 布局：领域专用脚本随各自源码——rspack.config.mts（本目录，配置源）与本入口放 packages/app/src/，
// 共享工具（collect/walk/terser/assert + minify/template loader）在 scripts/build/。
// 产物（.cache/dist = App 安装目录形态；宿主读该根 manifest.json + entry）：根下只放宿主读的契约件与
// 目录（manifest.json / assets / skills / ui / node_modules / 声明文本），代码全在 bin/。
// 源码侧同形：App 契约与随包静态件在仓库根（manifest.json / assets / skills），壳源与主体在
// packages/app/src/。
//   manifest.json       App v2 manifest（entry "bin/index.mjs" / icon "assets/icon.png"）
//   bin/index.mjs       壳：由壳源 packages/app/src/index.ts 写出，只 re-export 同目录的 ./app.mjs（宿主启 App 时会缓存它）
//                       入口用 .mjs：Node 按扩展名就判 ESM，安装树不必再带一份 package.json 定 type
//   bin/app.mjs         App 主体（含它自己切出的 chunk）
//   bin/dsh.mjs          受管 Node runtime 入口（宿主以 node 执行；与主体同一次构建、共享 chunk）
//   bin/cordis.patch.yml 我们的 roster patch（build:cordis 写出；runtime 按入口所在目录取它，不进包根）
//   assets/icon.png     App 身份图标（manifest.icon 指向的包内真实图片）
//   skills/             App skills（dshana，SKILL.md 随包分发）
//   ui/                   壳的文档侧（cards route 指向壳页，见 packages/ui/src/——相对资源路径，
//                         宿主以 /api/apps/<id>/ui<route> 服务；由 @dshana/ui 构建产出，本入口只拷贝）
// 路由：v2 走 ctx.routes.register（单个 route app），不生成 .cache/dist/routes/ 目录——宿主只认注册
// 的 route app，不扫 dist。
// 用法：node packages/app/src/build.ts [RSPACK_ENV=<构建环境目录>]
// 注意：本文件是构建入口，不在 bundle 里（入口在 rspack.config.mts 指定）；collectSource 会把
// app 与 host 两域的 .ts 一并收作 URL 回写与静态 URL 断言的扫描面。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";
import config from "./rspack.config.mts"; // 同目录（app 域配置随源码）
import {
  collectSource,
  makeUrlRewriter,
  extraMinify,
  assertNoStaticFileUrl,
} from "../../../scripts/build/common.mts";
// 交付目录常量（.cache/dist、.cache/ui）与 Node 版本断言（本入口以 TypeScript 直跑，依赖原生类型剥离）
import { DIST_DIR, UI_DIR, ROOT } from "../../../scripts/shared/paths.mts";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url)); // packages/app/src/

// rspack 解析：RSPACK_ENV 指向构建环境（推荐），否则本地 node_modules
function resolveRspackEntry(coreDir) {
  const pkg = JSON.parse(fs.readFileSync(join(coreDir, "package.json"), "utf8"));
  const dot = pkg.exports?.["."];
  let entry: string | null = null;
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") entry = dot.default ?? dot.import ?? dot.require;
  if (!entry) entry = pkg.main ?? "dist/index.js";
  return join(coreDir, entry as string);
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

// 源码收集（供 URL 回写）：app 主体与 host runtime 同一次构建，两域的 .ts 都要收
// （runtime 入口用 import.meta.url 定位安装根，静态化的 file:// 字面量必须回写）。
const rewriter = makeUrlRewriter(
  new Map([...collectSource(SRC_ROOT), ...collectSource(join(ROOT, "packages", "host", "src"))]),
);

// 单 compiler 编译封装（rspack 一次 run/close；stats 报错即 reject）
async function compile(cfg, label) {
  const compiler = rspack(cfg);
  await new Promise<void>((resolvePromise, reject) => {
    compiler.run((err, stats) => {
      compiler.close(() => { });
      if (err) return reject(err);
      if (stats?.hasErrors()) return reject(new Error(label + "：" + stats.toString({ errors: true })));
      console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
      resolvePromise();
    });
  });
}

// 主 bundle 编译（rspack output.clean 清空 .cache/dist 后写入 index.js）
await compile(config, "build:app 主 bundle");

// 受管 runtime 入口已随本次 rspack 构建落到交付目录 bin/（两入口一次构建，见 rspack.config.mts）
const runtimeEntry = join(DIST_DIR, "bin", "dsh.mjs");
if (!fs.pathExistsSync(runtimeEntry)) {
  throw new Error("受管 runtime 入口缺失（" + runtimeEntry + "）：拒绝出一份没有 runtime 的 App");
}
// bin/index.mjs = 壳：直接由壳源 packages/app/src/index.ts 写出（去行注释 + 把源内的 ./app.ts
// 换成同目录的 ./app.mjs）。不由 rspack 产出——静态两行、跨构建字面不变，宿主缓存它才稳
// （rspack 出的入口会带 ESM chunk 运行时与数字 id，每次都变）。壳与主体同在 bin/，包根只留
// 宿主读的契约件与目录。
if (!fs.pathExistsSync(join(DIST_DIR, "bin", "app.mjs"))) {
  throw new Error("App 主体缺失（bin/app.mjs）：拒绝出交付目录");
}
const shellJs = fs.readFileSync(join(SRC_ROOT, "index.ts"), "utf8")
  .replace(/^[ \t]*\/\/.*$/gm, "")
  .replace(/\.\/app\.ts/g, "./app.mjs")
  .trim() + "\n";
fs.writeFileSync(join(DIST_DIR, "bin", "index.mjs"), shellJs, "utf8");

// 1) 静态化路径字面量回写（dist 主区）
rewriter(DIST_DIR);

// 2) App 交付目录组装（dist 根 = App 安装目录；根下是 manifest/skills/icon/ui 这类契约件与目录，入口在 bin/）
fs.copySync(join(ROOT, "manifest.json"), join(DIST_DIR, "manifest.json"));
fs.copySync(join(ROOT, "skills"), join(DIST_DIR, "skills"));
// App 图标：仓库根 assets/icon.png 为唯一规范源（manifest.icon "assets/icon.png"）；
// 依赖部署（自包含打包）：DSH 依赖由 scripts/release/pack/index.mts 物化进安装目录 node_modules，
// dist = App 安装目录形态（含 cordis 产物）；依赖随包物化，dist 保持轻量壳。
const iconSrc = join(ROOT, "assets", "icon.png");
if (!fs.pathExistsSync(iconSrc))
  throw new Error("App 图标缺失（assets/icon.png，仓库根）：manifest.icon 指向 assets/icon.png，需真实可解码图片");
fs.copySync(iconSrc, join(DIST_DIR, "assets", "icon.png"));
console.log("manifest.json + skills/ + assets/icon.png -> .cache/dist/（App v2 安装目录形态）");

// 壳的文档侧（ui/ 整树：页面脚本 bundle + 静态面）：由 @dshana/ui 先行构建产出 .cache/ui，
// 本入口只拷贝。缺件即拒（contributes.cards 的 route 指向 ui 内页面，缺了就是卡片 404 +
// manifest 校验失败）。
const uiSrc = UI_DIR;
if (!fs.pathExistsSync(uiSrc)) {
  throw new Error("壳的文档侧产物缺失（" + uiSrc + "）：先跑 pnpm run build:ui");
}
fs.copySync(uiSrc, join(DIST_DIR, "ui"));
console.log("ui/ -> .cache/dist/ui（壳的文档侧整树，来自 .cache/ui）");

// 3) 二次压缩（主区：JS + 静态壳页 HTML）+ 静态 URL 断言
await extraMinify(DIST_DIR);
assertNoStaticFileUrl(DIST_DIR);
console.log("build:app done ->", DIST_DIR);
