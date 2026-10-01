// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/host/src/rspack.config.mts — 受管 runtime 入口 bundle 构建配置（host 域）
// 产物：.cache/host/dsh-host.mjs（ESM）。App 域的构建把它拷进交付目录的 runtime/，
// 宿主 ctx.runtime.start({ runtime:"node", entry:"runtime/dsh-host.mjs" }) 直接以 node 执行
// （entry 相对 App 安装根）。
//
// 打包纪律：
//   - @deepseek-ai/*（dsh/cordis/dsh-* 官方插件树）**不静态打进**：它们随包物化在安装目录
//     node_modules（自包含打包，见 scripts/release/pack/index.mts），运行时直接解析（不安装、
//     不下载），但仍不能静态打进本 bundle——dsh 定位/动态 import 一律 /* webpackIgnore: true */ 保留原生
//     import()（见 packages/host/src/locate.ts 与 main.ts）；
//   - @hana/app-sdk 的 connectAppRuntime 运行时实现来自 devDependencies（file:vendor/
//     hana-app-sdk/hana-app-sdk.tgz，0.946.2，Apache-2.0，来源与许可声明见 THIRD_PARTY_NOTICES.md），
//     经静态 import 由本 bundle 内联（只依赖 node:crypto，无运行时包解析——bundle 后
//     不依赖 App 能解析 @hana/app-sdk 包）；
//   - node 内建外部 import（externalsPresets.node）；零宿主依赖的叶子模块（@dshana/shared）
//     随 bundle 内联。
//   - 不做 library 命名导出：入口只 self-run（main()），宿主只认 stdout readyMarker/退出码。
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_DIR } from "../../../scripts/shared/paths.mts";

const root = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))); // packages/host/src/ → 仓库根

export default {
  name: "dshana-runtime",
  mode: "production",
  target: "node",
  entry: path.join(root, "packages", "host", "src", "main.ts"),
  output: {
    path: HOST_DIR,
    filename: "dsh-host.mjs",
    module: true,
    clean: true,
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  // .ts 交给内置 swc 转译（同主 bundle 配置）：host 域也是正式 TypeScript，无 JSX。
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
  optimization: { minimize: true, usedExports: false, sideEffects: false },
  devtool: false,
  node: false,
  stats: "errors-warnings",
};
