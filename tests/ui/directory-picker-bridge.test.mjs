// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/directory-picker-bridge.test.mjs — 壳页注入的目录桥
//
// 锁死三条不变量：
//   ① 宿主 pick 的结果怎么读：一条路径原样取，空/畸形一律当取消（DSH 把 null 当取消）；
//   ② 桥的形状就是 DSH 客户端读的那一份（`{ pick: () => Promise<string|null> }`），装了能拆、能复原；
//   ③ 宿主 SDK 缺 `resources.pick` 时不静默返回空路径，而是抛给 DSH 自己的错误面。

import test from "node:test";
import assert from "node:assert/strict";

import { installDirectoryPickerBridge, pickedPathOf } from "../../src/ui/dsh-inject.ts";

const KEY = "__DSH_DIRECTORY_PICKER__";

test("pickedPathOf: 有路径原样取，空与畸形当取消", () => {
  assert.equal(pickedPathOf({ resources: [{ kind: "local-file", path: "E:\\work\\a" }] }), "E:\\work\\a");
  assert.equal(pickedPathOf({ resources: [] }), null);
  assert.equal(pickedPathOf({}), null);
  assert.equal(pickedPathOf(undefined), null);
  assert.equal(pickedPathOf({ resources: [{ kind: "local-file" }] }), null);
  assert.equal(pickedPathOf({ resources: ["E:\\work\\a"] }), null);
});

test("桥：pick 调宿主 resources.pick(mode=directory)，取消回 null；拆掉后全局干净", async () => {
  const calls = [];
  const sdk = {
    resources: {
      async pick(input) {
        calls.push(input);
        return { resources: [{ kind: "local-file", path: "E:\\Hanako\\workspace" }] };
      },
    },
  };
  const restore = installDirectoryPickerBridge(sdk);
  assert.equal(typeof globalThis[KEY]?.pick, "function");
  assert.deepEqual(calls, []);
  assert.equal(await globalThis[KEY].pick(), "E:\\Hanako\\workspace");
  assert.deepEqual(calls, [{ mode: "directory" }]);
  restore();
  assert.equal(globalThis[KEY], undefined);

  // 取消：宿主回空列表 → null（DSH 的流程据此走 onCancel，而不是当成失败）
  const cancelled = installDirectoryPickerBridge({ resources: { async pick() { return { resources: [] }; } } });
  assert.equal(await globalThis[KEY].pick(), null);
  cancelled();

  // 先前的值在拆桥时复原
  globalThis[KEY] = { pick: async () => "old" };
  const restore2 = installDirectoryPickerBridge(sdk);
  restore2();
  assert.equal(await globalThis[KEY].pick(), "old");
  delete globalThis[KEY];
});

test("桥：宿主 SDK 没有 resources.pick 时报错，不假装取消", async () => {
  const restore = installDirectoryPickerBridge({});
  await assert.rejects(() => globalThis[KEY].pick(), /resources\.pick/);
  restore();
  assert.equal(globalThis[KEY], undefined);
});

test("桥：壳页没传入且全局也没有 SDK 时报错，错因与上一个分得开", async () => {
  const restore = installDirectoryPickerBridge(undefined);
  await assert.rejects(() => globalThis[KEY].pick(), /没拿到宿主 SDK/);
  restore();
  // 全局上有 SDK 时仍能兼底（别的宿主形态）：
  globalThis.hana = { resources: { async pick() { return { resources: [{ path: "E:\\tmp" }] }; } } };
  const restore2 = installDirectoryPickerBridge(undefined);
  assert.equal(await globalThis[KEY].pick(), "E:\\tmp");
  restore2();
  delete globalThis.hana;
});
