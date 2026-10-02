// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/routes/faces-hub.test.mjs — 面间直投通道的服务端半（packages/tools/src/faces-hub.ts）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFacesHub } from "@dshana/tools/faces-hub.ts";

const CARD = "card-1";

function send(over = {}) {
  return {
    card: CARD, sub: "f1", from: "navigation", to: "workspace",
    kind: "selection", payload: { sessionId: "s1" }, at: 100, ...over,
  };
}

function poll(over = {}) {
  return { card: CARD, sub: "m1", as: "workspace", since: 0, fresh: true, ...over };
}

/** 给挂起的 promise 装个观察窗（不 await 也能看它落没落）。 */
function watch(promise) {
  const rec = { settled: false, value: undefined, error: undefined };
  promise.then((v) => { rec.settled = true; rec.value = v; }, (e) => { rec.settled = true; rec.error = e; });
  return rec;
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));

test("指名投递：只有命中的面收得到，回执说清投到了几个面", async () => {
  const hub = createFacesHub({ parkMs: 40 });
  const main = watch(hub.poll(poll({ fresh: false })));
  const fp = watch(hub.poll(poll({ sub: "f1", as: "navigation", fresh: false })));
  await tick();
  assert.equal(main.settled, false, "首挂没有当前帧 → 挂着");
  assert.equal(fp.settled, false);

  const sent = await hub.send(send({ to: "workspace" }));
  assert.equal(sent.ok, true);
  assert.equal(sent.seq, 1);
  assert.equal(sent.delivered, 1, "只有主卡命中");

  await tick();
  assert.equal(main.settled, true);
  assert.equal(main.value.frames.length, 1);
  assert.deepEqual(main.value.frames[0].payload, { sessionId: "s1" });
  assert.equal(fp.settled, false, "FP 不在收件人里，继续挂着");
  await tick(60);
  assert.equal(fp.value.frames.length, 0, "挂起到超时只回心跳");
});

test("others 排除的是发射的那份文档：同角色的另一份文档照样收", async () => {
  const hub = createFacesHub({ parkMs: 40 });
  const self = watch(hub.poll(poll({ sub: "f1", as: "navigation", fresh: false })));
  const peer = watch(hub.poll(poll({ sub: "f2", as: "navigation", fresh: false })));
  const main = watch(hub.poll(poll({ fresh: false })));
  await tick();

  const sent = await hub.send(send({ sub: "f1", from: "navigation", to: "others" }));
  assert.equal(sent.delivered, 2, "主卡 + 另一份导航文档");
  await tick();
  assert.equal(self.settled, false, "自己那份不收自己的投递");
  assert.equal(peer.settled, true);
  assert.equal(main.settled, true);
});

test("首挂（fresh）当场给快照，不回放历史帧；之后的挂起才算跟随", async () => {
  const hub = createFacesHub({ parkMs: 30 });
  await hub.send(send({ to: "workspace" }));            // 地上已经有一帧
  const born = await hub.poll(poll({ sub: "m9", as: "workspace" }));
  assert.equal(born.seq, 1);
  assert.deepEqual(born.frames, [], "首挂不给历史帧");
  assert.deepEqual(born.state, { selection: { value: { sessionId: "s1" }, at: 100 } }, "给的是当前值");

  // 带着刚对齐的序号再挂：只等新帧
  const waiting = watch(hub.poll(poll({ sub: "m9", as: "workspace", since: born.seq, fresh: false })));
  await tick();
  assert.equal(waiting.settled, false);
  await hub.send(send({ to: "workspace", payload: { sessionId: "s2" }, at: 200 }));
  await tick();
  assert.equal(waiting.value.frames.length, 1);
  assert.deepEqual(waiting.value.frames[0].payload, { sessionId: "s2" });
});

test("断线重连（非首挂）：带上同一个 since 就只补缺的那几帧", async () => {
  const hub = createFacesHub({ parkMs: 30 });
  const first = await hub.poll(poll({ since: 0 }));
  const base = first.seq;
  await hub.send(send({ sub: "f1", from: "navigation", to: "others", payload: { sessionId: "s2" }, at: 200 }));
  await hub.send(send({ sub: "f1", from: "navigation", to: "others", payload: { sessionId: "s3" }, at: 300 }));
  const again = await hub.poll(poll({ since: base, fresh: false }));
  assert.equal(again.frames.length, 2);
  assert.deepEqual(again.frames.map((f) => f.payload.sessionId), ["s2", "s3"]);
  assert.equal(again.reset, undefined);

  const nothing = await hub.poll(poll({ since: again.seq, fresh: false, sub: "m2" }));
  assert.deepEqual(nothing.frames, []);
  assert.equal(nothing.seq, 2, "没有新帧时 seq 回到当前值");
});

test("序号倒退（服务端半重启过）→ reset，改以 state 重建", async () => {
  const hub = createFacesHub({ parkMs: 30 });
  const res = await hub.poll(poll({ since: 999, fresh: false }));
  assert.equal(res.reset, true);
  assert.equal(res.seq, 0);
  assert.deepEqual(res.frames, []);
  assert.deepEqual(res.state, {});
});

test("环形缓冲没兜住 → reset（不假装补上了）", async () => {
  const hub = createFacesHub({ parkMs: 30, ringSize: 2 });
  for (const at of [10, 20, 30, 40]) await hub.send(send({ to: "others", at }));
  const res = await hub.poll(poll({ since: 1, fresh: false }));
  assert.equal(res.reset, true, "since 早于缓冲下界");
  assert.equal(res.seq, 4);
  const fine = await hub.poll(poll({ sub: "m3", since: 3, fresh: false }));
  assert.equal(fine.reset, undefined, "since 落在缓冲区里就不 reset");
  assert.equal(fine.frames.length, 1);
});

test("state 类 kind 写权威记录（单写者）；冷启动从记录把当前值读回", async () => {
  const writes = [];
  let record = null;
  const hub = createFacesHub({
    parkMs: 30,
    readRecord: async (key) => (record && record.key === key ? record.value : null),
    writeRecord: async (key, value) => { writes.push({ key, value }); record = { key, value }; },
  });
  await hub.send(send({ to: "workspace", payload: { sessionId: "s7" }, at: 555 }));
  assert.deepEqual(writes, [{ key: "dshana.selection", value: { value: { sessionId: "s7" }, at: 555 } }]);

  const cold = createFacesHub({
    parkMs: 30,
    readRecord: async (key) => (key === "dshana.selection" ? { value: { sessionId: "s7" }, at: 555 } : null),
  });
  const seeded = await cold.poll(poll({ since: 0 }));
  assert.deepEqual(seeded.state, { selection: { value: { sessionId: "s7" }, at: 555 } });
});

test("镜像写入失败不回滚投递（只留痕）", async () => {
  const logs = [];
  const hub = createFacesHub({
    parkMs: 30,
    writeRecord: async () => { throw new Error("storage down"); },
    log: (msg) => logs.push(msg),
  });
  const sent = await hub.send(send({ to: "workspace" }));
  assert.equal(sent.ok, true);
  assert.equal(sent.seq, 1);
  assert.match(logs.join("\n"), /镜像写入失败/);
});

test("没有匹配的订阅面 → delivered 0（如实回报，不假装投出去了）", async () => {
  const hub = createFacesHub({ parkMs: 30 });
  const sent = await hub.send(send({ to: "stream" }));
  assert.equal(sent.delivered, 0);
  assert.equal(typeof hub.stats()[0].card, "string");
});

test("作用域隔离：不同卡片实例的帧互不可见", async () => {
  // parkMs 给得比用例跑得久：否则“另一张卡仍挂着”可能只是它自己超时了。
  const hub = createFacesHub({ parkMs: 150 });
  const a = watch(hub.poll(poll({ card: "a", sub: "ma", as: "workspace", fresh: false })));
  const b = watch(hub.poll(poll({ card: "b", sub: "mb", as: "workspace", fresh: false })));
  await tick();
  await hub.send(send({ card: "a", to: "workspace" }));
  await tick();
  assert.equal(a.value.frames.length, 1);
  assert.equal(b.settled, false, "另一张卡的订阅面不受影响");
});
