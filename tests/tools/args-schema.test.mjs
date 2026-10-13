// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/tools/args-schema.test.mjs — 工具参数单一来源（zod）的两面与校验闸门。
//
// 守三件事：
//   ① 模型面 `parameters` 由 zod 生成，仍是「顶层 action + oneOf 分支 + 每支
//      additionalProperties:false」的形状，且**不含 context**（宿主注入的字段不该给模型看）；
//   ② 运行期校验真的拦：未知 action / 未知顶层键 / 缺必填 / 越界取值都抛错，错误里带全部
//      issues（path / code / message）；
//   ③ `approve` 的 outcome 不再 fail-open——宿主不校验入参（已实测），今天 `outcome:"allow"`
//      会被静默当成 allowed-once，这是本次要关掉的口子。
import { test } from "node:test";
import assert from "node:assert/strict";
import { doExecute, parameters } from "@dshana/tools/index.ts";
import { SESSION_ID_RE, isValidSessionId } from "@dshana/shared/task-binding.ts";

/** 跑一次分发，拿抛出的消息（不抛返回 null）。 */
async function dispatch(input) {
  try {
    await doExecute(input, { log: { info() {}, warn() {}, error() {} } }, {
      submitDshTask: () => ({ ready: Promise.reject(new Error("stub: 不该走到提交")), promise: Promise.resolve() }),
    });
    return null;
  } catch (e) {
    return String(e && e.message ? e.message : e);
  }
}

test("parameters 由 zod 生成：顶层 oneOf，每支 additionalProperties:false 且 required 含 action", () => {
  assert.equal(parameters.type, "object", "顶层仍是对象形状");
  assert.ok(Array.isArray(parameters.oneOf), "子命令在 oneOf 里单独成支");
  assert.ok(parameters.oneOf.length >= 5, "五个 action 各一支");
  for (const branch of parameters.oneOf) {
    assert.equal(branch.additionalProperties, false, "分支闭合（额外键不允许）");
    assert.equal(branch.type, "object");
    assert.ok(branch.required.includes("action"), "action 恒必填");
    const literal = branch.properties.action.const;
    assert.equal(typeof literal, "string", "action 是字面量（判别键）");
  }
  assert.equal(parameters.$schema, undefined, "顶层 $schema 剥掉：与手写版形状一致");
});

test("模型面不含 context：宿主注入字段不给模型看", () => {
  const withContext = parameters.oneOf.filter((b) => Object.hasOwn(b.properties, "context"));
  assert.equal(withContext.length, 0, "context 只进运行期 union");
});

// sessionId 的两面必须逐字等价（同一接受集合）：模型面的 pattern 来自同一份正则的投影，
// 而 JSON Schema 的 pattern 带不了标志——一旦那份正则改用 `i`，模型面就会静默变窄（只认小写），
// 比真闸门更严。这个回归没有别的东西拦得住：两面都能各自通过自己的测试。
test("sessionId：模型面 pattern 与运行期闸门接受同一集合（大小写都收）", () => {
  const approve = parameters.oneOf.find((b) => b.properties.action.const === "approve");
  const pattern = approve.properties.sessionId.pattern;
  assert.equal(typeof pattern, "string", "sessionId 的 pattern 要投影出来");

  const fromSchema = new RegExp(pattern);
  const upper = "session-ABCDEF01-2345-6789-ABCD-EF0123456789";
  const lower = "session-abcdef01-2345-6789-abcd-ef0123456789";
  const mixed = "Session-AbCdEf01-2345-6789-AbCd-Ef0123456789";
  for (const sid of [lower, upper, mixed]) {
    assert.equal(fromSchema.test(sid), true, "模型面应接受 " + sid);
    assert.equal(isValidSessionId(sid), true, "运行期应接受 " + sid);
  }
  for (const bad of ["session-abc", "../../etc/passwd", "", "session-abcdef01-2345-6789-abcd-ef012345678"]) {
    assert.equal(fromSchema.test(bad), false, "模型面应拒 " + JSON.stringify(bad));
    assert.equal(isValidSessionId(bad), false, "运行期应拒 " + JSON.stringify(bad));
  }
  // 投影要原样保留（带标志的正则会在这里丢掉大小写容忍）。
  assert.equal(pattern, SESSION_ID_RE.source, "模型面 pattern 就是那份正则的 source（单一来源）");
  assert.equal(SESSION_ID_RE.flags, "", "正则不带标志：带 `i` 会在投影时丢掉大小写容忍");
});

test("每个子命令只认自己的字段：open 看不到 approvalId，approve 看不到 task", () => {
  const byCommand = Object.fromEntries(parameters.oneOf.map((b) => [b.properties.action.const, b]));
  for (const cmd of ["open", "reply", "close", "get", "approve"]) {
    assert.ok(byCommand[cmd], "缺 " + cmd + " 分支");
  }
  assert.equal(byCommand.open.properties.approvalId, undefined, "open 不该有 approvalId");
  assert.equal(byCommand.approve.properties.task, undefined, "approve 不该有 task");
  assert.equal(byCommand.reply.properties.cwd, undefined, "cwd 只属于 open（reply 沿用会话已有 cwd）");
  assert.ok(byCommand.open.properties.agentPreset, "agentPreset 只属于 open（预设钉在会话上）");
  assert.equal(byCommand.reply.properties.agentPreset, undefined, "reply 不该有 agentPreset");
  assert.ok(byCommand.open.required.includes("cwd"));
  assert.ok(byCommand.open.required.includes("task"));
  assert.ok(byCommand.approve.required.includes("approvalId"));
  for (const cmd of ["close", "get"]) {
    assert.deepEqual(byCommand[cmd].required, ["action"], cmd + " 无必填业务字段（目标二选一由解析层判）");
  }
});

test("校验失败：未知 action / 未知顶层键 / 缺必填 / 越界 outcome 一律拦下", async () => {
  const cases = [
    [{ action: "nope" }, /invalid_union|Invalid discriminator/],
    [{ action: "open", task: "t", cwd: "C:\\w", bogus: 1 }, /unrecognized_keys|Unrecognized key/],
    [{ action: "open", cwd: "C:\\w" }, /task/],
    [{ action: "approve", approvalId: "a", outcome: "allow" }, /Invalid option|allowed-once/],
  ];

  for (const [input, re] of cases) {
    const msg = await dispatch(input);
    assert.ok(msg !== null, "应抛错：" + JSON.stringify(input));
    assert.match(msg, /dshana: invalid arguments/, "抬头一致：" + msg);
    assert.match(msg, re, "错误里带可定位的 issues：" + msg);
    // 读者是模型：除了“错在哪”，还要说“下一步去哪看”。不指 tool_help——本工具是顶层
    // oneOf，宿主的一行摘要（paramsSummary）只认平铺 properties，那里的参数栏是空的。
    assert.match(msg, /read the `dshana` skill/, "错误尾行要指路到技能：" + msg);
  }
});

// description 是模型能拿到的唯一固定入口（dshana 是延迟加载工具，parameters 不在常驻前缀；
// tool_help 对它只透传 description）。它只讲这工具是干什么的，动作与字段清单全交手册：
// 指路必须可解析（指技能名，不写仓库相对路径），且不在 desc 里再抄一遍 action 枚举。
test("工具 description 指技能名，不写相对路径、不指 tool_help、不逐条列 action", async () => {
  const { description, SKILL_NAME } = await import("@dshana/tools/index.ts");
  assert.equal(SKILL_NAME, "dshana", "技能名与 skills/ 下的目录名一致");
  assert.match(description, /read the `dshana` skill/, "要指到技能名（技能目录按名字给 location）");
  // 旧写法是仓库相对路径，模型无法解析（不知道相对谁）
  assert.doesNotMatch(description, /skills\/dshana\/SKILL\.md/, "不写仓库相对路径");
  assert.doesNotMatch(description, /tool_help/, "不指 tool_help（对本工具参数栏是空的）");
  // 职责边界：动作清单与逐动作语义在手册里，desc 不再抄一份（否则 summary 要永远与它同步）
  for (const cmd of ["open", "reply", "close", "get", "approve"]) {
    assert.doesNotMatch(description, new RegExp("`?" + cmd + "`?\\s*="), "desc 不列 " + cmd + " 枚举");
  }
  assert.match(description, /^DeepSeek Harness \(DSH\) sub-agent executor/, "保留一句话职责：这是什么工具");
});

test("approve 的 outcome 不再 fail-open：非法值被拒，缺省仍是 allowed-once", async () => {
  // 先证明非法值真的过不了闸（今日实现会静默当成 allowed-once）
  const bad = await dispatch({ action: "approve", approvalId: "a", outcome: "allowed" });
  assert.ok(bad !== null && /invalid arguments/.test(bad), "拼错的 outcome 必须被拒：" + bad);
  // 合法但目标缺失时，走到的是目标解析层的失败（说明闸门放行、语义层接手），不是 invalid arguments
  const missingTarget = await dispatch({ action: "approve", approvalId: "a", outcome: "rejected" });
  assert.ok(missingTarget !== null, "approve 缺目标时应由解析层报错");
  assert.doesNotMatch(missingTarget, /invalid arguments/, "合法 outcome 不该被 schema 拦：" + missingTarget);
});

test("宿主注入的 context 被放行（形状随通道变，未知键不拦）", async () => {
  const hostContext = {
    sessionPath: "E:\\x\\s.jsonl",
    sessionId: null,
    messageId: "m-1",
    messageText: "hi",
    selectionText: "sel",
    callToken: "tok",
    agentId: "hanako",
  };
  // 走到提交链即说明闸门放行（stub 的 ready 会 reject，但那不是 schema 错误）
  const msg = await dispatch({ action: "open", task: "t", cwd: "C:\\w", context: hostContext });
  assert.ok(msg !== null);
  assert.doesNotMatch(msg, /invalid arguments/, "宿主 context 不该被判非法参数：" + msg);
  assert.match(msg, /stub: 不该走到提交/, "闸门之后应继续走到提交链：" + msg);
});
