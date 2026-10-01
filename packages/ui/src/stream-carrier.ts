// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/stream-carrier.ts — 远端流载体（页面侧，NDJSON over HTTP）
//
// 为什么换成这条路：内核的远端流原本只有 /api/remote.mux 那条 WebSocket 承载（见
// packages/host/src/mux-relay.ts 与 packages/shared/src/mux-chunks.ts：宿主对受管服务的 WS
// 中继有 1 MiB 上游帧上限，超限帧要切片搬运）。本模块把这条腿换成宿主接口：一条流一个
// HTTP 请求，下行是 NDJSON 响应流，上行各自一个 POST。分片与回执不再需要，每行独立。
//
// 协议与路径见 packages/shared/src/stream-carrier.ts（两端共用）。
//
// 失败语义是跨 bundle 契约，与旧载体一字不变（别改）：DSH 的 normalizeConnectionStream 只看
// 结构标记不看 instanceof（页半与内核半是两份独立 bundle），标记挂在抛出的 Error 上：
//   · { kind: 'carrier' } = 物理载体丢失（请求开不出、响应流被截断）。DSH 侧按可重试处理，
//     连接代次仍在位时立刻重开一次。
//   · { kind: 'remote', code, details } = 宿主交付的逻辑失败，带域码与 details。

import {
  STREAM_MAX_INFLIGHT,
  STREAM_PATH_CANCEL,
  STREAM_PATH_END,
  STREAM_PATH_ITEM,
  STREAM_PATH_OPEN,
  parseStreamFrame,
  splitNdjsonLines,
} from "@dshana/shared/stream-carrier.ts";

/** 标记键名（DSH 侧固定读这个属性名，不是我们的私有约定）。 */
const STREAM_FAILURE = "dshRemoteStreamFailure";

/** 载体失败（物理链接丢失）：kind:'carrier'，DSH 侧按可重试的载体丢失处理。 */
export function carrierFailure(message: string, cause?: unknown): Error {
  const error: any = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.name = "DSHStreamCarrierError";
  error[STREAM_FAILURE] = { kind: "carrier" };
  return error;
}

/** 宿主交付的逻辑失败：kind:'remote' + 域码 + details，DSH 侧原样重建成带码的 RemoteError。 */
export function remoteStreamFailure(message: string, code: unknown, details: unknown, cause?: unknown): Error {
  const error: any = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.name = "DSHStreamRemoteError";
  error[STREAM_FAILURE] = {
    kind: "remote",
    code: typeof code === "string" && code ? code : "gateway/internal",
    details: details && typeof details === "object" ? details : {},
  };
  return error;
}

/** 载体依赖：URL 解析与 fetch 由调用方注入（便于单测，也避免与 dsh-inject 互引）。 */
export interface StreamCarrierDeps {
  /** 把载体路径解析成绝对 URL（dsh-inject 传中继前缀下的地址）。 */
  resolve: (pathname: string) => URL;
  /** 注入的 fetch（缺省用全局 fetch）。 */
  fetchImpl?: (input: any, init?: any) => Promise<any>;
}

/** 页面侧的远端流载体。 */
export interface StreamCarrier {
  /** 开一条逻辑流；返回值逐项交出，收尾即 done。 */
  openStream: (endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>) => AsyncIterable<unknown>;
  /** 页面收尾（pagehide）：中断全部在途流，按终态处理（不是载体丢失）。 */
  dispose: () => void;
}

const abortError = () => new DOMException("Aborted", "AbortError");

/**
 * 造一个页面侧载体。
 * @param deps - URL 解析与 fetch 注入
 */
export function createStreamCarrier(deps: StreamCarrierDeps): StreamCarrier {
  const resolve = deps.resolve;
  const doFetch = deps.fetchImpl ?? ((input: any, init?: any) => fetch(input, init));
  // 流 id 必须**跨面唯一**：宿主那张在途流表是按受管 runtime 的，而这个 runtime 被多个面共用
  // （主卡与流卡各是一份文档，各自装配一份注入代码）。只用自增序号的话，第二个面的 hana-1
  // 永远撞上第一个面那条长命的 $events，每次重试都是 409。
  const instance = Math.random().toString(36).slice(2, 10);
  let nextId = 0;
  const inflight = new Map<string, AbortController>();
  let disposed = false;

  /** 一条小 JSON 控制 POST（item / end / cancel）。 */
  const post = (pathname: string, body: unknown, signal?: AbortSignal): Promise<any> =>
    doFetch(resolve(pathname).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });

  /** 取消一条流：对端已收场时是无操作；失败不抛（取消本来就是尽力）。 */
  const cancel = async (streamId: string): Promise<void> => {
    try {
      await post(STREAM_PATH_CANCEL, { streamId });
    } catch { /* 载体已断或对端已收场：取消是尽力而为 */ }
  };

  async function* openStream(endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>) {
    if (signal && signal.aborted) throw signal.reason || abortError();
    if (disposed) throw carrierFailure("DSH stream carrier disposed");
    if (inflight.size >= STREAM_MAX_INFLIGHT) throw new Error("Too many DSH remote streams");

    const streamId = "hana-" + instance + "-" + String(++nextId);
    const control = new AbortController();
    const onAbort = () => control.abort(signal ? signal.reason : abortError());
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    inflight.set(streamId, control);

    let response;
    try {
      response = await post(STREAM_PATH_OPEN, {
        streamId,
        endpoint,
        // payload 必须成键出现（协议两端都是我们，缺键一律当非法），undefined 补成 null。
        payload: payload === undefined ? null : payload,
      }, control.signal);
    } catch (error) {
      inflight.delete(streamId);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (control.signal.aborted) throw signal?.reason || abortError();
      throw carrierFailure("DSH stream carrier failed to open the stream", error);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      inflight.delete(streamId);
      if (signal) signal.removeEventListener("abort", onAbort);
      throw carrierFailure(
        "DSH stream carrier rejected the stream: HTTP " + String(response.status)
        + (text ? " " + text.slice(0, 200) : ""),
      );
    }

    // 上行泵：页面推过来的项各自一个 POST，半关时发 end。上行失败不单独抛，由下行收场体现。
    const pump = uplink === undefined ? null : (async () => {
      try {
        for await (const value of uplink) {
          if (control.signal.aborted) return;
          await post(STREAM_PATH_ITEM, { streamId, value });
        }
        if (!control.signal.aborted) await post(STREAM_PATH_END, { streamId });
      } catch { /* 上行失败由下行收场体现 */ }
    })();

    const reader = response.body?.getReader?.();
    // 收到 end 帧即已收场：对端已摘表，不再补发 cancel。
    let settled = false;
    try {
      if (!reader) {
        const text = await response.text().catch(() => "");
        for (const line of splitNdjsonLines(text).lines) {
          const frame = parseStreamFrame(line);
          if (frame === null) continue;
          if (frame.type === "item") yield frame.value;
          else if (frame.type === "end") { settled = true; return; }
          else throw remoteStreamFailure(frame.error.message, frame.error.code, frame.error.details);
        }
        throw carrierFailure("DSH stream carrier closed before the stream ended");
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        const split = splitNdjsonLines(buffer);
        buffer = split.rest;
        for (const line of split.lines) {
          const frame = parseStreamFrame(line);
          if (frame === null) continue;
          if (frame.type === "item") yield frame.value;
          else if (frame.type === "end") { settled = true; return; }
          else throw remoteStreamFailure(frame.error.message, frame.error.code, frame.error.details);
        }
      }
      // 响应流干净结束却没收到 end 帧：载体被截断（页半与内核半的类身份跨不过去，
      // 所以这里必须给 carrier 标记，DSH 侧才敢重开）。
      throw carrierFailure("DSH stream carrier closed before the stream ended");
    } catch (error) {
      // 页面收尾（pagehide）：终态错误，不带 carrier 标记（DSH 侧不该据此重开）。
      if (disposed) throw new Error("DSH stream carrier disposed");
      if (control.signal.aborted) throw signal?.reason || abortError();
      throw error;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (inflight.delete(streamId) && !disposed && !settled) await cancel(streamId);
      await pump;
    }
  }

  return {
    openStream,
    dispose(): void {
      disposed = true;
      for (const control of inflight.values()) control.abort(new Error("DSH stream carrier disposed"));
      inflight.clear();
    },
  };
}
