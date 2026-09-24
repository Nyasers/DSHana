// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/tools/session-card.test.mjs — 会话卡字面量（src/tools/shared/card.ts）与工具回执的形状。
//
// 工具面不挂流内卡：open / reply 的 details 只有 dsh 坐标（句柄契约），没有 card。会话的可见入口
// 统一交给对话底部的任务 chip（lib/session-run.ts 的 chipVisibility）。
// 卡字面量本身仍要正确——字段规则由宿主定：pluginId 必填且等于归属 App id、route 走 ui/ 静态树、
// aspectRatio 是 "宽:高" 字符串。提交链用 deps.submitDshTask 注入 fake，不触真 runtime、不碰宿主任务面。
// 工具面动作是 open/reply；提交链内部 action 词汇仍是 create/send（映射在 tools 侧）。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doExecute } from "../../src/tools/index.ts";
import { SESSION_CARD_ROUTE, sessionCard } from "../../src/tools/shared/card.ts";

const SID = "session-0f0e0d0c-0b0a-4009-0807-060504030201";
const here = dirname(fileURLToPath(import.meta.url));

function fakeSubmit(loc) {
  const calls = [];
  return {
    calls,
    submitDshTask: (args) => {
      calls.push(args);
      return { ready: Promise.resolve(loc), promise: Promise.resolve() };
    },
  };
}

async function run(action, loc, input = {}) {
  const fake = fakeSubmit(loc);
  const out = await doExecute({ action, ...input }, { log: { info() {}, warn() {}, error() {} } }, {
    submitDshTask: fake.submitDshTask,
  });
  return { out, fake };
}

/** 卡 route 的查询串（宿主把 route 拼在 App ui 静态树路径后面，查询串是卡页的数据源） */
function cardQuery(card) {
  assert.match(card.route, /^\/stream\.html\?/, "App 卡的 route 走 ui/ 静态树，不是 /routes/ 命名空间");
  return new URLSearchParams(card.route.slice(card.route.indexOf("?") + 1));
}

test("卡页存在：SESSION_CARD_ROUTE 指向 ui/ 里真实存在的页面", () => {
  assert.equal(SESSION_CARD_ROUTE, "/stream.html");
  assert.ok(
    existsSync(join(here, "..", "..", "src", "ui", SESSION_CARD_ROUTE.replace(/^\//, ""))),
    "常量指向的页面必须真的在 src/ui 里（宿主按 ui 静态树取页）",
  );
});

test("open：回执不带 card，details.dsh 形状不变", async () => {
  const cwd = "E:\\Hanako\\workspace";
  const loc = { action: "create", sessionId: SID, rpcId: "rpc-1", taskId: "task-1", delivery: "next-step", cwd };
  const { out, fake } = await run("open", loc, { task: "干活", cwd, context: { callToken: "tok" } });

  assert.deepEqual(out.details.dsh, {
    action: "open",
    sessionId: SID,
    rpcId: "rpc-1",
    taskId: "task-1",
    status: "running",
    delivery: "next-step",
    cwd,
  }, "dsh 是句柄契约的形状；delivery 陈述本任务实际的投递档位");
  assert.match(out.content[0].text, /next-step/, "回执要写出档位，模型不必猜结果什么时候回来");
  assert.equal(fake.calls.length, 1, "提交链仍被调一次");
  assert.equal(fake.calls[0].action, "create", "工具面是 open，提交链内部仍是 create");
  assert.equal(out.details.card, undefined, "工具面不挂流内卡，可见入口归对话底部的任务 chip");
});

test("reply：回执不带 card，details.dsh 形状不变", async () => {
  const loc = { action: "send", sessionId: SID, rpcId: "rpc-2", taskId: "task-2", delivery: "next-step" };
  const { out, fake } = await run("reply", loc, { task: "接着跑", sessionId: SID });

  assert.deepEqual(out.details.dsh, {
    action: "reply",
    sessionId: SID,
    rpcId: "rpc-2",
    taskId: "task-2",
    status: "running",
    delivery: "next-step",
    cwd: undefined,
  });
  assert.match(out.content[0].text, /next-step/);
  assert.equal(fake.calls[0].action, "send", "工具面是 reply，提交链内部仍是 send");
  assert.equal(out.details.card, undefined, "工具面不挂流内卡");
});

test("卡字面量：字段规则（pluginId / route / aspectRatio / 查询串快照）", () => {
  const cwd = "E:\\Hanako\\workspace";
  const card = sessionCard({ action: "open", sessionId: SID, taskId: "task-1", delivery: "next-step", cwd });
  assert.equal(card.pluginId, "dshana", "宿主要求 pluginId 等于工具归属 App id，缺了或不等一律丢卡");
  assert.match(card.aspectRatio, /^\d+:\d+$/, "aspectRatio 是 \"宽:高\" 字符串；给数字会被渲染端当非法值");
  assert.match(card.title, /子代理已开启/);
  assert.match(card.description, /task-1/, "taskId 在卡面描述里");

  const q = cardQuery(card);
  assert.ok(Number(q.get("ts")) > 0, "?ts= 防缓存");
  assert.ok(Number(q.get("at")) > 0);
  assert.equal(q.get("sid"), SID, "sid 是卡页钉住哪一段 DSH 会话的唯一依据");
  assert.equal(q.get("cwd"), cwd);

  const noCwd = sessionCard({ action: "reply", sessionId: SID, taskId: "task-3" });
  assert.equal(cardQuery(noCwd).get("cwd"), null, "没有 cwd 就不塞这一格");
});
