// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/build.ts — ui 域构建入口（壳的文档侧）
// 产物：.cache/ui/，即交付目录里 ui/ 那一棵树的完整内容——页面脚本 bundle（app-shell / stream /
// settings 与它们的 css、动态 chunk）加上静态面（*.html 与图片、样式等）。
// App 域的构建（packages/app/src/build.ts）把它拷进交付目录的 ui/，缺件即拒。
// 用法：node packages/ui/src/build.ts [RSPACK_ENV=<构建环境目录>]
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

import fs from "fs-extra";
import config from "./rspack.config.mts";
import { collectSource, makeUrlRewriter, assertNoStaticFileUrl } from "../../../scripts/build/common.mts";
// 产物目录常量（.cache/ui）与 Node 版本断言（本入口以 TypeScript 直跑，依赖原生类型剥离）
import { UI_DIR } from "../../../scripts/shared/paths.mts";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url)); // packages/ui/src/

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

const rewriter = makeUrlRewriter(collectSource(SRC_ROOT));

const compiler = rspack(config);
await new Promise<void>((resolvePromise, reject) => {
  compiler.run((err, stats) => {
    compiler.close(() => { });
    if (err) return reject(err);
    if (stats?.hasErrors()) return reject(new Error("build:ui：" + stats.toString({ errors: true })));
    console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
    resolvePromise();
  });
});

// 静态面拷贝（白名单：只放行已知的静态类型，其余一律不拷）。
// 为何不用黑名单逐个数脚本扩展名：改名那天 .mts 就是没被列上的那个，于是 rspack.config.mts
// 与 build.ts 直接漏进了产物。白名单没有这种缺口，以后多出什么类型都不会漏出源码。
// 逐文件拷（不整棵拷目录）：非静态子目录（例如只放 .d.ts 的 types/）整棵带过来会落一个
// 空目录进交付面，逐文件写就不会——空目录没有代表文件，自然不出现。
const STATIC_EXT = [".html", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".json", ".map"];
let staticCount = 0;
const copyStatic = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const src = join(dir, name);
    if (fs.statSync(src).isDirectory()) {
      copyStatic(src);
      continue;
    }
    if (!STATIC_EXT.some((ext) => name.endsWith(ext))) continue;
    fs.copySync(src, join(UI_DIR, relative(SRC_ROOT, src)));
    staticCount += 1;
  }
};
copyStatic(SRC_ROOT);
console.log("ui/ 静态面 -> " + UI_DIR + "（" + staticCount + " 个文件，白名单 " + STATIC_EXT.join(" ") + "；脚本由 ui bundle 产出）");

// 完整性断言：cards route 的页面与三个入口脚本缺一即拒（产物不完整不交给 App 域）。
// 页面脚本名与 rspack.config.mts 的 entry 同名，页面文件名与 manifest 的 route 同名。
const REQUIRED = [
  "main.html", "default.html", "sidebar.html", "settings.html", "stream.html",
  "app-shell.js", "stream.js", "settings.js",
];
const missing = REQUIRED.filter((rel) => !fs.pathExistsSync(join(UI_DIR, rel)));
if (missing.length) {
  throw new Error("ui 产物不完整（缺 " + missing.join(" / ") + "）：页面或入口 bundle 未产出");
}

rewriter(UI_DIR);
assertNoStaticFileUrl(UI_DIR);
console.log("build:ui done ->", UI_DIR);
