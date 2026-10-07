// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// vendor/stubs/dsh-session-telemetry-otel/index.js — 上游同名包的空实现替身
//
// 为什么替掉它：它是 base roster 里 `session-telemetry-otel` 那一行的包，而那一行已在组合层
// （packages/dsh/app/cordis.patch.yml）按 id 关掉；它自己还会拖进 registry 版
// `@deepseek-ai/dsh-otel` → `got` → cacheable-request → http-cache-semantics（那条 high 告警）。
// 替成空实现后，那棵子树连同告警一起离开依赖树。理由与复核时点见 pnpm-workspace.yaml 的 overrides。

/** 插件名（cordis 会用到）。 */
export const name = '@deepseek-ai/dsh-session-telemetry-otel';

/** 空实现：不做任何事（不注册导出器、不发任何数据）。 */
export function apply() {
  /* 就地留白。 */
}

export default { name, apply };
