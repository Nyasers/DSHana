// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/intent-landing.ts — 跨面意图的**落地面**（纯逻辑：登记、退订、按 kind 派发）
//
// 为什么单独一件：落地端（各 integration）现在各写各的 applier 循环（读 → 判 at → 判 pending →
// 落地 → 清空），那套机器本该由通道/桥统一持有。这里把这台机器抽成纯逻辑：谁登记了哪条 kind、
// 本面参不参与这条 kind、帧来了派给谁——不碰 DOM、不碰 fetch，单测直接打。
//
// 纪律：
//   · **只派给参与的面**（参与面由意图描述符表的 faces 声明，判据由调用方注入）；
//   · **不做落地去重**：state 类落地本来就幂等（就是把值装上），command 类在通道上不会被重放
//     （首挂只给快照）。反倒是“按 at 去重”会误杀：两个面在同一毫秒发出的两条不同意图，at 会撞。
//   · 单个落地回调抛错只留痕，不拖累别的回调与后续帧。
import type { ChannelKind } from "@dshana/shared/shared-state.ts";
import type { FaceAddress } from "@dshana/shared/face-addresses.ts";

/** 一次落地的上下文（谁发的、什么时候、哪条 kind）。 */
export interface IntentLandingMeta {
  kind: ChannelKind;
  at: number;
  from: FaceAddress | null;
}

/** 一件落地回调：载荷 ← 帧（已归一），meta 供需要判新旧/归因的落地端用。 */
export type IntentLandingHandler = (payload: unknown, meta: IntentLandingMeta) => void;

export interface IntentLandingsOptions {
  /** 本面是否参与这条 kind（由调用方接描述符表与自己的角色词）。 */
  takes: (kind: ChannelKind) => boolean;
  /** 回调抛错时的留痕（缺省静默）。 */
  onError?: (message: string, error: unknown) => void;
}

export interface IntentLandings {
  /** 登记一件落地回调；返回退订（插件卸载时用）。 */
  register(kind: ChannelKind, handler: IntentLandingHandler): () => void;
  /** 这条 kind 上有没有登记的落地端（诊断用）。 */
  has(kind: ChannelKind): boolean;
  /** 派发一帧；返回是否真的派给了至少一个回调（未参与/没人登记都返回 false）。 */
  dispatch(kind: ChannelKind, payload: unknown, meta: IntentLandingMeta): boolean;
  /** 当前登记的 kind 清单（诊断用）。 */
  kinds(): ChannelKind[];
}

/** 建一套落地面。 */
export function createIntentLandings(opts: IntentLandingsOptions): IntentLandings {
  const handlers = new Map<ChannelKind, Set<IntentLandingHandler>>();
  const note = typeof opts.onError === "function" ? opts.onError : () => {};

  return {
    register(kind, handler) {
      let set = handlers.get(kind);
      if (!set) { set = new Set(); handlers.set(kind, set); }
      set.add(handler);
      return () => {
        const live = handlers.get(kind);
        if (!live) return;
        live.delete(handler);
        if (live.size === 0) handlers.delete(kind);
      };
    },
    has(kind) {
      const set = handlers.get(kind);
      return !!set && set.size > 0;
    },
    dispatch(kind, payload, meta) {
      if (!opts.takes(kind)) return false;
      const set = handlers.get(kind);
      if (!set || set.size === 0) return false;
      for (const handler of [...set]) {
        try { handler(payload, meta); } catch (error) {
          note("跨面意图落地回调抛错（kind=" + kind + "）：", error);
        }
      }
      return true;
    },
    kinds: () => [...handlers.keys()],
  };
}
