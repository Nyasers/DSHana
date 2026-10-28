// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity-sync.ts — 把本 App 的运行状态写成卡片当前视图的 activity（页面状态点）
//
// 宿主给页面按钮画一个状态点，取值来自卡的当前视图 Chrome 描述（APPS.md「当前视图 Chrome」）。
// 页面侧写要走 hana.chrome.set，而后台（本 App 进程不在页面里）走 ctx.surfaces 的三个方法：
//   listCardChromeViews() → getCardChromeView() → setCardChrome()
//
// 状态从哪来：**事件**。DSH 的 `api-session/status` 在受管 runtime 子进程里发生，由那边的
// activity-feed 订阅、经控制面的 `activity-wait` 长轮询交给这里（activity-stream.ts）。空闲
// 时只有一个请求挂着，有变化毫秒级返回；不按节拍采样。
//
// 这里没有「状态轮询」，也没有兜底采样：通道不通就不亮灯。采样在真机上被证否过两次——DSH
// 会话常常只有一两秒，节拍再密也会把整个 running 窗口夹在两次采样之间。宁可不亮，也不假装。
//
// 唯一还会定时做的事是**枚举卡片视图**（宿主不告诉 App「有卡挂载了」），而且只在有东西要写
// 的时候扫：在跑时每几秒扫一次好补写上刚打开的卡；不跑时完全停表。
import { errText } from "@dshana/shared/err-text.ts";
import { type PageActivity } from "./activity.ts";
import { currentActivity, subscribeActivity } from "./activity-store.ts";

/** 在跑时枚举视图的间隔：只为发现「刚挂载的卡」，不是为了取状态。 */
export const VIEW_REFRESH_MS = 5000;
/** 一个视图连续失败几次就不再碰它（宿主列表里会留着已关闭卡的视图）。 */
export const MAX_VIEW_STRIKES = 3;

/** 一次写入的判定结果：null = 不必写（已经一致）；否则是要提交的完整描述。 */
export function planChromeWrite(
  current: { revision?: unknown; activity?: unknown } | null | undefined,
  desired: PageActivity | null,
): { revision: number; activity: PageActivity | null } | null {
  const now = current && typeof current === "object" ? current.activity ?? null : null;
  if (now === desired) return null;
  // 宿主的 revision 是**正整数**（严格递增）：读不到、非数字、读到 0 或负数都当从头算。
  // 不能拿一个非法值加一交上去——那会被拒，而且下一轮算出来的值还是同一个。
  // 类型也要卡住：字符串 "7" 不强转（不替宿主的数据做隐式修正）。
  const raw = current && typeof current === "object" ? (current as { revision?: unknown }).revision : undefined;
  const rev = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
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
  /** 在跑时枚举视图的间隔（默认 VIEW_REFRESH_MS）。 */
  refreshMs?: number;
  log?: (level: "info" | "warn" | "debug", message: string) => void;
}

/**
 * 装一次同步，返回卸载函数。
 *
 * ctx 是宿主 App 上下文（apply 收到的那份）：用 ctx.surfaces.* 写卡片描述。状态来自受管
 * runtime 的活动通道。面缺失只记一条日志后安静退出。
 */
export function installHostActivitySync(ctx: any, options: ActivitySyncOptions = {}): () => void {
  const refreshMs = Number(options.refreshMs) > 0 ? Number(options.refreshMs) : VIEW_REFRESH_MS;
  const log = typeof options.log === "function" ? options.log : () => {};

  const surfaces = ctx && ctx.surfaces;
  // 启动自检一律 info：宿主的 ctx.logger.debug 不落盘（实测日志里一行 DEBUG 都没有），
  // 用 debug 写等于「我看不到到底哪一步路没走通」。
  if (!surfaces || typeof surfaces.listCardChromeViews !== "function"
    || typeof surfaces.getCardChromeView !== "function" || typeof surfaces.setCardChrome !== "function") {
    log("info", "activity-sync: 宿主不提供卡片当前视图的读写面，不起同步");
    return () => {};
  }

  /** 每个视图上一次**已生效**的取值；用来跳过无变化的写入。键 = cardInstanceId。 */
  const applied = new Map<string, PageActivity | null>();
  /** 每个视图已连续失败几次：失败到上限就不再碰它，直到下次列视图时重新出现。 */
  const strikes = new Map<string, number>();
  /** 已报过「已落到卡片」的实例：每张卡只报一次。 */
  const announced = new Set<string>();

  let stopped = false;
  /** 当前应有的状态：由活动通道的快照直接赋值。 */
  let desired: PageActivity | null = null;
  let busy = false;
  let busySince = 0;
  let sawEmpty = false;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  /** 停掉枚举定时器：不跑的时候这里不该有任何待办。 */
  function stopSweep(): void {
    if (sweepTimer !== null) clearTimeout(sweepTimer);
    sweepTimer = null;
  }

  /** 排一次枚举。仅在 desired === "running" 期间使用。 */
  function scheduleSweep(delay = refreshMs): void {
    if (stopped) return;
    stopSweep();
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      void runSweep();
    }, delay);
  }

  async function runSweep(): Promise<void> {
    await flush();
    // 还在跑就继续扫：可能有刚挂载的卡要补写。不跑就到此为止。
    if (!stopped && desired === "running") scheduleSweep();
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

  /** 用当前状态推一次视图。并发保护 + 挂死看门狗（一个不返回的调用不能把同步锁死）。 */
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

  /** 收到一次上报就更新状态；页面可能同时开多个面，谁报都一样。 */
  function applyReport(reported: { running: string[] }): void {
    const next: PageActivity | null = reported.running.length > 0 ? "running" : null;
    if (next === desired) {
      if (next === null) stopSweep();
      return;
    }
    desired = next;
    if (next === "running") {
      log("info", "activity-sync: 会话在跑（" + reported.running.length + " 个，页面报来），推状态点");
      // 上报到了立刻写；同时开一轮枚举，好补写上之后才挂载的卡。
      void flush();
      scheduleSweep();
    } else {
      log("info", "activity-sync: 没有会话在跑，撤状态点");
      stopSweep();
      void flush();
    }
  }

  const offReport = subscribeActivity(applyReport);
  // 启动时先看一次现值：页面可能在本模块装上之前就报过了。
  const initial = currentActivity();
  if (initial) applyReport(initial);
  log("info", "activity-sync: 已接管（状态由页面报来；空闲零唤醒，只在会话在跑时枚举视图）");

  return () => {
    stopped = true;
    stopSweep();
    offReport();
    applied.clear();
    strikes.clear();
    announced.clear();
  };
}
