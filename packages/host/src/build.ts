// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/host/src/build.ts — host 域构建入口（受管 runtime 入口 bundle）
// 产物：.cache/host/dsh-host.mjs。App 域的构建（packages/app 那份）把它拷进交付目录的
// runtime/ 并做交付面收口（静态 URL 回写与断言覆盖整个 dist）。
// 用法：node packages/host/src/build.ts [RSPACK_ENV=<构建环境目录>]
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";
import config from "./rspack.config.mts";
import { collectSource, makeUrlRewriter, assertNoStaticFileUrl } from "../../../scripts/build/common.mts";
// 产物目录常量（.cache/host）与 Node 版本断言（本入口以 TypeScript 直跑，依赖原生类型剥离）
import { HOST_DIR } from "../../../scripts/shared/paths.mts";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url))); // packages/host/src/

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
    if (stats?.hasErrors()) return reject(new Error("build:host：" + stats.toString({ errors: true })));
    console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
    resolvePromise();
  });
});

rewriter(HOST_DIR);
assertNoStaticFileUrl(HOST_DIR);
console.log("build:host done ->", HOST_DIR);
