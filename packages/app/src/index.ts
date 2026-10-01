// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/app/src/index.ts — 壳（宿主按 manifest.entry=bin/index.mjs 加载它并调 apply）。
//
// 只把主体（./app.ts → 产物 bin/app.mjs）重新导出。产物 bin/index.mjs 由本文件写出
// （见 packages/app/src/build.ts：去注释、把 ./app.ts 换成同目录的 ./app.mjs）——静态两行、
// 跨构建字面不变，宿主缓存它才稳；不由 rspack 出（那会带 chunk 运行时与数字 id）。
export * from "./app.ts";
export { default } from "./app.ts";
