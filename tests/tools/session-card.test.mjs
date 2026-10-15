// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/tools/session-card.test.mjs — 会话卡的投递载荷、坐标与工具回执的形状。
//
// 卡走 contributes.messageRenderers + session:send-custom（不是工具回执的 details.card）：
//   · 回执只留 details.dsh（句柄契约）与那句人可读文案；**不再有 details.card**；
//   · 卡 id 由 taskId 派生、随投递那条自定义消息自己的 details 投出，卡读不到 payload，靠
//     `hana.surface.getContext().cardInstanceId` 读回同一个值让后端认领那条任务（见 tests/lib/session-card.test.mjs）；
//   · 卡的字面量（id / route / title）只在 manifest 里一份，工具面不再抄。
// 提交链用 deps.submitDshTask 注入 fake，不触真 runtime、不碰宿主任务面。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doExecute } from "@dshana/tools/index.ts";
import {
  SESSION_CARD_MANIFEST_ID,
  SESSION_CARD_ROUTE_PATH,
  SESSION_CARD_TYPE,
  sessionCardNote,
} from "@dshana/tools/shared/card.ts";
import { manifestPath } from "../../scripts/shared/contract-assets.mts";

const SID = "session-0f0e0d0c-0b0a-4007-0605-040302010099";
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

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

const loc = (over = {}) => ({
  action: "create",
  sessionId: SID,
  rpcId: "rpc-1",
  taskId: "task-1",
  delivery: "next-step",
  cwd: "E:\\Hanako\\workspace",
  cardEntryId: "entry-1",
  cardError: null,
  ...over,
});

test("卡页存在：SESSION_CARD_ROUTE_PATH 指向 ui/ 里真实存在的页面", () => {
  assert.equal(SESSION_CARD_ROUTE_PATH, "/stream.html");
  assert.ok(
    existsSync(join(ROOT, "packages", "ui", "src", SESSION_CARD_ROUTE_PATH.replace(/^\//, ""))),
    "常量指向的页面必须真的在 packages/ui/src 里（宿主按 ui 静态树取页）",
  );
});

test("manifest：卡与 messageRenderers 成对，route 不带查询串（宿主校验器禁 `?`）", () => {
  const manifest = JSON.parse(readFileSync(manifestPath(ROOT), "utf8"));
  const cards = manifest.contributes.cards;
  const card = cards.find((c) => c.id === SESSION_CARD_MANIFEST_ID);
  assert.ok(card, "会话卡要在 contributes.cards 里声明");
  assert.equal(card.route, SESSION_CARD_ROUTE_PATH);
  assert.ok(!card.route.includes("?"), "manifest 卡的 route 不能带查询串（宿主校验器 mb() 会拒）");
  assert.ok(!/[#\\]/.test(card.route), "route 不能带 # 或反斜杠");
  assert.ok(!card.route.includes(".."), "route 不能带 ..");
  assert.equal(card.cardForm, "flush", "形态随到黑板绑定上");
  assert.ok(card.face && card.face.image, "带 route 的卡要有卡面");

  const renderers = manifest.contributes.messageRenderers;
  assert.ok(Array.isArray(renderers), "要声明 contributes.messageRenderers（流内卡的渲染通道）");
  const mapping = renderers.find((r) => r.customType === SESSION_CARD_TYPE);
  assert.ok(mapping, "短名要与投递时用的 customType 一致");
  assert.equal(mapping.cardId, SESSION_CARD_MANIFEST_ID, "cardId 必须指向上面那张带 route 的卡");
  assert.ok(!mapping.customType.includes("/"), "customType 是短名，不能自带命名空间前缀");
  assert.ok(!mapping.customType.startsWith("app:"), "customType 不能自己带 app: 前缀（宿主会剥掉再盖）");
});

test("open：回执不再有 details.card，details.dsh 形状带 cardEntryId", async () => {
  const cwd = "E:\\Hanako\\workspace";
  const { out, fake } = await run("open", loc({ cwd }), { task: "干活", cwd, context: { callToken: "tok" } });

  assert.equal(out.details.card, undefined, "投递路径已换成自定义消息，回执里不该再有卡字面量");
  assert.deepEqual(out.details.dsh, {
    action: "open",
    sessionId: SID,
    rpcId: "rpc-1",
    taskId: "task-1",
    status: "running",
    delivery: "next-step",
    cwd,
    cardEntryId: "entry-1",
  }, "dsh 是句柄契约的形状；cardEntryId 是投递那条自定义消息的节点 id");
  assert.match(out.content[0].text, /next-step/, "回执要写出档位，模型不必猜结果什么时候回来");
  assert.equal(fake.calls.length, 1, "提交链仍被调一次");
  assert.equal(fake.calls[0].action, "create", "工具面是 open，提交链内部仍是 create");
  assert.equal(fake.calls[0].callToken, "tok", "投递会话卡要的令牌就是这次工具调用的");
});

test("open：卡投递失败时如实写进回执（不谎报卡已投出）", async () => {
  const cwd = "E:\\Hanako\\workspace";
  const { out } = await run("open", loc({ cwd, cardEntryId: null, cardError: "session does not belong to app" }), {
    task: "干活",
    cwd,
    context: { callToken: "tok" },
  });
  assert.match(out.content[0].text, /会话卡未能确认投出/, "卡是会话在聊天流里唯一的把手，失败要说出来");
  assert.match(out.content[0].text, /session does not belong to app/, "带上真实原因");
  assert.equal(out.details.dsh.cardEntryId, undefined, "没有 entryId 就不塞这一格");
  assert.match(out.content[0].text, /taskId task-1/, "任务本身照常报告（卡失败不阻断提交）");
});

test("reply：回执也走同一条路（无 details.card，action=reply）", async () => {
  const { out, fake } = await run("reply", loc({ action: "send", rpcId: "rpc-2", taskId: "task-2", cwd: null }), {
    task: "接着跑",
    sessionId: SID,
  });
  assert.equal(out.details.card, undefined, "reply 与 open 同一口径：不再出卡字面量");
  assert.deepEqual(out.details.dsh, {
    action: "reply",
    sessionId: SID,
    rpcId: "rpc-2",
    taskId: "task-2",
    status: "running",
    delivery: "next-step",
    cwd: undefined,
    cardEntryId: "entry-1",
  });
  assert.equal(fake.calls[0].action, "send", "工具面是 reply，提交链内部仍是 send");
});

test("回执措辞：成功时不额外加话，失败/未落盘时如实说清", () => {
  assert.equal(sessionCardNote({ cardEntryId: "entry-1", cardError: null }), "", "卡已就位就不必再报一遍");
  const failed = sessionCardNote({ cardEntryId: null, cardError: "session does not belong to app" });
  assert.match(failed, /会话卡未能确认投出/);
  assert.match(failed, /session does not belong to app/);
  assert.match(failed, /任务本身已经在跑/, "卡失败不阻断提交，要说清任务照常");
  const queued = sessionCardNote({ cardEntryId: null, cardError: null });
  assert.match(queued, /落盘节点 id 未回执/, "消息可能还在流式队列里：如实说，不当失败");
  assert.doesNotMatch(queued, /未能确认投出/);
});
