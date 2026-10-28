// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity.ts — 页面状态点的取值词表
//
// 宿主的页面按钮会画一个小圆点，词表只有两个（shared/surface-activity 的 SurfaceActivity）：
//   · running —— 有活在跑（金色，--gold）
//   · unread  —— 有输出没人看（远山青，--accent）
// 合并优先级由宿主定：running 压过 unread。这里不发明新档位。
//
// 本 App 只报 running，判据是 DSH 自己的会话状态（事件，见 activity-sync.ts）。
// 不报 unread：「有输出没人看」需要一个阅读位点，而 DSH 的完成未读标记只存在于它的浏览器端，
// 服务端拿不到；本 App 也没有自己的阅读位点。拿「刚跑完」凑一个会让点永久亮着说谎。
/** 页面状态点的取值（与宿主 SurfaceActivity 同词）。 */
export type PageActivity = "running" | "unread";
