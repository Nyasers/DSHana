// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/face-role.ts — 页面的「面」与 DSH 侧角色词
//
// 面的事实源是页面自己的静态声明（<meta name="hana-dshana-role"> 或 body[data-dshana-view]），
// 不认识时回落到 default。这里只放词表与纯函数：app-shell.ts 是浏览器脚本、测试不引它，
// 映射表放在可单测的模块里。
//
// 面与 DSH 上游角色的对应：
//   default  — full（整幅 DSH UI）与 detached（拆窗）共用，upstream 的 standalone
//   main     — 主卡：中列 + 右列，没有 DSH 侧栏（侧栏归 FP），upstream 的 workspace
//   sidebar  — FP：只有侧栏，upstream 的 navigation
//   stream   — 只读会话流：只有中列，侧栏/右列/输入位都收起（upstream 的 stream 面）
//   settings — App 自己的设置页，不注入 DSH，借 workspace 的角色词（不进 DSH 界面）

/** 全部面（判定用的封闭词表）。 */
export const FACE_VIEWS = ["default", "main", "sidebar", "stream", "settings"] as const;

/** 一个面。 */
export type FaceView = (typeof FACE_VIEWS)[number];

/** 面 → DSH 侧上游角色词（发布到 __DSHANA__.role，由 ui-layout / ui-session 读）。 */
export const FACE_ROLE: Record<FaceView, string> = {
  default: "standalone",
  main: "workspace",
  sidebar: "navigation",
  stream: "stream",
  settings: "workspace",
};

/** 认面：不是词表里的值就当没声明。 */
export function isFaceView(value: unknown): value is FaceView {
  return typeof value === "string" && (FACE_VIEWS as readonly string[]).includes(value);
}

/** 面 → 角色词；认不出面时按上游整幅 UI（standalone），不擅自少一列。 */
export function roleForView(view: unknown): string {
  return isFaceView(view) ? FACE_ROLE[view] : "standalone";
}
