// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// vendor/stubs/dsh-otel/index.js — 上游 @deepseek-ai/dsh-otel 的空实现（本仓专用替身）
//
// 为什么要替掉它：
//   · 上游 base 的 roster 带两行遥测（`otel` / `session-telemetry-otel`），default mode=FEEDBACK_ONLY、
//     OTLP 端点默认指向 https://dsh-otel-collector.deepseeksvc.com/v1/logs。我们是本地单用户应用，
//     不往外送任何东西，所以那两行在组合层按 id 关掉了（packages/dsh/app/cordis.patch.yml）。
//   · 而 `dsh-otel` 是整棵依赖树里 `got → cacheable-request → http-cache-semantics` 的**唯一入口**
//     （`pnpm why got`：只有一个依赖者），带一条 high 级 advisory（GHSA-ch52-4w7c-c8xp），且上游
//     还没发补丁版（registry 上最新就是 4.2.0）。既然它的唯一消费者是那两行已关的 roster，
//     就把它换成空实现：依赖树里不再有 got/cacheable-request/http-cache-semantics，
//     `pnpm audit --audit-level=high` 也不需要再记例外。
//
// 替身必须满足的两点：
//   · **能解析**：profile 解析 roster 时会按名字找包，缺件会报错，所以这里是一个合法包（见 package.json）。
//   · **能当插件加载**：万一有哪一行被启用（例如上游 web-app / product-analytics 那几行），
//     cordis 会 `apply()` 它——空实现就是什么都不做，正是"遥测关掉"想要的效果。
//
// 复核：上游发布 `http-cache-semantics >= 4.2.1` 之后，这条替身可以撤掉（改回实时依赖 + 保留
// 组合层那两行 disabled）；若上游让某段代码直接 import dsh-otel 的 API，替身会在这里缺件暴露出来
// （装机烟测：DSH 必须仍能起到 phase=ready）。

/** 插件名（cordis 会用到）。 */
export const name = '@deepseek-ai/dsh-otel';

/** 空实现：不做任何事（不注册导出器、不发任何数据）。 */
export function apply() {
  /* 就地留白：见文件头“为什么要替掉它”。 */
}

export default { name, apply };
