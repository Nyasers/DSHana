// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/mux-chunks.ts — 承载面分片信封（中继 ↔ 页面载体之间的私有约定）
//
// 为什么需要它：宿主对「App 受管服务」的 WebSocket 中继有一条 1 MiB 的**上游帧**上限
// （宿主侧实现：上游 ws 客户端 `{ maxPayload: 1024 * 1024 }`，超限即把下游连接
// `close(1011, "Managed service stopped")`）。DSH 的 mux 帧是原子 JSON，打开长会话时
// 首帧就是整段历史 snapshot，一帧就能超过 1 MiB —— 于是历史流永远打不开。
//
// 分片点必须在宿主**之前**：本 App 的运行时中继与页面载体正好夹在这条管子的两侧，
// 二者都是本仓库的代码，DSH 完全不知情（协议两端一行不改）。中继把超限的帧按尺寸切成
// 分片，载体在页面侧重组，重组完再交给 DSH 的解析器。
//
// 为什么还要回执：宿主除了单帧上限，还有一条「转发下一帧前若下游缓冲已超 1 MiB 就掐」
// 的守卫。所以只把帧切小不够——**发得快一样致命**，尤其远端访问时页面排空更慢。载体每收
// 一片回一次执，中继只在窗口内（见 MUX_CHUNK_WINDOW，明显小于宿主的 1 MiB）在途。
//
// 分片载荷按 **UTF-8 字节**切，接收端先拼字节再解码：切点落在多字节码点中间也不会坏
// （逐片解码才会）。分片是二进制帧，避免 base64/JSON 转义的体积膨胀。
//
// 本模块零依赖、只认 Uint8Array（浏览器与 Node 同构）：中继与载体共用同一份编解码。

/** 单片的载荷上限。宿主的上限是 1 MiB，取 128 KiB 留足余量。 */
export const MUX_CHUNK_BYTES = 128 * 1024;

/**
 * 在途未确认字节的上限（载荷口径）。宿主的下游缓冲守卫判的是**线上字节**且门槛是
 * `bufferedAmount > 1 MiB`，而一片 128 KiB 载荷在线上是 131,088 字节（10 字节帧头 +
 * 6 字节信封 + 载荷）：窗口拉满 1 MiB 就是 8 片 = 1,048,704 字节，光分片就越线，
 * 再叠一个 live 帧或一次 ping 当场 1011。故取 768 KiB（6 片 = 线上 786,528），
 * 给 live 帧与 ping 留 256 KiB。
 */
export const MUX_CHUNK_WINDOW = 768 * 1024;

/** 一片分片帧的固定开销（帧头 + 信封）——窗口按线上字节核算时用得上。 */
export const MUX_CHUNK_FRAME_OVERHEAD = 16;

/** 分片/回执帧的魔数（"HNK1"）：只用来把自己造的二进制帧与别的二进制流量区分开。 */
export const MUX_CHUNK_MAGIC = [0x48, 0x4e, 0x4b, 0x31] as const;

/** 分片帧：magic(4) + kind(1)=CHUNK + last(1) + payload。 */
export const MUX_CHUNK_KIND_CHUNK = 1;
/** 回执帧：magic(4) + kind(1)=ACK + u32BE(本次确认的分片载荷字节数)。 */
export const MUX_CHUNK_KIND_ACK = 2;

/** 分片能力的开关（页面在 mux URL 上声明；中继只在看到它时才启用分片）。 */
export const MUX_CHUNK_QUERY = "dshanaMuxChunks";
export const MUX_CHUNK_QUERY_VALUE = "1";

/**
 * 闸门票面（页面在 mux URL 上声明；中继取走后不上上游 DSH）。
 * 页面带上「钉住的会话 + 对应的宿主任务」，中继据此只让活跃任务的流建起来，
 * 任务失活即拒建并断开活流（执行侧见 src/runtime/bridge.ts 的闸门段）。
 */
export const MUX_GATE_SID_QUERY = "dshanaSid";
export const MUX_GATE_TASK_QUERY = "dshanaTask";

const MAGIC_LEN = MUX_CHUNK_MAGIC.length;
const CHUNK_HEADER_LEN = MAGIC_LEN + 2;
const ACK_LEN = MAGIC_LEN + 1 + 4;

/** 一帧二进制数据是否是我们造的分片/回执帧（只看魔数）。 */
export function isMuxControlFrame(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC_LEN + 1) return false;
  for (let i = 0; i < MAGIC_LEN; i += 1) if (bytes[i] !== MUX_CHUNK_MAGIC[i]) return false;
  return true;
}

/** 分片帧（last=true 表示这条消息的最后一片）。 */
export function encodeChunk(payload: Uint8Array, last: boolean): Uint8Array {
  const out = new Uint8Array(CHUNK_HEADER_LEN + payload.length);
  out.set(MUX_CHUNK_MAGIC, 0);
  out[MAGIC_LEN] = MUX_CHUNK_KIND_CHUNK;
  out[MAGIC_LEN + 1] = last ? 1 : 0;
  out.set(payload, CHUNK_HEADER_LEN);
  return out;
}

/** 回执帧：确认已收下的分片载荷字节数（中继据此放行后续分片）。 */
export function encodeAck(bytes: number): Uint8Array {
  const out = new Uint8Array(ACK_LEN);
  out.set(MUX_CHUNK_MAGIC, 0);
  out[MAGIC_LEN] = MUX_CHUNK_KIND_ACK;
  new DataView(out.buffer).setUint32(MAGIC_LEN + 1, bytes >>> 0);
  return out;
}

/** 解一帧我们造的控制帧；不是控制帧或长度不合返回 null。 */
export function decodeMuxControlFrame(
  bytes: Uint8Array,
): { kind: "chunk"; last: boolean; payload: Uint8Array } | { kind: "ack"; bytes: number } | null {
  if (!isMuxControlFrame(bytes)) return null;
  const kind = bytes[MAGIC_LEN];
  if (kind === MUX_CHUNK_KIND_CHUNK) {
    if (bytes.length < CHUNK_HEADER_LEN) return null;
    return { kind: "chunk", last: bytes[MAGIC_LEN + 1] === 1, payload: bytes.subarray(CHUNK_HEADER_LEN) };
  }
  if (kind === MUX_CHUNK_KIND_ACK) {
    if (bytes.length < ACK_LEN) return null;
    return { kind: "ack", bytes: new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC_LEN + 1) };
  }
  return null;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

export function encodeUtf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/** 按上限切字节（切点可在码点中间——接收端先拼字节再解码）。limit<=0 视作单段。 */
export function sliceBytes(bytes: Uint8Array, limit: number = MUX_CHUNK_BYTES): Uint8Array[] {
  if (!Number.isFinite(limit) || limit <= 0 || bytes.length <= limit) return [bytes];
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += limit) parts.push(bytes.subarray(at, Math.min(at + limit, bytes.length)));
  return parts;
}

/** 一条超出上限的文本消息 → 分片序列（最后一片带 last）。 */
export function splitTextMessage(text: string, limit: number = MUX_CHUNK_BYTES): Uint8Array[] {
  const payloads = sliceBytes(encodeUtf8(text), limit);
  return payloads.map((payload, i) => encodeChunk(payload, i === payloads.length - 1));
}

/** 页面侧重组：逐片喂入，收齐最后一片时交出完整文本；未收齐返回 null。 */
export class ChunkAssembler {
  #parts: Uint8Array[] = [];
  #bytes = 0;

  get pending(): number {
    return this.#bytes;
  }

  /** 喂一片；返回完整字节（交调用方解码）或 null。 */
  push(payload: Uint8Array, last: boolean): Uint8Array | null {
    this.#parts.push(payload);
    this.#bytes += payload.length;
    if (!last) return null;
    const out = new Uint8Array(this.#bytes);
    let at = 0;
    for (const part of this.#parts) { out.set(part, at); at += part.length; }
    this.reset();
    return out;
  }

  reset(): void {
    this.#parts = [];
    this.#bytes = 0;
  }
}

/**
 * 中继侧在途窗口：只在已确认字节数低于上限时放行下一片。
 * 上限必须明显小于宿主的 1 MiB 下游缓冲守卫，给 live 帧与主题推送留余量。
 */
export class ChunkWindow {
  #limit: number;
  #outstanding = 0;
  #waiters: Array<() => void> = [];
  #closed = false;

  constructor(limit: number = MUX_CHUNK_WINDOW) {
    this.#limit = limit;
  }

  get outstanding(): number {
    return this.#outstanding;
  }

  /** 还能放行的字节数（下限 0）。 */
  get room(): number {
    return Math.max(0, this.#limit - this.#outstanding);
  }

  /** 记账一片；调用方应先 await waitForRoom(bytes)。 */
  reserve(bytes: number): void {
    this.#outstanding += bytes;
  }

  /** 收到回执：冲减在途并使等待者重新评估。 */
  ack(bytes: number): void {
    this.#outstanding = Math.max(0, this.#outstanding - Math.max(0, bytes));
    const wake = this.#waiters;
    this.#waiters = [];
    for (const fn of wake) fn();
  }

  /** 等到有 bytes 的额度为止（关窗时立即返回，由调用方按已关闭收场）。 */
  waitForRoom(bytes: number): Promise<void> {
    if (this.#closed || this.room >= bytes) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#waiters.push(resolve); });
  }

  close(): void {
    this.#closed = true;
    const wake = this.#waiters;
    this.#waiters = [];
    for (const fn of wake) fn();
  }
}
