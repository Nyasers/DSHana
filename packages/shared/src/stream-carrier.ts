// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/stream-carrier.ts — 远端流载体协议（两侧共用）
//
// 为什么需要它：内核的远端流原本只有 /api/remote.mux 那条 WebSocket 承载，WS 在宿主侧有 1 MiB
// 上游帧上限，还得靠中继切片搬运。本协议把这条腿换成宿主接口：页面用 NDJSON over HTTP 打中继
// 的 /_stream/* 路，中继在受管 runtime 进程内直驱 ctx.typertGateway.wireStream，不经 DSH 端口。
//
// 帧与 DSH 自己的 mux 协议同形但不共享代码：那一头的两端都是上游实现，这一头的两端都是我们。
// 分片编码（mux-chunks.ts）不在这条路上用：NDJSON 的每行各自独立，没有帧上限可撞。
//
// 路径：
//   POST <前缀>/open   { streamId, endpoint, payload } → 200 application/x-ndjson（下行流）
//   POST <前缀>/item   { streamId, value }             → 204（上行项）
//   POST <前缀>/end    { streamId }                    → 204（上行半关）
//   POST <前缀>/cancel { streamId }                    → 204（取消逻辑流）
//
// 下行帧：
//   { type: "item",  value }
//   { type: "end" }
//   { type: "error", error: { code, message, details } }

/** 载体路径前缀（中继按它分流，不转发给 DSH）。 */
export const STREAM_PATH_PREFIX = "/_stream";

/** 开一条逻辑流的路径。 */
export const STREAM_PATH_OPEN = STREAM_PATH_PREFIX + "/open";
/** 上行一项的路径。 */
export const STREAM_PATH_ITEM = STREAM_PATH_PREFIX + "/item";
/** 上行半关的路径。 */
export const STREAM_PATH_END = STREAM_PATH_PREFIX + "/end";
/** 取消一条逻辑流的路径。 */
export const STREAM_PATH_CANCEL = STREAM_PATH_PREFIX + "/cancel";

/** 一条远端流允许同时开着几条（与内核 mux 的量级一致）。 */
export const STREAM_MAX_INFLIGHT = 128;

/** 下行帧：一条流的值。 */
export interface StreamItemFrame {
  type: "item";
  value: unknown;
}
/** 下行帧：流正常收尾。 */
export interface StreamEndFrame {
  type: "end";
}
/** 下行帧：流以宿主交付的逻辑失败收场。 */
export interface StreamErrorFrame {
  type: "error";
  error: { code: string; message: string; details: object };
}
/** 下行帧联合。 */
export type StreamDownlinkFrame = StreamItemFrame | StreamEndFrame | StreamErrorFrame;

/** 一帧下行帧编成一行 NDJSON（带换行）。 */
export function encodeStreamFrame(frame: StreamDownlinkFrame): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * 解一行下行帧。
 * @returns 解析成功的帧；空行/非对象/无 type 时 null（按协议忽略）
 */
export function parseStreamFrame(line: string): StreamDownlinkFrame | null {
  const text = String(line || "").trim();
  if (!text) return null;
  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const type = decoded.type;
  if (type === "item") return { type: "item", value: decoded.value };
  if (type === "end") return { type: "end" };
  if (type === "error") {
    const error = decoded.error && typeof decoded.error === "object" ? decoded.error : {};
    return {
      type: "error",
      error: {
        code: typeof error.code === "string" && error.code ? error.code : "gateway/internal",
        message: typeof error.message === "string" && error.message ? error.message : "DSH remote stream failed",
        details: error.details && typeof error.details === "object" ? error.details : {},
      },
    };
  }
  return null;
}

/**
 * 按换行切成完整行；返回剩下的残段。
 * @param buffer - 已累积的文本
 * @returns { lines, rest }
 */
export function splitNdjsonLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let at = buffer.indexOf("\n");
  let rest = buffer;
  while (at >= 0) {
    lines.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
    at = rest.indexOf("\n");
  }
  return { lines, rest };
}
