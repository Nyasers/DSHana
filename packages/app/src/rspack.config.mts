// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/app/src/rspack.config.mts — dshana 主 bundle 构建配置（app 域：随源码，见布局原则
// 「领域专用脚本随各自源码」；.mts 不被 collectSource 收集，不随 bundle 打包）
// 与 hana-remote-dev 的 rspack.config.mts 对齐，按 dshana 实际适配：
//   - 两入口一次构建：
//       · 主体 packages/app/src/app.ts → bin/app.mjs
//       · 受管 runtime 入口 packages/host/src/main.ts → bin/dsh.mjs（宿主以 node 执行）
//     主体与 runtime 有公共代码，同一次构建让 rspack 把它切成共享 chunk（splitChunks），
//     两边不各打一份；切出的 chunk 都归 bin/。
//   - 产物根 index.js **不由本构建产出**：由壳源码 packages/app/src/index.ts 写出两行 re-export
//     （见 packages/app/src/build.ts）。宿主按 manifest.entry=index.js 加载它、且启 App 时
//     会缓存它——静态写出才能跨构建不变（rspack 出的入口会带数字 id/chunk 名，每次都变）。
//   - 输出 ESM module（纯 ESM 无原生模块，不需要 CJS+loadBundle 沙箱；宿主直接 import）
//   - library.type=module：入口具名导出（apply）真 emit 成 ESM export，宿主直接 import
//   - packages/app/src/assets 只有 icon.png（App 图标，由 build.ts 原样 copy，不进 bundle），
//     本配置不需要 asset 规则
//   - externalsPresets.node：node 内置模块保持外部 import（零运行时依赖）
// rspack 解析路径走 packages/app/src/build.ts 的 resolveRspackEntry（RSPACK_ENV 或本地 node_modules）
import path from "node:path";

import { ROOT, DIST_DIR } from "../../../scripts/shared/paths.mts";

export default {
  name: "dshana",
  mode: "production",
  target: "node",
  entry: {
    // App 主体（宿主在隔离进程内加载）
    "bin/app": path.join(ROOT, "packages", "app", "src", "app.ts"),
    // 受管 runtime 入口（宿主以 node 执行 bin/dsh.mjs）
    "bin/dsh": path.join(ROOT, "packages", "host", "src", "main.ts"),
    // 产物根 index.js 不在这里：它是 build.ts 写出的静态壳（两行 re-export），不参与打包
  },
  output: {
    path: DIST_DIR,
    // 入口（bin/main、bin/dsh）与它们共享的 chunk 都归 bin/
    filename: (pathData) => {
      const name = String(pathData.chunk?.name ?? "");
      return name.startsWith("bin/") ? "[name].mjs" : "bin/[name].mjs";
    },
    chunkFilename: "bin/[name].mjs",
    module: true,
    clean: true,
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  // .ts 交给内置 swc 转译：app 域是正式 TypeScript（interface / 类型注解 / import type），
  // 构建期由 swc 剥掉类型只留 JS。本域无 JSX，test 只收 .ts、parser 不开 tsx（否则 .ts 里的
  // `<` 会被当 JSX 起头）；jsc.target 与 tsconfig.app.json 的 ES2022 对齐，不做无谓降级。
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
  // 入口导出无外部消费者时会被导出级 tree-shaking 摇成空壳（插件本体要全部保留）。
  // splitChunks 全量切：主体自己按需分包，chunk 落 bin/（壳侧不重复一份）。
  optimization: {
    minimize: true,
    usedExports: false,
    sideEffects: false,
    splitChunks: { chunks: "all" },
  },
  devtool: false,
  node: false,
  stats: "minimal",
};
