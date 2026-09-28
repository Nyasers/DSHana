// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/clipboard-forward.test.mjs — DSH 剪贴板写请求的一层纯转发
//
// 锁死「纯转发」的定义：
//   ① 桥可用时只转发，原生一次都不碰（嵌入场景里原生被 Permissions-Policy 关死，
//      碰它只会刷一条 [Violation]）；
//   ② **桥拒绝也不回落原生**：失败由应用侧用 reject 表达，转发层原样交回；
//   ③ 没有可转发的目标（桥缺席 / clipboardWrite 不是函数）就不装，页面保持原生行为；
//   ④ 安装幂等、可逆，且覆盖实例方法 + 原型方法。
// 另加：只有图 / 富文本时明确失败，不假装成功。

import test from "node:test";
import assert from "node:assert/strict";

import { createClipboardForward, installClipboardForward } from "../../src/ui/clipboard-forward.ts";

/** 造一个假的宿主窗：navigator.clipboard + Clipboard 原型 + 记录。 */
function fakeWindow({ withClipboard = true } = {}) {
  const calls = [];
  class Clipboard {
    writeText(text) {
      calls.push({ kind: "native", text });
      return Promise.resolve();
    }
  }
  const clipboard = withClipboard ? new Clipboard() : null;
  const target = {
    navigator: withClipboard ? { clipboard } : {},
    Clipboard,
    __DSHANA__: undefined,
  };
  target.calls = calls;
  return { target, clipboard, calls };
}

test("桥可用：只转发，原生零调用（不触发 Permissions-Policy violation）", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve({ written: true }); } };
  installClipboardForward({ target });
  await clipboard.writeText("hello");
  assert.deepEqual(bridged, ["hello"]);
  assert.equal(calls.length, 0);
});

test("桥拒绝：原样 reject，原生一次都不碰（纯转发不回落）", async () => {
  const { target, clipboard, calls } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.reject(new Error("not allowed in card slots")) };
  installClipboardForward({ target, warn: () => {} });
  await assert.rejects(() => clipboard.writeText("a"), /not allowed in card slots/);
  assert.equal(calls.length, 0, "桥拒绝后不该回落原生——失败是应用侧用 reject 表达的");
});

test("转发结果原样交回（resolve 什么就 resolve 什么）", async () => {
  const { target, clipboard } = fakeWindow();
  const payload = { written: true };
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve(payload) };
  installClipboardForward({ target });
  assert.equal(await clipboard.writeText("x"), payload);
});

test("桥同步抛错：转成 reject，不碰原生", async () => {
  const { target, clipboard, calls } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => { throw new Error("bridge exploded"); } };
  installClipboardForward({ target, warn: () => {} });
  await assert.rejects(() => clipboard.writeText("x"), /bridge exploded/);
  assert.equal(calls.length, 0);
});

test("write(items)：text/plain 走桥且不碰原生", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve({ written: true }); } };
  clipboard.write = (items) => { calls.push({ kind: "native-write", items }); return Promise.resolve(); };
  installClipboardForward({ target });
  const item = { types: ["text/plain"], getType: () => Promise.resolve({ text: () => Promise.resolve("hi") }) };
  await clipboard.write([item]);
  assert.deepEqual(bridged, ["hi"]);
  assert.equal(calls.length, 0, "走桥时不该碰原生");
});

test("write(items)：只有图像时明确失败，不回落原生", async () => {
  const { target, clipboard, calls } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve({ written: true }) };
  clipboard.write = (items) => { calls.push({ kind: "native-write", items }); return Promise.resolve(); };
  installClipboardForward({ target, warn: () => {} });
  const image = { types: ["image/png"], getType: () => Promise.resolve({ text: () => Promise.resolve("ignored") }) };
  await assert.rejects(() => clipboard.write([image]), /text\/plain/);
  assert.equal(calls.length, 0);
});

test("extractText：取第一个 text/plain；只认 types 里的文本项", async () => {
  const { extractText } = createClipboardForward({ bridge: null });
  const items = [
    { types: ["image/png"], getType: () => Promise.resolve({ text: () => Promise.resolve("no") }) },
    { types: ["text/plain;charset=utf-8"], getType: () => Promise.resolve({ text: () => Promise.resolve("yes") }) },
  ];
  assert.equal(await extractText(items), "yes");
  assert.equal(await extractText([{ types: ["image/png"], getType: () => Promise.resolve({ text: () => Promise.resolve("no") }) }]), null);
  assert.equal(await extractText([]), null);
});

test("桥缺席：不装，页面保持原生行为", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const nativeInstance = clipboard.writeText;
  installClipboardForward({ target });
  assert.equal(clipboard.writeText, nativeInstance, "没有可转发的目标就不该接管");
  await clipboard.writeText("plain");
  assert.deepEqual(calls, [{ kind: "native", text: "plain" }]);
});

test("clipboardWrite 不是函数：同样不装", async () => {
  const { target, clipboard } = fakeWindow();
  const nativeInstance = clipboard.writeText;
  target.__DSHANA__ = { clipboardWrite: "nope" };
  installClipboardForward({ target });
  assert.equal(clipboard.writeText, nativeInstance);
});

test("实例 + 原型都换掉，disposer 还原到原值，二次安装是空操作", async () => {
  const { target, clipboard } = fakeWindow();
  const nativeProto = target.Clipboard.prototype.writeText;
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve(true) };

  const dispose = installClipboardForward({ target });
  assert.notEqual(clipboard.writeText, nativeProto, "实例方法应被换成转发实现");
  assert.notEqual(target.Clipboard.prototype.writeText, nativeProto, "原型方法应被换成转发实现");
  assert.equal(clipboard.writeText, target.Clipboard.prototype.writeText, "两层是同一个转发实现");

  const second = installClipboardForward({ target });
  assert.equal(typeof second, "function");
  dispose();
  assert.equal(clipboard.writeText, nativeProto);
  assert.equal(target.Clipboard.prototype.writeText, nativeProto);
  // 先装的那次已撤销；此时"二次安装"返回的空 disposer 不应报错
  second();

  const again = installClipboardForward({ target });
  assert.notEqual(clipboard.writeText, nativeProto, "撤销后可以重新安装");
  again();
});

test("没有 clipboard API 时静默跳过（不阻断页面）", () => {
  const { target } = fakeWindow({ withClipboard: false });
  const dispose = installClipboardForward({ target });
  assert.equal(typeof dispose, "function");
  dispose();
});

test("装配失败（属性不可写）走 warn，不静默", () => {
  const { target, clipboard } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve(true) };
  Object.defineProperty(clipboard, "writeText", { value: clipboard.writeText, writable: false, configurable: false });
  const warns = [];
  installClipboardForward({ target, warn: (message, error) => warns.push([message, error]) });
  assert.equal(warns.length, 1);
  assert.match(String(warns[0][0]), /writeText/);
});

test("createClipboardForward：桥存在时原生的同步抛错不会被碰到", async () => {
  const { writeText } = createClipboardForward({ bridge: { clipboardWrite: () => Promise.resolve(undefined) } });
  await writeText("x");
});
