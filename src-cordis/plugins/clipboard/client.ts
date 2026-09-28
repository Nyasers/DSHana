// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/clipboard 前端 client 半 —— 剪贴板写口（原生优先，失败才转给应用侧）。
//
// 它的顺序是**原生优先**：把 DSH 侧读到的 navigator.clipboard.writeText / write 换成写口：先试原生，拿不到才转给
// DSHana 应用侧（壳页发布的 __DSHANA__.clipboardWrite）。判断、回落、失败表达都不在这里：
// 写不写得成由应用侧的 handler 决定（src/ui/app-shell.ts 的 writeClipboard），它 reject 就是
// 失败，它 resolve 就是成功——转发层原样把那个结果交回 DSH。
//
// 转发本体在 src/ui/clipboard-forward.ts（唯一一份实现，不复制逻辑）。壳页在注入 DSH 之前也装
// 同一份（全局最早 + 一次机会），本 client 半随后幂等补装：同一个 MARK，先装的那次生效，这里的
// 调用是空操作。
//
// 依赖方向：本文件 import src/ui/clipboard-forward.ts。
// 约束：只在浏览器面加载；无 navigator 的构建/测试环境直接跳过。

import { installClipboardForward } from "../../../src/ui/clipboard-forward.js";

export function apply(ctx) {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined || navigator.clipboard === null) return;
  const install = () => installClipboardForward({ target: globalThis });
  if (typeof ctx.effect === "function") {
    ctx.effect(() => install(), 'clipboard: forward DSH writes to the App side (idempotent)');
    return;
  }
  install();
}
