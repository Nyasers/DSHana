// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/host/src/activity-feed.ts — 「哪些会话正在跑」的进程内事件源（受管 runtime 子进程内）
//
// 为什么在这里做：DSH 在本进程内（main.ts 的 runProfile 返回 boot.ctx），它自己会发
// `api-session/status(sessionId, running)`。App 主进程拿不到这条事件（宿主只把受管 runtime
// 的服务代理给浏览器，App 后端的 ctx.runtime.fetch 响应体有界，ctx.runtime.watch 只报宿主
// runtime 生命周期）。所以在源头订阅、经 bridge 的 SSE 推出去，是唯一不必轮询的路。
//
// 语义：只维护「当前哪些会话在跑」这一个集合。谁在跑由 DSH 说了算（它的 status 事件），
// 本模块不推断、不猜测、不做补救——推断出来的状态迟早会和真实情况分叉。

/** 对外发布的快照：正在跑的会话 id。 */
export interface ActivitySnapshot {
  /** 正在跑的会话 id（DSH 已报 running=true 且尚未报 false 的那些）。 */
  running: string[];
  /** 本快照对应的时刻（epoch ms），供消费方判断新旧。 */
  at: number;
  /** 单调递增的版本号：消费方拿它做长轮询的“我看到哪一版”。 */
  version: number;
}

export interface ActivityFeed {
  /** 当前快照（无活动时 running 为空）。 */
  snapshot(): ActivitySnapshot;
  /** 订阅变化；返回退订函数。订阅即刻回调一次当前快照。 */
  subscribe(listener: (snapshot: ActivitySnapshot) => void): () => void;
  /**
   * 等到「版本 > sinceVersion」或超时（毫秒）。长轮询的落脚点：请求挂在这里，
   * 有变化立刻回，超时回当前快照。不按固定节拍盲发请求，也不靠采样。
   */
  wait(sinceVersion: number, timeoutMs: number): Promise<ActivitySnapshot>;
  /** 接上 DSH 的事件源；返回解绑函数。未接上时快照恒为空。 */
  attach(ctx: any): () => void;
}

/**
 * 建一个空的事件源。
 *
 * 分两步（create → attach）是因为启动顺序：bridge 先起来按端口注册服务，DSH 之后才 boot
 * 出 ctx。bridge 拿着同一个实例，attach 之后再订阅也能拿到后续变化。
 */
export function createActivityFeed(): ActivityFeed {
  const running = new Set<string>();
  const listeners = new Set<(snapshot: ActivitySnapshot) => void>();
  /** 版本号：每次集合变化 +1。长轮询靠它判断“有没有新东西”。 */
  let version = 0;

  const snapshot = (): ActivitySnapshot => ({ running: [...running], at: Date.now(), version });

  function publish(): void {
    version += 1;
    const snap = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(snap);
      } catch {
        // 单个消费方抛错不该带走其它消费方，也不该把 bridge 的响应流写死。
      }
    }
  }

  return {
    snapshot,
    wait(sinceVersion, timeoutMs) {
      if (version > sinceVersion) return Promise.resolve(snapshot());
      const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          listeners.delete(onChange);
          resolve(snapshot());
        };
        const onChange = (): void => finish();
        const timer = setTimeout(finish, Math.min(ms, 60000));
        listeners.add(onChange);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      // 订阅即给一次当前状态：消费方重连时不必再单独查一次。
      try {
        listener(snapshot());
      } catch {
        /* 同上 */
      }
      return () => {
        listeners.delete(listener);
      };
    },
    attach(ctx) {
      if (!ctx || typeof ctx.on !== "function") return () => {};
      // 事件形态见 api/session-controller/types.ts：'api-session/status'(sessionId, running)。
      const off = ctx.on("api-session/status", (sessionId: unknown, isRunning: unknown) => {
        const id = typeof sessionId === "string" ? sessionId : "";
        if (!id) return;
        const wasRunning = running.has(id);
        if (isRunning === true) {
          if (wasRunning) return;
          running.add(id);
          publish();
          return;
        }
        if (!wasRunning) return;
        running.delete(id);
        publish();
      });
      return () => {
        if (typeof off === "function") off();
      };
    },
  };
}
