// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity-store.ts — 页面报上来的会话活动快照（App 主进程内）
//
// 链路：受管 runtime 订阅 DSH 的 `api-session/status` → 经中继的 SSE 推给**页面** →
// 页面 POST 到本 App 的 `/dshana/activity` → 落在这里 → activity-sync 据此写状态点。
//
// 为什么绕页面这一圈：App 进程没有网络权限（实测 `ERR_ACCESS_DENIED`），直连不了中继端口；
// 而页面天生有中继的路径票据（它就是靠那条前缀加载 DSH 的），并且它能把请求发回本 App 的
// 路由。于是「推」这件事交给页面代劳，后端只负责收。
//
// 语义：只保存**页面报上来的**事实，不推断、不续期。页面没了就当作没有新消息，
// 旧状态的保鲜由消费方（activity-sync）自己判断。
/** 页面报来的一次快照。 */
export interface ReportedActivity {
  /** 正在跑的会话 id。 */
  running: string[];
  /** 页面写这个快照的时刻（epoch ms；缺省用到达时刻）。 */
  at: number;
  /** 到达本进程的时刻（epoch ms），用来判断新鲜度。 */
  receivedAt: number;
}

type Listener = (snapshot: ReportedActivity) => void;

const listeners = new Set<Listener>();
let latest: ReportedActivity | null = null;

/** 把一串会话 id 收敛成快照形态：去空、去重、保序。 */
export function normalizeRunning(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 收下一次页面报告。返回落库后的快照。
 * 页面可能同时开多个面（多用例），谁报都一样：这里是「当前事实」，不是事件流。
 */
export function reportActivity(input: unknown, now = Date.now()): ReportedActivity {
  const src = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const at = typeof src.at === "number" && Number.isFinite(src.at) ? src.at : now;
  const snapshot: ReportedActivity = { running: normalizeRunning(src.running), at, receivedAt: now };
  latest = snapshot;
  for (const listener of [...listeners]) {
    try {
      listener(snapshot);
    } catch {
      // 单个消费方抛错不该影响其它消费方，也不该让上报失败。
    }
  }
  return snapshot;
}

/** 当前快照；从未收到过报告时返回 null（区别于「收到了、里面没有人跑」）。 */
export function currentActivity(): ReportedActivity | null {
  return latest;
}

/** 订阅变化；返回退订函数。订阅不会立即回调（首次值用 currentActivity 自己取）。 */
export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 清空（App 卸载/重载时用；测试也需要）。 */
export function resetActivity(): void {
  latest = null;
  listeners.clear();
}
