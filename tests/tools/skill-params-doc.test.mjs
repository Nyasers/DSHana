// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/tools/skill-params-doc.test.mjs — 参数参照与 SKILL 的分工闸
//
// SKILL.md 原先手写一张 Required/Optional 表，与 parameters 是同一事实的两份副本：改一次工具
// 就要回去对齐一次，漏改则模型照着旧表传参。现在字段表由 derive 从 zod 定义直出到
// skills/dshana/references/parameters.md（同一份源，与 parameters 同源），SKILL.md 只留指针与
// schema 表达不了的跨字段约束。
//
// 这里守三件事：
//   ① 生成物与当前 zod 定义一致（derive --check 是 CI 门禁；此处再拦一道，直接跑测试也能发现）；
//   ② SKILL.md 指到了那份参照，且不再自带字段表（回退成手写表就会在这里红）；
//   ③ 跨字段约束仍在 SKILL.md 正文里（那半推导不出来，删了就没人讲）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderParamsDoc } from "../../scripts/derive/params-doc.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC_REL = "skills/dshana/references/parameters.md";
const read = (rel) => readFileSync(join(ROOT, ...rel.split("/")), "utf8");

test("参数参照与 zod 定义一致（漂了就重跑 derive skill-params）", () => {
  const onDisk = read(DOC_REL);
  assert.equal(onDisk, renderParamsDoc(), `${DOC_REL} 与当前定义不一致：跑 node scripts/derive/index.mts skill-params`);
});

test("每个 action 各一节，判别键 action 不混进字段表", () => {
  const doc = read(DOC_REL);
  for (const cmd of ["open", "reply", "close", "get", "approve"]) {
    assert.match(doc, new RegExp("^## `" + cmd + "` — ", "m"), "缺 " + cmd + " 一节");
  }
  assert.doesNotMatch(doc, /^\| `action` \|/m, "action 是判别键，不是入参，不该进字段表");
});

test("字段来自 schema：required 与模型面一致，sessionId 带形态约束", () => {
  const doc = read(DOC_REL);
  // open 的 task/cwd 必填，其余可选（与 parameters.required 同源）
  assert.match(doc, /^\| `task` \| string \| yes \|/m);
  assert.match(doc, /^\| `cwd` \| string \| yes \|/m);
  assert.match(doc, /^\| `label` \| string \| no \|/m);
  // approve 的 outcome 是 enum 投影
  assert.match(doc, /^\| `outcome` \| `allowed-once` \\?\| `rejected` \| no \|/m);
  // sessionId 的 pattern 如实带出（约束关键字来自 schema）
  assert.match(doc, /`pattern` = `\^\[sS\]\[eE\]\[sS\]\[sS\]\[iI\]\[oO\]\[nN\]-/);
});

test("SKILL.md 指向参照，且不再自带字段表", () => {
  const skill = read("skills/dshana/SKILL.md");
  assert.match(skill, /references\/parameters\.md/, "要明确指到那份参照");
  // 旧表的两列标题是「手写副本」的指纹；回来了就是又抄了一份
  assert.doesNotMatch(skill, /\| action \| Required \| Optional \| Semantics \|/, "SKILL.md 不该再自带字段表");
  assert.doesNotMatch(skill, /^\| `open` \| task, cwd \|/m, "旧的手写字段表残留");
});

test("跨字段约束留在 SKILL.md：schema 表达不了，不能跟着表一起删掉", () => {
  const skill = read("skills/dshana/SKILL.md");
  assert.match(skill, /exactly one of `taskId`/, "reply 的目标二选一");
  assert.match(skill, /at least one/, "close / get 至少一个");
  assert.match(skill, /`open` takes no `sessionId`/, "open 不收 sessionId");
});

// 参照缺失时不响：SKILL.md 那句指针指向一片空白，模型读不到字段说明，而技能照旧加载、不报错。
// 随 skills/ 整树进包，所以出包处加一道断言（缺件拒包），这里钉住它在主流程里真的被调用。
test("出包前断言技能参照在位（缺件拒包）", () => {
  const packAssert = read("scripts/release/pack/assert.mts");
  assert.match(packAssert, /export function assertSkillReferences/, "assert.mts 要有这条断言");
  assert.match(packAssert, /references\/parameters\.md|references", "parameters\.md/, "断言要核到那份参照");
  const pack = read("scripts/release/pack/index.mts");
  assert.match(pack, /assertSkillReferences\(distDir\)/, "pack 主流程要真的调它");
});
