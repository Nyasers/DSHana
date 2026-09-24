// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/card.ts — 会话入口卡字面量（工具返回值 details.card）
//
// 卡页 = ui/entry.html：一行坐标 + 一个「在新窗口打开」的按钮。它不是 DSH 现场（那个在
// ui/stream.html，由按钮开出的原生窗口加载），所以不带票据、不注入、会话终结也不冻结。
//
// 宿主契约（server 0.951.4 bundle 实证，见 APPS.md「形式归属」）：工具结果的 details.card
// 被运行时透传成流内 plugin_card 块，随后由卡 iframe 加载 route。三条硬要求：
//   · pluginId 必填且必须等于本工具的归属 App id（不等于会被当场丢掉）；
//   · route 必须是宿主能解析到本 App 的写法——App 卡走 ui/ 静态树
//     （/api/apps/<appId>/ui<route>），不是 ctx.routes 的 /routes/ 命名空间；
//   · aspectRatio 是 "宽:高" 字符串（渲染端按它 split 出比例），不是数字。
// 查询串在提交时快照（卡页不做轮询，只取一次状态），?ts= 防缓存。
import { APP_ID } from "#/lib/boot-state.ts";

/** 卡页文件名（App ui/ 静态树内）。 */
export const SESSION_CARD_ROUTE = "/entry.html";

/** 卡面比例（"宽:高"；渲染端按冒号拆，数字会被当非法值丢掉）。入口卡只有一行，压扁。 */
const CARD_ASPECT_RATIO = "8:1";

/** 会话入口卡的动作面（title 的措辞随它变）。 */
export type SessionCardAction = "open" | "reply";

/** 动作 → 卡面文案。 */
const WHAT: Record<SessionCardAction, string> = { open: "子代理已开启", reply: "续发消息已提交" };

/** sessionCard 的入参：提交成功后拿到的定位信息。 */
export interface SessionCardInput {
  action: SessionCardAction;
  sessionId: string;
  taskId: string;
  /** 后台结果的投递档位（与工具回执 details.dsh.delivery 同一个值）。 */
  delivery?: string | null;
  cwd?: string | null;
}

/** 宿主流内 plugin_card 块的字面量（三条硬要求见文件头）。 */
export interface SessionCard {
  pluginId: string;
  route: string;
  title: string;
  description: string;
  aspectRatio: string;
}

/** 会话入口卡字面量。 */
export function sessionCard({ action, sessionId, taskId, delivery, cwd }: SessionCardInput): SessionCard {
  const now = Date.now();
  const params = [
    "ts=" + now,
    "at=" + now,
    "sid=" + encodeURIComponent(sessionId),
    // tid 只给「打开」用：入口卡把它回传给 /dshana/sessions/open，窗口那边再拿去绑票据面。
    "tid=" + encodeURIComponent(taskId),
  ];
  if (cwd) params.push("cwd=" + encodeURIComponent(cwd));
  const what = WHAT[action] || WHAT.open;
  return {
    pluginId: APP_ID,
    route: SESSION_CARD_ROUTE + "?" + params.join("&"),
    title: "DSHana " + what,
    description: sessionId.slice(0, 12) + "… · " + (cwd || "未指定工作目录") + " · taskId " + taskId +
      (delivery ? " · 结果按 " + delivery + " 档投递" : ""),
    aspectRatio: CARD_ASPECT_RATIO,
  };
}
