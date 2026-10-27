// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity-stream.ts — 订阅受管 runtime 的会话活动（App 主进程内）
//
// 为什么不是轮询：轮询按固定节拍采样，DSH 会话常常只有一两秒，整个 running 窗口会夹在两次
// 采样之间（真机验证过两次都漏）。这里改成**长轮询**：请求挂在 runtime 侧，有变化立刻回，
// 没变化就等到超时回当前快照。空闲时只有一个请求挂着，延迟是毫秒级，不是节拍级。
//
// 为什么不用 WebSocket / 直连端口：App 进程没有网络权限（实测 `ERR_ACCESS_DENIED Access to
// this API is restricted`），只能用宿主的受管服务代理 `ctx.runtime.fetch`，而那条路响应体
// 有界，长连接会被切断；控制面上的一问一答正好在它的能力范围内。
//
// 传输协议（与 packages/host/src/main.ts 的 onControl 对齐）：
//   POST /_control { action: "activity-wait", args: { since, timeoutMs } }
//   → { running: string[], at: number, version: number }
import { invokeControl } from "./controller.ts";

/** 一次快照（形状见 packages/host/src/activity-feed.ts）。 */
export interface ActivitySnapshot {
  running: string[];
  at?: number;
  version?: number;
}

export interface ActivityStreamOptions {
  /** 每次拿到快照时回调（包括超时返回的那次，调用方自己判断有没有变）。 */
  onSnapshot: (snapshot: ActivitySnapshot) => void;
  /**
   * 单次挂起的上限（毫秒），封顶 20000。上限来自宿主契约：`ctx.runtime.fetch` 的 timeoutMs 只接
   * 1–30000，再长直接被拒（实测过：传 35000 整条通道就不通了）。留出 8 秒余量给往返。
   */
  waitMs?: number;
  /** 连接状态变化（仅用于日志）。 */
  onStatus?: (state: "open" | "closed", detail?: string) => void;
}

/** 宿主对单次受管服务请求的超时上限（SDK：timeoutMs 只接 1–30000）。 */
export const MAX_FETCH_TIMEOUT_MS = 30000;
/** 挂起时长上限：给往返留余量，不贴着宿主上限。 */
export const MAX_WAIT_MS = 20000;

/** 把 runtime 的原始回包收成快照；形状不对就当空。 */
export function normalizeSnapshot(value: unknown): ActivitySnapshot {
  const src = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const running = Array.isArray(src.running)
    ? src.running.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const at = typeof src.at === "number" && Number.isFinite(src.at) ? src.at : undefined;
  const version = typeof src.version === "number" && Number.isFinite(src.version) ? src.version : undefined;
  return at === undefined ? { running, ...(version === undefined ? {} : { version }) } : { running, at, ...(version === undefined ? {} : { version }) };
}

/**
 * 起一条订阅循环。返回停止函数（幂等）。
 *
 * 循环形态：拿到的版本号喂回下一次请求的 `since`，于是「有变化立刻回、没变化挂到超时」。
 * 出错时退避（1s 起，上限 15s）后重试；错误只报一次，恢复时报一次。
 */
export function subscribeActivityStream(ctx: any, options: ActivityStreamOptions): () => void {
  const requested = Number(options.waitMs) > 0 ? Number(options.waitMs) : MAX_WAIT_MS;
  const waitMs = Math.min(requested, MAX_WAIT_MS);
  // 挂起时间必须**短于**宿主的 fetch 超时，否则请求会先被宿主截断，长轮询每次都以失败告终。
  const fetchTimeoutMs = Math.min(MAX_FETCH_TIMEOUT_MS, waitMs + 8000);
  const { onSnapshot, onStatus } = options;
  let stopped = false;
  let since = 0;
  let attempt = 0;
  let failing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(delay: number): void {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void loop();
    }, delay);
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      const raw = await invokeControl(
        ctx,
        "activity-wait",
        { since, timeoutMs: waitMs },
        { timeoutMs: fetchTimeoutMs },
      );
      const snapshot = normalizeSnapshot(raw);
      if (typeof snapshot.version === "number") since = snapshot.version;
      if (failing) {
        failing = false;
        onStatus?.("open");
      }
      try {
        onSnapshot(snapshot);
      } catch {
        // 消费方抛错不该把循环打断。
      }
      schedule(0);
    } catch (e) {
      attempt += 1;
      if (!failing) {
        failing = true;
        onStatus?.("closed", e instanceof Error ? e.message : String(e));
      }
      const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt - 1, 4));
      schedule(delay);
    }
  }

  void loop();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
