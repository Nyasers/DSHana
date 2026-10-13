// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/tools/descriptions.test.mjs — 工具面 desc 与技能面 desc 的守
//
// 两条 desc 都服务按需加载：常驻的只留够触发的信息，细则在手册正文与 references/ 里。
// 这里只守「能失败、且没有第二者拦得住」的东西：
//   ① 工具 desc（packages/tools/src/index.ts）是模型与手册之间唯一的指针——它必须落在**技能名**
//      上（技能目录按名字给 location 绝对路径），不写仓库相对路径（模型不知道相对谁），不指
//      tool_help（本工具顶层 oneOf，那里参数栏是空的），也不把动作清单再抄一遍（那是手册的活）。
//   ② 技能 desc（skills/dshana/SKILL.md 的 frontmatter）**常驻**在系统提示的 available_skills 段
//      里，决定模型要不要把手册读进来。它消失或说不清自己是谁，手册就等于不存在，而技能照旧
//      加载、不报错——静默失效，只能靠测试拦。
//   ③ 指针的落点四处同名：工具 desc 里的技能名 == frontmatter.name == 所在目录名 == SKILL_NAME。
//      改一处漏改另一处，模型手里的指针就悬空。
//
// 不在这里守的：desc 的措辞与长度（"何时读"该怎么说、常驻行留多长）是编辑判断，正则只能锁住
// 当前写法、锁不住意思，换个说法就红而意思没变。那两条归评审，不归测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { description as toolDescription, SKILL_NAME } from "@dshana/tools/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_PATH = join(ROOT, "skills", "dshana", "SKILL.md");

/** 取 SKILL.md 的 frontmatter 字段（只认单层 `键: 值`）。 */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(m, "SKILL.md 缺 frontmatter：技能目录靠 name/description 才索引得到");
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

const skill = frontmatter(readFileSync(SKILL_PATH, "utf8"));

test("工具 desc 指技能名，不写相对路径、不指 tool_help、不列 action 枚举", () => {
  assert.match(toolDescription, new RegExp("read the `" + SKILL_NAME + "` skill"), "指路要落在技能名上（技能目录按名字给 location）");
  assert.doesNotMatch(toolDescription, /skills\/dshana\/SKILL\.md/, "不写仓库相对路径（模型不知道相对谁）");
  assert.doesNotMatch(toolDescription, /tool_help/, "不指 tool_help（本工具顶层 oneOf，那里参数栏是空的）");
  for (const cmd of ["open", "reply", "close", "get", "approve"]) {
    assert.doesNotMatch(toolDescription, new RegExp("`?" + cmd + "`?\\s*="), "动作清单是手册的活，desc 不抄 " + cmd);
  }
  assert.match(toolDescription, /^DeepSeek Harness/, "开头要说清这是什么工具，不能只剩一句指针");
});

test("技能 desc 在位：常驻行，索引与触发都靠它", () => {
  assert.ok(skill.description && skill.description.length > 0, "frontmatter 缺 description：技能目录索引不到它");
  assert.match(skill.description, /dshana/, "要说清自己是哪个工具的手册");
});

test("指针落点一致：工具 desc 的技能名 = frontmatter.name = 目录名 = SKILL_NAME", () => {
  const dirName = basename(dirname(SKILL_PATH));
  assert.equal(SKILL_NAME, dirName, "SKILL_NAME 要与技能目录名一致");
  assert.equal(skill.name, SKILL_NAME, "frontmatter.name 与源码 SKILL_NAME 不一致：工具那句指路会悬空");
  assert.equal(skill.name, dirName, "frontmatter.name 要与所在目录同名");
});
