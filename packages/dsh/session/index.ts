// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/dsh-session 的 service 半（cordis 子插件）——五个会话操作的编排落点。
//
// 位置与角色：本包随受管 runtime（dist/bin/dsh.mjs）跑，与 DSH 同进程，用 cordis 的 inject 直取
// DSH 的会话服务（sessions / sessionQuery / sessionProjections），不经 DSH 的 HTTP 面。
// 宿主侧编排（工具面、回执、卡片字面量、callToken 接收与下传）在同域的另一个包
// @dshana/session 的 src/ 下：两个包各持自己的形态，不共享代码，本包没有 src/ 可 import。
//
// 自持性约束：随包物化的成品树只带 cordis 子插件（node_modules/@dshana 下 dsh-clipboard /
// dsh-provider / dsh-session / dsh-theme 与组合层 dsh-app），开发期的 @dshana/* 兄弟包不在其中。所以本半只许依赖
// DSH 侧服务与 node 内建，不 import 任何 @dshana/* 包——要复用的东西得随本半一起打包进来。
//
// 分工（见 specs/current/session-plugin/spec.md §4.1）：
//   · App 侧留：ctx.tools.register 与参数 schema、回执文本、卡片字面量、宿主任务声明的三个档位、
//     callToken 的接收与下传；
//   · 本半接：任务创建与回写、终态等待、同会话串行化、会话建立/续用、prompt、取消链、审批应答、读取。
// 调用面（App 侧一次 invokeControl(ctx, "<action>", { op, args, callToken? })，本半按 op 分发）
// 由 T2 接上，见 specs/current/session-plugin/tasks.md。
//
// 容错纪律：apply 不抛——依赖缺失/初始化失败只记日志、降级为空操作，不阻断 DSH 启动
// （与 @dshana/dsh-provider 同款；子插件日志走 ctx.logger，受管 runtime 的输出由宿主运行体日志捕获）。

export const name = "@dshana/dsh-session";

/** 依赖的 DSH 服务：会话集合（sessions）、冷读查询（sessionQuery）、投影（sessionProjections）。 */
export const inject = ["sessions", "sessionQuery", "sessionProjections"];

function log(ctx, msg) {
  try {
    ctx.logger?.info?.("[" + name + "] " + msg);
  } catch {
    /* 日志失败不阻断 */
  }
}

export function apply(ctx, _config) {
  try {
    log(ctx, "已挂载（inject: sessions / sessionQuery / sessionProjections 已就绪）");
  } catch (e) {
    // 顶层兜底：apply 永不抛出（cordis 侧不希望插件把 boot 带下去）
    try {
      ctx.logger?.error?.("[" + name + "] 初始化失败，降级为空操作：" + ((e && e.message) || e));
    } catch {
      /* 忽略 */
    }
  }
}
