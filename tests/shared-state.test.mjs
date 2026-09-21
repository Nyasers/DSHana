// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/shared-state.test.mjs — UI 跨面共享通道的键挑选与生命周期收尾（src/lib/shared-state.ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHARED_KEY_PREFIX, listSharedKeys, renewSharedState } from "../src/lib/shared-state.ts";

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
