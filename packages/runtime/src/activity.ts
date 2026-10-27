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
// 本 App 只报 running 一档，判据是**宿主任务记录**：只要还有一条本 App 起的 DSH 任务没有到
// 终态，这一页就有活在跑。会话与任务的绑定事实源就是宿主记录（见 packages/shared/src/task-binding.ts），
// 不另建一份映射，所以页面、设置页、状态点看到的都是同一批数。
//
// 不报 unread：那不是「有没有输出」的事，是「用户有没有看过」，本 App 没有自己的阅读位点；
// 拿别的信号凑一个 unread 只会让这个点说谎。宁可不亮，也不乱亮。
import { isTerminalTaskStatus, taskBindingOf } from "@dshana/shared/task-binding.ts";

/** 页面状态点的取值（与宿主 SurfaceActivity 同词）。 */
export type PageActivity = "running" | "unread";

/**
 * 从宿主任务记录算出这一页该亮什么：有非终态的 DSH 任务 → "running"，否则 null（不亮）。
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
