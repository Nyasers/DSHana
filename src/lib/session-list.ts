// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/session-list.ts — 把宿主任务记录投影成「可打开的 DSH 会话」清单（纯函数）。
//
// 会话的坐标不在 App 自己的索引里，而在宿主任务记录的 metadata.dsh（见 lib/task-binding.ts）。
// 所以清单 = 本 App 的任务记录里带 sessionId 的那些，**按会话去重**（reply 会给同一个 sessionId 不断
// 建新记录）、按最近活动排序、截断到上限。
//
// 消费方：GET /dshana/sessions（设置页的会话清单）与 POST /dshana/sessions/open（开窗口）。
// 纯函数：宿主记录的形状只在这里归一，路由层不碰字段。

/** 会话清单里的一项（字段都归一到"缺就是 null"，页面不必再判 undefined）。 */
export interface SessionSummary {
  taskId: string;
  sessionId: string;
  /** 建会话的那个动作（create / send），缺则 null。 */
  action: string | null;
  cwd: string | null;
  /** 显示名：任务记录里的 label 优先，缺则空串（页面自己兜底文案）。 */
  label: string;
  status: string;
  createdAt: number | null;
  updatedAt: number | null;
}

/** 清单上限：只保留最近这么多条会话（历史越久远越没有打开的诉求）。 */
export const SESSION_LIST_LIMIT = 20;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * 宿主任务记录 → 会话清单。
 * 只认有 dsh.sessionId 的记录（没有它就没有可打开的会话）；按 updatedAt（缺则 createdAt）降序，
 * 再截到 SESSION_LIST_LIMIT。并列时按 taskId 稳定排序，保证同一次输入给出同样的顺序。
 */
export function summarizeSessions(records: readonly unknown[]): SessionSummary[] {
  /** 排序键：最近活动优先（updatedAt 缺则 createdAt，都没有算 0）。 */
  const act = (s: SessionSummary) => s.updatedAt ?? s.createdAt ?? 0;
  const out: SessionSummary[] = [];
  for (const raw of records || []) {
    const rec = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
    const meta = rec.metadata && typeof rec.metadata === "object" ? rec.metadata : {};
    const dsh = meta.dsh && typeof meta.dsh === "object" ? meta.dsh : null;
    const sessionId = dsh ? str(dsh.sessionId) : null;
    const taskId = str(rec.taskId);
    if (!taskId || !sessionId) continue;
    out.push({
      taskId,
      sessionId,
      action: dsh ? str(dsh.action) : null,
      cwd: dsh ? str(dsh.cwd) : null,
      label: str(meta.label) || "",
      status: str(rec.status) || "unknown",
      createdAt: num(rec.createdAt),
      updatedAt: num(rec.updatedAt),
    });
  }
  // 一个会话一条：reply 每次都为同一个 sessionId 建新任务记录，不去重的话，同一会话的二十次
  // 续发就能把别的会话全挤出清单。同一 sessionId 只留最近活动的那条。
  const bySession = new Map<string, SessionSummary>();
  for (const s of out) {
    const prev = bySession.get(s.sessionId);
    if (!prev || act(s) >= act(prev)) bySession.set(s.sessionId, s);
  }
  const unique = [...bySession.values()];
  unique.sort((a, b) => act(b) - act(a) || (a.taskId < b.taskId ? 1 : a.taskId > b.taskId ? -1 : 0));
  return unique.slice(0, SESSION_LIST_LIMIT);
}
