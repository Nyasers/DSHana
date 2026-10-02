// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/face-channel.test.mjs — 面间直投通道的客户端半（packages/ui/src/face-channel.ts）
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createFaceChannel } from "@dshana/ui/face-channel.ts";

/** 假宿主管道：get 挂起等人应答（可应答/可失败），post 记账。 */
function makeIO() {
  const state = { pending: [], gets: [], posts: [] };
  return {
    state,
    get(path, signal) {
      state.gets.push(path);
      return new Promise((resolve, reject) => {
        const rec = { path, resolve, reject };
        state.pending.push(rec);
        if (signal) {
          signal.addEventListener("abort", () => {
            const at = state.pending.indexOf(rec);
            if (at >= 0) state.pending.splice(at, 1);
            reject(new Error("aborted"));
          }, { once: true });
        }
      });
    },
    post(path, body) {
      state.posts.push({ path, body });
      return Promise.resolve({ ok: true, seq: 1, delivered: 2, to: body.to });
    },
    reply(body, index = 0) {
      const rec = state.pending.splice(index, 1)[0];
      assert.ok(rec, "没有挂起的 get 可以应答");
      rec.resolve(body);
    },
    fail(error = new Error("boom"), index = 0) {
      const rec = state.pending.splice(index, 1)[0];
      assert.ok(rec, "没有挂起的 get 可以失败");
      rec.reject(error);
    },
  };
}

const tick = (ms = 12) => new Promise((r) => setTimeout(r, ms));

/** 起过循环的通道一律在用例收尾停表：循环里挂着定时器，不停表测试进程不会退出。 */
const live = [];
afterEach(() => { for (const chan of live.splice(0)) { try { chan.stop(); } catch { /* 已停 */ } } });

function makeChannel(io, over = {}) {
  const chan = createFaceChannel({
    role: "workspace", scope: "card-1", io, subId: "m1",
    retryBaseMs: 1, retryMaxMs: 2, requestTimeoutMs: 4000, log: () => {}, ...over,
  });
  live.push(chan);
  return chan;
}

test("首读懒种子：先用权威记录给当前值，不依赖通道就绪（也不开轮询）", async () => {
  const io = makeIO();
  const chan = makeChannel(io, { seed: async () => ({ value: { sessionId: "s1" }, at: 7 }) });
  const hit = await chan.read("selection");
  assert.deepEqual(hit, { value: { sessionId: "s1" }, at: 7 });
  assert.equal(io.state.gets.length, 0, "只读一次不该开轮询");
});

test("publish：指名投递、载荷归一、发射面自己看得见自己的写入", async () => {
  const io = makeIO();
  const chan = makeChannel(io);
  const frames = [];
  chan.onFrame((f) => frames.push(f));

  const res = await chan.publish("selection", { sessionId: "s2", extra: 1 });
  assert.equal(res.delivered, 2);
  assert.deepEqual(io.state.posts[0], {
    path: "dshana/faces/send",
    body: {
      card: "card-1", sub: "m1", from: "workspace", to: "others",
      kind: "selection", payload: { sessionId: "s2" }, at: io.state.posts[0].body.at,
    },
  });
  assert.equal(typeof io.state.posts[0].body.at, "number");
  assert.deepEqual((await chan.read("selection")).value, { sessionId: "s2" });
  assert.equal(frames.length, 1, "自写也通知本地订阅者");
  assert.equal(frames[0].payload.sessionId, "s2");
  await tick();
  assert.equal(io.state.gets.length, 1, "publish 顺手把收件循环起起来");
});

test("收帧：落缓存、通知、下一轮轮询带已见的最大序号", async () => {
  const io = makeIO();
  const chan = makeChannel(io);
  const seen = [];
  chan.onFrame((f) => seen.push(f));
  chan.start();
  await tick();
  assert.match(io.state.gets[0], /since=0/, "首挂从 0 起");
  assert.match(io.state.gets[0], /as=workspace/);
  assert.match(io.state.gets[0], /sub=m1/);

  io.reply({ ok: true, seq: 3, frames: [{ seq: 3, at: 9, from: "navigation", to: "others", kind: "selection", payload: { sessionId: "s9" } }] });
  await tick();
  assert.deepEqual(await chan.read("selection"), { value: { sessionId: "s9" }, at: 9 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].from, "navigation");
  assert.ok(io.state.gets.some((p) => /since=3/.test(p)), "下一次挂起带着已见序号");
  assert.ok(io.state.gets.some((p) => /fresh=0/.test(p)), "拿到过应答之后就不再是首挂");
});

test("首挂的 state 快照落地；同一条快照重复送到不重复通知", async () => {
  const io = makeIO();
  const chan = makeChannel(io);
  const seen = [];
  chan.onFrame((f) => seen.push(f));
  chan.start();
  await tick();
  const snap = { ok: true, seq: 0, frames: [], state: { selection: { value: { sessionId: "s3" }, at: 3 } } };
  io.reply(snap);
  await tick();
  assert.deepEqual((await chan.read("selection")).value, { sessionId: "s3" });
  assert.equal(seen.length, 1);
  io.reply(snap);
  await tick();
  assert.equal(seen.length, 1, "同值同时刻的快照不当成一次变化");
});

test("轮询失败按退避重试，且不丢已见序号", async () => {
  const io = makeIO();
  const chan = makeChannel(io);
  chan.start();
  await tick();
  io.reply({ ok: true, seq: 5, frames: [] });
  await tick();
  io.fail(new Error("connection reset"));
  await tick(30);
  assert.ok(io.state.gets.length >= 3, "失败后要继续挂");
  assert.match(io.state.gets[2], /since=5/, "重连带着已见序号");
});

test("挂起超时（客户端侧）当失败走退避，不会把循环卡死", async () => {
  const io = makeIO();
  const chan = makeChannel(io, { requestTimeoutMs: 5 });
  chan.start();
  await tick(40);
  assert.ok(io.state.gets.length >= 2, "超时后要再挂一次");
});

test("停止后不再轮询；再 start 仍能工作", async () => {
  const io = makeIO();
  const chan = makeChannel(io);
  chan.start();
  await tick();
  const before = io.state.gets.length;
  chan.stop();
  await tick(30);
  assert.equal(io.state.gets.length, before, "停表后不再挂新的");
  chan.start();
  await tick();
  assert.equal(io.state.gets.length, before + 1, "再 start 能重新挂起");
});

test("词表外的 kind 当场拒（不退化成随便塞）", async () => {
  const io = makeIO();
  const chan = makeChannel(io);
  await assert.rejects(() => chan.publish("session-rename", {}), /未知通道 kind/);
  assert.equal(io.state.posts.length, 0);
});

test("不可恢复的失败（无凭据/被拒）停表：不重试、留一条痕", async () => {
  const io = makeIO();
  const logs = [];
  const chan = makeChannel(io, { log: (m) => logs.push(m) });
  chan.start();
  await tick();
  io.fail(new Error("缺少 App surface 会话凭据（appSurfaceSession）"));
  await tick(40);
  assert.equal(io.state.gets.length, 1, "命中不可恢复的错就不再挂新的");
  assert.match(logs.join("\n"), /不可恢复/);
});

test("可恢复的失败不刷屏：同一个错只在头一次与每隔一阵留痕", async () => {
  const io = makeIO();
  const logs = [];
  const chan = makeChannel(io, { log: (m) => logs.push(m), retryBaseMs: 1, retryMaxMs: 2 });
  chan.start();
  await tick();
  for (let i = 0; i < 5; i += 1) { io.fail(new Error("connection reset")); await tick(8); }
  assert.equal(logs.filter((m) => /轮询失败/.test(m)).length, 1, "5 次失败里只留一条痕");
});
