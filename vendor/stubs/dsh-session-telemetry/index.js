// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// vendor/stubs/dsh-session-telemetry/index.js — 上游同名包的空实现替身
//
// 为什么替掉它：它只被 `dsh-session-telemetry-otel` 依赖（那一行已关），留着就还会把
// otel 那棵树连回来。理由与复核时点见 pnpm-workspace.yaml 的 overrides。

/** 插件名（cordis 会用到）。 */
export const name = '@deepseek-ai/dsh-session-telemetry';

/** 空实现：不做任何事。 */
export function apply() {
  /* 就地留白。 */
}

export default { name, apply };
