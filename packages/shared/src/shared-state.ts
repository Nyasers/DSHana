// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/shared-state.ts — UI 跨面共享通道的纯词表（键前缀、值构造、读侧挑选）。
//
// 通道：应用态存储（hana.storage.global → <dataDir>/storage/global.json）。主卡与 FP 用它对齐
// 视图状态，也是跨面转发（FP 发射意图 → 整幅面落地）的载体：boot 快照、设置视图、会话选中、
// 主面板选中、会话行面（读写实现见 ui/surface-bridge.ts，词表见下方 INTENT_KINDS）。
//
// 键形如 `dshana.<kind>`，**不带卡片实例**：本 App 单 DSH 源、单主卡，宿主给主卡与其 FP 同一个
// cardInstanceId，按实例分段没有区分度。于是这批键的寿命就是一次 App 生命周期——没有哪一个键
// 该活过它。
//
// 纯挑选逻辑（listSharedKeys）与副作用（App 侧的 renewSharedState）分开：前者是单测面，后者
// 只做一次 getAll + 逐个 delete。广播键 `dshana:settings` 不在此列（冒号而非点号，且它是设置
// revision 的广播面，不是视图状态）。

import type { FaceAddress } from "./face-addresses.ts";

/** UI 共享通道的键前缀（页面侧拼键与应用侧收尾共用；改一处必须改两处）。 */
export const SHARED_KEY_PREFIX = "dshana.";

/** 跨面共用的当前选中会话（写侧：壳页在本地选中变化时写；读侧：FP 与主卡的对齐，
 * 以及 DSH 侧 ui-session 在「本面没钉住 sid」时跟随它。消费方见 ui/surface-bridge.ts 与
 * integrations/ui-session。会话卡不写也不读它——那张卡钉自己那一段。 */
export const SELECTION_SHARED_KEY = SHARED_KEY_PREFIX + "selection";

// ---- 跨面转发：意图词表与封套 ----
// 方向是单向的：局部面（FP）发射意图，整幅面落地。跨文档能过的只有**意图**——插件实例、注入的
// hook 与 React 树都留在发射端，接收端拿自己的插件实例把那条面重建出来。同一 kind 在两边各自
// 注册消费方（见 ui/surface-bridge.ts 与 integrations/*）。
//
// 词表是封闭的：未知 kind 在读写两端都被拒，通道不退化成“随便塞”。加一个 kind 要同时在这里
// 给出它的载荷归一，读侧拿到的永远是干净形状（多余字段丢掉、缺的补空）。

/** 可跨面转发的意图种类。 */
export const INTENT_KINDS = [
  "settings-view",   // 设置面板开/关与当前分区
  "panel-view",      // 主面板选中（FP 点面板行、主卡把那页打开）
  "selection",       // 当前选中会话（切会话）
  "session-rename",  // 重命名弹窗
  "session-archive", // 归档确认
  "row-toast",      // 会话行提示
  "shortcuts-panel", // 快捷键参考框
] as const;

/** 一个意图种类。 */
export type IntentKind = (typeof INTENT_KINDS)[number];

/** 认意图种类（词表外的值当场拒）。 */
export function isIntentKind(value: unknown): value is IntentKind {
  return typeof value === "string" && (INTENT_KINDS as readonly string[]).includes(value);
}

/** 一条转发值的封套：载荷 + 写入时刻（at 由通道盖章，接收端据此只采纳比自己动手更新的意见）。 */
export interface IntentEnvelope<T = unknown> {
  value: T;
  at: number;
}

/** 把载荷打成封套（写入端用）。 */
export function intentSharedValue<T>(value: T, at: number = Date.now()): IntentEnvelope<T> {
  return { value, at };
}

/** 各 kind 的载荷形状（读写两端共用一份；写侧归一后再落盘，读侧直接拿到这个形状）。 */
export interface IntentPayloadMap {
  "settings-view": { open: boolean; section: string | null };
  "panel-view": { panelId: string | null };
  selection: { sessionId: string | null };
  "session-rename": { sessionId: string | null; title: string };
  "session-archive": { sessionId: string | null; displayTitle: string; activity: unknown[] };
  "row-toast": { notice: Record<string, unknown> | null };
  "shortcuts-panel": Record<string, never>;
}

/**
 * 每个 kind 的性质：
 *   state   —— 镜像状态（落地后留着，重开面要能把当前值恢复出来）；
 *   command —— 一次性动作（落地后由接收端清掉，重开面不得重放）。
 * 判错两种都会出乖：把 command 当 state 镜像，重载主卡就会把旧的重命名框重新弹一遍。
 */
export type IntentNature = "state" | "command";

/**
 * 一条跨面意图的**完整描述**（单一事实源）。
 *
 * 加一条跨面意图 = 这里加一条 + 在落地端登记一个回调；运输（共享空间 / 直投通道）、
 * 投递面筛选、命令类的“不回放”全由这套描述推出来，不再各处再写一份。
 */
export interface IntentSpec<K extends IntentKind = IntentKind> {
  nature: IntentNature;
  /** 载荷归一（读侧拿到的永远是干净形状）。 */
  normalize(raw: unknown): IntentPayload<K>;
  /**
   * 参与这条意图的面（发射端与落地端都在内）。不在其中的面收到的帧一律丢。
   * 不声明 = 未迁移（还只走广播共享空间，投递面由各集成自己的角色闸把关）。
   */
  faces?: readonly FaceAddress[];
}

/** 意图描述符表：词表、性质、载荷归一、参与面的**唯一**来源。 */
export const INTENT_SPECS = {
  "settings-view": { nature: "state", normalize: (raw) => normalizeIntent("settings-view", raw) },
  "panel-view": { nature: "state", normalize: (raw) => normalizeIntent("panel-view", raw) },
  selection: {
    nature: "state",
    normalize: (raw) => normalizeIntent("selection", raw),
    // FP 与主卡发射、（未钉住的）会话流卡只读跟随：三面参与，整幅面与设置页不参与。
    faces: ["navigation", "workspace", "stream"],
  },
  "session-rename": { nature: "command", normalize: (raw) => normalizeIntent("session-rename", raw) },
  "session-archive": { nature: "command", normalize: (raw) => normalizeIntent("session-archive", raw) },
  "row-toast": { nature: "command", normalize: (raw) => normalizeIntent("row-toast", raw) },
  "shortcuts-panel": { nature: "command", normalize: (raw) => normalizeIntent("shortcuts-panel", raw) },
} as const satisfies Record<IntentKind, IntentSpec<IntentKind>>;

/** 取一条描述符（词表外的值当场拒）。 */
export function intentSpec<K extends IntentKind>(kind: K): IntentSpec<K> {
  if (!isIntentKind(kind)) throw new Error("未知跨面意图：" + String(kind));
  return INTENT_SPECS[kind] as IntentSpec<K>;
}

/** 这条意图参与哪些面（没声明就是 null，表示“由消费方自己的角色闸把关”）。 */
export function intentFaces(kind: IntentKind): readonly FaceAddress[] | null {
  if (!isIntentKind(kind)) return null;
  const faces = INTENT_SPECS[kind].faces;
  return faces && faces.length ? faces : null;
}

/** 面是否参与这条意图（未声明参与面时一律当真）。 */
export function faceTakesIntent(kind: IntentKind, face: string): boolean {
  const faces = intentFaces(kind);
  return faces === null || (faces as readonly string[]).includes(face);
}

/**
 * 每个 kind 的性质（从描述符表推出来，不再自带一份副本）。
 */
export const INTENT_NATURE: Record<IntentKind, IntentNature> = Object.fromEntries(
  INTENT_KINDS.map((kind) => [kind, INTENT_SPECS[kind].nature]),
) as Record<IntentKind, IntentNature>;

/** 一个 kind 的载荷类型。 */
export type IntentPayload<K extends IntentKind> = IntentPayloadMap[K];

/** 非空字符串，其余（含空串）归 null。 */
function nonEmptyOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 一个 kind 的载荷归一（纯函数）。 */
export function normalizeIntent<K extends IntentKind>(kind: K, raw: unknown): IntentPayload<K> {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = (() => {
    switch (kind) {
      case "settings-view": return { open: v.open === true, section: nonEmptyOrNull(v.section) };
      case "panel-view": return { panelId: nonEmptyOrNull(v.panelId) };
      case "selection": return { sessionId: nonEmptyOrNull(v.sessionId) };
      case "session-rename": return { sessionId: nonEmptyOrNull(v.sessionId), title: typeof v.title === "string" ? v.title : "" };
      case "session-archive": return {
        sessionId: nonEmptyOrNull(v.sessionId),
        displayTitle: typeof v.displayTitle === "string" ? v.displayTitle : "",
        activity: Array.isArray(v.activity) ? v.activity : [],
      };
      case "row-toast": return { notice: v.notice && typeof v.notice === "object" ? (v.notice as Record<string, unknown>) : null };
      case "shortcuts-panel": return {};
    }
  })();
  return out as IntentPayload<K>;
}

/** 应用态存储的最小面（结构类型：不绑定 SDK 类型，单测可直接传假实现）。
 * 与宿主 `ctx.storage.global` 一致：getAll 回 `{ entries }`，delete 按键删。 */
export interface SharedStateStore {
  getAll(): Promise<{ entries?: Record<string, unknown> } | undefined>;
  delete(key: string): Promise<unknown>;
}

/**
 * 从存储快照里挑出本通道的键（纯函数）。
 * @param entries getAll 的 entries（键 → 值）
 */
export function listSharedKeys(entries: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const key of Object.keys(entries ?? {})) {
    if (key.startsWith(SHARED_KEY_PREFIX)) out.push(key);
  }
  return out.sort();
}
