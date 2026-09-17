// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/session-card.test.mjs — dshana open/reply 返回值里的会话流卡字面量。
//
// 卡是新增字段：details.dsh 的形状必须原样（SKILL 与句柄契约都读它），只有 delivery 一档是
// 从提交链的投递档位照抄下来的（档位由 session-run 的 TASK_DELIVERY 定，工具面只陈述不另选）。提交链用
// deps.submitDshTask 注入 fake，不触真 runtime、不碰宿主任务面。
// 工具面动作是 open/reply；提交链内部 action 词汇仍是 create/send（映射在 tools 侧）。
// 卡页 = ui/stream.html（只读会话流面）：查询串里的 sid 把注入的 DSH UI 钉在这段会话上。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doExecute } from "../src/tools/index.ts";
import { SESSION_CARD_ROUTE, sessionCard } from "../src/tools/shared/card.ts";

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
    existsSync(join(here, "..", "src", "ui", SESSION_CARD_ROUTE.replace(/^\//, ""))),
    "常量指向的页面必须真的在 src/ui 里（宿主按 ui 静态树取页）",
  );
});

test("open：返回值带 card.route（ui 静态树路径 + ?ts= 快照），details.dsh 形状不变", async () => {
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
  }, "dsh 是句柄契约的形状，卡片只加不改；delivery 陈述本任务实际的投递档位");
  assert.match(out.content[0].text, /next-step/, "回执要写出档位，模型不必猜结果什么时候回来");
  assert.equal(fake.calls.length, 1, "提交链仍被调一次");
  assert.equal(fake.calls[0].action, "create", "工具面是 open，提交链内部仍是 create");

  const card = out.details.card;
  assert.equal(card.pluginId, "dshana", "宿主要求 pluginId 等于工具归属 App id，缺了或不等一律丢卡");
  assert.match(card.aspectRatio, /^\d+:\d+$/, "aspectRatio 是 \"宽:高\" 字符串；给数字会被渲染端当非法值");
  assert.match(card.title, /子代理已开启/);
  assert.match(card.description, /task-1/, "taskId 在卡面描述里（卡体让给会话流）");

  const q = cardQuery(card);
  assert.ok(Number(q.get("ts")) > 0, "?ts= 防缓存");
  assert.ok(Number(q.get("at")) > 0);
  assert.equal(q.get("sid"), SID, "sid 是卡页钉住哪一段 DSH 会话的唯一依据");
  assert.equal(q.get("cwd"), cwd);
});

test("sessionCard：没有 cwd 就不塞这一格（卡页只认有值的那几个）", () => {
  const q = cardQuery(sessionCard({ action: "open", sessionId: SID, taskId: "task-3" }));
  assert.equal(q.get("cwd"), null);
});

test("reply：同样带卡；没有 cwd 时 route 不带 cwd、dsh 的 cwd 仍是缺省态", async () => {
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

  const card = out.details.card;
  assert.equal(card.pluginId, "dshana");
  assert.match(card.title, /续发消息/);
  const q = cardQuery(card);
  assert.equal(q.get("sid"), SID);
  assert.equal(q.get("cwd"), null, "reply 没有 cwd 就不塞这一格");
});
