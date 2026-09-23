// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/session-run.test.mjs — open 的 cwd 契约（src/lib/session-run.ts）
//
// 两段各钉各的：App 侧只判「绝对」（纯字符串，按平台语义）；「存在 / 是目录 / 有但用不了」是受管
// runtime 的 cwd-check 回执，在 sessionCwdRejection 里翻成拒绝理由。errno 决定文案——「不存在」与
// 「看不到」必须给不同的话，否则排查只能靠猜。
//
// 样本路径按平台取：「绝对」的判据是运行平台给的，拿 Windows 盘符路径去跑 Linux 会得到一个
// 失败的单测，而不是一条有价值的断言。
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertAbsoluteSessionCwd, sessionCwdRejection } from "../../src/lib/session-run.ts";

// 路径的「绝对」是平台语义：/srv/work 在两边都算绝对，盘符路径只在 Windows 上算。
test("绝对路径放过", () => {
  assert.equal(assertAbsoluteSessionCwd("/srv/work"), undefined);
  if (process.platform === "win32") {
    assert.equal(assertAbsoluteSessionCwd("E:\\Hanako\\workspace"), undefined);
  }
});

test("相对路径被拒（App 与受管 runtime 的解析基准不同）", () => {
  assert.throws(() => assertAbsoluteSessionCwd("workspace"), /必须是绝对路径/);
  assert.throws(() => assertAbsoluteSessionCwd(".\\workspace"), /必须是绝对路径/);
});

test("runtime 报可用 → 不拒", () => {
  assert.equal(sessionCwdRejection({ ok: true, isDirectory: true }, "/srv/work"), null);
});

test("runtime 报是文件 → 拒，文案指向「不是目录」", () => {
  const bad = sessionCwdRejection({ ok: true, isDirectory: false }, "/srv/work/file.txt");
  assert.ok(bad);
  assert.match(bad.message, /不是目录/);
});

test("ENOENT → 拒，文案说「不存在」", () => {
  const bad = sessionCwdRejection(
    { ok: false, code: "ENOENT", message: "ENOENT: no such file or directory, stat '/srv/gone'" },
    "/srv/gone",
  );
  assert.ok(bad);
  assert.match(bad.message, /cwd 不存在/);
});

test("拿不到权限 → 拒，但与「不存在」分开，且 errno 必须露出来", () => {
  const bad = sessionCwdRejection(
    { ok: false, code: "EACCES", message: "EACCES: permission denied, stat '/srv/x'" },
    "/srv/x",
  );
  assert.ok(bad);
  assert.match(bad.message, /cwd 不可用/);
  assert.match(bad.message, /EACCES/);
  assert.doesNotMatch(bad.message, /不存在/);
});

test("回执形状意外（没有 ok）→ 也拒，且不谎称不存在", () => {
  const bad = sessionCwdRejection({ message: "boom" }, "/srv/x");
  assert.ok(bad);
  assert.match(bad.message, /cwd 不可用/);
  assert.doesNotMatch(bad.message, /不存在/);
});
