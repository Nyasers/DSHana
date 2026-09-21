// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/mux-relay.ts — 中继的 WS 帧搬运（分片模式）
//
// 只在页面声明支持分片时启用（见 lib/mux-chunks.ts 的 MUX_CHUNK_QUERY）；未声明的连接走
// bridge.ts 的原始 socket 双向透传，两侧各自成立。
//
// 为什么要搬运帧：宿主对 App 受管服务的 WS 中继有 1 MiB 上游帧上限，超限即
// close(1011, "Managed service stopped")。DSH 的 mux 帧是原子 JSON，长会话的首帧就是
// 整段历史 snapshot，一帧就能超。分片点必须在宿主**之前**，本中继正是那个位置。
//
// 帧搬运纪律（只认头；未改动的帧原样转发，改动过的帧才按本模块规则重写）：
//   · 上游（DSH）→ 客户端（宿主）：控制帧（ping/pong/close）**立即原样转发**，绝不排在
//     大消息后面——DSH 的 mux 会 ping，宿主的 ws 客户端负责自动 pong，卡住会把连接 ping 死。
//     数据消息按 FIN 组装成完整消息：不超过上限原样转发，超过上限切成二进制分片帧，
//     按在途窗口放行（等载体回执），避免撞宿主那条「下游缓冲超 1 MiB 就掐」的守卫。
//   · 客户端 → 上游：小二进制帧解掩码后若是本模块的控制帧（回执）就地吃掉、不进 DSH；
//     其余帧原样转发（掩码原样保留，收端自己解）。
//
// 握手也归本模块：上游 101 响应头原样回写客户端，之后才进入帧模式（响应头里可能夹带
// 首帧字节，按剩余量交给帧解析）。
//
// 上游侧不掩码（它是 ws 服务端）；本中继发给客户端的方向同样不掩码（我们对宿主是服务端）。
import { ChunkWindow, MUX_CHUNK_BYTES, decodeMuxControlFrame, encodeChunk, sliceBytes } from "#/lib/mux-chunks.ts";
import { OPCODE, framePayload, readFrameHeader, serializeFrame, type WsFrameHeader } from "#/lib/ws-frames.ts";

const OP_CONTINUATION = OPCODE.CONTINUATION;
const OP_TEXT = OPCODE.TEXT;
const OP_BINARY = OPCODE.BINARY;
const OP_CLOSE = OPCODE.CLOSE;

/** 需要解掩码检查控制帧的最大长度（回执帧只有 9 字节；留一点余量）。 */
const CONTROL_PROBE_BYTES = 32;
/** 客户端 → 上游单帧的缓冲上限：mux 请求都是小帧，超过即视为协议异常。 */
const CLIENT_FRAME_MAX = 4 * 1024 * 1024;
/** 上游握手响应头的长度上限（防对端不回响应头时无限攒缓冲）。 */
const HANDSHAKE_MAX = 16 * 1024;
/** 属于正常收尾的断开原因（不刷日志）。 */
const NORMAL_END = new Set(["client close", "upstream close"]);

type FrameHeader = WsFrameHeader;

interface CompleteMessage {
  opcode: number;
  parts: Buffer[];
  bytes: number;
  /** 单帧且未掩码时的整帧原文（优先原样转发，保持字节级不变）。 */
  raw: Buffer | null;
}

/** 把掩码帧的载荷解出来（只用于小帧的控制帧探针）。 */
function unmaskPayload(frame: FrameHeader, raw: Buffer): Buffer {
  return framePayload(frame, raw);
}

export interface MuxRelayOptions {
  clientSocket: any;
  upstreamSocket: any;
  log?: (s: string) => void;
}

/**
 * 接管一条已建立的 WS 连接：先原样回写上游握手响应头，再进入帧搬运。
 * 调用方（bridge.ts）负责把升级请求写给上游（含升级请求里带过来的 head 字节），
 * 此后本对象独占两个 socket 的读写。
 */
export function startFrameRelay(opts: MuxRelayOptions): { dispose(): void } {
  const { clientSocket, upstreamSocket, log = () => {} } = opts;
  const window = new ChunkWindow();
  let disposed = false;

  let handshakeDone = false;
  let handshake: Buffer = Buffer.alloc(0);
  let upstreamBuffer: Buffer = Buffer.alloc(0);

  // 正在组装的数据消息 + 待切分的完整消息队列（控制帧不走队列，立即转发）
  let messageOpcode: number | null = null;
  let messageParts: Buffer[] = [];
  let messageBytes = 0;
  let wholeFrame: Buffer | null = null;
  const pending: CompleteMessage[] = [];
  let draining = false;

  const finish = (why = "unknown") => {
    if (disposed) return;
    disposed = true;
    // 正常收尾（任一侧断开）不必刷日志；只记值得追的异常收场。
    if (!NORMAL_END.has(why)) log(`mux-relay: 异常收场（${why}）`);
    window.close();
    try { upstreamSocket.destroy(); } catch { /* 已断 */ }
    try { clientSocket.destroy(); } catch { /* 已断 */ }
  };

  const writeClient = (bytes: Buffer): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (clientSocket.write(bytes)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { clientSocket.off?.("drain", done); resolve(); };
      clientSocket.once?.("drain", done);
    });
  };

  /** 切分一条完整消息：小则单帧转发，大则按窗口分片。 */
  const emitMessage = async (message: CompleteMessage): Promise<void> => {
    if (disposed) return;
    if (message.bytes <= MUX_CHUNK_BYTES) {
      await writeClient(message.raw ?? serializeFrame(message.opcode, Buffer.concat(message.parts)));
      return;
    }
    const body = Buffer.concat(message.parts);
    const chunks = sliceBytes(new Uint8Array(body.buffer, body.byteOffset, body.length), MUX_CHUNK_BYTES);
    log(`mux-relay: 上游消息 ${message.bytes} B → ${chunks.length} 片（单片上限 ${MUX_CHUNK_BYTES} B）`);
    for (let i = 0; i < chunks.length; i += 1) {
      if (disposed) return;
      const chunk = chunks[i];
      await window.waitForRoom(chunk.length);
      if (disposed) return;
      window.reserve(chunk.length);
      await writeClient(serializeFrame(OP_BINARY, encodeChunk(chunk, i === chunks.length - 1)));
    }
  };

  /** 队列消费：一次只跑一个，保证同一条消息的分片连续发出。 */
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (!disposed && pending.length > 0) await emitMessage(pending.shift() as CompleteMessage);
    } finally {
      draining = false;
    }
  };

  /** 同步解析上游帧：控制帧立即转发，数据消息入队。 */
  const consumeUpstream = (): void => {
    for (;;) {
      if (disposed) return;
      const frame = readFrameHeader(upstreamBuffer);
      if (frame === null || upstreamBuffer.length < frame.totalLength) return;
      const raw = upstreamBuffer.subarray(0, frame.totalLength);
      upstreamBuffer = upstreamBuffer.subarray(frame.totalLength);

      if (frame.opcode >= OP_CLOSE) {
        writeClient(Buffer.from(raw)).catch(() => { finish("回写控制帧失败"); });
        if (frame.opcode === OP_CLOSE) { finish("上游发来 close"); return; }
        continue;
      }
      if (frame.opcode === OP_CONTINUATION) {
        if (messageOpcode === null) continue; // 无起始帧的续帧：丢弃，不拼错流
        messageParts.push(Buffer.from(raw.subarray(frame.headerLength)));
        messageBytes += frame.payloadLength;
        wholeFrame = null;
      } else {
        if (messageOpcode !== null) { messageOpcode = null; messageParts = []; messageBytes = 0; wholeFrame = null; }
        messageOpcode = frame.opcode;
        messageParts = [Buffer.from(raw.subarray(frame.headerLength))];
        messageBytes = frame.payloadLength;
        wholeFrame = frame.fin && !frame.masked ? Buffer.from(raw) : null;
      }
      if (frame.fin) {
        pending.push({ opcode: messageOpcode, parts: messageParts, bytes: messageBytes, raw: wholeFrame });
        messageOpcode = null;
        messageParts = [];
        messageBytes = 0;
        wholeFrame = null;
        void drain();
      }
    }
  };

  /** 客户端 → 上游：回执就地吃掉，其余原样转发（同步，保证顺序）。 */
  let clientBuffer: Buffer = Buffer.alloc(0);
  const consumeClient = (): void => {
    for (;;) {
      if (disposed) return;
      const frame = readFrameHeader(clientBuffer);
      if (frame === null || clientBuffer.length < frame.totalLength) return;
      const raw = clientBuffer.subarray(0, frame.totalLength);
      clientBuffer = clientBuffer.subarray(frame.totalLength);
      if (frame.payloadLength > CLIENT_FRAME_MAX) { finish("客户端帧过大"); return; }

      if (frame.opcode === OP_BINARY && frame.payloadLength <= CONTROL_PROBE_BYTES) {
        const control = decodeMuxControlFrame(new Uint8Array(unmaskPayload(frame, raw)));
        if (control?.kind === "ack") { window.ack(control.bytes); continue; }
        if (control?.kind === "chunk") continue; // 页面不该发分片：静默丢弃，不进 DSH
      }
      try { upstreamSocket.write(raw); } catch { finish("写上游失败"); return; }
    }
  };

  /** 上游 → 客户端：先原样回写握手响应头，之后交给帧解析。 */
  const consumeHandshake = (): void => {
    const end = handshake.indexOf("\r\n\r\n");
    if (end < 0) {
      if (handshake.length > HANDSHAKE_MAX) { finish("握手响应头过长"); return; }
      return;
    }
    // 只回写响应头本身：紧随其后的首帧字节属于帧流（早先把它一并写出去会重复投递）。
    const head = handshake.subarray(0, end + 4);
    const rest = handshake.subarray(end + 4);
    handshake = Buffer.alloc(0);
    void writeClient(Buffer.from(head)).then(() => {
      if (disposed) return;
      handshakeDone = true;
      if (rest.length > 0) {
        upstreamBuffer = Buffer.concat([upstreamBuffer, Buffer.from(rest)]);
        consumeUpstream();
      }
    });
  };

  upstreamSocket.on("data", (data: Buffer) => {
    if (disposed) return;
    if (!handshakeDone) {
      handshake = Buffer.concat([handshake, data]);
      consumeHandshake();
      return;
    }
    upstreamBuffer = Buffer.concat([upstreamBuffer, data]);
    consumeUpstream();
  });
  clientSocket.on("data", (data: Buffer) => {
    if (disposed) return;
    clientBuffer = Buffer.concat([clientBuffer, data]);
    consumeClient();
  });
  for (const [socket, label] of [[clientSocket, "client"], [upstreamSocket, "upstream"]]) {
    socket.on("error", (e) => finish(`${label} error ${e?.message ?? ""}`));
    socket.on("close", () => finish(`${label} close`));
  }
  consumeClient();

  return { dispose: finish };
}
