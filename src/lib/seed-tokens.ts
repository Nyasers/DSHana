// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/seed-tokens.ts — 注入 DSH 之前先垫上的 DSW 底色 token（token-map 的子集，按面分）
//
// 为什么需要：DSH 自己的 design-platform.css 在 body 上写了整套浅色默认
// （--dsw-alias-bg-base = bluish-00，近白），而把宿主色写上去的主题桥是**跑在 DSH 客户端里的
// 插件**，要等它加载完才生效。这中间的几百毫秒里，DSH 的框架层（ui-layout 的 .frame）和它的
// 加载屏都按自己的近白底色画了一遍——就是"闪白"。
//
// 所以在注入前把这几格按宿主主题变量垫上（写 body 的内联 style，**不加 !important**）：
//   · 赢过 DSH 自己的静态样式表（内联 > 普通规则）；
//   · 输给主题桥的 body{… !important}（桥落地后以桥为准）；
//   · DSH 侧注册主题写的内联覆照也照旧盖得掉我们。
//
// 值按面取，取的是"这一面加载完之后真正显示的底色"，两张台面因此不换底：
//   · 中列面（default / main / stream / settings）：中列画 --dsw-alias-bg-base ← 宿主 --bg；
//   · 侧栏面（sidebar）：可见区就是侧栏列，列画 --dsw-specific-sidebar-fill ← 宿主 --sidebar-bg，
//     那么它身后那一层（.frame 的 --dsw-alias-bg-base，DSH 加载屏也在这一层）也得是侧栏色，
//     否则自举台面已是侧栏色、DSH 一加载又退回中列色，看着像加载时换了一次底。
//
// 映射关系必须与 src-cordis/plugins/theme/token-map.ts 一致：每面垫的值 = 这一面可见底 token
// （FACE_BACKDROP）在映射表里的宿主变量，单测盯着这一点——映射改了而这里没跟，测试直接红。
// 宿主变量取不到就跳过——不发明用户没选过的颜色。

/** 一格垫片：[DSW / dsh 首帧变量, 宿主主题变量]。 */
export type SeedPair = readonly [string, string];

const CENTER_SEED: ReadonlyArray<SeedPair> = [
  ["--dsw-alias-bg-base", "--bg"],
  ["--dsw-specific-sidebar-fill", "--sidebar-bg"],
  // dsh index 里的首帧样式按 **@media (prefers-color-scheme: dark)** 写 body 底与启动屏底
  // （ui-theme/src/boot-theme.ts），而那个媒体查询跟的是浏览器系统而非宿主主题。
  // --dsw-alias-bg-base 已在规则表里（桥会盖），--dsh-boot-bg 不是 --dsw-* 成员、桥管不到，
  // 只能靠这层垫片：它写 body 内联，优先级高于样式表，把系统判定的深/浅盖掉。
  ["--dsh-boot-bg", "--bg"],
];

/** 面 → 这一面可见底的 DSW token：中列面是中列的 --dsw-alias-bg-base，侧栏面是侧栏列的填色。 */
export const FACE_BACKDROP: Readonly<Record<string, string>> = {
  default: "--dsw-alias-bg-base",
  main: "--dsw-alias-bg-base",
  stream: "--dsw-alias-bg-base",
  settings: "--dsw-alias-bg-base",
  sidebar: "--dsw-specific-sidebar-fill",
};

/** 面 → 垫片规格；每个面都摊平写全，重复的格也重写一遍（换面时是干净覆盖，不留上一面的值）。 */
export const VIEW_SEEDS: Readonly<Record<string, ReadonlyArray<SeedPair>>> = {
  default: CENTER_SEED,
  main: CENTER_SEED,
  stream: CENTER_SEED,
  settings: CENTER_SEED,
  sidebar: [
    ["--dsw-alias-bg-base", "--sidebar-bg"],
    ["--dsw-specific-sidebar-fill", "--sidebar-bg"],
    ["--dsh-boot-bg", "--sidebar-bg"],
  ],
};

/** 面没登记时退回 default（中列面的取值）。 */
export function seedTokensForView(view: string): ReadonlyArray<SeedPair> {
  return VIEW_SEEDS[view] || VIEW_SEEDS.default;
}

/** 面 → 这一面可见底那一格 token，没登记时退回中列面的。壳页把它写在 <html> 的
 * data-dshana-backdrop 上：主题桥的映射表只有一张、没有面的概念，这行声明就是告诉桥
 * “这一面的底是哪一格”，桥再用同一张表取出它对应的宿主变量（不新增第二份数据面）。 */
export function backdropTokenForView(view: string): string {
  return FACE_BACKDROP[view] || FACE_BACKDROP.default;
}

/** 垫片写过的全部 token（各面摊平后的并集）。撤垫片按它抹，与面无关——各面的 token 键集相同，
 * 只有取值用的宿主变量不同。桥里那份硬编码名单必须与它同源（单测盯着）。 */
export const SEED_TOKEN_KEYS: ReadonlyArray<string> = [
  ...new Set(Object.values(VIEW_SEEDS).flat().map(([token]) => token)),
];

/**
 * DSH 自己显式选了 light/dark 时，首帧的明暗归它 index 里的 boot 样式（那份按偏好写死、
 * 不带媒体查询），我们既不垫也不留——垫上反而会在模块装载那段把它的深色/浅色盖成宿主色。
 * 偏好为 system（或尚未读到 index）时才垫：那一段的宿主色只能由我们提供。
 */
export function seedsForDshPreference(preference: string | null | undefined): boolean {
  return preference !== "light" && preference !== "dark";
}
