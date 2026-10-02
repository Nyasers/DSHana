// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/shared-state.test.mjs — UI 跨面共享通道的键挑选（@dshana/shared/shared-state.ts）
// 与 App 侧生命周期收尾（packages/app/src/shared-state.ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHARED_KEY_PREFIX, listSharedKeys } from "@dshana/shared/shared-state.ts";
import {
  INTENT_KINDS, intentSharedValue, isIntentKind, normalizeIntent,
} from "@dshana/shared/shared-state.ts";
import { renewSharedState } from "@dshana/app/shared-state.ts";

test("只认本通道前缀（广播键 dshana:settings 不是视图状态）", () => {
  const entries = {
    [SHARED_KEY_PREFIX + "boot-state"]: {},
    [SHARED_KEY_PREFIX + "panel-view"]: {},
    "dshana:settings": { revision: 1 },
    "other.app.card.x.boot-state": {},
    "unrelated": {},
  };
  assert.deepEqual(listSharedKeys(entries), [SHARED_KEY_PREFIX + "boot-state", SHARED_KEY_PREFIX + "panel-view"]);
});

test("空/缺省输入不炸", () => {
  assert.deepEqual(listSharedKeys(null), []);
  assert.deepEqual(listSharedKeys({}), []);
});

test("renewSharedState：清空本通道全部键，广播键与他人键不动，单个删除失败只记数", async () => {
  const entries = {
    [SHARED_KEY_PREFIX + "boot-state"]: { at: 1 },
    [SHARED_KEY_PREFIX + "settings-view"]: { open: true },
    [SHARED_KEY_PREFIX + "boom"]: {},
    "dshana:settings": { revision: 3 },
  };
  const deleted = [];
  const store = {
    async getAll() {
      return { entries };
    },
    async delete(k) {
      if (k === SHARED_KEY_PREFIX + "boom") throw new Error("宿主拒绝");
      deleted.push(k);
    },
  };
  const r = await renewSharedState(store);
  assert.equal(r.scanned, 4);
  assert.equal(r.removed, 2);
  assert.equal(r.failed, 1);
  assert.deepEqual(deleted, [SHARED_KEY_PREFIX + "boot-state", SHARED_KEY_PREFIX + "settings-view"]);
});

test("renewSharedState：存储面缺失或 getAll 抛错都只是 no-op", async () => {
  assert.deepEqual(await renewSharedState(null), { scanned: 0, removed: 0, failed: 0 });
  assert.deepEqual(await renewSharedState({}), { scanned: 0, removed: 0, failed: 0 });
  const broken = {
    async getAll() {
      throw new Error("宿主不可达");
    },
    async delete() {},
  };
  assert.deepEqual(await renewSharedState(broken), { scanned: 0, removed: 0, failed: 0 });
});

// ---- 跨面转发：词表与载荷归一（FP 发射意图 → 整幅面落地）----

test("意图词表：封闭，词表外的值一律不认", () => {
  for (const kind of INTENT_KINDS) assert.equal(isIntentKind(kind), true);
  for (const bad of ["settings", "overlay", "", null, undefined, 1, {}, ["selection"]]) {
    assert.equal(isIntentKind(bad), false, String(bad));
  }
  // 既有三件与新增的会话行面都在同一张词表上
  for (const kind of ["settings-view", "panel-view", "selection", "session-rename", "session-archive", "row-toast", "shortcuts-panel"]) {
    assert.ok(INTENT_KINDS.includes(kind), kind);
  }
});

test("封套：载荷原样，at 由写入端盖章", () => {
  assert.deepEqual(intentSharedValue({ sessionId: "s1" }, 7), { value: { sessionId: "s1" }, at: 7 });
  const stamped = intentSharedValue(null);
  assert.equal(stamped.value, null);
  assert.ok(Number.isFinite(stamped.at) && stamped.at > 0);
});

test("载荷归一：多余字段丢掉、缺的补空、脏值归 null", () => {
  assert.deepEqual(normalizeIntent("selection", { sessionId: "s1", at: 9, extra: 1 }), { sessionId: "s1" });
  assert.deepEqual(normalizeIntent("selection", ""), { sessionId: null });
  assert.deepEqual(normalizeIntent("panel-view", { panelId: "" }), { panelId: null });
  assert.deepEqual(normalizeIntent("panel-view", { panelId: "plugins" }), { panelId: "plugins" });
  assert.deepEqual(normalizeIntent("settings-view", { open: "yes", section: "" }), { open: false, section: null });
  assert.deepEqual(normalizeIntent("settings-view", { open: true, section: "models" }), { open: true, section: "models" });
  assert.deepEqual(normalizeIntent("session-rename", { sessionId: "s2", title: "名字" }), { sessionId: "s2", title: "名字" });
  assert.deepEqual(normalizeIntent("session-rename", { sessionId: "s2" }), { sessionId: "s2", title: "" });
  assert.deepEqual(normalizeIntent("session-archive", {}), { sessionId: null, displayTitle: "", activity: [] });
  assert.deepEqual(normalizeIntent("row-toast", { notice: { kind: "archived" } }), { notice: { kind: "archived" } });
  assert.deepEqual(normalizeIntent("row-toast", { notice: "archived" }), { notice: null });
  assert.deepEqual(normalizeIntent("shortcuts-panel", { anything: 1 }), {});
  // 非对象输入不炸
  assert.deepEqual(normalizeIntent("session-archive", null), { sessionId: null, displayTitle: "", activity: [] });
});
