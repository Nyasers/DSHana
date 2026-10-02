// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/host/src/profile-bundles.ts — 自有 profile 的层列表口径（纯函数，供 main.ts 与单测共用）
//
// 口径：**init-and-forget**。安装方只在建目录那一刻写初始层列（`initProfile` 只补缺、不覆盖），
// 之后那份 `dsh.profile.bundles` 归用户与插件管理面：他们打开上游 OPTIONAL_BUNDLES 那四个可选
// bundle、自装第三方插件，都写在这里。上游 desktop / web 就是这个做法，所以它们没有「用户开关被
// 抹掉」这个问题。
//
// 唯一要碰它的例外是**退役元组**：早期版本钉过 `[dsh-base, dsh-web-app]`（官方 web 层），那份
// 元组整份都是我们的、不含用户条目；清单**精确等于**它时迁到当前初始层列（上游 app-boot 的
// normalizeShippedProfile 同一手法：只认精确元组）。清单里进了别的东西就一概不碰。
//
// 为什么单独一份：main.ts 是受管 runtime 入口，import 它就等于跑一次 boot；这条规则却是纯计算，
// 值得被单测直接钉住。

/** 共享底座（层序第一层）。 */
export const BASE_BUNDLE = "@deepseek-ai/dsh-base";
/** 本 App 的组合层（层序第二层，紧随底座）。 */
export const OWN_BUNDLE = "@dshana/dsh-app";
/** 初始层列：只在建目录那一刻写进清单（之后归用户与插件管理面）。 */
export const PROFILE_BUNDLES = [BASE_BUNDLE, OWN_BUNDLE];

/** 退役元组：早期版本钉住的整份层列（精确匹配才迁移）。 */
export const RETIRED_TUPLES: readonly (readonly string[])[] = [
  [BASE_BUNDLE, "@deepseek-ai/dsh-web-app"],
];

/**
 * 层列表迁移（纯函数）：清单**精确等于**某个退役元组时给出当前初始层列，否则 `undefined`
 * （= 什么都不做）。
 *
 * 判据是"精确等于整份元组"，不是"包含退役层"：只有那种情况能确定这份清单整份是我们写的、
 * 没有用户条目——包含退役层但还夹着别的东西时，动它就是抹用户开关。
 * @param current - 清单里当前的层列表（可能为空/未定义）。
 * @returns 迁移后的层列表；不需要迁移时 undefined。
 */
export function migrateProfileBundles(current: unknown): string[] | undefined {
  if (!Array.isArray(current)) return undefined;
  const list = current.filter((n): n is string => typeof n === "string");
  if (list.length !== current.length) return undefined; // 有非字符串条目 = 被人手改过，不碰
  const retired = RETIRED_TUPLES.some(
    (tuple) => tuple.length === list.length && tuple.every((name, index) => name === list[index]),
  );
  return retired ? [...PROFILE_BUNDLES] : undefined;
}
