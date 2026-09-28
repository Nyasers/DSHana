// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/card.ts — 会话卡字面量（工具返回值 details.card）
//
// 一张卡，两个挂载态（页 = ui/stream.html，见 src/ui/stream.html 与 src/ui/app-shell.ts）：
//   · 聊天流里：只画一行入口（会话坐标）；不注入 DSH、不带票据，所以不叠也不冻结。
//   · 取出到黑板 / 拆窗：宿主把同一 route 装到新的挂载上，页面自己认挂载态，注入完整 DSH 现场。
// 「取出」是宿主手势（聊天卡右上角菜单 / 拖拽），不经过本 App 的代码；所以这里不注册
// manifest 卡，也不调 hana.cards.open——卡片中心因此不占一格，聊天流里那张卡也不带任何写入口。
//
// 宿主契约（见 APPS_EN.md「Card sizing and form contract」与「Contributing a chalkboard card」）：
//   · pluginId 必填且必须等于本工具的归属 App id（不等于会被当场丢掉）；
//   · route 必须是宿主能解析到本 App 的写法——App 卡走 ui/ 静态树
//     （/api/apps/<appId>/ui<route>），不是 ctx.routes 的 /routes/ 命名空间；
//   · aspectRatio 是 "宽:高" 字符串（渲染端按它 split 出比例），不是数字；聊天卡的
//     aspectRatio 与 cardForm 会在「取出」时复制到黑板绑定上，形态随过去。
// 查询串在提交时快照（卡页不做轮询，只取一次状态），?ts= 防缓存。
import { APP_ID } from "#/lib/boot-state.ts";

/** 会话卡页（App ui/ 静态树内的 stream 面）。 */
export const SESSION_CARD_ROUTE = "/stream.html";

/** 聊天流里的占位比例（"宽:高"；渲染端按冒号拆，数字会被当非法值丢掉）。
    8:1 的高度对「1 行抬头 + 3 行坐标」刚好；宽度变窄时宿主会按同一比例把高度一起压扁，
    所以入口行自己把真实高度报给宿主（见 stream-entry.ts 的 reportEntryHeight）。 */
const CARD_ASPECT_RATIO = "8:1";

/** 卡面抬头（宿主聊天卡上那一行标题）。动作不写在这里：状态字样是卡**内**第一行的事。 */
const CARD_TITLE = "DSHana";

/** 会话卡的动作面（写进 route 的 act=，卡页据此渲染状态字样）。 */
export type SessionCardAction = "open" | "reply";

/** sessionCard 的入参：提交成功后拿到的定位信息。 */
export interface SessionCardInput {
  action: SessionCardAction;
  sessionId: string;
  taskId: string;
  /** 后台结果的投递档位（与工具回执 details.dsh.delivery 同一个值）。 */
  delivery?: string | null;
  cwd?: string | null;
}

/** 宿主流内 plugin_card 块的字面量。 */
export interface SessionCard {
  pluginId: string;
  route: string;
  title: string;
  description: string;
  aspectRatio: string;
  cardForm: string;
}

/** 会话卡字面量。 */
export function sessionCard({ action, sessionId, taskId, delivery, cwd }: SessionCardInput): SessionCard {
  const now = Date.now();
  const params = [
    "ts=" + now,
    "at=" + now,
    // 动作是数据，状态字样（"子代理已开启" 这类）是卡页的文案：文案住在卡页里，改文对
    // 已经发出的卡也生效（它们每次打开都重新取那一页）。
    "act=" + action,
    "sid=" + encodeURIComponent(sessionId),
    // tid 只作展示与备查：入口行把它写在副行上。
    "tid=" + encodeURIComponent(taskId),
  ];
  if (cwd) params.push("cwd=" + encodeURIComponent(cwd));
  return {
    pluginId: APP_ID,
    route: SESSION_CARD_ROUTE + "?" + params.join("&"),
    title: CARD_TITLE,
    description: sessionId.slice(0, 12) + "… · " + (cwd || "未指定工作目录") + " · taskId " + taskId +
      (delivery ? " · 结果按 " + delivery + " 档投递" : ""),
    aspectRatio: CARD_ASPECT_RATIO,
    // 黑板绑定的形态跟着聊天卡过去（宿主只搬 aspectRatio 与 cardForm 两个键）。
    cardForm: "flush",
  };
}
