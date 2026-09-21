// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/build/server-config.mts — 集成层的 server 半共享 preset（rspack + swc）
//
// 上游的 api 包发布的是**单个 ESM bundle**（lib/index.js：只 import node 内建与 dsh-* 兄弟包，
// 未压缩），我们的 overlay 是那份包的 TS 源码。要既带上 delta、又不把兄弟包内联成重复副本，
// 就得用同一姿势重打一遍：非相对导入保持外部，相对导入合并进同一个文件。
//
// 为什么是 rspack（而不是 client 半用的 tsdown）：上游源码带 **标准装饰器**（`@Remote('list')`
// 挂在类方法上，实现在 dsh-typert-protocol 的 remoteDecorator，按 (value, context) 取值）。
// rolldown/oxc 现在只降 legacy：标准装饰器会被原样放出去（`@(void 0)` 之类仍是语法错误，
// node 一 import 就 Invalid or unexpected token）。swc 要 `legacyDecorator: false` +
// `decoratorVersion: "2022-03"` 才按标准提案降级，语义与上游产物一致。
//
// 与上游产物对齐的三处：format esm（不是 closure-factory 的 cjs）、platform node、不压缩。
// dts 不从源码生成：上游的 lib/types/** 与 lib/*.d.ts 原样沿用模板（覆盖层只加可选字段，
// 方法签名没变，声明面不用重打）。
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

/** 判断 specifier 是否该保持外部：非相对、非绝对路径的一律外部（node 内建由 externalsPresets 管）。 */
function isBare(spec) {
  const s = String(spec || "");
  if (!s) return false;
  if (s.startsWith(".") || s.startsWith("file:") || s.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return false; // win32 绝对路径
  return true;
}

/** 解析 rspack（RSPACK_ENV 或本地 node_modules；与 src-cordis/build.ts 同一口径）。 */
async function loadRspack() {
  const envDir = process.env.RSPACK_ENV;
  if (envDir) {
    const coreDir = join(envDir, "node_modules", "@rspack", "core");
    const pkg = JSON.parse(fs.readFileSync(join(coreDir, "package.json"), "utf8"));
    const dot = pkg.exports?.["."];
    let entry = null;
    if (typeof dot === "string") entry = dot;
    else if (dot && typeof dot === "object") entry = dot.default ?? dot.import ?? dot.require ?? null;
    const mod = await import(pathToFileURL(join(coreDir, entry || pkg.main || "dist/index.js")).href);
    return mod.rspack ?? mod.default?.rspack;
  }
  const mod = await import("@rspack/core");
  return mod.rspack ?? mod.default?.rspack;
}

/**
 * 打一个包的 server 半（单文件 ESM bundle）。
 * @param opts - { id, pkgDir, outDir, entry, outFile }：id = 包名；pkgDir = 源码树根
 *   （stage 树，entry 相对它）；outDir = lib 目标目录；entry 缺省 src/index.ts；
 *   outFile 缺省 index.js。
 * @returns { id, out }：产物路径
 */
export async function buildServerBundle({ id, pkgDir, outDir, entry = "src/index.ts", outFile = "index.js" }) {
  const rspack = await loadRspack();
  const out = join(outDir, outFile);
  const compiler = rspack({
    name: id + "/server",
    mode: "production",
    target: "node",
    entry: join(pkgDir, entry),
    output: {
      path: outDir,
      filename: outFile,
      module: true,
      library: { type: "module" },
      clean: false, // 同目录还有模板拷来的 package.json / lib/types（clean 会误删）
    },
    experiments: { outputModule: true },
    externalsPresets: { node: true },
    externalsType: "module",
    externals: [(ctx, cb) => (isBare(ctx.request) ? cb(null, ctx.request) : cb())],
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: "builtin:swc-loader",
            options: {
              jsc: {
                parser: { syntax: "typescript", decorators: true },
                transform: { legacyDecorator: false, decoratorVersion: "2022-03" },
                target: "es2022",
              },
            },
          },
        },
      ],
    },
    // minimize false：对齐上游产物（lib/index.js 未压缩）。
    // usedExports/sideEffects false：不许摇树丢掉「只为副作用存在」的模块（装饰器注册、prototype 写入）。
    optimization: { minimize: false, usedExports: false, sideEffects: false, concatenateModules: true },
    node: false,
    devtool: false,
    stats: "errors-warnings",
  });
  await new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) return reject(err);
      if (!stats || stats.hasErrors()) {
        return reject(new Error("server 半编译失败（" + id + "）：\n" + String(stats ? stats.toString({ errors: true }) : err)));
      }
      const warnings = stats.toString({ warnings: true });
      if (warnings && warnings.trim()) console.log("[integrations] " + id + " server 半告警：\n" + warnings);
      resolve();
    });
  });
  return { id, out };
}
