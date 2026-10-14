// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/preset-roster.test.mjs — preset roster 的纯函数（packages/session/src/preset-roster.ts）
//
// 这里只钉不碰网络的那几个：id 收集、查找、挂载失败取首行、两条拒绝文案。取数（readPresetRoster）
// 要求受管 runtime 在线，由真机路径覆盖，不进单测。
//
// 文案有两条要守的约定：名字不在 roster 上时**必须把可用列表带在错误里**（DSH 自己那条
// `agent-preset/not-found` 只报传进去的那个，不带候选，所以这条是唯一的信息来源）；roster 为空
// 时不能渲染出一个空的「offers: 」，要说明该部署没声明任何 preset。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  presetIds,
  findPreset,
  brokenReason,
  unknownPresetError,
  brokenPresetError,
  assertPresetInRoster,
  parsePresetRoster,
} from "@dshana/session/preset-roster.ts";

const rows = [
  { id: "standard", order: 1, isDefault: true },
  { id: "ptc", order: 2 },
  { id: "dshana", name: "标准特调", order: 5 },
  { id: "broken-one", broken: "tool-pwsh: waiting for shell\nsecond line" },
];

test("id 收集跳过非字符串与空白项", () => {
  const ids = presetIds([{ id: "a" }, { id: "  b  " }, { id: 42 }, { name: "no id" }, null, { id: "" }]);
  assert.deepEqual(ids, ["a", "b"]);
});

test("查找按 trim 后的 id 命中", () => {
  assert.equal(findPreset(rows, "ptc")?.order, 2);
  assert.equal(findPreset(rows, "  dshana  ")?.name, "标准特调");
  assert.equal(findPreset(rows, "nope"), undefined);
});

test("挂载失败只取首行（diagnostic 可能是多行）", () => {
  assert.equal(brokenReason(findPreset(rows, "broken-one")), "tool-pwsh: waiting for shell");
  assert.equal(brokenReason(findPreset(rows, "ptc")), "");
  assert.equal(brokenReason(undefined), "");
});

test("未知名字的错误带候选列表（DSH 那条只报传进去的那个）", () => {
  const err = unknownPresetError("typo", rows);
  assert.match(err.message, /unknown agent preset "typo"/);
  for (const id of ["standard", "ptc", "dshana", "broken-one"]) {
    assert.ok(err.message.includes(id), "候选里应含 " + id);
  }
  assert.match(err.message, /action=presets/);
});

test("roster 为空时不说「offers: 空」，而是说明该部署没有声明", () => {
  const err = unknownPresetError("typo", []);
  assert.match(err.message, /declares no presets/);
  assert.doesNotMatch(err.message, /offers: \)/);
});

test("挂载失败是另一条理由：说 id 被声明了但当前挂不起来", () => {
  const err = brokenPresetError("broken-one", "tool-pwsh: waiting for shell");
  assert.match(err.message, /is declared but currently cannot compose/);
  assert.match(err.message, /tool-pwsh: waiting for shell/);
  // 不能混成「名字不存在」——那是另一回事。
  assert.doesNotMatch(err.message, /unknown agent preset/);
});

test("命中的名字静默通过（不发散）", () => {
  assert.equal(assertPresetInRoster("ptc", rows), undefined);
  assert.equal(assertPresetInRoster("broken-one", rows), undefined);
});

test("未命中的名字由 zod enum 报错（自带候选），再补一句指路", () => {
  let caught;
  try {
    assertPresetInRoster("typo", rows);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "应当抛错");
  // zod 的枚举报错形态：Invalid option: expected one of "a"|"b"
  assert.match(caught.message, /Invalid option: expected one of/);
  for (const id of ["standard", "ptc", "dshana", "broken-one"]) {
    assert.ok(caught.message.includes(`"${id}"`), "候选里应含 " + id);
  }
  // zod 不知道本工具还有 presets action，那句指路由我们加。
  assert.match(caught.message, /action=presets/);
});

test("roster 为空时不造就一个无候选的 enum，而是说清本部署没声明", () => {
  let caught;
  try {
    assertPresetInRoster("typo", []);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.match(caught.message, /declares no presets/);
  assert.doesNotMatch(caught.message, /Invalid option/);
});

test("roster 里的项缺 id / id 非字符串时不被当成候选", () => {
  const messy = [{ id: "a" }, { id: 42 }, { name: "no id" }, null];
  let caught;
  try {
    assertPresetInRoster("b", messy);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.ok(caught.message.includes('"a"'), "a 应在候选里");
  assert.doesNotMatch(caught.message, /"42"/);
});

// ---- 回执解析："读不出来" 与 "确实是空" 必须分开 ----

test("合法回执：presets 数组原样收下", () => {
  const rows = parsePresetRoster({ presets: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual(presetIds(rows), ["a", "b"]);
});

test("合法空表：该部署确实没声明 preset，如实返回空", () => {
  assert.deepEqual(parsePresetRoster({ presets: [] }), []);
});

test("回执形状不对 → 抛错（不返回空表）", () => {
  // 返回空表会被 open 的预检读成「没有任何名字合法」，把合法名字一起拒掉——正是 fail-open 要防的事。
  for (const bad of [null, undefined, {}, { presets: null }, { presets: "standard" }, []]) {
    assert.throws(() => parsePresetRoster(bad), /no presets array/, "应拒：" + JSON.stringify(bad));
  }
});

test("行级脏数据只被滤掉，不让一行坏数据把整份读取判死", () => {
  const rows = parsePresetRoster({ presets: [{ id: "a" }, null, 42, "x", { id: "b" }] });
  assert.deepEqual(presetIds(rows), ["a", "b"]);
});

test("formatRow 对 null 行不炸（导出函数，不受解析器的行过滤保护）", async () => {
  const { formatRow } = await import("@dshana/tools/actions/presets.ts");
  assert.doesNotThrow(() => formatRow(null));
  assert.doesNotThrow(() => formatRow(undefined));
  assert.equal(formatRow({ id: "a", name: "甲", order: 1, isDefault: true }), "a（甲）  [默认；order 1]");
});
