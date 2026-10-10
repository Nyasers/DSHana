// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/force-follow.test.mjs — 「强制跟随宿主主题的面」从设置搬到 <html> 的那一步。
//
// 这一层只有一个职责：把设置里的这张表编码成属性。锁三件事：
//   ① 正常路径：合法表编成逗号分隔的面名写进 <html>，空表写成空串（显式「一个都不强制」）；
//   ② 失败路径一律**不写属性**：取数失败、形状不对（缺键 / 脏值 / 非数组）——属性缺席时桥按
//      缺省（只有侧栏面）兜底，也就是这一功能之前的行为，一次取数失败不该把界面弄成别的样子；
//   ③ 写前比现值：同值重写会白触发桥一轮重算（它观察这个属性）。
//   ④ 并发：三次触发（焦点 / 可见性 / 广播）各自能起一次拉取，先发起的晚落地时不得把旧名单盖回去。
import test from "node:test";
import assert from "node:assert/strict";

const ATTR = "data-dshana-force-follow";

/** 造一个假文档根 + 假 fetch，返回 {writes, calls, restore}。 */
function harness({ settings, fail = false } = {}) {
  const attrs = new Map();
  const writes = [];
  const calls = [];
  const prevDoc = globalThis.document;
  const prevFetch = globalThis.fetch;
  const prevLoc = globalThis.location;
  globalThis.location = { pathname: "/api/apps/dshana/ui/main.html", search: "?appSurfaceSession=t" };
  globalThis.document = {
    documentElement: {
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      setAttribute: (name, value) => { attrs.set(name, value); writes.push([name, value]); },
    },
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fail) throw new Error("network down");
    return {
      ok: true,
      json: async () => (settings === undefined ? { ok: true, settings: {} } : { ok: true, settings }),
    };
  };
  return {
    writes,
    calls,
    attrs,
    restore: () => {
      globalThis.document = prevDoc;
      globalThis.fetch = prevFetch;
      globalThis.location = prevLoc;
    },
  };
}

/** 每个用例都拿一份全新的模块实例（模块无状态，但 import 期会读 location）。 */
async function load() {
  return await import("@dshana/ui/force-follow.ts");
}

test("合法表：编成逗号分隔的面名写进 <html>", async () => {
  const h = harness({ settings: { forceFollowFaces: ["main", "stream"] } });
  try {
    const { publishForceFollow } = await load();
    assert.equal(await publishForceFollow(), true);
    assert.deepEqual(h.writes, [[ATTR, "main,stream"]]);
    assert.match(h.calls[0].url, /\/dshana\/settings$/, "走 App 路由的设置端点");
  } finally {
    h.restore();
  }
});

test("空表：写成空串（显式一个都不强制），不是不写", async () => {
  const h = harness({ settings: { forceFollowFaces: [] } });
  try {
    const { publishForceFollow } = await load();
    assert.equal(await publishForceFollow(), true);
    assert.deepEqual(h.writes, [[ATTR, ""]]);
  } finally {
    h.restore();
  }
});

test("同值不重写：桥观察这个属性，同值重写会白触发它一轮重算", async () => {
  const h = harness({ settings: { forceFollowFaces: ["sidebar"] } });
  try {
    const { publishForceFollow } = await load();
    await publishForceFollow();
    await publishForceFollow();
    assert.equal(h.writes.length, 1, "第二次同值不该再写一遍");
  } finally {
    h.restore();
  }
});

test("并发：先发起的那次晚落地，不把旧名单盖回去", async () => {
  // 造一个能控速的 fetch：第一次发起拖到我们放行才落地，第二次立即落地。
  const attrs = new Map();
  const writes = [];
  const prevDoc = globalThis.document;
  const prevFetch = globalThis.fetch;
  const prevLoc = globalThis.location;
  globalThis.location = { pathname: "/api/apps/dshana/ui/main.html", search: "?appSurfaceSession=t" };
  globalThis.document = {
    documentElement: {
      getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
      setAttribute: (name, value) => { attrs.set(name, value); writes.push([name, value]); },
    },
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let calls = 0;
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      await firstGate; // 第一次：等我们放行
      return { ok: true, json: async () => ({ ok: true, settings: { forceFollowFaces: ["sidebar"] } }) };
    }
    return { ok: true, json: async () => ({ ok: true, settings: { forceFollowFaces: ["main", "stream"] } }) };
  };
  try {
    const { publishForceFollow } = await load();
    const slow = publishForceFollow();   // 先发起，取到旧名单，但卡在闸上
    const fast = await publishForceFollow(); // 后发起，立即落地新名单
    assert.equal(fast, true);
    assert.deepEqual(writes, [[ATTR, "main,stream"]], "后发起的先落地，写新名单");
    releaseFirst();                       // 放行旧那次
    assert.equal(await slow, false, "落后的一次应放弃写");
    assert.deepEqual(writes, [[ATTR, "main,stream"]], "旧名单不得盖回");
    assert.equal(attrs.get(ATTR), "main,stream");
  } finally {
    globalThis.document = prevDoc;
    globalThis.fetch = prevFetch;
    globalThis.location = prevLoc;
  }
});

test("失败路径一律不写属性：取数失败 / 缺键 / 脏值 / 非数组", async () => {
  const cases = [
    { name: "取数失败", opts: { settings: {}, fail: true } },
    { name: "设置里没有这个键", opts: { settings: { approvalTimeoutSec: 30 } } },
    { name: "脏值（不可选的面）", opts: { settings: { forceFollowFaces: ["settings"] } } },
    { name: "脏值（词表外的值）", opts: { settings: { forceFollowFaces: ["nope"] } } },
    { name: "非数组", opts: { settings: { forceFollowFaces: "sidebar" } } },
  ];
  for (const c of cases) {
    const h = harness(c.opts);
    try {
      const { publishForceFollow } = await load();
      assert.equal(await publishForceFollow(), false, c.name + "：应报未写");
      assert.deepEqual(h.writes, [], c.name + "：不该写任何属性（桥走缺省兜底）");
    } finally {
      h.restore();
    }
  }
});
