// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// vendor/stubs/dsh-host-product-telemetry-otel/index.js — 上游同名包的空实现替身
//
// 为什么替掉它：它由上游 web-app / client-product-analytics 的 `desktop-product-telemetry` 行声明，
// 我们并不加载 web-app 那一层，但它仍会经 meta 依赖树拖进 registry 版 `@deepseek-ai/dsh-otel`
// → `got` → cacheable-request → http-cache-semantics（那条 high 告警）。替成空实现后子树随之离开。
// 理由与复核时点见 pnpm-workspace.yaml 的 overrides。

/** 插件名（cordis 会用到）。 */
export const name = '@deepseek-ai/dsh-host-product-telemetry-otel';

/** 空实现：不做任何事（不注册导出器、不发任何数据）。 */
export function apply() {
  /* 就地留白。 */
}

export default { name, apply };
