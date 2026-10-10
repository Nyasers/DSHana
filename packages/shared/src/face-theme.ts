// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/face-theme.ts — 「强制跟随宿主主题的面」这张声明（单点）。
//
// 语义（两件事是同一件，不拆成两个旋钮）：
//   在列表里的面 ⇒ 恒跟随宿主（无视 dsh 自己的 light/dark 偏好）+ 覆盖带 !important
//                  （元素级/属性级请求改写不了它）；
//   不在列表里的面 ⇒ 仅在 dsh 偏好为 system 时跟随，覆盖不带 !important（让位给属性请求，
//                    壁纸这类整屏层能透出来）。
//
// 为什么这个声明住在这里：它的消费者跨域——App 设置存储（packages/runtime 的 validateSettings）
// 与设置页（packages/ui 的 settings.tsx）都要同一张表，而 runtime 不能引 ui（依赖方向是
// ui → shared、runtime → shared）。桥脚本（packages/dsh/theme/assets/theme-bridge.js）是 cordis
// 侧散装浏览器 JS，import 不到本模块，只能读 <html> 上的属性；它与这里的一致性由测试守着。
//
// 面词表仍只有 packages/ui/src/face-role.ts 的 FACE_VIEWS 一处事实源：这里只挑其中
// **会注入 DSH 的**那几面作候选（settings 是 App 自己的设置页，不注入 DSH，没有覆盖可言），
// 两者的从属关系由测试断言，不在这里复制词表。

/**
 * 缺省：只有侧栏面。
 *
 * 侧栏面整幅嵌在宿主框架里，四周都是宿主色，用它自己的明暗会与四周不同调——跟随因此是强制的。
 * 其余面（default / main / stream）都开在宿主之后，让壁纸这类整屏层透出来更协调，故缺省不强制。
 */
export const FORCE_FOLLOW_FACES = Object.freeze(["sidebar"]);

/**
 * 可以被选进这张表的面（会注入 DSH 的那几面）。
 * settings 不在其中：它是 App 自己的设置页，直接吃宿主主题，没有「覆盖」这回事。
 */
export const FORCE_FOLLOW_CANDIDATES = Object.freeze(["default", "main", "sidebar", "stream"]);

/** 一个可选面。 */
export type ForceFollowFace = (typeof FORCE_FOLLOW_CANDIDATES)[number];

/** 认一个面是否可选（词表外的值当场拒）。 */
export function isForceFollowFace(value: unknown): value is ForceFollowFace {
  return typeof value === "string" && (FORCE_FOLLOW_CANDIDATES as readonly string[]).includes(value);
}

/**
 * 校验并归一这张表（纯函数，供设置存储与设置页共用）。
 *
 * 口径与 validateSettings 的其余字段一致：**严格拒绝**，不静默丢弃脏值——
 *   · 非数组（含 null / undefined）→ 抛错；
 *   · 含词表外的值（settings 也在词表外）→ 抛错，报出是哪一个；
 *   · 含重复项 → 抛错（存储被手改出重复值说明那份文件已经不对了，归一化会把它盖掉）；
 *   · 顺序即写入顺序，原样保留（不排序：设置页按候选表渲染，顺序不由这份值决定）。
 * 空数组是合法值，语义 = 一个面都不强制。
 */
export function normalizeForceFollowFaces(input: unknown): ForceFollowFace[] {
  if (!Array.isArray(input)) {
    throw new Error("强制跟随宿主主题的面必须是数组（收到 " + JSON.stringify(input) + "）");
  }
  const out: ForceFollowFace[] = [];
  for (const item of input) {
    if (!isForceFollowFace(item)) {
      throw new Error(
        "强制跟随宿主主题的面含不可选的值：" + JSON.stringify(item) +
        "（可选：" + FORCE_FOLLOW_CANDIDATES.join(" / ") + "）",
      );
    }
    if (out.includes(item)) {
      throw new Error("强制跟随宿主主题的面含重复项：" + item);
    }
    out.push(item);
  }
  return out;
}

/**
 * 壳页写在 `<html>` 上的属性名，值 = 逗号分隔的面名（空串 = 一个都不强制）。
 *
 * 桥读它判「这一面是不是强制面」。**属性缺席与空串是两回事**：缺席（老页面、或壳页还没拉到
 * 设置）时桥按 FORCE_FOLLOW_FACES 的缺省兜底，空串是显式「一个都不强制」。
 *
 * 与设置键 `forceFollowFaces` 同名同义（一个在存储里、一个在 DOM 上）。
 */
export const FORCE_FOLLOW_ATTR = "data-dshana-force-follow";

/**
 * 页面在 `<html>` 上声明自己面名的属性（值 = 面词表里的一个面）。
 *
 * 面的单一事实源是页面自己的静态声明（`meta[name=hana-dshana-role]` 或 `body[data-dshana-view]`），
 * 这个属性是它在 `<html>` 上的投影——桥读它比对面名，因为桥在 DSH 文档里、读不到外层页面的 DOM。
 * 每个会注入 DSH 的页面都得自己写它：壳页在 app-shell.ts 的 publishFace()、会话卡在
 * stream-entry.ts 的 boot()。
 */
export const FACE_ATTR = "data-dshana-face";

/** 把这张表编成属性值（壳页写入用；空表编成空串，见上面的缺席/空串之分）。 */
export function encodeForceFollowFaces(faces: readonly ForceFollowFace[]): string {
  return normalizeForceFollowFaces([...faces]).join(",");
}

/** 把属性值解成这张表（桥侧同一条规则的 TS 版，供壳页回读与测试对照）。 */
export function decodeForceFollowFaces(value: unknown): ForceFollowFace[] {
  if (value === null || value === undefined) return [...FORCE_FOLLOW_FACES];
  const out: ForceFollowFace[] = [];
  for (const part of String(value).split(",")) {
    const name = part.trim();
    if (name) out.push(name as ForceFollowFace);
  }
  return out;
}

/**
 * 设置页保存这张表后广播的频道名与消息类型。
 *
 * 为什么需要它：设置页与卡片是两个文档（宿主设置区一个 iframe、卡片另一个），设置页看不到
 * 卡片，卡片也看不到设置页。宿主 App 存储没有订阅口，而 `visibilitychange` 在「切到另一个
 * 并排的 iframe」时**不触发**——只有同源广播才是那条可靠的路。
 *
 * 接收侧（壳页／会话卡）收到就重读一次；广播不可用时接收侧还有可见性与焦点兜底。
 */
export const FORCE_FOLLOW_CHANNEL = "dshana.force-follow";

/** 广播消息类型（只这一种；带 kind 是为了以后加别的消息时不撞车）。 */
export const FORCE_FOLLOW_CHANGED = "force-follow-changed";
