// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/app-card-id.ts — 流内自定义消息卡的实例 id、载荷与坐标（纯事实）
//
// 会话卡走 `contributes.messageRenderers` + `session:send-custom`（宿主契约见 APPS.md
// 「为自定义消息声明一张流内卡」）。这条路与工具回执卡的区别在证明绑定什么：工具卡的证明
// 拿 toolName 去比 `effectiveToolName`（宿主经 nOr 换成 bridgedTool.name），而发送侧的签名用的是
// 工具的局部名，两者不等 → 卡块不产出；自定义卡的证明只绑 customType + details 摘要，不碰
// toolName，所以结构上没有那个坑。
//
// 坐标不走卡 route：manifest 卡（contributes.cards[].route）的 route 由宿主校验器禁掉 `?` `#` `\` `..`
// （bundle mb()），查询串挂不上去。
//
// **卡的实例 id 由本 App 自己定**：`details.cardInstanceId` 只要过宿主的形状闸
// （`/^[am]_[0-9a-f]{20}$/`，bundle nM），宿主就原样采用、不自己算（bundle yAt 的 stored 分支；
// 消息渲染器投影的调用点把 details.cardInstanceId 传成 stored）。于是「这次投递」在投递那一刻
// 就有自己的名字：卡从 `hana.surface.getContext().cardInstanceId` 原样读回，App 后端拿它直查
// 自己的业务记录（宿主任务记录，见 packages/session/src/session-card.ts）——不扫会话条目树，
// 也不依赖宿主的哈希公式（那是宿主内部实现，SDK 不导出推导器）。
//
// 本模块只放**纯**事实：常量、id 派生、载荷/坐标的字面量组装与归一。读任务记录、投递分别住在
// packages/session/src/session-card.ts 与 packages/tools/src/shared/card.ts。
import { createHash } from "node:crypto";

/** 本 App 的 id。域串里带上它，派生出的卡 id 只在 dshana 的命名空间内成立（不与其他 App 撞）。 */
export const SESSION_CARD_APP_ID = "dshana";

/**
 * 宿主认的卡实例 id 形状：`/^[am]_[0-9a-f]{20}$/`（bundle nM）。
 *
 * 这是**公开的形状契约**（宿主用它判「作者给的 id 能不能用」）：写得进去的 id 必须过它，否则
 * 宿主丢掉作者的值、自己按内部公式算一个，卡读回来的就不是我们的 id。
 */
export const SESSION_CARD_INSTANCE_ID_RE = /^[am]_[0-9a-f]{20}$/;

/**
 * 派生域串：把本 App 与本卡的用途钉进哈希输入，别人的 sha256(taskId) 因此不会与它相同。
 *
 * appId 在这里以字面量出现是必要的：`@dshana/shared` 是最底层，不能 import `@dshana/runtime`
 * 的 APP_ID（那边反过来依赖这边）。同文件的 SESSION_CARD_DETAILS_KEY 出于同一理由也是字面量。
 */
const SESSION_CARD_ID_DOMAIN = SESSION_CARD_APP_ID + ":session-card";

/** 本 App 的会话卡：manifest 卡 id（contributes.cards[].id）。 */
export const SESSION_CARD_ID = "session-card";

/** 会话卡的自定义消息短名（contributes.messageRenderers[].customType；投递时也只写这个短名）。 */
export const SESSION_CARD_CUSTOM_TYPE = "session-card";

/** 会话卡的页面：App ui/ 静态树内的 stream 面（manifest 卡 route 指向它）。 */
export const SESSION_CARD_ROUTE = "/stream.html";

/**
 * 一张会话卡的实例 id：`a_` + sha256(域串 + taskId) 前 20 位 hex。
 *
 * 卡是 per-task 的（一次 open/reply 投一张，绑的是这次提交的任务），任务身份 taskId 就是它的
 * 自然主键，所以 id 由 taskId **确定性**派生：投递侧把它写进 `details.cardInstanceId`，卡侧原样
 * 读回，反查侧按同一条派生在任务记录里认领（见 packages/session/src/session-card.ts）——三处
 * 同一条定义，不需要另存一份「卡 id → 坐标」。
 *
 * taskId 必填：没有任务身份就没有这张卡，也不该凭空造一个 id。首尾空白先归一（宿主 id 是
 * 字符串，带空白会让同一个任务算出两个 id）。
 */
export function sessionCardIdForTask(taskId: string): string {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("sessionCardIdForTask: taskId 为空（卡 id 由任务身份派生）");
  const digest = createHash("sha256").update(SESSION_CARD_ID_DOMAIN + "\0" + id).digest("hex").slice(0, 20);
  return "a_" + digest;
}

/** 一条会话卡的坐标（投递时随消息写一份副本，读回时从宿主任务记录的 metadata.dsh 归一）。 */
export interface SessionCardCoords {
  /** 工具面动作：open（create）/ reply（send）。 */
  action: string;
  /** 受管 DSH 会话 id（session-<uuid>）。 */
  sessionId: string;
  /** 宿主任务句柄。 */
  taskId: string;
  /** 本次 prompt 的 rpcId。 */
  rpcId: string;
  /** 会话工作目录；未指定时为空串。 */
  cwd: string;
  /** 后台结果的投递档位。 */
  delivery: string;
}

/** 组一份坐标：缺省位补空串（宿主 details 走 JSON，undefined 会在那里丢掉）。纯函数。 */
export function sessionCardCoords(input: {
  action: string;
  sessionId: string;
  taskId: string;
  rpcId?: string;
  cwd?: string | null;
  delivery?: string | null;
}): SessionCardCoords {
  return {
    action: input.action,
    sessionId: input.sessionId,
    taskId: input.taskId,
    rpcId: input.rpcId || "",
    cwd: input.cwd || "",
    delivery: input.delivery || "",
  };
}

/** details 里本 App 的键。宿主的证明键（hanaAppCustomCardSource）与它的负标记由宿主自己写。 */
export const SESSION_CARD_DETAILS_KEY = "dshana";

/**
 * 投递载荷的 details：卡的实例身份 + 这份载荷自己的坐标副本。
 *
 * `cardInstanceId` 是本 App 派生的那个 id（sessionCardIdForTask）——宿主过形状闸后原样采用，
 * 卡读回的 `cardInstanceId` 因此就是它，反查按它在任务记录里认领。
 *
 * `dshana` 块是这次投递的坐标副本（读会话的人不必再跳去任务记录）；**反查不读它**——坐标的
 * 事实源是宿主任务记录的 metadata.dsh（packages/shared/src/task-binding.ts），那里由提交链写入。
 *
 * 不写 pluginId / appId —— 宿主拿这两个键判归属（bundle fPr）：写了且与本 App 不等，
 * 整条证明直接判 APP_CARD_SOURCE_OWNER_MISMATCH（投递照常但不签证明，于是也没有 sourceStatus）。
 */
export function sessionCardDetails(coords: SessionCardCoords): Record<string, unknown> {
  return {
    cardInstanceId: sessionCardIdForTask(coords.taskId),
    [SESSION_CARD_DETAILS_KEY]: {
      action: coords.action,
      sessionId: coords.sessionId,
      taskId: coords.taskId,
      rpcId: coords.rpcId,
      cwd: coords.cwd || undefined,
      delivery: coords.delivery,
    },
  };
}

/**
 * 从 details 归一出坐标副本；不是本 App 的会话卡载荷时返回 null。
 *
 * 与 sessionCardDetails 是同一份形状的两半：写入的副本能原样读回（单测钉住这条往返）。
 */
export function sessionCardCoordsOf(details: unknown): SessionCardCoords | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const block = (details as Record<string, unknown>)[SESSION_CARD_DETAILS_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const b = block as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const taskId = typeof b.taskId === "string" ? b.taskId : "";
  if (!sessionId || !taskId) return null;
  return {
    action: typeof b.action === "string" ? b.action : "",
    sessionId,
    taskId,
    rpcId: typeof b.rpcId === "string" ? b.rpcId : "",
    cwd: typeof b.cwd === "string" ? b.cwd : "",
    delivery: typeof b.delivery === "string" ? b.delivery : "",
  };
}
