// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/session-list.test.mjs — 会话清单投影（src/lib/session-list.ts）。
// 事实源是宿主任务记录：只有带 metadata.dsh.sessionId 的记录才是"可打开的会话"。
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSessions, SESSION_LIST_LIMIT } from "../../src/lib/session-list.ts";

/** 造一条宿主任务记录（形状按 AppTaskRecordV2 里我们用到的字段）。 */
function rec(taskId, sessionId, extra = {}) {
  const { metadata: extraMeta, ...rest } = extra;
  return {
    taskId,
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    ...rest,
    metadata: {
      ...(extraMeta || {}),
      dsh: sessionId ? { action: "create", cwd: "C:/x", sessionId } : { action: "create" },
    },
  };
}

test("summarizeSessions: 归一字段，丢掉没有会话坐标的记录", () => {
  const out = summarizeSessions([
    rec("t1", "session-a"),
    rec("t2", null), // 没有 sessionId：没有可打开的会话
    { taskId: "t3" }, // 连 metadata 都没有
    null,
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    taskId: "t1",
    sessionId: "session-a",
    action: "create",
    cwd: "C:/x",
    label: "",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
  });
});

test("summarizeSessions: label 取自任务记录，缺则空串", () => {
  const out = summarizeSessions([
    { ...rec("t1", "s1"), metadata: { dsh: { sessionId: "s1" }, label: "DSH 新任务：干活" } },
  ]);
  assert.equal(out[0].label, "DSH 新任务：干活");
});

test("summarizeSessions: 按最近活动降序，缺 updatedAt 用 createdAt", () => {
  const out = summarizeSessions([
    rec("old", "s-old", { updatedAt: 100 }),
    rec("new", "s-new", { updatedAt: 500 }),
    { ...rec("mid", "s-mid"), updatedAt: undefined, createdAt: 300 },
  ]);
  assert.deepEqual(out.map((s) => s.taskId), ["new", "mid", "old"]);
});

test("summarizeSessions: 截断到上限，保留最新的那批", () => {
  const many = Array.from({ length: SESSION_LIST_LIMIT + 5 }, (_, i) =>
    rec("t" + String(i).padStart(3, "0"), "s" + i, { updatedAt: i }),
  );
  const out = summarizeSessions(many);
  assert.equal(out.length, SESSION_LIST_LIMIT);
  assert.equal(out[0].taskId, "t" + String(SESSION_LIST_LIMIT + 4).padStart(3, "0"));
});
