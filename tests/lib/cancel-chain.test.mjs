// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/cancel-chain.test.mjs — src/lib/cancel-chain.js 纯函数单测（计划/超时解析）
// 执行器依赖宿主 ctx（app-runtime 注入），仅在无宿主时验证纯面与设置注入路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAppRuntime } from "../../src/lib/app-runtime.ts";
import {
  planCancel,
  requestCancel,
  settleCancelTerminal,
  resolveTaskTimeoutSec,
  resolveApprovalTimeoutMs,
} from "../../src/lib/cancel-chain.ts";
import { cancelAccepted } from "../../src/lib/dsh-rpc.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";

test("planCancel: 无取消标记 → 需 DSH cancel；有标记 → 幂等不重复", () => {
  const fresh = { dshSessionId: SID, taskId: "task-1", rpcId: "r_1", status: "running", cancel: null };
  assert.deepEqual(planCancel(fresh), { sessionId: SID, taskId: "task-1", dshCancelNeeded: true, hostEscalateAvailable: true });
  const marked = { ...fresh, cancel: { at: 2, reason: "user" } };
  assert.deepEqual(planCancel(marked), { sessionId: SID, taskId: "task-1", dshCancelNeeded: false, hostEscalateAvailable: true });
  assert.deepEqual(planCancel(null), { sessionId: "", taskId: "", dshCancelNeeded: false, hostEscalateAvailable: false });
});

test("cancelAccepted: 空值/ok/accepted 视为接受", () => {
  assert.equal(cancelAccepted(undefined), true);
  assert.equal(cancelAccepted(null), true);
  assert.equal(cancelAccepted({}), false);
  assert.equal(cancelAccepted({ ok: true }), true);
  assert.equal(cancelAccepted({ accepted: true }), true);
  assert.equal(cancelAccepted({ ok: false }), false);
});

test("requestCancel: 发请求即返回，终态结算丢后台（不占工具回调）", async () => {
  const order = [];
  let releaseSettle;
  const gate = new Promise((res) => { releaseSettle = res; });
  const deps = {
    executeCancel: async () => {
      order.push("execute");
      return { status: "cancelling", sessionId: SID, taskId: "task-9", dshAccepted: true };
    },
    settle: async (a) => {
      order.push("settle:" + a.taskId);
      await gate;
      order.push("settled");
      return { settled: "escalated" };
    },
  };
  const t0 = Date.now();
  const out = await requestCancel({ sessionId: SID, reason: "user", deps, confirmMs: 15000 });
  const ms = Date.now() - t0;
  assert.equal(out.status, "cancelling");
  assert.equal(out.taskId, "task-9");
  assert.deepEqual(order, ["execute", "settle:task-9"], "返回应发生在结算完成之前");
  assert.ok(ms < 50, "不该等确认窗口（实测 " + ms + "ms）");
  releaseSettle();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["execute", "settle:task-9", "settled"], "结算仍在后台跑完");
});

test("requestCancel: 非 cancelling 分支（无绑定/幂等/DSH 不可达）不启动结算", async () => {
  let settled = 0;
  const deps = {
    executeCancel: async () => ({ status: "no-active-work", sessionId: SID, taskId: null }),
    settle: async () => { settled += 1; return { settled: "unresolved" }; },
  };
  const out = await requestCancel({ sessionId: SID, deps });
  assert.equal(out.status, "no-active-work");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, 0, "没有 taskId 就不该进结算");
});

test("settleCancelTerminal: 终态 → terminal；超窗 → 升级宿主 cancel；升级失败 → unresolved", async () => {
  const ok = await settleCancelTerminal({
    taskId: "t1",
    deps: {
      awaitTerminal: async () => ({ status: "canceled" }),
      cancelHostTask: async () => { throw new Error("不该升级"); },
    },
  });
  assert.deepEqual(ok, { settled: "terminal", terminal: { status: "canceled" } });

  const escalated = [];
  const esc = await settleCancelTerminal({
    taskId: "t2",
    deps: {
      awaitTerminal: async () => null,
      cancelHostTask: async (id, reason) => { escalated.push([id, reason]); },
    },
  });
  assert.deepEqual(esc, { settled: "escalated" });
  assert.deepEqual(escalated, [["t2", "cancel-confirm-timeout"]], "超窗用固定 reason 升级");

  const unresolved = await settleCancelTerminal({
    taskId: "t3",
    deps: { awaitTerminal: async () => null, cancelHostTask: async () => { throw new Error("宿主不支持"); } },
  });
  assert.deepEqual(unresolved, { settled: "unresolved" });

  assert.deepEqual(await settleCancelTerminal({ taskId: "", deps: {} }), { settled: "unresolved" }, "无 taskId 直接 unresolved");
});

test("resolveTaskTimeoutSec / resolveApprovalTimeoutMs：无宿主回落与自持设置注入", () => {
  initAppRuntime(null); // 无宿主：回落
  assert.equal(resolveTaskTimeoutSec(0), 1800);
  assert.equal(resolveTaskTimeoutSec(undefined), 1800);
  assert.equal(resolveTaskTimeoutSec(120), 120);
  assert.equal(resolveApprovalTimeoutMs(), 30000); // 缺省 30s

  // 超时值住在自持设置里（dataDir/settings.json，与数据模式同栈）
  const dir = mkdtempSync(join(tmpdir(), "dshana-timeout-"));
  try {
    const write = (settings) =>
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ version: 1, revision: 1, settings }),
        "utf8",
      );
    const base = { mode: "private", path: null, profile: "dshana" };
    write({ ...base, defaultTimeoutSec: 90, approvalTimeoutSec: 7 });
    initAppRuntime({ ctx: {}, dataDir: dir });
    assert.equal(resolveTaskTimeoutSec(0), 90);
    assert.equal(resolveTaskTimeoutSec(60), 60);
    assert.equal(resolveApprovalTimeoutMs(), 7000);

    write({ ...base, defaultTimeoutSec: 0, approvalTimeoutSec: 0 });
    assert.equal(resolveApprovalTimeoutMs(), 0, "approvalTimeoutSec=0 = 显式禁用");
    assert.equal(resolveTaskTimeoutSec(0), 1800, "defaultTimeoutSec=0 视同未设，回落缺省 1800");
  } finally {
    initAppRuntime(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
