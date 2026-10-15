// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/shared/card.ts — 会话卡在**工具面**的视图（回执措辞 + 卡身份转出）
//
// 卡怎么投出去、坐标怎么回到卡上，住在 packages/session/src/session-card.ts 与
// packages/shared/src/app-card-id.ts；卡的字面量（id / route / title / cardForm / face）住在
// packages/app/src/manifest.json（宿主读契约的唯一来源）。本模块只做两件工具面自己的事：
//   · 把卡的身份常量转出来（工具面文案与测试要引用，但事实源不在这里）；
//   · 提供回执里那句「卡没投出去」的措辞——open 与 reply 共用一处，两处各写一遍就会漂。
//
// 会话卡走 contributes.messageRenderers + session:send-custom：那条路的绑定证明只绑 customType
// 与 details 摘要，不碰 toolName。工具回执那条路走不通——宿主对工具回执卡验的 effectiveToolName
// 来自 bridgedTool.name（app__dshana__dshana_<hash>），而签名侧用的是工具的局部名（dshana），
// 两者不等即判 invalid，卡块不产出。
import {
  SESSION_CARD_CUSTOM_TYPE,
  SESSION_CARD_ID,
  SESSION_CARD_ROUTE,
} from "@dshana/shared/app-card-id.ts";

/** 会话卡的 manifest 卡 id（contributes.cards[].id，也是 messageRenderers[].cardId）。 */
export const SESSION_CARD_MANIFEST_ID = SESSION_CARD_ID;

/** 会话卡的自定义消息短名（contributes.messageRenderers[].customType）。 */
export const SESSION_CARD_TYPE = SESSION_CARD_CUSTOM_TYPE;

/** 会话卡页（App ui/ 静态树内的 stream 面，manifest 卡 route 指向它）。 */
export const SESSION_CARD_ROUTE_PATH = SESSION_CARD_ROUTE;

/** 交付了一条会话卡的回执事实（提交链 resolve 出来的那一份）。 */
export interface SessionCardOutcome {
  /** 那条自定义消息在会话 jsonl 里的节点 id；尚未落盘或投递失败时为 null。 */
  cardEntryId?: string | null;
  /** 投递失败的原因（成功时为 null/undefined）。 */
  cardError?: string | null;
}

/**
 * 回执里关于会话卡的那一句。
 *
 * 三态，各说各的（都不谎报）：
 *   · 拿到 entryId：卡就在会话里，什么都不加（坐标回执里已经有了，不必再抄一遍）。
 *   · 没 entryId 也没错：投递被接受但节点 id 没回执（消息可能还在流式队列里），说清"未确认落盘"。
 *   · 有错：投递失败（未授权、会话不属本 App、超时等）——**卡是这段会话在聊天流里唯一的把手**，
 *     必须说出来，并说明任务本身照常在跑（别让用户以为整次提交失败了）。
 */
export function sessionCardNote({ cardEntryId, cardError }: SessionCardOutcome): string {
  if (cardError) return "\n（会话卡未能确认投出：" + cardError + "；任务本身已经在跑。）";
  if (!cardEntryId) return "\n（会话卡已投出，但落盘节点 id 未回执：消息可能还在流式队列里。）";
  return "";
}

