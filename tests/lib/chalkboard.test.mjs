// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/chalkboard.test.mjs — 放黑板那一步（src/lib/chalkboard.ts）。
// 立住两件事：写共用选中在前、请宿主开卡在后（顺序反了卡挂上去读到的就是旧选中）；
// 以及缺 SDK 面时在写之前就失败，不留一个「选中改了但卡没开」的半截状态。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_CARD_ID, placeSessionOnChalkboard } from "../../src/lib/chalkboard.ts";
import { SELECTION_SHARED_KEY, SHARED_KEY_PREFIX, selectionSharedValue } from "../../src/lib/shared-state.ts";

/** 假 SDK：记录调用次序与载荷。global 可选「对象」或「工厂」两种形态（SDK 两版都出现过）。 */
function fakeSdk({ globalAsFactory = false, withCards = true, withStorage = true } = {}) {
  const calls = [];
  const store = {
    set(key, value) {
      calls.push(["set", key, value]);
      return Promise.resolve({ ok: true });
    },
  };
  const sdk = {};
  if (withStorage) sdk.storage = { global: globalAsFactory ? () => store : store };
  if (withCards) {
    sdk.cards = {
      open(cardId) {
        calls.push(["open", cardId]);
        return Promise.resolve({ cardInstanceId: "c1", existing: false });
      },
    };
  }
  return { sdk, calls };
}

test("放置：先写共用选中，再请宿主开那张声明卡", async () => {
  const { sdk, calls } = fakeSdk();
  await placeSessionOnChalkboard(sdk, "session-1");

  assert.equal(calls.length, 2, "恰好两步");
  const [first, second] = calls;
  assert.equal(first[0], "set");
  assert.equal(first[1], SELECTION_SHARED_KEY);
  assert.equal(first[1], SHARED_KEY_PREFIX + "selection", "键前缀与共享通道同源");
  assert.equal(first[2].sessionId, "session-1");
  assert.equal(typeof first[2].at, "number", "意见带写入时刻");
  assert.deepEqual(second, ["open", SESSION_CARD_ID]);
});

test("放置：写入值与会话选中契约同形（selectionSharedValue）", async () => {
  const { sdk, calls } = fakeSdk();
  await placeSessionOnChalkboard(sdk, "session-2");
  const value = calls[0][2];
  const expected = selectionSharedValue("session-2", value.at);
  assert.deepEqual(value, expected);
});

test("放置：storage.global 是工厂（可调用对象）也能取到", async () => {
  const { sdk, calls } = fakeSdk({ globalAsFactory: true });
  await placeSessionOnChalkboard(sdk, "session-3");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], SELECTION_SHARED_KEY);
});

test("放置：会话 id 归一（去空白），空 id 直接失败且什么都不写", async () => {
  const { sdk, calls } = fakeSdk();
  await placeSessionOnChalkboard(sdk, "  session-4  ");
  assert.equal(calls[0][2].sessionId, "session-4");

  const empty = fakeSdk();
  await assert.rejects(() => placeSessionOnChalkboard(empty.sdk, "   "), /没有可放到黑板的会话/);
  assert.deepEqual(empty.calls, [], "失败在读坐标阶段，不碰选中也不开卡");
});

test("放置：缺 cards.open 在写选中之前失败（不留半截状态）", async () => {
  const { sdk, calls } = fakeSdk({ withCards: false });
  await assert.rejects(() => placeSessionOnChalkboard(sdk, "session-5"), /hana\.cards\.open 不可用/);
  assert.deepEqual(calls, [], "卡面不可用时不该先改共用选中");
});

test("放置：缺 storage.global 直接失败", async () => {
  const { sdk, calls } = fakeSdk({ withStorage: false });
  await assert.rejects(() => placeSessionOnChalkboard(sdk, "session-6"), /hana\.storage\.global 不可用/);
  assert.deepEqual(calls, []);
});
