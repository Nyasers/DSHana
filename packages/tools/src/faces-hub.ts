// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/tools/src/faces-hub.ts — 面间直投通道的服务端半（App 进程内的中介）
//
// 协议（地址、帧、寻址、词表）住在 packages/shared/src/faces-channel.ts，这里只做中介：接一条
// 指名投递、按寻址扇出、给晚到的订阅面一份 state 快照、把 state 类 kind 镜像进权威记录。
//
// 为什么中介者在 App 进程内：宿主没给「面→面」的一等原语（见 faces-channel.ts 头注释），而本 App 的
// route handler 就在 App 进程内执行、又能读 ctx.storage.global，所以中介者只能是它。
//
// 传输是**长轮询**（poll 挂起直到有帧或超时），不是流式响应：不赌宿主中间层对流式响应是否缓冲、
// 是否被超时掐断；`since` 语义天然把重连做对（断了就带同一个 since 再挂一次，环形缓冲内不丢帧）。
//
// 三条纪律，错一条就退化成「共享空间 + 各自判」：
//   · **指名**：帧只投给命中的面（面地址或扇出）；`others` 排除的是发射的那份文档（按 sub），
//     不是整个角色——同角色的第二份文档照样收得到；
//   · **不回放**：首挂（since=0）只给 state 快照，不给历史帧，重开一面不得把旧命令重放一遍；
//   · **单写者**：state 类 kind 的权威记录由这里写（页面不再直写键），冷启动从记录把当前值读回。
import {
  CHANNEL_KINDS,
  CHANNEL_NATURE,
  channelRecordKey,
  frameMatches,
  type ChannelFrame,
  type ChannelKind,
  type ChannelPollRequest,
  type ChannelPollResult,
  type ChannelSendRequest,
  type FaceAddress,
  type FaceTarget,
} from "@dshana/shared/faces-channel.ts";

/** 一次 poll 的挂起上限（毫秒）：远小于常见代理超时，超时就当心跳应答、客户端立刻再挂。 */
export const FACES_PARK_MS = 20000;
/** 每作用域的帧环形缓冲：重连重放的窗口。 */
export const FACES_RING_SIZE = 256;
/** 订阅面存活期：两倍挂起上限留余量（挂起中不会被淘汰，掉线的会被下一轮淘汰）。 */
export const FACES_SUBSCRIBER_TTL_MS = 45000;

/** 存下来的帧多带一个发射文档的 sub（寻址要用，发给订阅面时剥掉）。 */
type StoredFrame = ChannelFrame & { fromSub: string };

interface StateEntry {
  value: unknown;
  at: number;
}

interface Subscriber {
  sub: string;
  as: FaceAddress;
  lastSeen: number;
}

interface Waiter {
  recheck: () => void;
}

interface Scope {
  card: string;
  seq: number;
  frames: StoredFrame[];
  state: Map<ChannelKind, StateEntry>;
  seeded: Promise<void> | null;
  subscribers: Map<string, Subscriber>;
  waiters: Set<Waiter>;
}

/** 一次 send 的回执：delivered 是真的会被投到的面数（0 = 当前没有匹配的订阅面）。 */
export interface FacesSendResult {
  ok: true;
  seq: number;
  delivered: number;
  to: FaceTarget;
}

export interface FacesHub {
  send(req: ChannelSendRequest): Promise<FacesSendResult>;
  poll(req: ChannelPollRequest): Promise<ChannelPollResult>;
  /** 诊断面：作用域、序号、缓冲深度、订阅面数与挂起数。 */
  stats(): Array<{ card: string; seq: number; frames: number; subscribers: number; waiting: number }>;
}

export interface FacesHubOptions {
  now?: () => number;
  parkMs?: number;
  ringSize?: number;
  subscriberTtlMs?: number;
  /** 冷启动读 state 类 kind 的权威记录（`{ value, at }`；缺失/坏值当没有当前值）。 */
  readRecord?: (key: string) => Promise<unknown>;
  /** 写 state 类 kind 的权威记录（页面不再直写这张键）。 */
  writeRecord?: (key: string, value: unknown) => Promise<unknown>;
  log?: (msg: string) => void;
}

/** 取错误的可读文本（catch 到的值类型未知）。 */
function errText(e: unknown): string {
  return ((e as { message?: string })?.message as string) || String(e);
}

/** 建一台 hub。缺省 readRecord/writeRecord 时退化成纯内存（单测与无 ctx 场景够用）。 */
export function createFacesHub(opts: FacesHubOptions = {}): FacesHub {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const parkMs = Number(opts.parkMs) > 0 ? Number(opts.parkMs) : FACES_PARK_MS;
  const ringSize = Number(opts.ringSize) > 0 ? Number(opts.ringSize) : FACES_RING_SIZE;
  const ttlMs = Number(opts.subscriberTtlMs) > 0 ? Number(opts.subscriberTtlMs) : FACES_SUBSCRIBER_TTL_MS;
  const readRecord = typeof opts.readRecord === "function" ? opts.readRecord : null;
  const writeRecord = typeof opts.writeRecord === "function" ? opts.writeRecord : null;
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const scopes = new Map<string, Scope>();

  function scopeFor(card: string): Scope {
    let scope = scopes.get(card);
    if (!scope) {
      scope = { card, seq: 0, frames: [], state: new Map(), seeded: null, subscribers: new Map(), waiters: new Set() };
      scopes.set(card, scope);
    }
    return scope;
  }

  /** 冷启动：把 state 类 kind 的当前值从权威记录读回（一次；失败当没有当前值）。 */
  function seed(scope: Scope): Promise<void> {
    if (scope.seeded) return scope.seeded;
    scope.seeded = (async () => {
      if (!readRecord) return;
      for (const kind of CHANNEL_KINDS) {
        if (CHANNEL_NATURE[kind] !== "state" || scope.state.has(kind)) continue;
        try {
          const rec = (await readRecord(channelRecordKey(kind))) as { value?: unknown; at?: unknown } | null;
          const value = rec && typeof rec === "object" ? rec.value : null;
          // 没有记录 = 没有当前值：不进 state（订阅面据此知道「没人表过态」）。
          if (value && typeof value === "object") {
            scope.state.set(kind, { value, at: typeof rec?.at === "number" ? rec.at : 0 });
          }
        } catch (e) {
          log("冷启动读记录失败（当没有当前值）：" + errText(e));
        }
      }
    })();
    return scope.seeded;
  }

  /** 记一次心跳：订阅面的存活按它最后一次 poll 算。 */
  function touch(scope: Scope, sub: string, as: FaceAddress): void {
    const seen = scope.subscribers.get(sub);
    if (seen) { seen.lastSeen = now(); seen.as = as; return; }
    scope.subscribers.set(sub, { sub, as, lastSeen: now() });
  }

  /** 活着的订阅面（顺手淘汰过期的）。 */
  function live(scope: Scope): Subscriber[] {
    const deadline = now() - ttlMs;
    const out: Subscriber[] = [];
    for (const [sub, s] of scope.subscribers) {
      if (s.lastSeen < deadline) { scope.subscribers.delete(sub); continue; }
      out.push(s);
    }
    return out;
  }

  function frameFor(f: StoredFrame): ChannelFrame {
    return { seq: f.seq, at: f.at, from: f.from, to: f.to, kind: f.kind, payload: f.payload };
  }

  /**
   * 算一次应答。三条判定：
   *   · 首挂（fresh）：只给 state 快照 + 当前序号，不给历史帧——新挂上的面不被回放旧命令；
   *   · 客户端比服务端更新（since > seq，服务端半重启过）：reset，改以 state 重建；
   *   · 环形缓冲没兜住（since 早于缓冲下界）：reset，改以 state 重建。
   * 后两种都把 seq 带上，客户端据此把 since 对齐到当前值（不重放、不丢新帧）。
   */
  function buildPoll(scope: Scope, req: ChannelPollRequest): ChannelPollResult {
    const oldest = scope.frames.length ? scope.frames[0].seq : 0;
    const ahead = req.since > scope.seq;
    const dropped = !ahead && req.since > 0 && oldest > 0 && req.since < oldest - 1;
    const reset = ahead || dropped;
    const fresh = req.fresh;
    const frames = fresh || ahead
      ? []
      : scope.frames
        .filter((f) => f.seq > req.since && frameMatches(f.to, f.fromSub, { sub: req.sub, as: req.as }))
        .map(frameFor);
    const state: Record<string, StateEntry> = {};
    if (fresh || reset) for (const [kind, entry] of scope.state) state[kind] = entry;
    return {
      ok: true,
      seq: scope.seq,
      frames,
      ...(fresh || reset ? { state } : {}),
      ...(reset ? { reset: true } : {}),
    };
  }

  function wake(scope: Scope): void {
    for (const waiter of [...scope.waiters]) {
      try { waiter.recheck(); } catch { /* 单个挂起者出错不拖累别的 */ }
    }
  }

  async function send(req: ChannelSendRequest): Promise<FacesSendResult> {
    const scope = scopeFor(req.card);
    scope.seq += 1;
    const frame: StoredFrame = {
      seq: scope.seq, at: req.at, from: req.from, to: req.to, kind: req.kind, payload: req.payload, fromSub: req.sub,
    };
    scope.frames.push(frame);
    if (scope.frames.length > ringSize) scope.frames.splice(0, scope.frames.length - ringSize);
    if (CHANNEL_NATURE[req.kind] === "state") {
      scope.state.set(req.kind, { value: req.payload, at: req.at });
      if (writeRecord) {
        try {
          await writeRecord(channelRecordKey(req.kind), { value: req.payload, at: req.at });
        } catch (e) {
          // 投递已经发生，镜像失败不回滚：只留痕（记录落后一拍，页面读到的仍是上一次的当前值）。
          log("state 记录镜像写入失败（投递已发生）：" + errText(e));
        }
      }
    }
    const delivered = live(scope).filter((s) => frameMatches(req.to, req.sub, { sub: s.sub, as: s.as })).length;
    wake(scope);
    return { ok: true, seq: scope.seq, delivered, to: req.to };
  }

  async function poll(req: ChannelPollRequest): Promise<ChannelPollResult> {
    const scope = scopeFor(req.card);
    touch(scope, req.sub, req.as);
    await seed(scope);
    const immediate = buildPoll(scope, req);
    // 首挂/reset 当场应答（快照要到手，不该让新挂上的面干等一轮），其余没帧才挂起。
    if (req.fresh || immediate.frames.length > 0 || immediate.reset) return immediate;
    return await new Promise<ChannelPollResult>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        scope.waiters.delete(waiter);
        touch(scope, req.sub, req.as);
        resolve(buildPoll(scope, req));
      };
      const waiter: Waiter = {
        recheck: () => {
          const snapshot = buildPoll(scope, req);
          // 没轮到自己就继续挂着：别人的帧不该把这个挂起者叫醒。
          if (snapshot.frames.length > 0 || snapshot.reset) finish();
        },      };
      const timer = setTimeout(finish, parkMs);
      scope.waiters.add(waiter);
    });
  }

  return {
    send,
    poll,
    stats: () => [...scopes.values()].map((s) => ({
      card: s.card, seq: s.seq, frames: s.frames.length,
      subscribers: live(s).length, waiting: s.waiters.size,
    })),
  };
}

/**
 * 进程内的共享 hub。
 *
 * 必须是单例：route handler 一次请求一次调用，而挂起的 poll 与后来的 send 得落在同一个作用域上，
 * 各建一台就会「发出去没人被叫醒」。App 在 apply 期建 deps，但 apply 可能重来，所以按进程记忆。
 */
let sharedHub: FacesHub | null = null;

export function facesHubFor(opts: FacesHubOptions = {}): FacesHub {
  if (!sharedHub) sharedHub = createFacesHub(opts);
  return sharedHub;
}

/** 测试用：丢掉进程内单例。 */
export function resetFacesHub(): void {
  sharedHub = null;
}
