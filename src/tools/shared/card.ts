// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/card.ts — 会话流卡字面量（工具返回值 details.card）
//
// 卡页 = ui/stream.html（只读会话流面）：工具出卡时把这张 DSH 会话的 id 写进查询串，
// 页面据此把注入的 DSH UI 钉在那一段上（面 = stream，输入位收起）。任务回执本身不另画页面：
// 会话/目录/taskId 在卡的 title / description 里，实时跟踪态由卡页向 App 后端取一次
// /dshana/card-state 补在顶部一行。
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
export const SESSION_CARD_ROUTE = "/stream.html";

/** 卡面比例（"宽:高"；渲染端按冒号拆，数字会被当非法值丢掉）。 */
const CARD_ASPECT_RATIO = "16:9";

/** 会话流卡的动作面（与 ui/card.html 的 WHAT 表一致）。 */
export type SessionCardAction = "open" | "reply";

/** 动作 → 卡面文案（与 ui/card.html 的 WHAT 表保持一致）。 */
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

/** 会话流卡字面量。 */
export function sessionCard({ action, sessionId, taskId, delivery, cwd }: SessionCardInput): SessionCard {
  const now = Date.now();
  const params = [
    "ts=" + now,
    "at=" + now,
    "sid=" + encodeURIComponent(sessionId),
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
