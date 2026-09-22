// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/theme/adapter.ts — 适配层的取值规则与编译（零依赖纯函数）。
//
// 为什么不再是 1:1 映射表：宿主只给十几个变量（--bg / --bg-card / --text / --overlay-* …），
// 而 DSH 前端在用的 --dsw-* 有一百七十多个，其中大量是「比底深一档 / 深两档」的层次位。1:1
// 直连会把几档语义挤到同一个宿主变量上（base 与 layer-1 同接 --bg、悬停与静止同接一档叠色），
// 层级随之塌掉。适配层让每条规则自带偏移量，档位由规则拉开，不再受宿主变量个数限制。
//
// 三种写法：
//   "--bg"                      直连宿主变量
//   { of: "--bg", shift: 8 }    基色向对比方向偏移 8%。对比色默认 --text：浅色主题它是深墨 →
//                               压暗，深色主题它是浅字 → 提亮。一个表达式覆盖两套明暗，不必
//                               分开写 light / dark。
//   { fixed: "#2b2b2b" }        固定值。宿主没有对应语义时才用，登记在表里、逐条写理由。
//
// 编译只在服务端做一次，产物是 [token, cssValue, hostVars] 三元组：
//   · 桥（assets/theme-bridge.js）按 hostVars 判空后原样写进 body 覆盖，不再自带一份编译逻辑；
//   · 垫片（src/lib/seed-tokens.ts）与测试断言复用同一个 compileTarget。
// 这样「同一个值由同一处算出」是结构上的事，不靠两处手写保持一致。

/** 一条适配规则的目标。 */
export type AdapterTarget =
  | string
  | { of: string; shift?: number; with?: string }
  | { fixed: string };

/** 一条适配规则：DSH token 名 + 目标。 */
export type AdapterRule = readonly [string, AdapterTarget];

/** 编译后的三元组：token、CSS 值、这一值依赖的宿主变量（判空用）。 */
export type CompiledRule = readonly [string, string, readonly string[]];

/** 偏移的默认对比色：宿主 --text 在浅色主题是深墨、深色主题是浅字，方向自动反向。 */
const CONTRAST_VAR = "--text";

/** 把一条规则的目标编译成 CSS 值（`var(--bg)` / `color-mix(…)` / 原样字面量）。 */
export function compileTarget(target: AdapterTarget): string {
  if (typeof target === "string") {
    return target.startsWith("~") ? target.slice(1) : "var(" + target + ")";
  }
  if ("fixed" in target) return target.fixed;
  const pct = Number(target.shift) || 0;
  const against = target.with || CONTRAST_VAR;
  if (pct <= 0) return "var(" + target.of + ")";
  if (pct >= 100) return "var(" + against + ")";
  return (
    "color-mix(in srgb, var(" + target.of + ") " + (100 - pct) + "%, var(" + against + ") " + pct + "%)"
  );
}

/** 一条规则依赖的宿主变量（固定值不依赖任何宿主变量）。 */
export function targetHostVars(target: AdapterTarget): string[] {
  if (typeof target === "string") return target.startsWith("~") ? [] : [target];
  if ("fixed" in target) return [];
  const against = target.with || CONTRAST_VAR;
  return against === target.of ? [target.of] : [target.of, against];
}

/** 整表编译：规则 → 三元组。 */
export function compileRules(rules: ReadonlyArray<AdapterRule>): CompiledRule[] {
  return rules.map(([token, target]) => [token, compileTarget(target), targetHostVars(target)]);
}
