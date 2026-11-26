// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/tools/skill-params-doc.test.mjs — 技能面（随包）与仓库面的分工闸
//
// 四个读者，四个位置：
//   · skills/dshana/          —— 随包，读者是**调用** dshana 的 agent（怎么用）
//   · .agents/skills/         —— 不随包，读者是改这个 App 源码的协作者（怎么改、怎么验）
//   · dshana-install-skill/   —— 随仓库不随包，读者是拿到仓库链接要**装** DSHana 的外部 agent
//   · DESIGN.md               —— 不随包，写给人看的设计叙事
//
// 字段表由 derive 从 zod 定义直出到 skills/dshana/references/parameters.md（与 parameters
// 同源）；只调用方用得上的内容按「什么时候需要读」拆成 references/ 下的几份，开发闭环在
// .agents/skills/。
//
// 这里守四件事：
//   ① 生成物与当前 zod 定义一致（derive --check 是 CI 门禁；此处再拦一道，直接跑测试也能发现）；
//   ② SKILL.md 指到了每一份随包参照，且不再自带字段表（回退成手写表就会在这里红）；
//   ③ 跨字段约束仍在 SKILL.md 正文里（那半推导不出来，删了就没人讲）；
//   ④ 开发闭环在仓库侧：它不是随包参照，仓库侧手册存在且被 SKILL.md 指到。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

// 拆分后 SKILL.md 是「怎么用」，其余按「什么时候读」分家。这里把分工钉住：
// 两个面都不能把对方的活抢回去（实现内幕回 SKILL，或调用步骤搬走让每次触发都读不到）。
test("按需阅读面：SKILL.md 的指针表与 references/ 实际文件一一对应", () => {
  const skill = read("skills/dshana/SKILL.md");
  const named = [...new Set([...skill.matchAll(/references\/([\w.-]+\.md)/g)].map((m) => m[1]))];
  assert.ok(named.includes("parameters.md"), "字段表必须被指到");
  for (const name of named) {
    assert.doesNotThrow(() => read("skills/dshana/references/" + name), "SKILL.md 指到了不存在的 " + name);
  }
  const onDisk = readdirSync(join(ROOT, "skills", "dshana", "references")).filter((f) => f.endsWith(".md"));
  const unlisted = onDisk.filter((f) => !named.includes(f));
  assert.deepEqual(unlisted, [], "references/ 下有 SKILL.md 没指到的文件（模型找不到）：" + unlisted.join(", "));
});

// 这两段只在特定场合用得上（出错时、开窗口时），不该占每次触发的预算。
test("只在特定场合用到的内容搬出了 SKILL.md", () => {
  const skill = read("skills/dshana/SKILL.md");
  assert.doesNotMatch(skill, /^## Troubleshooting$/m, "排障步骤按需读");
  assert.doesNotMatch(skill, /^## Known limitations$/m, "已知限制按需读");
  assert.doesNotMatch(skill, /^## Theme$/m, "主题说明按需读");
  assert.doesNotMatch(skill, /^## First install/m, "安装说明按需读");
  // 搬走的内容真的在参照里（否则是删了而不是搬了）
  assert.match(read("skills/dshana/references/troubleshooting.md"), /^## Known limitations$/m);
  assert.match(read("skills/dshana/references/setup.md"), /^## First install/m);
  assert.match(read("skills/dshana/references/ui.md"), /^## Theme$/m);
});

// 开发闭环的读者是改源码的协作者，不是调用 dshana 的 agent；它不该占每次触发的预算。
test("开发闭环在仓库侧，不在随包技能里", () => {
  const skill = read("skills/dshana/SKILL.md");
  assert.doesNotMatch(skill, /^## After changing source/m, "开发闭环不该在随包 SKILL 里");
  // 也不该作为随包参照文件存在（它不该被拷进包）
  const refs = readdirSync(join(ROOT, "skills", "dshana", "references"));
  assert.ok(!refs.includes("development.md"), "开发闭环不该随包（development.md 应已移出 references/）");
  // 它真在仓库侧的技能面里
  assert.doesNotThrow(() => read(".agents/skills/dshana-dev-loop/SKILL.md"), "仓库侧要有开发手册");
  // SKILL.md 要把它指出来（否则协作者找不到）
  assert.match(skill, /\.agents\/skills\/dshana-dev-loop/, "SKILL.md 要指向仓库侧手册");
});

test("跨字段约束留在 SKILL.md：schema 表达不了，不能跟着表一起删掉", () => {
  const skill = read("skills/dshana/SKILL.md");
  assert.match(skill, /exactly one of `taskId`/, "reply 的目标二选一");
  assert.match(skill, /at least one/, "close / get 至少一个");
  assert.match(skill, /`open` takes no `sessionId`/, "open 不收 sessionId");
});

