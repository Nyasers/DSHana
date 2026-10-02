// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/faces-channel.test.mjs — 面间直投通道的纯协议（地址、寻址、词表、归一）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_KINDS,
  CHANNEL_NATURE,
  CHANNEL_SCOPE_FALLBACK,
  FACE_ADDRESSES,
  channelRecordKey,
  frameMatches,
  isChannelKind,
  isFaceAddress,
  isFaceTarget,
  normalizeChannelPayload,
  normalizePoll,
  normalizeScope,
  normalizeSend,
} from "@dshana/shared/faces-channel.ts";

test("地址词表：面地址与扇出各认什么", () => {
  assert.deepEqual([...FACE_ADDRESSES], ["workspace", "navigation", "stream", "standalone"]);
  assert.equal(isFaceAddress("navigation"), true);
  assert.equal(isFaceAddress("sidebar"), false, "面地址用的是角色词，不是页面词");
  assert.equal(isFaceAddress(null), false);
  assert.equal(isFaceTarget("others"), true);
  assert.equal(isFaceTarget("*"), true);
  assert.equal(isFaceTarget("somewhere"), false);
});

test("通道词表是意图词表的子集：只有已搬上通道的 kind 能过", () => {
  assert.deepEqual([...CHANNEL_KINDS], ["selection"]);
  assert.equal(isChannelKind("selection"), true);
  assert.equal(isChannelKind("settings-view"), false, "还在共享空间上的 kind 不得走通道");
  assert.equal(isChannelKind("session-rename"), false);
  assert.equal(CHANNEL_NATURE.selection, "state");
  assert.equal(channelRecordKey("selection"), "dshana.selection");
});

test("寻址：指名只投收件人，others 排除发射的那份文档（不是整个角色）", () => {
  const main = { sub: "m1", as: "workspace" };
  const fp = { sub: "f1", as: "navigation" };
  const fp2 = { sub: "f2", as: "navigation" };

  assert.equal(frameMatches("workspace", "f1", main), true);
  assert.equal(frameMatches("workspace", "f1", fp), false);
  assert.equal(frameMatches("navigation", "f1", fp2), true, "同角色的另一份文档照样收得到");
  assert.equal(frameMatches("others", "f1", fp), false, "发射的那份文档不收自己的");
  assert.equal(frameMatches("others", "f1", fp2), true);
  assert.equal(frameMatches("others", "f1", main), true);
  assert.equal(frameMatches("*", "m1", main), true, "扇出 * 连发射面自己也收");
});

test("normalizeSend：形状/词表在外层把关，载荷归一后落成干净形状", () => {
  const now = () => 1234;
  assert.equal(normalizeSend({ from: "sidebar", to: "workspace", kind: "selection" }, now).ok, false);
  assert.equal(normalizeSend({ from: "navigation", to: "sidebar", kind: "selection" }, now).ok, false);
  assert.equal(normalizeSend({ from: "navigation", to: "workspace", kind: "row-toast" }, now).ok, false);

  const ok = normalizeSend(
    { card: "  c1  ", sub: "f1", from: "navigation", to: "workspace", kind: "selection", payload: { sessionId: "s1", extra: 9 } },
    now,
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, {
    card: "c1", sub: "f1", from: "navigation", to: "workspace",
    kind: "selection", payload: { sessionId: "s1" }, at: 1234,
  });
  assert.equal("extra" in ok.value.payload, false, "多余字段不带下去");
});

test("normalizeSend：缺卡片戳时用占位作用域；at 缺省由服务端盖章", () => {
  const ok = normalizeSend({ sub: "m1", from: "workspace", to: "others", kind: "selection", payload: { sessionId: null } }, () => 77);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.card, CHANNEL_SCOPE_FALLBACK);
  assert.equal(ok.value.at, 77);
  assert.equal(ok.value.sub, "m1");
});

test("normalizePoll：as 必须在面地址词表里；since 取非负整数", () => {
  assert.equal(normalizePoll({}).ok, false, "缺 as 不是面地址");
  assert.equal(normalizePoll({ as: "nope" }).ok, false);
  const ok = normalizePoll({ card: "c1", sub: "m1", as: "workspace", since: "9" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.since, 0, "非数值的 since 当首挂");
  const neg = normalizePoll({ as: "workspace", since: -5 });
  assert.equal(neg.value.since, 0);
  const floored = normalizePoll({ as: "workspace", since: 3.7 });
  assert.equal(floored.value.since, 3);
});

test("normalizeScope / normalizeChannelPayload：占位兜底与词表外拒（抛）", () => {
  assert.equal(normalizeScope(undefined), CHANNEL_SCOPE_FALLBACK);
  assert.equal(normalizeScope("  c9 "), "c9");
  assert.deepEqual(normalizeChannelPayload("selection", { sessionId: "s2" }), { sessionId: "s2" });
  assert.throws(() => normalizeChannelPayload("settings-view", {}), /未知通道 kind/);
});

test("描述符表是单一事实源：每个 kind 一条，性质与 INTENT_NATURE 一致", async () => {
  const { INTENT_KINDS, INTENT_NATURE, INTENT_SPECS, intentFaces, faceTakesIntent } = await import("@dshana/shared/shared-state.ts");
  assert.deepEqual(Object.keys(INTENT_SPECS).sort(), [...INTENT_KINDS].sort());
  for (const kind of INTENT_KINDS) {
    assert.equal(INTENT_SPECS[kind].nature, INTENT_NATURE[kind], kind + " 的性质要与描述符一致");
    assert.equal(typeof INTENT_SPECS[kind].normalize, "function");
  }
  assert.deepEqual([...intentFaces("selection")], ["navigation", "workspace", "stream"]);
  assert.equal(faceTakesIntent("selection", "workspace"), true);
  assert.equal(faceTakesIntent("selection", "standalone"), false, "整幅面不参与会话选中");
  assert.equal(intentFaces("session-rename"), null, "还没迁移的 kind 不声明参与面");
  assert.equal(faceTakesIntent("session-rename", "standalone"), true, "未声明就一律当真");
});

test("描述符的归一被通道复用（同一份载荷形状）", async () => {
  const { intentSpec } = await import("@dshana/shared/shared-state.ts");
  assert.deepEqual(intentSpec("selection").normalize({ sessionId: "s1", extra: 1 }), { sessionId: "s1" });
  assert.equal(intentSpec("selection").nature, "state");
  assert.throws(() => intentSpec("nope"), /未知跨面意图/);
});
