// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/activity.ts — 页面状态点（页面导航上的运行指示）的状态判定（纯函数）
//
// 宿主的页面按钮会画一个小圆点，词表只有两个（shared/surface-activity 的 SurfaceActivity）：
//   · running —— 有活在跑（金色，--gold）
//   · unread  —— 有输出没人看（远山青，--accent）
// 合并优先级 fixed：running 压过 unread。宿主自己的会话用同一套词，所以这里不发明新档位。
//
// 本 App 报两个档位的前提不一样：
//
//   running —— 判据是 **DSH 自己的会话状态**（`session/list` 每条记录上的 `running`）。
//   这比宿主任务记录宽：用户在 DSH 界面里自己开的会话根本不是宿主任务，宿主那边没有它的
//   任何记录，拿任务记录当判据会把这类会话整体漏掉。
//
//   unread  —— 仍然不报。「有输出没人看」需要一个**阅读位点**，而本 App 没有任何方式知道
//   用户看过哪个会话哪一轮；拿「刚跑完」凑一个只会让点永久亮着说谎。要报这一档，得先有一个
//   「用户看见了这个会话」的事实源，那是个独立功能，不在判据里假造。
import { isTerminalTaskStatus, taskBindingOf } from "@dshana/shared/task-binding.ts";

/** 页面状态点的取值（与宿主 SurfaceActivity 同词）。 */
export type PageActivity = "running" | "unread";

/**
 * 从 `session/list` 的条目算出这一页该亮什么：任一会话 `running` → "running"，否则 null。
 *
 * `blank` 的会话跳过：那是刚创建、还没写下任何内容的席位，它短暂地 `running` 不代表 App 有活要干，
 * 让它闪一下只是噪声。条目畸形按不亮处理——这里只回答“要不要亮灯”。
 */
export function activityFromSessions(items: unknown): PageActivity | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { running?: unknown; blank?: unknown };
    if (rec.blank === true) continue;
    if (rec.running === true) return "running";
  }
  return null;
}

/**
 * 哪些会话正在跑（同上判据）。只用于日志：亮灯时能直接看出是哪一条会话引起，
 * 不必再从“本 App 起了任务”反推。
 */
export function runningSessionIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { sessionId?: unknown; running?: unknown; blank?: unknown };
    if (rec.blank === true || rec.running !== true) continue;
    out.push(typeof rec.sessionId === "string" ? rec.sessionId : "(无 id)");
  }
  return out;
}

/**
 * 从宿主任务记录算出该亮什么：有非终态的 DSH 任务 → "running"，否则 null。
 *
 * 这是 `session/list` 拿不到时的降级判据（受管 runtime 还没起来、控制面暂时不通）。它只看得见本
 * App 自己起的任务，看不见用户在 DSH 界面里开的会话，所以不能当主判据。
 *
 * 只认**真正带 DSH 绑定**的记录（metadata.dsh.sessionId 合法）：别的 App 任务、本 App 将来
 * 可能加的其它任务类型都不该点亮 DSH 的页面。记录畸形（缺 taskId / 会话 id 非法）按没有绑定
 * 处理——这里只回答「要不要亮灯」，不是一致性检查；一致性由读绑定的那条路负责。
 */
export function activityFromTasks(rows: unknown): PageActivity | null {
  if (!Array.isArray(rows)) return null;
  for (const rec of rows) {
    if (!rec || typeof rec !== "object") continue;
    if (!taskBindingOf(rec)) continue;
    if (!isTerminalTaskStatus((rec as { status?: unknown }).status)) return "running";
  }
  return null;
}
