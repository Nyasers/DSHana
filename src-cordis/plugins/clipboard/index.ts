// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/clipboard — DSH Web UI 剪贴板转发（只有 client 半）。
//
// 语义：嵌入场景（DSHana 卡）下 navigator.clipboard 被宿主的 Permissions-Policy 拒绝（真机
// permissions.query({name:'clipboard-write'}) → 'denied'），原生 writeText 一调就是一条
// [Violation] 随后 reject。所以把 DSH 侧的写请求转给 DSHana 应用侧。
//
// 本包只有写口这一层（原生优先 + 兜底）（client 半，client.js）：把 navigator.clipboard.writeText / write
// 换成转发实现，转给壳页发布的 __DSHANA__.clipboardWrite。写不写得成由应用侧的 handler 决定
// （src/ui/app-shell.ts 的 writeClipboard，它走宿主 capability clipboard.writeText，在宿主主
// 窗口上下文执行，不受插件 iframe 权限链限制）——本包不做判断、不做回落、不上报。
//
// 为什么是转发而不是自己做：同文档注入之后前端与壳页共用一个 window，__DSHANA__ 直接可调——
// 不需要 postMessage + MessageChannel + 超时 + 回执校验那套握手，也不需要注入点、index 改写、
// 独立桥脚本；而"写进系统剪贴板"这件事的能力面只在应用侧（宿主能力门）。
//
// 本半（service 半）**无运行时行为**：构建按包扫 index.js（src-cordis/build.ts 的逐包
// rspack），故显式留一个空实现并在注释里记明，不做多余的事（不注册路由、不注入 index）。
// 依赖数组为空——本包不消费任何 cordis 服务。

export const name = '@dshana/clipboard'

export function apply() {
  /* 就地留白：见文件头“本半无运行时行为”。 */
}
