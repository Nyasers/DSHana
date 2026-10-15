// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/session/src/session-card.ts — 会话卡的投递与坐标反查（坐标随卡自己走）
//
// 投递：一次 open/reply 提交成功后，往**调用方会话**投一条 display 的自定义消息
// （`session:send-custom`），宿主按 manifest 的 contributes.messageRenderers 把它渲染成流内卡。
// 那条消息的 `details` 里带上本 App 自己派生的实例 id（`sessionCardIdForTask(taskId)`）与坐标副本。
//
// 反查：卡 iframe 收不到 payload（宿主契约），能读到的身份是 `hana.surface.getContext().cardInstanceId`
// ——而那个值就是投递时作者写进 details 的同一个 id（宿主对合法形状的作者 id 原样采用，见
// @dshana/shared/app-card-id.ts）。所以卡把 id 报给 App 后端，后端**在宿主任务记录里认领**：
// `tasks.list()` 是几条到几十条记录，逐条按同一条派生算一遍，命中哪条就取那条任务的
// `metadata.dsh`（提交链写在那里，见 @dshana/shared/task-binding.ts）——坐标天然就在里面，
// 不需要另建「卡 id → 坐标」的表，也不需要扫整棵会话条目树。
//
// 命中率不是 100% 的：卡可能是更早一版投出的（id 出自另一条派生），或那条任务记录已被宿主回收。
// 认不到时返回 null，由卡回落「跟随当前选中」并在卡面如实标注未钉住——不空着，也不假装钉住了。
import {
  SESSION_CARD_CUSTOM_TYPE,
  SESSION_CARD_INSTANCE_ID_RE,
  sessionCardCoords,
  sessionCardDetails,
  sessionCardIdForTask,
  type SessionCardCoords,
} from "@dshana/shared/app-card-id.ts";

/** 取错误的可读文本（与 @dshana/shared/err-text.ts 同款；此处不为此加一条包依赖）。 */
function errText(e: unknown): string {
  return ((e as { message?: unknown } | null)?.message as string) || String(e);
}

function fieldOf(record: unknown, key: string): string {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "";
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * 一条候选任务记录的 `metadata.dsh`。
 *
 * 形状与 @dshana/shared/task-binding.ts 的 dshObjectOf 同源，但**不复用它**：那边是绑定归一，
 * 要求 sessionId 过合法 dshSessionId 形态（归不到会话的记录直接不进索引），而反查要的是
 * 「这条记录是不是这张卡投出那次提交写下的」——卡只认派生 id，形态设闸是上游提交链的事。
 */
function dshOf(record: unknown): Record<string, unknown> | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const meta = (record as Record<string, unknown>).metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const dsh = (meta as Record<string, unknown>).dsh;
  return dsh && typeof dsh === "object" && !Array.isArray(dsh) ? (dsh as Record<string, unknown>) : null;
}

function dshText(dsh: Record<string, unknown>, key: string): string {
  const value = dsh[key];
  return typeof value === "string" ? value : "";
}

/**
 * 在宿主任务记录里认领 cardInstanceId 指的那一条，并归一出它自己的坐标。纯函数。
 *
 * 命中判据 = 「这条任务的 taskId 派生出的卡 id 正好等于卡报上来的那个」：投递侧与反查侧用的是
 * 同一条派生（sessionCardIdForTask），命中即等价于「这张卡确实由这次提交投出」，不需要额外的
 * 信任假设。没有卡 id、没有候选、或候选里没有一条算得出这个 id → 返回 null（不猜、不凑最近的一条）。
 *
 * 报上来的 id 先过宿主的形状闸：形状不对的串根本不可能由 sessionCardIdForTask 产出（派生的结果
 * 恒是 `a_` + 20 位小写 hex），先挡掉就不必对每条记录算一次 sha256。
 *
 * 命中了但带不出完整坐标（记录缺 taskId、或 metadata.dsh 缺 sessionId，即提交链的绑定回写没落地）
 * 时也返回 null——宁可回落「跟随当前选中」，也不端出一份缺字段的坐标。这种记录不终止扫描：同一个
 * taskId 若是重复出现，后一条完整的那份仍应被采纳。
 *
 * taskId 取自记录本身（宿主在根上给），不是 metadata.dsh —— 那一块只装 DSH 坐标，没有任务身份。
 */
export function matchTaskCard(records: unknown, { cardInstanceId }: { cardInstanceId: string }): SessionCardCoords | null {
  const wanted = String(cardInstanceId || "").trim();
  if (!wanted || !SESSION_CARD_INSTANCE_ID_RE.test(wanted)) return null;
  if (!Array.isArray(records)) return null;
  for (const record of records) {
    const taskId = fieldOf(record, "taskId");
    if (!taskId) continue;
    if (sessionCardIdForTask(taskId) !== wanted) continue;
    const dsh = dshOf(record);
    const sessionId = dsh ? dshText(dsh, "sessionId") : "";
    if (!sessionId) continue;
    return sessionCardCoords({
      action: dsh ? dshText(dsh, "action") : "",
      sessionId,
      taskId,
      rpcId: dsh ? dshText(dsh, "rpcId") : "",
      cwd: dsh ? dshText(dsh, "cwd") : "",
      delivery: fieldOf(record, "delivery"),
    });
  }
  return null;
}

/**
 * 读宿主任务记录（默认实现：ctx.tasks.list）。
 *
 * `scope: "own"` 是主路径：本 App 建的任务都挂在自己名下（宿主按 type/pluginId/appTaskOwner 三元组
 * 判归属，own 那一档就是按同一判据筛的），这条既是最小面、也不需要额外能力面——它与卡状态面读的
 * 是同一份记录、同一档。显式写出来是「不吃隐式默认」：宿主缺省档同样是 own。
 *
 * own 抛了才退 `scope: "all"`：宿主只认 own/all 两个值（bundle 的 `task scope must be own or all`），
 * 而 all 另要 app/tasks.read-all（manifest 未声明，所以这一档在本 App 的授权下通常会被拒）。
 * 留它是因为那正是"读不到"的两种原因之一，抛出来的错要能落到日志；两次都读不到就一律抛给调用方：
 * 反查路由据此回「查不到」而不是编一份坐标出来。
 */
export async function readTaskRecords(ctx: unknown): Promise<unknown> {
  const tasks = (ctx as { tasks?: { list?: unknown } } | null)?.tasks;
  if (!tasks || typeof tasks.list !== "function") throw new Error("ctx.tasks.list 不可用（宿主任务面缺失）");
  const list = tasks.list as (opts?: unknown) => Promise<unknown>;
  let ownError: unknown = null;
  try {
    const rows = await list({ scope: "own" });
    if (Array.isArray(rows)) return rows;
    ownError = new Error("ctx.tasks.list 未返回数组");
  } catch (e) {
    ownError = e;
  }
  try {
    const rows = await list({ scope: "all" });
    if (Array.isArray(rows)) return rows;
    throw new Error("ctx.tasks.list 未返回数组");
  } catch (e) {
    throw new Error("宿主任务记录不可读（own: " + errText(ownError) + "；all: " + errText(e) + "）");
  }
}

/** 投递一次会话卡的结果。entryId 为 null 表示消息还在流式队列里、尚未落盘（宿主回包如此）。 */
export interface SessionCardDelivery {
  ok: boolean;
  entryId: string | null;
  mode: string | null;
  sessionId: string;
}

/**
 * 往调用方会话投一条会话卡（fire 后由调用方决定要不要等；本函数自己 await，失败抛出）。
 *
 * 载荷口径（每一条都有理由）：
 *   · customType 只给短名 —— 宿主会剥掉已有前缀再盖成 app:<appId>/<短名>；自己带前缀会被剥掉。
 *   · display: true —— 硬要求。缺省 false 时这条消息不进 messageRenderers 渲染通道，卡不出现。
 *   · triggerTurn: false —— 空闲时不另起回合。**注意会话正在流式时宿主会无视它**（把消息排进当前
 *     回合，于是进模型上下文）；这是宿主契约，不是本 App 能决定的（见 APPS.md 的 session:send-custom 一节）。
 *   · details 放 cardInstanceId（本 App 按 taskId 派生的实例 id，宿主过形状闸后原样采用）+ 坐标副本；
 *     **不放 pluginId / appId**（宿主拿它判归属，不等就拒签证明）。
 *   · 不传 sessionId，只传 callToken —— 会话身份由宿主从这次工具调用的令牌解析；归属校照旧执行，
 *     所以 scope 必须显式 "all"（调用方会话不在本 App 的分区里）。
 */
export async function deliverSessionCard(
  ctx: unknown,
  { callToken, coords, content }: { callToken: string; coords: SessionCardCoords; content: string },
): Promise<SessionCardDelivery> {
  const bus = (ctx as { bus?: { request?: unknown } } | null)?.bus;
  if (!bus || typeof bus.request !== "function") throw new Error("ctx.bus.request 不可用（宿主 bus 面缺失）");
  const res = (await (bus.request as (verb: string, payload: unknown) => Promise<unknown>)("session:send-custom", {
    callToken,
    scope: "all",
    customType: SESSION_CARD_CUSTOM_TYPE,
    content,
    display: true,
    triggerTurn: false,
    details: sessionCardDetails(coords),
  })) as Record<string, unknown> | null;
  return {
    ok: !!(res && res.ok),
    entryId: res && typeof res.entryId === "string" && res.entryId ? res.entryId : null,
    mode: res && typeof res.mode === "string" ? res.mode : null,
    sessionId: res && typeof res.sessionId === "string" ? res.sessionId : "",
  };
}

/**
 * 投递消息的正文（`content`）。
 *
 * 它是**卡面之外**的可见文本：宿主把 `display: true` 的自定义消息画成卡块，正文本身不再单独占版
 * 面，但它是这条消息进会话历史时可读的那一行（也是模型在流式态被宿主排进当前回合时唯一会看到的东西）。
 * 所以它如实写清坐标，而不是写一句空话。
 */
export function sessionCardContent(coords: SessionCardCoords): string {
  const head = coords.action === "create" || coords.action === "open" ? "已开启 DSH 子代理" : "已向 DSH 子代理续发消息";
  return head + "：taskId " + coords.taskId + "，sessionId " + coords.sessionId +
    (coords.cwd ? "，cwd " + coords.cwd : "") +
    "。任务在后台执行，完成/失败按 " + (coords.delivery || "next-step") + " 档投递回本会话。";
}
