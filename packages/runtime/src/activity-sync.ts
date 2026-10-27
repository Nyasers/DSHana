// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity-sync.ts — 把本 App 的运行状态写成卡片当前视图的 activity（页面状态点）
//
// 宿主给页面按钮画一个状态点，取值来自卡的当前视图 Chrome 描述（APPS.md「当前视图 Chrome」）。
// 页面侧写要走 hana.chrome.set，而后台（本 App 进程不在页面里）走 ctx.surfaces 的三个方法：
//   listCardChromeViews() → getCardChromeView() → setCardChrome()
// 本模块就是后台那一路：周期性看一眼 **DSH 自己的会话状态**，算出「这一页该不该亮」，
// 再只在变化时写一次。
//
// 三条纪律（照抄宿主契约，不自行简化）：
//   · 描述是**整份替换**，所以写入前必须先 get，把页面自己的 title / tabs / actions 带上再提交；
//     只交 activity 会把页面写过的其它字段一起抹掉。
//   · revision 在同一视图内严格递增；被拒（竞争）就重新读一遍，不盲目重试同一个值。
//   · 只在真正变化时写。每轮都写等于每轮都抢页面自己的写入机会。
//
// 视图从哪来：宿主只为自己注册过当前视图的卡提供这份能力（listCardChromeViews 只列本 App 的
// 活视图）。整页主卡的视图要等页面**真正挂载后**才注册，所以 App 刚启动时这张表是空的（实测）。
// 本模块把空表当“暂时无写入面”处理，不报错、不空转。
import { errText } from "@dshana/shared/err-text.ts";
import { activityFromSessions, activityFromTasks, runningSessionIds, type PageActivity } from "./activity.ts";
import { rpcViaControl } from "./controller.ts";

/** 没有任何卡片视图时多久看一次：没人看得见这个点，快轮询没意义。 */
export const IDLE_POLL_MS = 15000;
/** 有视图时多久看一次：DSH 会话经常几秒就说完了，节拍粗了就会整个错过。 */
export const FAST_POLL_MS = 2000;
/** 已经在跑时多久看一次：终态要尽早反映成"灭灯"。 */
export const ACTIVE_POLL_MS = 2000;

/** 一次写入的判定结果：null = 不必写（已经一致）；否则是要提交的完整描述。 */
export function planChromeWrite(
  current: { revision?: unknown; activity?: unknown } | null | undefined,
  desired: PageActivity | null,
): { revision: number; activity: PageActivity | null } | null {
  const now = current && typeof current === "object" ? current.activity ?? null : null;
  if (now === desired) return null;
  // 宿主的 revision 是**正整数**（严格递增）：读不到、读到 0 或负数都当从头算，
  // 不能拿一个非法值加一交上去——那会被拒，而且下一轮算出来的值还是同一个。
  const raw = current && typeof current === "object" ? Number(current.revision) : 0;
  const rev = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  return { revision: rev + 1, activity: desired };
}

/** 宿主返回的 description 里，除 activity 之外的字段原样带着（整份替换的纪律见文件头）。 */
export function mergeDescription(
  current: Record<string, unknown> | null | undefined,
  plan: { revision: number; activity: PageActivity | null },
): Record<string, unknown> {
  const base = current && typeof current === "object" ? { ...current } : {};
  return { ...base, revision: plan.revision, activity: plan.activity };
}

export interface ActivitySyncOptions {
  idleMs?: number;
  fastMs?: number;
  activeMs?: number;
  log?: (level: "info" | "warn" | "debug", message: string) => void;
}

/**
 * 装一次同步循环，返回卸载函数。
 *
 * ctx 是宿主 App 上下文（apply 收到的那份）：用 ctx.tasks.list 读任务记录，
 * 用 ctx.surfaces.listCardChromeViews / getCardChromeView / setCardChrome 写卡片描述。
 * 任何一个面缺失都只记一条日志后安静退出——这不是核心功能，缺了不该吵。
 */
export function installHostActivitySync(ctx: any, options: ActivitySyncOptions = {}): () => void {
  const idleMs = Number(options.idleMs) > 0 ? Number(options.idleMs) : IDLE_POLL_MS;
  const fastMs = Number(options.fastMs) > 0 ? Number(options.fastMs) : FAST_POLL_MS;
  const activeMs = Number(options.activeMs) > 0 ? Number(options.activeMs) : ACTIVE_POLL_MS;
  const log = typeof options.log === "function" ? options.log : () => {};

  const tasks = ctx && ctx.tasks;
  const surfaces = ctx && ctx.surfaces;
  // 启动自检一律 info：宿主的 ctx.logger.debug 不落盘（实测日志里一行 DEBUG 都没有），
  // 用 debug 写等于“我看不到到底哪一步路没走通”。这两条各只打一次，不吵。
  if (!surfaces || typeof surfaces.listCardChromeViews !== "function"
    || typeof surfaces.getCardChromeView !== "function" || typeof surfaces.setCardChrome !== "function") {
    log("info", "activity-sync: 宿主不提供卡片当前视图的读写面，不起同步");
    return () => {};
  }
  log("info", "activity-sync: 已接管（有视图时每 " + fastMs + "ms 看一次，无视图时 " + idleMs + "ms）");

  /** 每个视图上一次**已生效**的取值；用来跳过无变化的写入。键 = cardInstanceId。 */
  const applied = new Map<string, PageActivity | null>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  /** 本轮开始时刻：防止一次挂死的调用把循环永久锁在 busy=true。 */
  let busySince = 0;
  /** 已报过的"视图表为空"状态：只在状态翻转时打一行，不每轮刷。 */
  let sawEmpty = false;
  /** 已报过"已落到卡片"的实例：每张卡只报一次，之后的增减不必重复。 */
  const announced = new Set<string>();
  /** 会话状态读取是否处于“读不到”状态（只用于把日志从每轮刷降成翻转时报一次）。 */
  let sessionReadFailed = false;
  /** 上一轮是否有会话在跑（同上，只为日志去重）。 */
  let wasRunning = false;
  /** 上一轮是否有可写的卡片视图：决定下一轮的节拍。 */
  let hasViews = false;

  function schedule(ms: number) {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, ms);
  }

  async function pushToViews(desired: PageActivity | null): Promise<void> {
    let listed: any = null;
    try {
      listed = await surfaces.listCardChromeViews();
    } catch (e) {
      log("warn", "activity-sync: 列卡片视图失败：" + errText(e));
      return;
    }
    if (!listed || listed.ok !== true) {
      log("warn", "activity-sync: 列卡片视图被拒（" + String(listed && listed.code) + "）：" + String(listed && listed.error));
      return;
    }
    const views: any[] = Array.isArray(listed.views) ? listed.views : [];
    hasViews = views.length > 0;
    const live = new Set<string>();
    // 视图表空了不是错，但必须看得见：这是“能不能亮灯”的唯一分叉点。
    if (views.length === 0) {
      if (!sawEmpty) {
        sawEmpty = true;
        log("info", "activity-sync: 宿主尚未为本 App 注册卡片当前视图（页面未挂载）；"
          + "目标状态 " + String(desired) + " 已算出，等视图出现再落盘。");
      }
    } else if (sawEmpty) {
      sawEmpty = false;
      log("info", "activity-sync: 宿主开始提供卡片当前视图（" + views.length + " 个）");
    }
    for (const view of views) {
      const cardInstanceId = typeof view?.cardInstanceId === "string" ? view.cardInstanceId : "";
      const viewHandle = typeof view?.viewHandle === "string" ? view.viewHandle : "";
      if (!cardInstanceId || !viewHandle) continue;
      live.add(cardInstanceId);
      if (!announced.has(cardInstanceId)) {
        announced.add(cardInstanceId);
        log("info", "activity-sync: 拿到卡片视图 " + cardInstanceId + "（cardId " + String(view.cardId) + "）");
      }
      if (applied.has(cardInstanceId) && applied.get(cardInstanceId) === desired) continue;
      try {
        const current = await surfaces.getCardChromeView({ viewHandle, cardInstanceId });
        if (!current || current.ok !== true) {
          log("warn", "activity-sync: 读当前描述失败（" + String(current && current.code) + "），下一轮再试");
          applied.delete(cardInstanceId);
          continue;
        }
        const plan = planChromeWrite(current.description, desired);
        if (!plan) { applied.set(cardInstanceId, desired); continue; }
        const written = await surfaces.setCardChrome({
          viewHandle,
          cardInstanceId,
          description: mergeDescription(current.description, plan),
        });
        if (written && written.ok === true) {
          applied.set(cardInstanceId, desired);
          log("info", "activity-sync: 页面状态点 → " + String(desired) + "（卡片 " + cardInstanceId + "）");
        } else {
          // 被拒就是被拒：revision 竞争时下一轮重新读，绝不原样重试。
          applied.delete(cardInstanceId);
          log("warn", "activity-sync: 写描述被拒（" + String(written && written.code) + "）：" + String(written && written.error));
        }
      } catch (e) {
        applied.delete(cardInstanceId);
        log("warn", "activity-sync: 写入卡片描述异常：" + errText(e));
      }
    }
    // 视图关掉了就把它从记忆里去掉，重开时按新视图重新判一遍。
    for (const key of [...applied.keys()]) if (!live.has(key)) applied.delete(key);
    for (const key of [...announced]) if (!live.has(key)) announced.delete(key);
  }

  /**
   * 看一眼当前状态。主判据是 DSH 的 `session/list`：它看得见所有会话，包括用户在 DSH 界面里
   * 自己开的那些（宿主任务记录里根本没有它们）。控制面还没就绪或查询失败时回落到宿主任务记录，
   * 这样至少本 App 自己起的任务仍能亮灯。
   */
  async function readDesired(): Promise<PageActivity | null> {
    try {
      const value = await rpcViaControl(ctx, { method: "session/list", payload: {}, timeoutMs: 8000 });
      const items = value && Array.isArray((value as any).items) ? (value as any).items : null;
      if (items) {
        if (sessionReadFailed) {
          sessionReadFailed = false;
          log("info", "activity-sync: 会话状态恢复可用，改以 session/list 为准");
        }
        const ids = runningSessionIds(items);
        if (ids.length > 0 && !wasRunning) {
          wasRunning = true;
          log("info", "activity-sync: 有会话在跑（" + ids.length + " 个）：" + ids.join(", "));
        } else if (ids.length === 0) {
          wasRunning = false;
        }
        return activityFromSessions(items);
      }
      log("warn", "activity-sync: session/list 回执里没有 items，回落到任务记录");
    } catch (e) {
      // 受管 runtime 还没起来时这里是常态，不是故障：只在状态翻转时报一行，不每轮刷。
      if (!sessionReadFailed) {
        sessionReadFailed = true;
        log("info", "activity-sync: 暂时读不到会话状态（受管 runtime 未就绪或控制面不通），先用任务记录顶着：" + errText(e));
      }
    }
    if (tasks && typeof tasks.list === "function") {
      try {
        return activityFromTasks(await tasks.list());
      } catch (e) {
        log("warn", "activity-sync: 读宿主任务记录失败：" + errText(e));
      }
    }
    return null;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    // 上一轮卡死（宿主/控制面一个调用不返回）时到这里就把锁收回来：
    // 宁可多一个并发轮，也不能让状态点从此不再更新。
    if (busy && Date.now() - busySince < 30000) return;
    busy = true;
    busySince = Date.now();
    let desired: PageActivity | null = null;
    try {
      desired = await readDesired();
      await pushToViews(desired);
    } finally {
      busy = false;
      // 节拍：在跑或“有地方可写”时用快节拍，两者都没有时慢慢看。
      schedule(desired === "running" || hasViews ? (desired === "running" ? activeMs : fastMs) : idleMs);
    }
  }

  schedule(0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    applied.clear();
  };
}
