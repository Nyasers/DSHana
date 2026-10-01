// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/app/src/shell.ts — 产物根 index.js 的壳（宿主按 manifest.entry=index.js 加载它并调 apply）。
//
// 只做一件事：把主入口（./index.ts，产物 bin/main.mjs）重新导出。壳与主体是同一次 rspack
// 构建的两个 entry，公共部分由打包器自然切 chunk——壳里不重复实现，也不手写路径拼接。
export * from "./index.ts";
export { default } from "./index.ts";
