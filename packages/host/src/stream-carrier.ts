// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/host/src/stream-carrier.ts — 远端流载体（受管 runtime 进程内，不经 WebSocket）
//
// 为什么存在：内核的远端流原本只有 /api/remote.mux 那条 WebSocket 承载（api-gateway 的
// RemoteStreamMuxServer）。WS 那条腿在宿主侧有 1 MiB 上游帧上限，还得靠中继把超限帧切片搬运。
// 本模块把它换成宿主接口：在同一进程内直接调 ctx.typertGateway.wireStream.open（上游注释写明
// 它服务「WebSocket mux 与本地宿主传输」），用 NDJSON 承载逻辑流的帧。
//
// 协议（本模块自定，与 DSH 的 mux 协议同形但独立；页面侧对应 packages/ui/src/stream-carrier.ts）：
//   POST <前缀>/open   { streamId, endpoint, payload }
//     → 200 application/x-ndjson，逐行 { type:"item", value }
//                                     | { type:"end" }
//                                     | { type:"error", error:{ code, message, details } }
//   POST <前缀>/item   { streamId, value }  → 204（上行项）
//   POST <前缀>/end    { streamId }         → 204（上行半关）
//   POST <前缀>/cancel { streamId }         → 204（取消逻辑流，含断连兜底）
//
// 上行单开端点：浏览器侧的请求体在宿主代理里不保证是流式的，而上行项本来就稀疏（多数流只有
// 下行）。取消与上行都是小 JSON，各自一个 POST 比维持一条长连接稳。
//
// 流 ID 由页面铸（与页面的 mux 历史命名一致），载体按它索引在途流；重复 open 是协议错误。

import {
  STREAM_PATH_CANCEL,
  STREAM_PATH_END,
  STREAM_PATH_ITEM,
  STREAM_PATH_OPEN,
  encodeStreamFrame,
} from "@dshana/shared/stream-carrier.ts";

/** 单条控制请求（open 之外）的体积上限：上行项本身可以大，但走的是同一条小 JSON 通道。 */
const CONTROL_BODY_MAX_BYTES = 8 * 1024 * 1024;

/** 一条逻辑流允许积压的上行字节数（超了给页面一个明确失败，不无限攒内存）。 */
const UPLINK_INBOX_BYTES = 4 * 1024 * 1024;

/** 有界单消费者上行队列：页面推过来的项，内核按 AsyncIterable 读。 */
class UplinkInbox implements AsyncIterable<unknown> {
  private readonly maxBytes: number;
  private readonly onOverflow: (error: Error) => void;
  private queue: unknown[] = [];
  private bytes = 0;
  private ended = false;
  private closed = false;
  private taken = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(maxBytes: number, onOverflow: (error: Error) => void) {
    this.maxBytes = maxBytes;
    this.onOverflow = onOverflow;
  }

  push(value: unknown): void {
    if (this.failure !== undefined || this.closed) return;
    if (this.ended) {
      this.fail(new Error("远端流上行项出现在半关之后"));
      return;
    }
    const size = Buffer.byteLength(JSON.stringify(value === undefined ? null : value) ?? "", "utf8");
    if (this.bytes + size > this.maxBytes) {
      this.fail(new Error("远端流上行超出积压上限（" + String(this.maxBytes) + " 字节）"));
      return;
    }
    this.queue.push(value);
    this.bytes += size;
    this.signal();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.signal();
  }

  fail(error: Error): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.queue = [];
    this.bytes = 0;
    this.signal();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.taken) throw new Error("远端流上行队列只允许一个消费者");
    this.taken = true;
    return {
      next: () => this.next(),
      return: () => this.return(),
    };
  }

  private async next(): Promise<IteratorResult<unknown>> {
    for (;;) {
      if (this.closed) return { value: undefined, done: true };
      if (this.queue.length > 0) {
        const value = this.queue.shift();
        return { value, done: false };
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.ended) return { value: undefined, done: true };
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  private async return(): Promise<IteratorResult<unknown>> {
    this.closed = true;
    this.queue = [];
    this.bytes = 0;
    this.signal();
    return { value: undefined, done: true };
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/** 一条在途逻辑流。 */
interface ActiveStream {
  readonly control: AbortController;
  readonly inbox: UplinkInbox;
  /** 下行是否已收场（收场后再到的上行帧按已结束丢弃）。 */
  settled: boolean;
}

/** 载体依赖：注入内核的 wireStream 面，便于单测喂假实现。 */
export interface DshStreamCarrierDeps {
  /** ctx.typertGateway.wireStream.open：peer 传 undefined 表示操作者的进程内载体。 */
  open: (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: undefined, signal: AbortSignal) => Promise<AsyncIterable<unknown>>;
  /** ctx.typertGateway.wireStream.failure：把异常折成稳定的线字段。 */
  failure: (error: unknown) => { code: string; message: string; details: object };
  log?: (message: string) => void;
}

/** 远端流载体。 */
export interface DshStreamCarrier {
  /** 这个路径是否属于本载体（中继据此分流）。 */
  owns(pathname: string): boolean;
  /** 处理一个已鉴权的请求；不是本载体的路径返回 false。 */
  handle(req: any, res: any, pathname?: string): Promise<boolean>;
  /** 关停：取消全部在途流。 */
  close(): void;
  /** 在途流条数（诊断/测试用）。 */
  readonly active: number;
}

/** 读一个小 JSON 请求体（超过上限即拒）。 */
async function readJsonBody(req: any, maxBytes: number): Promise<any> {
  const chunks: any[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("远端流控制请求过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 回一个 JSON 错误（未发头时）。 */
function rejectJson(res: any, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/** 写一段并等背压（响应已断则直接返回）。 */
function writeChunk(res: any, text: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve();
  if (res.write(text)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * 造一个远端流载体。
 * @param deps - 内核的 wireStream 面与日志出口
 */
export function createStreamCarrier(deps: DshStreamCarrierDeps): DshStreamCarrier {
  const { open, failure, log = () => {} } = deps;
  if (typeof open !== "function" || typeof failure !== "function") {
    throw new Error("stream-carrier：需要 typertGateway.wireStream 的 open 与 failure");
  }
  const streams = new Map<string, ActiveStream>();

  /** 取一条在途流；不在表里返回 undefined（已收场的流上到达的帧按协议丢弃）。 */
  const get = (streamId: unknown): ActiveStream | undefined =>
    typeof streamId === "string" && streams.has(streamId) ? streams.get(streamId) : undefined;

  /** 一条流的收场：摘表 + 让内核侧停止读上行。 */
  const settle = (streamId: string, stream: ActiveStream, reason: Error): void => {
    stream.settled = true;
    streams.delete(streamId);
    stream.inbox.fail(reason);
  };

  async function handleOpen(req: any, res: any): Promise<void> {
    let body;
    try {
      body = await readJsonBody(req, CONTROL_BODY_MAX_BYTES);
    } catch (e) {
      rejectJson(res, 400, e instanceof Error ? e.message : String(e));
      return;
    }
    const streamId = body && typeof body.streamId === "string" ? body.streamId : "";
    const endpoint = body && typeof body.endpoint === "string" ? body.endpoint : "";
    if (!streamId) {
      rejectJson(res, 400, "远端流需要一个非空 streamId");
      return;
    }
    if (!endpoint) {
      rejectJson(res, 400, "远端流需要一个非空 endpoint");
      return;
    }
    if (streams.has(streamId)) {
      rejectJson(res, 409, "远端流 id 重复：" + streamId);
      return;
    }
    const control = new AbortController();
    // 上行队列先建：内核 open 期间页面就能推项，不丢。
    const stream: ActiveStream = { control, inbox: new UplinkInbox(UPLINK_INBOX_BYTES, (error) => control.abort(error)), settled: false };
    streams.set(streamId, stream);

    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    // 立刻把响应头刷出去：页面侧的 fetch 在拿到响应头时才认为流开了，而第一帧可能要等很久
    // （订阅一条安静的事件流就是这样）。不刷的话页面看起来像「流开不出来」。
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // 客户端断开（页面关窗、切面、载体换代）就是取消这条逻辑流：先中止信号，再把上行队列收掉，
    // 否则内核侧卡在读 uplink 上就永远不会结束（那条流会把响应挂到底）。
    res.on("close", () => {
      if (res.writableEnded || control.signal.aborted) return;
      const reason = new Error("远端流载体断开");
      control.abort(reason);
      settle(streamId, stream, reason);
    });

    let source;
    try {
      source = await open(endpoint, body.payload === undefined ? null : body.payload, stream.inbox, undefined, control.signal);
    } catch (e) {
      if (!control.signal.aborted) {
        await writeChunk(res, encodeStreamFrame({ type: "error", error: failure(e) }));
      }
      settle(streamId, stream, new Error("远端流打开失败"));
      if (!res.writableEnded) res.end();
      return;
    }
    try {
      for await (const value of source) {
        if (control.signal.aborted) break;
        await writeChunk(res, encodeStreamFrame({ type: "item", value }));
      }
      if (!control.signal.aborted) await writeChunk(res, encodeStreamFrame({ type: "end" }));
    } catch (e) {
      if (!control.signal.aborted) {
        await writeChunk(res, encodeStreamFrame({ type: "error", error: failure(e) }));
      }
    } finally {
      settle(streamId, stream, new Error("远端流已收场"));
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }

  async function handleControl(req: any, res: any, kind: "item" | "end" | "cancel"): Promise<void> {
    let body;
    try {
      body = await readJsonBody(req, CONTROL_BODY_MAX_BYTES);
    } catch (e) {
      rejectJson(res, 400, e instanceof Error ? e.message : String(e));
      return;
    }
    const stream = get(body && body.streamId);
    res.writeHead(204);
    res.end();
    if (!stream) return;
    if (kind === "item") stream.inbox.push(body.value);
    else if (kind === "end") stream.inbox.end();
    else {
      // 取消：中止信号 + 收掉上行队列（内核侧可能正卡在读 uplink 上）。
      const reason = new Error("远端流被取消");
      stream.control.abort(reason);
      settle(String(body.streamId), stream, reason);
    }
  }

  return {
    owns(pathname: string): boolean {
      return pathname === STREAM_PATH_OPEN || pathname === STREAM_PATH_ITEM
        || pathname === STREAM_PATH_END || pathname === STREAM_PATH_CANCEL;
    },
    async handle(req: any, res: any, pathname?: string): Promise<boolean> {
      // pathname 由调用方给：中继在鉴权时已经剥掉 `/_hana/<key>/` 前缀，而 req.url 上还带着它，
      // 从 req.url 重新解析会把自身路径认成不归本载体管，于是既不分流也不回响应。
      const path = pathname ?? new URL(req.url || "/", "http://stream.invalid").pathname;
      if (!this.owns(path)) return false;
      if (req.method !== "POST") {
        rejectJson(res, 405, "远端流载体只接受 POST");
        return true;
      }
      if (path === STREAM_PATH_OPEN) await handleOpen(req, res);
      else if (path === STREAM_PATH_ITEM) await handleControl(req, res, "item");
      else if (path === STREAM_PATH_END) await handleControl(req, res, "end");
      else await handleControl(req, res, "cancel");
      return true;
    },
    close(): void {
      const pending = [...streams.entries()];
      streams.clear();
      for (const [streamId, stream] of pending) {
        stream.settled = true;
        stream.inbox.fail(new Error("远端流载体关停"));
        stream.control.abort(new Error("远端流载体关停"));
        log("stream-carrier：关停时取消在途流 " + streamId);
      }
    },
    get active(): number {
      return streams.size;
    },
  };
}
