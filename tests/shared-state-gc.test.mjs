// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/shared-state-gc.test.mjs — 应用态存储里陈旧共享键的挑选与回收（src/lib/shared-state-gc.ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHARED_KEY_PREFIX,
  SHARED_KEY_KEEP_MS,
  pickStaleSharedKeys,
  pruneSharedState,
} from "../src/lib/shared-state-gc.ts";

const NOW = 1_800_000_000_000;
const key = (id, kind = "boot-state") => `${SHARED_KEY_PREFIX}${id}.${kind}`;

test("只动本应用共享通道前缀的键", () => {
  const entries = {
    [key("card-a")]: { at: 0 },
    "dshana.other.key": { at: 0 },
    "other.app.card.x.boot-state": { at: 0 },
  };
  assert.deepEqual(pickStaleSharedKeys(entries, NOW), [key("card-a")]);
});

test("活快照（窗口内）保留，超窗回收", () => {
  const entries = {
    [key("fresh")]: { at: NOW - 60_000 },
    [key("edge")]: { at: NOW - SHARED_KEY_KEEP_MS + 1 },
    [key("old")]: { at: NOW - SHARED_KEY_KEEP_MS - 1 },
  };
  assert.deepEqual(pickStaleSharedKeys(entries, NOW), [key("old")]);
});

test("at<=0、缺失、非对象值一律回收", () => {
  const entries = {
    [key("stale-marker")]: { at: 0, state: {} },
    [key("missing")]: { state: {} },
    [key("not-object")]: "x",
    [key("null")]: null,
    [key("nan")]: { at: Number.NaN },
    [key("alive")]: { at: NOW - 1 },
  };
  const expected = [key("missing"), key("nan"), key("not-object"), key("null"), key("stale-marker")].sort();
  assert.deepEqual(pickStaleSharedKeys(entries, NOW), expected);
});

test("空/缺省输入不炸", () => {
  assert.deepEqual(pickStaleSharedKeys(null, NOW), []);
  assert.deepEqual(pickStaleSharedKeys({}, NOW), []);
});

test("pruneSharedState：只删该删的，单个删除失败只记数", async () => {
  const entries = {
    [key("fresh")]: { at: NOW - 1 },
    [key("old")]: { at: 1 },
    [key("boom")]: { at: 1 },
    "dshana.keep": { at: 1 },
  };
  const deleted = [];
  const store = {
    async getAll() {
      return { entries };
    },
    async delete(k) {
      if (k === key("boom")) throw new Error("宿主拒绝");
      deleted.push(k);
    },
  };
  const r = await pruneSharedState(store, NOW);
  assert.equal(r.scanned, 4);
  assert.equal(r.removed, 1);
  assert.equal(r.failed, 1);
  assert.deepEqual(deleted, [key("old")]);
});

test("pruneSharedState：存储面缺失或 getAll 抛错都只是 no-op", async () => {
  assert.deepEqual(await pruneSharedState(null, NOW), { scanned: 0, removed: 0, failed: 0 });
  assert.deepEqual(await pruneSharedState({}, NOW), { scanned: 0, removed: 0, failed: 0 });
  const broken = {
    async getAll() {
      throw new Error("宿主不可达");
    },
    async delete() {},
  };
  assert.deepEqual(await pruneSharedState(broken, NOW), { scanned: 0, removed: 0, failed: 0 });
});
