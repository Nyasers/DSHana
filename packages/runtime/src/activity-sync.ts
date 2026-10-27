// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity-sync.ts — 把本 App 的运行状态写成卡片当前视图的 activity（页面状态点）
//
// 宿主给页面按钮画一个状态点，取值来自卡的当前视图 Chrome 描述（APPS.md「当前视图 Chrome」）。
// 页面侧写要走 hana.chrome.set，而后台（本 App 进程不在页面里）走 ctx.surfaces 的三个方法：
//   listCardChromeViews() → getCardChromeView() → setCardChrome()
// 本模块就是后台那一路：周期性读一眼宿主任务记录，算出「这一页该不该亮」，再只在变化时写一次。
//
// 三条纪律（照抄宿主契约，不自行简化）：
//   · 描述是**整份替换**，所以写入前必须先 get，把页面自己的 title / tabs / actions 带上再提交；
//     只交 activity 会把页面写过的其它字段一起抹掉。
//   · revision 在同一视图内严格递增；被拒（竞争）就重新读一遍，不盲目重试同一个值。
//   · 只在真正变化时写。每轮都写等于每轮都抢页面自己的写入机会。
//
// 视图从哪来：宿主只为自己注册过当前视图的卡提供这份能力（listCardChromeViews 只列本 App 的
// 活视图）。本 App 的整页主卡走的是 page 槽位，宿主的页卡渲染路径不注册 chrome 视图，于是
// 这一列表可能是空的——那种情况下本模块不报错、不空转，只把「没有可写的视图」记一次日志。
import { errText } from "@dshana/shared/err-text.ts";
import { activityFromTasks, type PageActivity } from "./activity.ts";

/** 没有在跑的任务时多久看一次宿主记录（对齐一轮页面轮询的呼吸）。 */
export const IDLE_POLL_MS = 15000;
/** 有任务在跑时多久看一次：终态要尽早反映成"灭灯"。 */
export const ACTIVE_POLL_MS = 3000;

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
  const activeMs = Number(options.activeMs) > 0 ? Number(options.activeMs) : ACTIVE_POLL_MS;
  const log = typeof options.log === "function" ? options.log : () => {};

  const tasks = ctx && ctx.tasks;
  const surfaces = ctx && ctx.surfaces;
  if (!tasks || typeof tasks.list !== "function") {
    log("debug", "activity-sync: 宿主任务面不可用（ctx.tasks.list 缺失），不起同步");
    return () => {};
  }
  if (!surfaces || typeof surfaces.listCardChromeViews !== "function"
    || typeof surfaces.getCardChromeView !== "function" || typeof surfaces.setCardChrome !== "function") {
    log("debug", "activity-sync: 宿主不提供卡片当前视图的读写面，不起同步");
    return () => {};
  }

  /** 每个视图上一次**已生效**的取值；用来跳过无变化的写入。键 = cardInstanceId。 */
  const applied = new Map<string, PageActivity | null>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

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
    const live = new Set<string>();
    for (const view of views) {
      const cardInstanceId = typeof view?.cardInstanceId === "string" ? view.cardInstanceId : "";
      const viewHandle = typeof view?.viewHandle === "string" ? view.viewHandle : "";
      if (!cardInstanceId || !viewHandle) continue;
      live.add(cardInstanceId);
      if (applied.has(cardInstanceId) && applied.get(cardInstanceId) === desired) continue;
      try {
        const current = await surfaces.getCardChromeView({ viewHandle, cardInstanceId });
        if (!current || current.ok !== true) {
          log("debug", "activity-sync: 读当前描述失败（" + String(current && current.code) + "），下一轮再试");
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
          log("debug", "activity-sync: 写描述被拒（" + String(written && written.code) + "）：" + String(written && written.error));
        }
      } catch (e) {
        applied.delete(cardInstanceId);
        log("warn", "activity-sync: 写入卡片描述异常：" + errText(e));
      }
    }
    // 视图关掉了就把它从记忆里去掉，重开时按新视图重新判一遍。
    for (const key of [...applied.keys()]) if (!live.has(key)) applied.delete(key);
  }

  async function tick(): Promise<void> {
    if (stopped || busy) return;
    busy = true;
    let desired: PageActivity | null = null;
    try {
      let rows: unknown = null;
      try {
        rows = await tasks.list();
      } catch (e) {
        log("warn", "activity-sync: 读宿主任务记录失败：" + errText(e));
        return;
      }
      desired = activityFromTasks(rows);
      await pushToViews(desired);
    } finally {
      busy = false;
      schedule(desired === "running" ? activeMs : idleMs);
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
