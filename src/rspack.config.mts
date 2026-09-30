// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/rspack.config.mts — dshana 构建配置（src 域：随源码根，见布局原则「领域专用脚本随各自源码」）
//
// 三个入口，落在包根与 bin/ 下（安装形态见 DESIGN.md「交付布局」）：
//   src/shell.ts         → dist/index.js            入口壳（manifest.entry 钉死这个文件名）
//   src/main.ts          → dist/bin/main.mjs        App 实现入口（工具 / 路由 / 受管 runtime 编排）
//   src/runtime/main.ts  → dist/bin/runtime.mjs     受管 DSH 子进程入口（宿主 RUNTIME_ENTRY 指它）
//
// 模块化的口径是**可复用的部分不分别内联**：两个 node 入口共享的模块由 splitChunks 自然切出
// （不由我们手写 cacheGroup 把它们强合成一个——那会破坏懒加载的切分），按需 import 的模块
// 各自成 chunk。不追求按源文件一一拆开——那是过度拆分，只换来"看起来整齐"。
//
// externals：
//   · @hana/app-sdk —— 不进 bundle，运行时从安装树 node_modules/@hana/app-sdk 解析（随包分发，
//     与 DSH 包集、@dshana/* 同一路子）；开发侧用仓库自己的 node_modules。
//   · node 内建（externalsPresets.node）；@deepseek-ai/* 由受管 runtime 用原生 import() 定位
//     （见 src/runtime/locate.ts 的 webpackIgnore）。
// 输出 ESM（纯 ESM 无原生模块，宿主直接 import；三个入口的具名导出真 emit 成 ESM export）。
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = path.join(root, "dist");
/** 三个入口的名字：它们的 filename 不会被改路（根入口另有 build.ts 改名成 index.js）。 */
const ENTRY_NAMES = new Set(["index", "bin/main", "bin/runtime"]);

export default {
  name: "dshana",
  mode: "production",
  target: "node",
  entry: {
    index: path.join(root, "src", "shell.ts"),
    "bin/main": path.join(root, "src", "main.ts"),
    "bin/runtime": path.join(root, "src", "runtime", "main.ts"),
  },
  output: {
    path: DIST_DIR,
    // 入口用 [name].mjs（index / bin/main / bin/runtime）；由打包器切出来的 chunk 一律落 bin/ 下
    filename: (pathData) => (ENTRY_NAMES.has(pathData.chunk?.name) ? "[name].mjs" : "bin/[name].mjs"),
    chunkFilename: "bin/[name].mjs",
    module: true,
    clean: true,
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  externals: [/^@hana\//u],
  // .ts 交给内置 swc 转译：src 域是正式 TypeScript，构建期只剥类型。本域无 JSX。
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: "builtin:swc-loader",
          options: { jsc: { parser: { syntax: "typescript" }, target: "es2022" } },
        },
      },
    ],
  },
  // usedExports/sideEffects 关：入口导出无外部消费者会被整体摇成空壳，插件本体全部保留。
  // splitChunks 交给打包器自然切（它按模块图的归属自己分组）；我们只把 chunk 落到 bin/ 下，
  // 不手写 cacheGroup 把它们强合一个。runtimeChunk 不需要（ESM 输出自带）。
  optimization: {
    minimize: true,
    usedExports: false,
    sideEffects: false,
    splitChunks: { chunks: "all" },
    runtimeChunk: false,
  },
  devtool: false,
  node: false,
  stats: "minimal",
};
