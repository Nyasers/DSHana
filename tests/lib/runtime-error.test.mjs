// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/runtime-error.test.mjs — src/lib/runtime-error.ts 纯函数单测（node --test）
// 覆盖：嵌套 AggregateError 展开、诊断尾巴的有界与截断标记、结构化失败报告的解析与合成。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runtimeErrorState,
  diagnosticTail,
  parseRuntimeFatal,
  fatalReportText,
  DIAGNOSTIC_TRUNCATED,
} from "../../src/lib/runtime-error.ts";

test("runtimeErrorState: 普通 Error / 字符串 / 未知值", () => {
  assert.deepEqual(runtimeErrorState(new Error("boom")), { message: "boom" });
  assert.deepEqual(runtimeErrorState("plain"), { message: "plain" });
  assert.deepEqual(runtimeErrorState(undefined), { message: "undefined" });
});

test("runtimeErrorState: AggregateError 递归展开每一层（空层被丢弃）", () => {
  const agg = new AggregateError([new Error("root"), new Error("second")], "boot failed");
  const state = runtimeErrorState(agg);
  assert.equal(state.message, "boot failed\nroot\nsecond");
  const nested = new AggregateError([new AggregateError([new Error("deep")], "mid")], "outer");
  assert.equal(runtimeErrorState(nested).message, "outer\nmid\ndeep");
});

test("diagnosticTail: 短文本原样（去空白），长文本保留末尾行并加截断标记", () => {
  assert.equal(diagnosticTail("  short  "), "short");
  const lines = Array.from({ length: 20 }, (_, i) => "line-" + i).join("\n");
  const tail = diagnosticTail(lines, 100, 3);
  assert.ok(tail.startsWith(DIAGNOSTIC_TRUNCATED));
  assert.ok(tail.endsWith("line-19"));
  assert.ok(tail.includes("line-17"));
  assert.ok(!tail.includes("line-0"));
});

test("diagnosticTail: 裁掉落在半个代理对上的首字符", () => {
  const text = "🎯".repeat(400); // 每个 2 个 UTF-16 单元
  const tail = diagnosticTail(text, 21, 4);
  // 结果以截断标记开头；标记后的首字符不得是孤立低代理项
  const body = tail.slice(DIAGNOSTIC_TRUNCATED.length + 1);
  assert.ok(!/^[\uDC00-\uDFFF]/u.test(body));
});

test("parseRuntimeFatal: 合法报告归一，形状不符返回 null", () => {
  assert.deepEqual(
    parseRuntimeFatal({ ok: false, kind: "boot-failed", message: "boom", causes: ["a", "", 3] }),
    { kind: "boot-failed", message: "boom", causes: ["a"] },
  );
  assert.equal(parseRuntimeFatal({ ok: true, message: "x" }), null);
  assert.equal(parseRuntimeFatal({ ok: false, message: "" }), null);
  assert.equal(parseRuntimeFatal(null), null);
  assert.equal(parseRuntimeFatal([1, 2]), null);
  assert.deepEqual(parseRuntimeFatal({ ok: false, message: "no kind" }), { kind: "unknown", message: "no kind", causes: [] });
});

test("fatalReportText: 主成因 + 去重成因层，有界", () => {
  const text = fatalReportText({ kind: "boot-failed", message: "root", causes: ["root", "extra"] });
  assert.equal(text, "root\nextra");
});