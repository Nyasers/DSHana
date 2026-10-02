// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/face-channel.ts — 面间直投通道的客户端半（长轮询循环 + 本地状态缓存）
//
// 一份文档一台：起一个挂起轮询循环收帧，收件人由服务端半按面地址挑（见 packages/tools/src/faces-hub.ts），
// 本层只做四件事：把你指名的投递发出去、把收到的帧落到本地缓存、把变化通知给订阅者、失败了退避重连。
//
// 两条与"共享空间 + 各自监听"划清界限的性质：
//   · **不判回声**：服务端半按发射文档的 sub 排除自己（`others`），所以本层不需要"这条是不是我自己写的"
//     这类判据，也就没有"清空盖新时间戳→被自己唤醒"那类循环可写；
//   · **不重放旧命令**：首挂只拿 state 快照，命令类帧只投当前在场且命中的面。
//
// 本地缓存为什么要懒种子：ui-session 的启动握手是"读一次当前值"，通道就绪与否不该改变这个语义
// （也不该让首屏多等一跳）。所以首读先直接读权威记录（注入口子 seed），随后的帧与快照把它保持新鲜。
import {
  CHANNEL_NATURE,
  isChannelKind,
  normalizeChannelPayload,
  type ChannelFrame,
  type ChannelKind,
  type FaceAddress,
  type FaceTarget,
} from "@dshana/shared/faces-channel.ts";

/** 通道用到的宿主管道（surface-bridge 的 apiFetch 实现；单测传假实现）。 */
export interface FaceChannelIO {
  /** GET 一条通道路径（返回已解析的 JSON）。signal 用于长轮询超时/停表。 */
  get(path: string, signal?: AbortSignal): Promise<unknown>;
  /** POST 一条通道路径（body 已是 JSON 值）。 */
  post(path: string, body: unknown): Promise<unknown>;
}

export interface FaceChannelOptions {
  /** 本面的角色词（face-role.ts 的 roleForView）。 */
  role: FaceAddress;
  /** 卡片实例戳（hana.surface.getContext()?.cardInstanceId；缺时由调用方给占位）。 */
  scope: string;
  io: FaceChannelIO;
  /** 首读的种子（读一次权威记录；不注入则首读为空，只等帧）。 */
  seed?: (kind: ChannelKind) => Promise<{ value: unknown; at: number } | null>;
  now?: () => number;
  log?: (msg: string) => void;
  subId?: string;
  /** 客户端长轮询超时（要比服务端挂起上限长一点，留给应答回程）。 */
  requestTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** 判“这个错不可能自愈”：命中即停表（不刷日志、不占着循环）。 */
  isFatal?: (error: unknown) => boolean;
}

/** 一条收到的帧（state 类帧同时已落进本地缓存）。 */
export interface FaceChannelFrame {
  kind: ChannelKind;
  at: number;
  from: FaceAddress | null;
  payload: unknown;
}

export interface FaceChannel {
  /** 起停幂等。 */
  start(): void;
  stop(): void;
  /** 指名投递；回执里的 delivered 是真的会被投到的面数。 */
  publish(kind: ChannelKind, payload: unknown, to?: FaceTarget): Promise<{ delivered: number }>;
  /** 读当前值（首读懒种子；没有当前值时为 null）。 */
  read(kind: ChannelKind): Promise<{ value: unknown; at: number } | null>;
  /** 订阅帧（含 state 快照引起的通知）；返回退订。 */
  onFrame(listener: (frame: FaceChannelFrame) => void): () => void;
}

const DEFAULT_PARK_TIMEOUT_MS = 26000;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_RETRY_MAX_MS = 5000;

/** 不会自愈的失败：没凭据/被拒——重试只是白耗（且会把日志刷成瀑布）。 */
const FATAL_PATTERN = /缺少 App surface 会话凭据|appSurfaceSession|HTTP 40[13]|HTTP 404/;
/** 同一个可恢复错误最多每这么多轮刷一条日志（5s 退避下约一分钟一条）。 */
const LOG_EVERY_N_FAILURES = 12;

function errText(e: unknown): string {
  return ((e as { message?: string })?.message as string) || String(e);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    /* 停表时立刻醒来（不然 stop 要等到退避结束） */
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** 建一台通道（不自动开跑，start 才起循环）。 */
export function createFaceChannel(opts: FaceChannelOptions): FaceChannel {
  const { role, scope, io } = opts;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const subId = opts.subId && opts.subId.trim() ? opts.subId.trim() : "s" + Math.random().toString(36).slice(2, 10);
  const requestTimeoutMs = Number(opts.requestTimeoutMs) > 0 ? Number(opts.requestTimeoutMs) : DEFAULT_PARK_TIMEOUT_MS;
  const retryBase = Number(opts.retryBaseMs) > 0 ? Number(opts.retryBaseMs) : DEFAULT_RETRY_BASE_MS;
  const retryMax = Number(opts.retryMaxMs) > 0 ? Number(opts.retryMaxMs) : DEFAULT_RETRY_MAX_MS;
  const isFatal = typeof opts.isFatal === "function" ? opts.isFatal : (e: unknown) => FATAL_PATTERN.test(errText(e));

  let running = false;
  // 首次挂起：拿快照 + 对齐序号（不重放历史帧）。收到第一次成功应答后就不再叫首挂。
  let fresh = true;
  let since = 0;
  let inflight: AbortController | null = null;
  // 停表的信号：stop 时中止在飞的请求与退避等待；start 再开时换一枚新的（AbortSignal 不可复用）。
  let halt = new AbortController();
  const cache = new Map<ChannelKind, { value: unknown; at: number }>();
  const seeding = new Map<ChannelKind, Promise<unknown>>();
  const listeners = new Set<(frame: FaceChannelFrame) => void>();

  function notify(frame: FaceChannelFrame): void {
    for (const listener of [...listeners]) {
      try { listener(frame); } catch (e) { log("帧监听者抛错（忽略）：" + errText(e)); }
    }
  }

  /** 落一条 state 值：值或时刻变了才算变化（快照与帧可能重复送同一条）。 */
  function applyState(kind: ChannelKind, value: unknown, at: number, from: FaceAddress | null): void {
    const next = { value: normalizeChannelPayload(kind, value), at };
    const prev = cache.get(kind);
    if (prev && prev.at === next.at && JSON.stringify(prev.value) === JSON.stringify(next.value)) return;
    cache.set(kind, next);
    notify({ kind, at, from, payload: next.value });
  }

  function applyFrame(raw: unknown): void {
    const f = raw as ChannelFrame | null;
    if (!f || typeof f !== "object" || !isChannelKind(f.kind)) return;
    const at = typeof f.at === "number" ? f.at : 0;
    if (CHANNEL_NATURE[f.kind] === "state") applyState(f.kind, f.payload, at, (f.from as FaceAddress) ?? null);
    else notify({ kind: f.kind, at, from: (f.from as FaceAddress) ?? null, payload: f.payload });
  }

  function applyPoll(raw: unknown): void {
    const res = raw as { ok?: unknown; seq?: unknown; frames?: unknown; state?: unknown } | null;
    if (!res || typeof res !== "object" || res.ok !== true) return;
    fresh = false;
    if (typeof res.seq === "number") since = res.seq;
    if (res.state && typeof res.state === "object") {
      for (const [kind, entry] of Object.entries(res.state as Record<string, unknown>)) {
        if (!isChannelKind(kind)) continue;
        const e = entry && typeof entry === "object" ? (entry as { value?: unknown; at?: unknown }) : {};
        applyState(kind, e.value, typeof e.at === "number" ? e.at : 0, null);
      }
    }
    if (Array.isArray(res.frames)) for (const frame of res.frames) applyFrame(frame);
  }

  function pollPath(): string {
    const q = "card=" + encodeURIComponent(scope)
      + "&sub=" + encodeURIComponent(subId)
      + "&as=" + encodeURIComponent(role)
      + "&since=" + String(since)
      + "&fresh=" + (fresh ? "1" : "0");
    return "dshana/faces/poll?" + q;
  }

  async function pollOnce(): Promise<void> {
    const ctl = new AbortController();
    inflight = ctl;
    const timer = setTimeout(() => ctl.abort(), requestTimeoutMs);
    try {
      applyPoll(await io.get(pollPath(), ctl.signal));
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  }

  async function loop(): Promise<void> {
    let backoff = retryBase;
    let failures = 0;
    while (running) {
      try {
        await pollOnce();
        // 空应答 = 服务端挂起超时（心跳）：立刻再挂，不算失败、不退避。
        backoff = retryBase;
        failures = 0;
      } catch (e) {
        if (!running) return;
        // 不可恢复（没凭据/被拒）：停表，而不是每 5 秒刷一条日志、把进程拖住。
        if (isFatal(e)) {
          running = false;
          log("面间通道停表（不可恢复的失败，不再重试）：" + errText(e));
          return;
        }
        failures += 1;
        // 可恢复的错（断网、进程重启）也只在头一次与之后每隔一阵留痕：稳定态不该刷屏。
        if (failures === 1 || failures % LOG_EVERY_N_FAILURES === 0) {
          log("面间通道轮询失败（第 " + failures + " 次，" + Math.round(backoff) + "ms 后重试）：" + errText(e));
        }
        await sleep(backoff, halt.signal);
        backoff = Math.min(backoff * 2, retryMax);
      }
    }
  }

  return {
    start(): void {
      if (running) return;
      if (halt.signal.aborted) halt = new AbortController();
      running = true;
      void loop();
    },
    stop(): void {
      running = false;
      halt.abort();
      if (inflight) { try { inflight.abort(); } catch { /* 已结束 */ } }
    },
    async publish(kind: ChannelKind, payload: unknown, to: FaceTarget = "others"): Promise<{ delivered: number }> {
      if (!isChannelKind(kind)) throw new Error("未知通道 kind：" + String(kind));
      const at = now();
      const value = normalizeChannelPayload(kind, payload);
      // 发射面自己也看得见自己的写入（不然它的下一读会拿到上一版，白等一次往返）。
      if (CHANNEL_NATURE[kind] === "state") applyState(kind, value, at, null);
      this.start();
      const res = (await io.post("dshana/faces/send", { card: scope, sub: subId, from: role, to, kind, payload: value, at })) as { delivered?: unknown } | null;
      const delivered = res && typeof res.delivered === "number" ? res.delivered : 0;
      if (delivered === 0) log("这条投递没有匹配的订阅面（to=" + String(to) + "，kind=" + kind + "）");
      return { delivered };
    },
    async read(kind: ChannelKind): Promise<{ value: unknown; at: number } | null> {
      if (!cache.has(kind) && typeof opts.seed === "function") {
        let pending = seeding.get(kind);
        if (!pending) {
          pending = Promise.resolve(opts.seed(kind))
            .then((rec) => {
              if (rec && rec.value && typeof rec.value === "object") {
                cache.set(kind, { value: normalizeChannelPayload(kind, rec.value), at: rec.at });
              }
            })
            .catch((e) => { log("首读种子失败（当没有当前值）：" + errText(e)); })
            .finally(() => { seeding.delete(kind); });
          seeding.set(kind, pending);
        }
        await pending;
      }
      const hit = cache.get(kind);
      return hit ? { value: hit.value, at: hit.at } : null;
    },
    onFrame(listener: (frame: FaceChannelFrame) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
