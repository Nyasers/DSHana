// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/session-card.test.mjs — 会话卡的实例 id、载荷与反查（packages/shared/src/app-card-id.ts +
// packages/session/src/session-card.ts）。
//
// 这里钉住的是「卡 id 由本 App 按 taskId 派生，反查靠它在宿主任务记录里认领」这条设计：
//   ① 派生 id 是确定性的、形状过宿主闸（`/^[am]_[0-9a-f]{20}$/`，bundle nM）——形状不过，
//      宿主会丢掉作者给的值自己算一个，卡读回来的就不是我们的 id；
//   ② 反查只在**命中**时给坐标：命中即等价于「这条任务确实投出了这张卡」；没命中回 null，
//      调用方据此回落「跟随当前选中」——不得编一份坐标顶上。
//   ③ details 里写坐标副本与 cardInstanceId，但绝不写 pluginId / appId（宿主拿它们判归属）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  SESSION_CARD_APP_ID,
  SESSION_CARD_CUSTOM_TYPE,
  SESSION_CARD_DETAILS_KEY,
  SESSION_CARD_INSTANCE_ID_RE,
  SESSION_CARD_ROUTE,
  sessionCardCoords,
  sessionCardCoordsOf,
  sessionCardDetails,
  sessionCardIdForTask,
} from "@dshana/shared/app-card-id.ts";
import { matchTaskCard, readTaskRecords, deliverSessionCard } from "@dshana/session/session-card.ts";

const APP_ID = "dshana";
const SID = "session-0f0e0d0c-0b0a-4007-0605-040302010099";

/** 测试侧的独立实现：照域串+taskId 手写一遍，用来对拍被测实现（不引被测代码）。 */
function deriveId(taskId) {
  return "a_" + createHash("sha256").update(APP_ID + ":session-card\0" + taskId).digest("hex").slice(0, 20);
}

/** 一条带 dsh 坐标的宿主任务记录（形状取自 ctx.tasks.list 的投影：taskId 在根上，坐标在 metadata.dsh）。 */
function taskRecord({
  taskId = "task-1",
  action = "create",
  sessionId = SID,
  rpcId = "rpc-1",
  cwd = "E:\\Hanako\\workspace",
  delivery = "next-step",
  withDsh = true,
  withSession = true,
} = {}) {
  const dsh = {
    action,
    rpcId,
    ...(withSession ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
  };
  return {
    taskId,
    status: "running",
    delivery,
    ...(withDsh ? { metadata: { dsh } } : {}),
    createdAt: 1,
    updatedAt: 2,
  };
}

test("常量：短名、route 与 details 键各只有一处事实源", () => {
  assert.equal(SESSION_CARD_CUSTOM_TYPE, "session-card");
  assert.equal(SESSION_CARD_ROUTE, "/stream.html");
  assert.equal(SESSION_CARD_DETAILS_KEY, "dshana");
  assert.equal(SESSION_CARD_APP_ID, APP_ID, "域串里的 appId 就是本 App 的 id");
});

test("派生 id：a_ + sha256(域串 + taskId) 前 20 位，且过宿主的形状闸", () => {
  for (const taskId of ["task-1", "app:dshana:0f0e0d0c", "  task-padded  ", "任务-id"]) {
    const got = sessionCardIdForTask(taskId);
    assert.equal(got, deriveId(String(taskId).trim()), "派生错一位，反查就整条失效：" + JSON.stringify(taskId));
    assert.match(got, SESSION_CARD_INSTANCE_ID_RE, "形状不过宿主闸时它会丢掉作者给的值：" + got);
  }
});

test("派生 id：同一个 taskId 恒得同一个 id，不同 taskId 必不相同（卡是 per-task 的）", () => {
  assert.equal(sessionCardIdForTask("task-1"), sessionCardIdForTask("task-1"), "同一条派生必须确定");
  assert.equal(sessionCardIdForTask("task-1"), sessionCardIdForTask("  task-1  "), "首尾空白先归一");
  const ids = new Set(["task-1", "task-2", "task-11", "Task-1"].map(sessionCardIdForTask));
  assert.equal(ids.size, 4, "四个不同 taskId 应给出四个互不相同的卡 id");
  assert.throws(() => sessionCardIdForTask(""), /taskId 为空/, "没有任务身份就没有这张卡");
  assert.throws(() => sessionCardIdForTask("   "), /taskId 为空/);
});

test("details：写 cardInstanceId + 坐标副本，且不带宿主判归属用的 pluginId/appId", () => {
  const coords = {
    action: "create",
    sessionId: SID,
    taskId: "task-1",
    rpcId: "rpc-1",
    cwd: "E:\\Hanako\\workspace",
    delivery: "next-step",
  };
  const details = sessionCardDetails(coords);
  assert.deepEqual(Object.keys(details).sort(), ["cardInstanceId", "dshana"], "本 App 只占这两格");
  assert.equal(details.cardInstanceId, deriveId("task-1"), "实例 id 按 taskId 派生（宿主过闸后原样采用）");
  assert.match(details.cardInstanceId, SESSION_CARD_INSTANCE_ID_RE);
  // 宿主拿 details.pluginId / details.appId 判归属（bundle fPr）：写了且不等就拒签证明。
  assert.equal(details.pluginId, undefined, "不能写 pluginId：宿主拿它判归属");
  assert.equal(details.appId, undefined, "不能写 appId：同上");
  assert.deepEqual(sessionCardCoordsOf(details), coords, "写进去的坐标副本能原样归一出来");
});

test("坐标组装：缺省位补空串（宿主 details 走 JSON，undefined 会在那里丢掉）", () => {
  const coords = sessionCardCoords({ action: "open", sessionId: "session-x", taskId: "task-3" });
  assert.deepEqual(coords, { action: "open", sessionId: "session-x", taskId: "task-3", rpcId: "", cwd: "", delivery: "" });
  for (const [k, v] of Object.entries(coords)) {
    assert.equal(typeof v, "string", k + " 该是字符串");
  }
  // cwd 为空时 details 里整格省掉（不写空串，那条消息的 details 保持干净）。
  const details = sessionCardDetails(coords);
  assert.equal(details.dshana.cwd, undefined, "空 cwd 不占一格");
  assert.equal(details.cardInstanceId, deriveId("task-3"), "缺省位不影响卡 id");
});

test("details 归一：不是本 App 的会话卡 / 缺关键坐标时回 null（不半认）", () => {
  assert.equal(sessionCardCoordsOf(null), null);
  assert.equal(sessionCardCoordsOf("x"), null);
  assert.equal(sessionCardCoordsOf({ hanaAppCustomCardSource: "sig" }), null, "只有宿主证明键不是坐标");
  assert.equal(sessionCardCoordsOf({ cardInstanceId: deriveId("task-1") }), null, "只有卡 id 没有坐标");
  assert.equal(sessionCardCoordsOf({ dshana: { action: "create", sessionId: "s" } }), null, "缺 taskId 不算坐标");
  assert.equal(sessionCardCoordsOf({ dshana: { action: "create", taskId: "t" } }), null, "缺 sessionId 不算坐标");
});

test("反查：按 taskId 派生的 id 在任务记录里命中那条，取它自己的 metadata.dsh", () => {
  const records = [
    taskRecord({ taskId: "task-old", action: "send", rpcId: "rpc-old" }),
    taskRecord({ taskId: "task-9", action: "send", rpcId: "rpc-9", cwd: "" }),
  ];
  const coords = matchTaskCard(records, { cardInstanceId: deriveId("task-9") });
  assert.deepEqual(coords, {
    action: "send",
    sessionId: SID,
    taskId: "task-9",
    rpcId: "rpc-9",
    cwd: "",
    delivery: "next-step",
  }, "命中哪条就取哪条任务自己的坐标");
});

test("反查：投递侧派生与反查侧同源——details 里的 cardInstanceId 直接就是命中键", () => {
  const details = sessionCardDetails(sessionCardCoords({ action: "create", sessionId: SID, taskId: "task-7" }));
  const records = [taskRecord({ taskId: "task-7" })];
  const coords = matchTaskCard(records, { cardInstanceId: details.cardInstanceId });
  assert.equal(coords && coords.taskId, "task-7", "卡把宿主给回的 cardInstanceId 报上来即可认领");
  assert.equal(coords.sessionId, SID);
});

test("反查：没命中回 null（不编坐标），空 id / 空候选 / 非数组也回 null", () => {
  const records = [taskRecord({ taskId: "task-1" })];
  assert.equal(matchTaskCard(records, { cardInstanceId: deriveId("not-in-records") }), null, "没命中就是没命中");
  assert.equal(matchTaskCard(records, { cardInstanceId: "a_0123456789abcdef0123" }), null, "形状合法但算不出来的一条");
  assert.equal(matchTaskCard(records, { cardInstanceId: "" }), null);
  assert.equal(matchTaskCard(null, { cardInstanceId: deriveId("task-1") }), null);
  assert.equal(matchTaskCard([], { cardInstanceId: deriveId("task-1") }), null);
  assert.equal(matchTaskCard("junk", { cardInstanceId: deriveId("task-1") }), null);
  // 形状不对的串根本不可能由派生产出：先挡掉，不必对每条记录算一次 sha256。
  for (const bad of ["task-1", "a_0123", "a_0123456789ABCDEF0123", "x_0123456789abcdef0123"]) {
    assert.equal(matchTaskCard(records, { cardInstanceId: bad }), null, "不过宿主形状闸的一律不认：" + bad);
  }
});

test("反查：候选缺坐标不算命中（绑定回写没落地时宁可回落「跟随当前选中」）", () => {
  const id = deriveId("task-1");
  assert.equal(matchTaskCard([{ taskId: "task-1", status: "running" }], { cardInstanceId: id }), null, "没有 metadata 就不是一次带坐标的提交");
  assert.equal(matchTaskCard([{ taskId: "task-1", metadata: {} }], { cardInstanceId: id }), null, "metadata 里没有 dsh");
  assert.equal(matchTaskCard([{ taskId: "task-1", metadata: { dsh: "x" } }], { cardInstanceId: id }), null, "dsh 不是对象");
  assert.equal(matchTaskCard([taskRecord({ taskId: "task-1", withSession: false })], { cardInstanceId: id }), null, "dsh 缺 sessionId");
  assert.equal(matchTaskCard([{ metadata: { dsh: { sessionId: SID } } }], { cardInstanceId: id }), null, "记录缺 taskId 就派生不出 id");
  // 同名任务但没有绑定：空 Metadata 的记录不挡住后面那条真命中的记录。
  const mixed = [{ taskId: "task-1" }, taskRecord({ taskId: "task-1" })];
  assert.equal(matchTaskCard(mixed, { cardInstanceId: id }).sessionId, SID, "认领只看能不能算出这个 id，再看坐标全不全");
});

test("读任务记录：先 scope=own，失败才退 scope=all；两次都失败就抛出（不假装没记录）", async () => {
  const calls = [];
  const own = await readTaskRecords({
    tasks: { list: async (opts) => { calls.push(opts); return [taskRecord()]; } },
  });
  assert.equal(Array.isArray(own), true);
  assert.deepEqual(calls, [{ scope: "own" }], "own 拿到就不再问 all");

  const fallback = [];
  const viaAll = await readTaskRecords({
    tasks: {
      list: async (opts) => {
        fallback.push(opts);
        if (opts && opts.scope === "own") throw new Error("task scope must be own or all");
        return [taskRecord({ taskId: "task-all" })];
      },
    },
  });
  assert.deepEqual(fallback, [{ scope: "own" }, { scope: "all" }], "own 抛了就退 all 再试一次");
  assert.equal(viaAll[0].taskId, "task-all");

  await assert.rejects(
    () => readTaskRecords({ tasks: { list: async () => { throw new Error("host down"); } } }),
    /宿主任务记录不可读（own: host down；all: host down）/,
    "两次都读不到必须显式抛出：反查路由据此回「查不到」而不是编一份坐标",
  );
  await assert.rejects(() => readTaskRecords({}), /ctx\.tasks\.list 不可用/, "任务面缺失同样显式失败");
  await assert.rejects(() => readTaskRecords({ tasks: { list: async () => ({}) } }), /未返回数组/, "回包不是数组也是失败");
});

test("投递：session:send-custom 的 details 带上派生 cardInstanceId 与坐标副本（不带 pluginId/appId）", async () => {
  const seen = [];
  const ctx = {
    bus: {
      request: async (verb, payload) => {
        seen.push({ verb, payload });
        return { ok: true, entryId: "entry-1", mode: "stream", sessionId: SID };
      },
    },
  };
  const coords = sessionCardCoords({
    action: "create",
    sessionId: SID,
    taskId: "task-5",
    rpcId: "rpc-5",
    cwd: "E:\\Hanako\\workspace",
    delivery: "next-step",
  });
  const out = await deliverSessionCard(ctx, { callToken: "tok-1", coords, content: "正文" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].verb, "session:send-custom");
  const p = seen[0].payload;
  assert.equal(p.callToken, "tok-1");
  assert.equal(p.scope, "all", "调用方会话不在本 App 分区里");
  assert.equal(p.customType, SESSION_CARD_CUSTOM_TYPE, "customType 只给短名（宿主会盖命名空间）");
  assert.equal(p.display, true, "display 缺省 false 时这条消息不进渲染通道");
  assert.equal(p.triggerTurn, false);
  assert.equal(p.details.cardInstanceId, deriveId("task-5"), "卡 id 随载荷投出（宿主过闸后原样采用）");
  assert.equal(p.details.pluginId, undefined);
  assert.equal(p.details.appId, undefined);
  assert.deepEqual(sessionCardCoordsOf(p.details), coords, "同一条载荷里的坐标副本");
  assert.deepEqual(out, { ok: true, entryId: "entry-1", mode: "stream", sessionId: SID });

  // 投递出去的那个 id，就是反查端要认领的那个键（两端同源，这条往返是整个机制的支点）。
  const records = [taskRecord({ taskId: "task-5", action: "create", rpcId: "rpc-5" })];
  assert.equal(matchTaskCard(records, { cardInstanceId: p.details.cardInstanceId }).taskId, "task-5");
});

test("投递：宿主回包没有 entryId 时如实回 null（消息可能还在流式队列里）", async () => {
  const ctx = { bus: { request: async () => ({ ok: true, sessionId: SID }) } };
  const coords = sessionCardCoords({ action: "send", sessionId: SID, taskId: "task-6" });
  assert.deepEqual(
    await deliverSessionCard(ctx, { callToken: "tok", coords, content: "x" }),
    { ok: true, entryId: null, mode: null, sessionId: SID },
    "entryId 缺就是缺（不编一个）：回执据此说「未确认落盘」，不当失败",
  );
  const rejected = { bus: { request: async () => ({ ok: false, error: "session does not belong to app" }) } };
  assert.deepEqual(
    await deliverSessionCard(rejected, { callToken: "tok", coords, content: "x" }),
    { ok: false, entryId: null, mode: null, sessionId: "" },
    "宿主明确拒了就如实回 ok:false",
  );
  await assert.rejects(
    () => deliverSessionCard({}, { callToken: "tok", coords, content: "x" }),
    /ctx\.bus\.request 不可用/,
    "bus 面缺失必须显式抛出",
  );
});
