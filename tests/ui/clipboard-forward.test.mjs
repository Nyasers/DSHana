// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/clipboard-forward.test.mjs — DSH 剪贴板写口：原生优先，失败才转给应用侧
//
// 锁死这条顺序与它的边界：
//   ① 本文档原生写得成时**只走原生**，兜底桥一次都不碰（声明了能力的 App 直接调，向 githana 看齐）；
//   ② 原生失败（或不存在）才把文本转给应用侧；桥的返回值原样交回；
//   ③ 两条都失败 → reject，以应用侧那条为准，原生那条挂在 `cause` 上；
//   ④ 桥缺席就**不装**（原生本来就够用）；
//   ⑤ 安装幂等、可逆，且覆盖实例方法 + 原型方法。

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

test("原生写得成：只走原生，兜底桥一次都不碰", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve({ written: true }); } };
  installClipboardForward({ target });
  await clipboard.writeText("hello");
  assert.deepEqual(calls, [{ kind: "native", text: "hello" }]);
  assert.equal(bridged.length, 0, "原生成了就不该再转给应用侧");
});

test("原生失败：转给应用侧，桥的返回值原样交回", async () => {
  const { target, clipboard } = fakeWindow();
  clipboard.writeText = () => Promise.reject(new Error("native denied"));
  const payload = { written: true };
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve(payload); } };
  installClipboardForward({ target });
  assert.equal(await clipboard.writeText("a"), payload);
  assert.deepEqual(bridged, ["a"]);
});

test("原生同步抛错：同样落到应用侧", async () => {
  const { target, clipboard } = fakeWindow();
  clipboard.writeText = () => { throw new Error("native threw"); };
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve(true); } };
  installClipboardForward({ target });
  await clipboard.writeText("b");
  assert.deepEqual(bridged, ["b"]);
});

test("两条都失败：reject，以应用侧为准，原生那条挂在 cause 上", async () => {
  const { target, clipboard } = fakeWindow();
  clipboard.writeText = () => Promise.reject(new Error("native denied"));
  target.__DSHANA__ = { clipboardWrite: () => Promise.reject(new Error("host refused: not allowed in card slots")) };
  installClipboardForward({ target, warn: () => {} });
  await assert.rejects(
    () => clipboard.writeText("x"),
    (error) => {
      assert.match(error.message, /host refused/);
      assert.match(String(error.cause && error.cause.message), /native denied/);
      return true;
    },
  );
});

test("原生不存在时：直接转给应用侧", async () => {
  const { target, clipboard } = fakeWindow();
  Object.defineProperty(clipboard, "writeText", { value: undefined, writable: true, configurable: true });
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve(true); } };
  installClipboardForward({ target });
  await clipboard.writeText("c");
  assert.deepEqual(bridged, ["c"]);
});

test("write(items)：原生写得成时只走原生", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve(true); } };
  clipboard.write = (items) => { calls.push({ kind: "native-write", items }); return Promise.resolve(); };
  installClipboardForward({ target });
  const item = { types: ["text/plain"], getType: () => Promise.resolve({ text: () => Promise.resolve("hi") }) };
  await clipboard.write([item]);
  assert.deepEqual(calls.map((c) => c.kind), ["native-write"]);
  assert.equal(bridged.length, 0);
});

test("write(items)：原生失败后取 text/plain 走写文本（仍是原生优先）", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve(true); } };
  clipboard.write = () => Promise.reject(new Error("native write denied"));
  installClipboardForward({ target });
  const item = { types: ["text/plain"], getType: () => Promise.resolve({ text: () => Promise.resolve("hi") }) };
  await clipboard.write([item]);
  assert.deepEqual(calls, [{ kind: "native", text: "hi" }], "取出的文本仍先走原生");
  assert.equal(bridged.length, 0);
});

test("write(items)：只有图像且原生失败 → 明确失败（消息带 text/plain）", async () => {
  const { target, clipboard } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve(true) };
  clipboard.write = () => Promise.reject(new Error("native write denied"));
  installClipboardForward({ target, warn: () => {} });
  const image = { types: ["image/png"], getType: () => Promise.resolve({ text: () => Promise.resolve("ignored") }) };
  await assert.rejects(() => clipboard.write([image]), /text\/plain/);
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
  assert.equal(clipboard.writeText, nativeInstance, "没有兜底目标就不该接管");
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
  assert.notEqual(clipboard.writeText, nativeProto, "实例方法应被换掉");
  assert.notEqual(target.Clipboard.prototype.writeText, nativeProto, "原型方法应被换掉");
  assert.equal(clipboard.writeText, target.Clipboard.prototype.writeText, "两层是同一个实现");

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

test("createClipboardForward：只给桥、没有原生时，写口直接转发", async () => {
  const bridged = [];
  const { writeText } = createClipboardForward({ bridge: { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve(undefined); } } });
  await writeText("x");
  assert.deepEqual(bridged, ["x"]);
});
