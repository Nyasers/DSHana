// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity-sync.ts — 把本 App 的运行状态写成卡片当前视图的 activity（页面状态点）
//
// 宿主给页面按钮画一个状态点，取值来自卡的当前视图 Chrome 描述（APPS.md「当前视图 Chrome」）。
// 页面侧写要走 hana.chrome.set，而后台（本 App 进程不在页面里）走 ctx.surfaces 的三个方法：
//   listCardChromeViews() → getCardChromeView() → setCardChrome()
//
// 状态从哪来（**事件驱动，不采样**）：DSH 的 `api-session/status` 在受管 runtime 子进程里发生，
// 由那边的 activity-feed 订阅、经 bridge 的 `/_control/activity` 用 SSE 推过来
// （packages/host/src/activity-feed.ts、bridge.ts；消费端见 activity-stream.ts）。
// 轮询在这里是被证否过的方案：DSH 会话常常只有一两秒，采样周期再小也会把整个 running 窗口
// 夹在两次采样之间。
//
// 但视图枚举没有事件面：宿主不告诉 App「有卡挂载了」。所以这里仍有一个轻量的周期任务，
// 它只做「列视图 + 补写」，状态本身来自事件。两者分工明确：状态由事件推，视图靠周期刷新。
//
// 三条纪律（照抄宿主契约，不自行简化）：
//   · 描述是**整份替换**，所以写入前必须先 get，把页面自己的 title / tabs / actions 带上再提交；
//     只交 activity 会把页面写过的其它字段一起抹掉。
//   · revision 在同一视图内严格递增；被拒（竞争）就重新读一遍，不盲目重试同一个值。
//   · 只在真正变化时写。每轮都写等于每轮都抢页面自己的写入机会。
import { errText } from "@dshana/shared/err-text.ts";
import { activityFromTasks, type PageActivity } from "./activity.ts";
import { subscribeActivityStream } from "./activity-stream.ts";
import { bridgeAccess } from "./managed-runtime.ts";
import { rpcViaControl } from "./controller.ts";

/** 视图枚举的刷新间隔：状态不靠它，它只负责发现「有卡挂载/卸载了」。 */
export const VIEW_REFRESH_MS = 5000;
/** 流不可用时的兜底采样间隔（老 runtime 或订阅失败时才会走到）。 */
export const FALLBACK_POLL_MS = 2000;
/** 一个视图连续失败几次就不再碰它（宿主列表里会留着已关闭卡的视图）。 */
export const MAX_VIEW_STRIKES = 3;

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
  /** 视图枚举刷新间隔（默认 VIEW_REFRESH_MS）。 */
  refreshMs?: number;
  /** 流不可用时的兜底采样间隔（默认 FALLBACK_POLL_MS）。 */
  fallbackMs?: number;
  log?: (level: "info" | "warn" | "debug", message: string) => void;
}

/**
 * 装一次同步循环，返回卸载函数。
 *
 * ctx 是宿主 App 上下文（apply 收到的那份）：用 ctx.surfaces.* 写卡片描述。状态来自受管
 * runtime 的 SSE（bridgeAccess 给的地址与钥匙）。任何一个面缺失都只记一条日志后安静退出。
 */
export function installHostActivitySync(ctx: any, options: ActivitySyncOptions = {}): () => void {
  const refreshMs = Number(options.refreshMs) > 0 ? Number(options.refreshMs) : VIEW_REFRESH_MS;
  const fallbackMs = Number(options.fallbackMs) > 0 ? Number(options.fallbackMs) : FALLBACK_POLL_MS;
  const log = typeof options.log === "function" ? options.log : () => {};

  const surfaces = ctx && ctx.surfaces;
  // 启动自检一律 info：宿主的 ctx.logger.debug 不落盘（实测日志里一行 DEBUG 都没有），
  // 用 debug 写等于「我看不到到底哪一步路没走通」。
  if (!surfaces || typeof surfaces.listCardChromeViews !== "function"
    || typeof surfaces.getCardChromeView !== "function" || typeof surfaces.setCardChrome !== "function") {
    log("info", "activity-sync: 宿主不提供卡片当前视图的读写面，不起同步");
    return () => {};
  }
  log("info", "activity-sync: 已接管（状态走 runtime 的 SSE，视图每 " + refreshMs + "ms 刷一次）");

  /** 每个视图上一次**已生效**的取值；用来跳过无变化的写入。键 = cardInstanceId。 */
  const applied = new Map<string, PageActivity | null>();
  /** 每个视图已连续失败几次：失败到上限就不再碰它，直到下次列视图时重新出现。 */
  const strikes = new Map<string, number>();
  /** 已报过「已落到卡片」的实例：每张卡只报一次，之后的增减不必重复。 */
  const announced = new Set<string>();

  let stopped = false;
  /** 当前应有的状态：由 SSE 快照直接赋值，或由兜底采样算出。 */
  let desired: PageActivity | null = null;
  let busy = false;
  let busySince = 0;
  let sawEmpty = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let stopStream: (() => void) | null = null;
  let streamReady = false;
  /** 兜底采样是否处于「读不到」状态（只用于把日志从每轮刷降成翻转时报一次）。 */
  let fallbackFailed = false;

  function scheduleRefresh(delay = refreshMs): void {
    if (stopped) return;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void tick();
    }, delay);
  }

  async function pushToViews(now: PageActivity | null): Promise<void> {
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
    const live = new Set<string>();
    // 视图表空了不是错，但必须看得见：这是「能不能亮灯」的唯一分叉点。
    if (views.length === 0) {
      if (!sawEmpty) {
        sawEmpty = true;
        log("info", "activity-sync: 宿主尚未为本 App 注册卡片当前视图（页面未挂载）；"
          + "目标状态 " + String(now) + " 已算出，等视图出现再落盘。");
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
      // 已经失败到上限的视图直接跳过：宿主列表里会留下已关闭卡的视图，逐个等超时
      // 会拖慢整轮（实测 RESULT_TIMEOUT），而它们本来就不可能写成功。
      if ((strikes.get(cardInstanceId) ?? 0) >= MAX_VIEW_STRIKES) continue;
      if (!announced.has(cardInstanceId)) {
        announced.add(cardInstanceId);
        log("info", "activity-sync: 拿到卡片视图 " + cardInstanceId + "（cardId " + String(view.cardId) + "）");
      }
      if (applied.has(cardInstanceId) && applied.get(cardInstanceId) === now) continue;
      try {
        const current = await surfaces.getCardChromeView({ viewHandle, cardInstanceId });
        if (!current || current.ok !== true) {
          const n = (strikes.get(cardInstanceId) ?? 0) + 1;
          strikes.set(cardInstanceId, n);
          log("warn", "activity-sync: 读当前描述失败（" + String(current && current.code) + "，第 " + n + " 次），下一轮再试");
          applied.delete(cardInstanceId);
          continue;
        }
        strikes.delete(cardInstanceId);
        const plan = planChromeWrite(current.description, now);
        if (!plan) { applied.set(cardInstanceId, now); continue; }
        const written = await surfaces.setCardChrome({
          viewHandle,
          cardInstanceId,
          description: mergeDescription(current.description, plan),
        });
        if (written && written.ok === true) {
          applied.set(cardInstanceId, now);
          log("info", "activity-sync: 页面状态点 → " + String(now) + "（卡片 " + cardInstanceId + "）");
        } else {
          // 被拒就是被拒：revision 竞争时下一轮重新读，绝不原样重试。
          const n = (strikes.get(cardInstanceId) ?? 0) + 1;
          strikes.set(cardInstanceId, n);
          applied.delete(cardInstanceId);
          log("warn", "activity-sync: 写描述被拒（" + String(written && written.code) + "，第 " + n + " 次）：" + String(written && written.error));
        }
      } catch (e) {
        applied.delete(cardInstanceId);
        log("warn", "activity-sync: 写入卡片描述异常：" + errText(e));
      }
    }
    // 视图关掉了就把它从记忆里去掉，重开时按新视图重新判一遍。
    for (const key of [...applied.keys()]) if (!live.has(key)) applied.delete(key);
    for (const key of [...announced]) if (!live.has(key)) announced.delete(key);
    for (const key of [...strikes.keys()]) if (!live.has(key)) strikes.delete(key);
  }

  /** 用当前状态推一次视图。并发保护 + 挂死看门狗（一个不返回的调用不能把循环锁死）。 */
  async function flush(): Promise<void> {
    if (busy && Date.now() - busySince < 30000) return;
    busy = true;
    busySince = Date.now();
    try {
      await pushToViews(desired);
    } finally {
      busy = false;
    }
  }

  /** 兜底采样：只在事件流不可用时使用（老 runtime、订阅失败）。 */
  async function pollFallback(): Promise<PageActivity | null> {
    try {
      const value = await rpcViaControl(ctx, { method: "session/list", payload: {}, timeoutMs: 8000 });
      const items = value && Array.isArray((value as any).items) ? (value as any).items : null;
      if (items) {
        if (fallbackFailed) {
          fallbackFailed = false;
          log("info", "activity-sync: 兜底采样恢复可用");
        }
        return (items as any[]).some((it) => it && typeof it === "object"
          && (it as any).blank !== true && (it as any).running === true) ? "running" : null;
      }
    } catch (e) {
      if (!fallbackFailed) {
        fallbackFailed = true;
        log("info", "activity-sync: 兜底采样读不到会话状态（受管 runtime 未就绪或控制面不通）：" + errText(e));
      }
    }
    const tasks = ctx && ctx.tasks;
    if (tasks && typeof tasks.list === "function") {
      try {
        return activityFromTasks(await tasks.list());
      } catch {
        /* 读不到任务记录时维持不亮 */
      }
    }
    return null;
  }

  /** 试着接上事件流；受管 runtime 还没起来时返回 false，下一轮再试。 */
  function ensureStream(): boolean {
    if (streamReady) return true;
    const access: any = typeof bridgeAccess === "function" ? bridgeAccess() : null;
    if (!access || !access.controlKey || !access.base) return false;
    stopStream = subscribeActivityStream({
      base: access.base,
      controlKey: access.controlKey,
      onSnapshot: (snapshot) => {
        const next: PageActivity | null = snapshot.running.length > 0 ? "running" : null;
        if (next === desired) return;
        desired = next;
        if (next === "running") log("info", "activity-sync: 会话在跑（" + snapshot.running.length + " 个），推状态点");
        else log("info", "activity-sync: 没有会话在跑，撤状态点");
        // 事件到了就立刻写，不等下一轮刷新。
        void flush();
      },
      onStatus: (state, detail) => {
        if (state === "open") {
          streamReady = true;
          log("info", "activity-sync: 已接上会话活动流（事件驱动，不轮询）");
          return;
        }
        // 断线：回到兜底采样，等重连成功再切回来。
        streamReady = false;
        log("warn", "activity-sync: 会话活动流断开（" + String(detail || "") + "），期间用兜底采样");
      },
    });
    return true;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const streaming = ensureStream();
      if (!streaming || !streamReady) {
        const next = await pollFallback();
        if (next !== desired) {
          desired = next;
          await flush();
        } else {
          await flush();
        }
      } else {
        // 事件流在跑：本轮只刷新视图，状态不动。
        await flush();
      }
    } finally {
      // 事件流通着时可以慢一点（只刷新视图）；兜底采样期间用快节拍。
      scheduleRefresh(streamReady ? refreshMs : fallbackMs);
    }
  }

  scheduleRefresh(0);
  return () => {
    stopped = true;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (typeof stopStream === "function") stopStream();
    stopStream = null;
    applied.clear();
    strikes.clear();
    announced.clear();
  };
}
