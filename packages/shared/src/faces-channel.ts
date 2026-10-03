// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/faces-channel.ts — 面间直投通道的纯协议（地址、帧、寻址判定、归一）。
//
// 与同目录 shared-state.ts 的分工：那一个是**广播共享空间**（App 全局存储 + onChanged，谁都能读、
// 读侧自己判新旧），本模块是**定向投递**——发射面指名（角色地址或扇出），只有命中的面收，
// 投递数（delivered）随回执回来。传输由 App 宿主半中介（本 App 私有 route：POST send + 长轮询 poll，
// 实现见 packages/tools/src/faces-hub.ts 与 packages/ui/src/face-channel.ts）。
//
// 为什么由 App 宿主半中介：宿主没给「面→面」的一等原语。hana.host.request 的类型是封闭白名单
// （@hana/plugin-sdk 的 APP_UI_HOST_REQUEST_TYPES），hana.emit 的 to 是会话定位符，app bus
// （ctx.bus.*）只对宿主半与插件存在，浏览器半没有入口。宿主给的跨面面只有全局存储、卡实例态与
// 几个专用推送。所以中介者只能是 App 自己：route 在 App 进程内执行，iframe 带 surface 会话票据即可访问。
//
// 词表是封闭的，且是 shared-state.ts 的 INTENT_KINDS 的**子集**：迁移一个面就从这里加一个 kind，
// 载荷归一沿用 normalizeIntent，两套词表不各说各话。

import { INTENT_NATURE, intentFaces, isIntentKind, normalizeIntent, type IntentKind } from "./shared-state.ts";
import {
  CHANNEL_SCOPE_FALLBACK,
  FACE_ADDRESSES,
  FACE_FANOUT,
  isFaceAddress,
  isFaceTarget,
  normalizeScope,
  type FaceAddress,
  type FaceTarget,
} from "./face-addresses.ts";

// ---- 地址 ----
// 词表住在 face-addresses.ts（意图描述符表也要用它，分开放才不成环）；这里重导出，
// 让通道的使用方从一处拿齐地址与帧。
export {
  CHANNEL_SCOPE_FALLBACK,
  FACE_ADDRESSES,
  FACE_FANOUT,
  isFaceAddress,
  isFaceTarget,
  normalizeScope,
};
export type { FaceAddress, FaceTarget };

// ---- 词表（试点：只搬会话选中）----

/** 已在定向通道上的 kind。其余 kind 仍走共享空间，逐个迁移。 */
/**
 * 已在定向通道上的 kind：全部意图都搬上来了。
 *
 * 留着这个常量而不是到处用 INTENT_KINDS：两者现在是同一批，但“意图词表”与“哪几件走通道”
 * 是两件事——将来若要某一 kind 回退到广播共享空间（或者新增一个先只在空间上试水的），
 * 改这里一处即可。
 */
export const CHANNEL_KINDS = [
  "selection", "panel-view", "settings-view",
  "session-rename", "session-archive", "row-toast", "shortcuts-panel",
] as const;

/** 一个走了定向通道的 kind。 */
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** 认通道 kind（词表外的值当场拒；kind 必须同时是意图词表里的）。 */
export function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === "string" && (CHANNEL_KINDS as readonly string[]).includes(value) && isIntentKind(value);
}

/** 通道 kind 的性质（从意图描述符表推出来，不再自带一份副本）。 */
export const CHANNEL_NATURE: Record<ChannelKind, "state" | "command"> = Object.fromEntries(
  CHANNEL_KINDS.map((kind) => [kind, INTENT_NATURE[kind]]),
) as Record<ChannelKind, "state" | "command">;

/** 这条 kind 参与哪些面（与描述符表同源；未声明为 null）。 */
export function channelFaces(kind: ChannelKind): readonly FaceAddress[] | null {
  return intentFaces(kind);
}

/** 一个 kind 在通道上的载荷（沿用意图词表的归一，形状只有一份）。 */
export type ChannelPayload<K extends ChannelKind = ChannelKind> = ReturnType<typeof normalizeIntent<K>>;

/** state 类 kind 的权威记录键（与共享空间同一批键：单写者是通道服务端半）。 */
export function channelRecordKey(kind: ChannelKind): string {
  return "dshana." + kind;
}

/** 载荷归一（词表外当场拒；读侧拿到的永远是干净形状）。 */
export function normalizeChannelPayload<K extends ChannelKind>(kind: K, raw: unknown): ChannelPayload<K> {
  if (!isChannelKind(kind)) throw new Error("未知通道 kind：" + String(kind));
  return normalizeIntent(kind as IntentKind, raw) as ChannelPayload<K>;
}

// ---- 帧 ----

/** 一条投递帧。seq 管投递顺序与去重（作用域内单调），at 是写入时刻（沿用意图封套语义）。 */
export interface ChannelFrame {
  seq: number;
  at: number;
  from: FaceAddress;
  to: FaceTarget;
  kind: ChannelKind;
  payload: unknown;
}

/** 认作用域（卡片实例戳；缺戳时用占位，作用域照样隔离）——实现在 face-addresses.ts（上方重导出）。 */

/** 一个订阅面（一份文档）：sub 是文档自己的随机 id（区分同角色的多份文档），as 是它的角色地址。 */
export interface ChannelSubscriber {
  sub: string;
  as: FaceAddress;
}

/**
 * 一条帧该不该投给这个订阅面（纯函数，寻址规则的单点）。
 *
 * `others` 排除的是**发射的那份文档**（按 sub），不是整个角色：同角色的第二份文档照样收得到。
 * 判错就出乖——按角色排的话，两份 FP 之间有一个人永远看不见对方的选中。
 */
export function frameMatches(to: FaceTarget, senderSub: string, subscriber: ChannelSubscriber): boolean {
  if (to === "*") return true;
  if (to === "others") return subscriber.sub !== senderSub;
  return to === subscriber.as;
}

// ---- 请求归一 ----

/** POST send 的请求形状。sub 是发射文档自己的 id（`others` 排除的就是它）。 */
export interface ChannelSendRequest {
  card: string;
  sub: string;
  from: FaceAddress;
  to: FaceTarget;
  kind: ChannelKind;
  payload: unknown;
  at: number;
}

/** GET poll 的请求形状。fresh 只在**首次挂起**时为真：给它当前快照 + 当前序号（不重放历史帧）。 */
export interface ChannelPollRequest {
  card: string;
  sub: string;
  as: FaceAddress;
  since: number;
  fresh: boolean;
}

/** 归一结果：ok 或一句给调用方的错（请求形状错，不是「没投到」）。 */
export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 归一订阅面 id（缺了就用 as 兜底：单份文档的场景照样可用）。 */
function subscriberId(v: Record<string, unknown>, as: FaceAddress): string {
  return typeof v.sub === "string" && v.sub.trim() ? v.sub.trim() : as;
}

/** 归一一条 send 请求（形状/词表全在这里把关，handler 只传 body）。 */
export function normalizeSend(raw: unknown, now: () => number): NormalizeResult<ChannelSendRequest> {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!isFaceAddress(v.from)) return { ok: false, error: "from 不是面地址：" + String(v.from) };
  if (!isFaceTarget(v.to)) return { ok: false, error: "to 不是面地址也不是扇出：" + String(v.to) };
  if (!isChannelKind(v.kind)) return { ok: false, error: "kind 不在通道词表里：" + String(v.kind) };
  return {
    ok: true,
    value: {
      card: normalizeScope(v.card),
      sub: subscriberId(v, v.from),
      from: v.from,
      to: v.to,
      kind: v.kind,
      payload: normalizeChannelPayload(v.kind, v.payload),
      at: numberOr(v.at, now()),
    },
  };
}

/** 归一一条 poll 请求（as 必须在面地址词表里；since 取非负整数；fresh 认 "1"/1/true）。 */
export function normalizePoll(raw: unknown): NormalizeResult<ChannelPollRequest> {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!isFaceAddress(v.as)) return { ok: false, error: "as 不是面地址：" + String(v.as) };
  const since = numberOr(v.since, 0);
  return {
    ok: true,
    value: {
      card: normalizeScope(v.card),
      sub: subscriberId(v, v.as),
      as: v.as,
      since: since > 0 ? Math.floor(since) : 0,
      fresh: v.fresh === true || v.fresh === 1 || v.fresh === "1",
    },
  };
}

/** 一次 poll 的应答（reset 表示环形缓冲没兜住，客户端以 state 重建）。 */
export interface ChannelPollResult {
  ok: true;
  seq: number;
  frames: ChannelFrame[];
  state?: Record<string, { value: unknown; at: number }>;
  reset?: boolean;
}
