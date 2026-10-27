// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity-stream.ts — 订阅受管 runtime 推来的会话活动流（App 主进程内）
//
// 为什么不再轮询：DSH 的 `api-session/status` 在 runtime 子进程里就发生了，那一侧订阅后经
// bridge 的 `/_control/activity` 用 SSE 推出来（见 packages/host/src/activity-feed.ts 与
// bridge.ts）。App 只要保一条长连接就能拿到每一次翻转——短会话不会再夹在两次采样之间。
//
// 传输：Node 原生 http（不是 ctx.runtime.fetch，那条路的响应体有界，拿不到长连接）。目标是
// 回环地址上的 bridge，用 controlKey 鉴权（与 /_control 同一个钥匙，浏览器侧拿不到）。
// 断线自动重连：bridge 重启或 runtime 换端口都会让流断掉，重连时服务端会先推一次当前快照。
import http from "node:http";

/** 服务端推来的一次快照（形状见 packages/host/src/activity-feed.ts）。 */
export interface ActivitySnapshot {
  running: string[];
}

export interface ActivityStreamOptions {
  /** bridge 的 loopback 基址，如 http://127.0.0.1:60086。 */
  base: string;
  /** 控制面钥匙（header x-hana-dsh-control）。 */
  controlKey: string;
  /** 每次收到快照时回调。 */
  onSnapshot: (snapshot: ActivitySnapshot) => void;
  /** 连接状态变化（仅用于日志）。 */
  onStatus?: (state: "open" | "closed", detail?: string) => void;
  /** 重连退避上限，默认 15 秒。 */
  maxBackoffMs?: number;
}

/** 从一行 SSE 文本里取出快照；不是数据行（注释、空行）返回 null。 */
export function parseSseData(line: string): ActivitySnapshot | null {
  const text = String(line ?? "");
  if (!text.startsWith("data:")) return null;
  const payload = text.slice(5).trim();
  if (!payload) return null;
  try {
    const value = JSON.parse(payload);
    const running = Array.isArray(value?.running)
      ? value.running.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      : [];
    return { running };
  } catch {
    return null;
  }
}

/**
 * 起一条订阅。返回停止函数（幂等）。
 * 断线后按指数退避重连（1s 起，上限 maxBackoffMs），直到 stop() 被调用。
 */
export function subscribeActivityStream(options: ActivityStreamOptions): () => void {
  const { base, controlKey, onSnapshot, onStatus } = options;
  const maxBackoffMs = Number(options.maxBackoffMs) > 0 ? Number(options.maxBackoffMs) : 15000;
  const url = new URL("/_control/activity", base);
  let stopped = false;
  let attempt = 0;
  let current: http.ClientRequest | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRetry(detail: string): void {
    if (stopped) return;
    onStatus?.("closed", detail);
    attempt += 1;
    const delay = Math.min(maxBackoffMs, 1000 * 2 ** Math.min(attempt - 1, 4));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "x-hana-dsh-control": controlKey,
          accept: "text/event-stream",
          "cache-control": "no-cache",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleRetry("HTTP " + String(res.statusCode));
          return;
        }
        attempt = 0;
        onStatus?.("open");
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          // SSE 以空行分隔事件；这里只关心 data 行。
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            const snapshot = parseSseData(line);
            if (snapshot) {
              try {
                onSnapshot(snapshot);
              } catch {
                // 消费方抛错不该把流打断。
              }
            }
            index = buffer.indexOf("\n");
          }
        });
        res.on("end", () => scheduleRetry("stream ended"));
        res.on("error", (e) => scheduleRetry(e instanceof Error ? e.message : String(e)));
      },
    );
    current = req;
    req.on("error", (e) => scheduleRetry(e instanceof Error ? e.message : String(e)));
  }

  connect();
  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (current) {
      try {
        current.destroy();
      } catch {
        /* 已断开 */
      }
      current = null;
    }
  };
}
