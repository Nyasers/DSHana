// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/card-display.ts — 会话流卡的展示档位（App 设置 sessionCardDisplay）
//
// 卡 = 工具回执里的 details.card：宿主把它渲染成流内 plugin_card 块，块里是一个注入 DSH UI 的
// iframe。一次会话发几张就叠几个 iframe——这是本 App 最贵的可见物，也是聊天流变卡的来源。
// 三个档位：
//   never      不挂卡（open / reply 都不挂；任务照跑，结果照投）
//   open-only  只在 open 挂（一个会话一张：reply 不再叠卡）
//   all        每次 open / reply 都挂（原行为）
// 为什么 open-only 就是"一个会话一张"：卡页按 sid 跟整段会话（GET /dshana/card-state?sessionId=），
// 不钉在某一次提交上，所以那唯一一张卡跟着会话活着，不存在"旧卡冻结、新卡补位"的真空。
//
// 纯判定与存储读取分开：档位的取值事实源是 App 设置，判定逻辑可以在单测里直接验。
import { appDataDir } from "#/lib/app-runtime.ts";
import { SESSION_CARD_DISPLAYS, SESSION_CARD_DISPLAY_DEFAULT } from "#/lib/card-display-modes.ts";
import { readSettingsSync } from "#/lib/data-source.ts";

/** 归一档位：只认这三个词，其余（缺省 / 未知 / 脏值）回落缺省档。 */
export function normalizeSessionCardDisplay(value: string | null | undefined): string {
  return typeof value === "string" && SESSION_CARD_DISPLAYS.includes(value)
    ? value
    : SESSION_CARD_DISPLAY_DEFAULT;
}

/** 这次动作要不要挂卡（纯函数）。 */
export function sessionCardShownFor(display: string, action: "open" | "reply"): boolean {
  const mode = normalizeSessionCardDisplay(display);
  if (mode === "never") return false;
  if (mode === "open-only") return action === "open";
  return true;
}

/**
 * 当前档位：同步读 App 设置，读不到 / 损坏回落缺省。
 * 同步读的理由同 cancel-chain 的超时解析——这条在工具回调路径上，异步化会往外扩散，而这份文件
 * 只有几行，"改完即时生效"比省一次读更重要。
 */
export function sessionCardDisplay(): string {
  try {
    const dir = appDataDir();
    if (!dir) return SESSION_CARD_DISPLAY_DEFAULT;
    return normalizeSessionCardDisplay(readSettingsSync(dir)?.sessionCardDisplay);
  } catch {
    return SESSION_CARD_DISPLAY_DEFAULT;
  }
}

/** 便捷判定：按当前设置决定这次动作挂不挂卡。 */
export function shouldAttachSessionCard(action: "open" | "reply"): boolean {
  return sessionCardShownFor(sessionCardDisplay(), action);
}
