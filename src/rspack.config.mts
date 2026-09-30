// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/rspack.config.mts — dshana 主 bundle 构建配置（src 域：随源码根，见布局原则\n// 「领域专用脚本随各自源码」；.mjs 不被 collectSource 收集，不随 bundle 打包）
// 与 hana-remote-dev 的 rspack.config.mts 对齐，按 dshana 实际适配：
//   - 两入口：src/shell.ts → dist/index.js（入口壳：宿主 import 的那份，只把 apply 转给实现包）
//             src/index.ts → dist/bin/impl.js（实现：生命周期 + dshana 工具 + lib + 路由全部收敛）
//     分家理由（DESIGN.md「交付布局」）：入口字节稳定，会变的实现单独成包，受管 runtime 入口
//     （src/runtime → dist/bin/dsh-host.mjs）与它同放 bin/。两入口各自自包含（splitChunks 关），
//     共享模块复制两份，换「壳薄 + 实现不被拆成第三方 chunk」的确定性。
//   - 输出 ESM module（纯 ESM 无原生模块，不需要 CJS+loadBundle 沙箱；宿主直接 import）
//   - library.type=module：入口具名导出（apply）真 emit 成 ESM export，宿主直接 import
//   - src/assets 只有 icon.png（App 图标，由 build.ts 原样 copy，不进 bundle），本配置不需要
//     asset 规则
//   - externalsPresets.node：node 内置模块保持外部 import（零运行时依赖）
// rspack 解析路径走 src/build.ts 的 resolveRspackEntry（RSPACK_ENV 或本地 node_modules）
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = path.join(root, "dist");

export default {
  name: "dshana",
  mode: "production",
  target: "node",
  entry: {
    index: path.join(root, "src", "shell.ts"),
    // "bin/impl" 里的斜杠就是输出子目录：产物落 dist/bin/impl.js
    "bin/impl": path.join(root, "src", "index.ts"),
  },
  output: {
    path: DIST_DIR,
    filename: "[name].js",
    module: true,
    clean: true,
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  // .ts 交给内置 swc 转译：src 域是正式 TypeScript（interface / 类型注解 / import type），
  // 构建期由 swc 剥掉类型只留 JS。本域无 JSX，test 只收 .ts、parser 不开 tsx（否则 .ts 里的
  // `<` 会被当 JSX 起头）；jsc.target 与 tsconfig.src.json 的 ES2022 对齐，不做无谓降级。
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
  // v1 的 assets 前端资源（jinja2 模板 + card.js/css）已随 W6 清理删除，无需 asset/source 与
  // template-loader 规则（src/assets 只剩 icon.png，由 build.ts 原样 copy，不进 bundle）。
  // usedExports: false + sideEffects: false —— 关闭导出级 tree-shaking（入口导出无外部
  // 消费者会被整体摇成空壳，插件本体全部保留）；splitChunks/runtimeChunk 关 —— 两入口各自
  // 自包含：壳不许被塞进共享 chunk，实现也不许被拆出去。
  optimization: { minimize: true, usedExports: false, sideEffects: false, splitChunks: false, runtimeChunk: false },
  devtool: false,
  node: false,
  stats: "minimal",
};
