// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/shell.ts — App v2 入口壳（manifest.entry 指向的包根 index.js 由本文件产出）
//
// 形态：入口只做一件事——把宿主的 apply 调用转交给实现入口 bin/main.mjs。
// 为什么分家：宿主的 app-host 子进程按 manifest.entry 的 file:// URL import 入口一次，
// 入口字节稳定，会变的实现就能单独换（实现入口 bin/main.mjs 与受管子进程入口 bin/runtime.mjs
// 都在 bin/ 下，一起构成"会变的那半边"，见 DESIGN.md「交付布局」）。
//
// 不做 cache-bust：换代码走的是换进程（宿主 reload / 安装新包），新子进程的模块缓存本来就是空的。
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HanaPluginContextV2 } from "#/types/host.ts";

/** App 安装目录（本壳与 bin/ 同层，index.js 就落在根上）。 */
const APP_ROOT = dirname(fileURLToPath(import.meta.url));
/** 实现入口（宿主 import 的入口 URL 所在目录下的 bin/）。 */
const IMPL_PATH = join(APP_ROOT, "bin", "main.mjs");

/**
 * 宿主契约：入口导出 apply，返回值即 disposer（宿主 await 结果并交回）。
 * 本壳只负责把调用转给实现——实现没导出 apply 说明包不完整，当场报错，不静默降级。
 */
export async function apply(ctx: HanaPluginContextV2) {
  const mod: any = await import(/* webpackIgnore: true */ pathToFileURL(IMPL_PATH).href);
  const impl = typeof mod?.apply === "function" ? mod.apply : mod?.default?.apply;
  if (typeof impl !== "function")
    throw new Error("实现入口 bin/main.mjs 未导出 apply（App 包不完整）：请重装本 App");
  return impl(ctx);
}

export default { apply };
