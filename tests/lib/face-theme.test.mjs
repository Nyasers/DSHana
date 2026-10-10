// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/face-theme.test.mjs — 「强制跟随宿主主题的面」这张声明的语义与它的从属关系。
//
// 盯三件事：
//   1. 缺省只有侧栏面（结构性理由：那一面整幅嵌在宿主框架里）；
//   2. 校验是严格的：词表外的值、重复项、非数组一律拒，空数组合法（= 一个都不强制）；
//   3. 候选面必须真的是 FACE_VIEWS 的子集，且 settings 不在其中——面词表仍只有
//      face-role.ts 一处事实源，这里不复制、只从属。
import test from "node:test";
import assert from "node:assert/strict";
import {
  FORCE_FOLLOW_ATTR,
  FORCE_FOLLOW_CANDIDATES,
  FORCE_FOLLOW_FACES,
  decodeForceFollowFaces,
  encodeForceFollowFaces,
  isForceFollowFace,
  normalizeForceFollowFaces,
} from "@dshana/shared/face-theme.ts";
import { FACE_VIEWS } from "@dshana/ui/face-role.ts";

test("缺省只有侧栏面（它整幅嵌在宿主框架里，必须与四周同调）", () => {
  assert.deepEqual([...FORCE_FOLLOW_FACES], ["sidebar"]);
});

test("候选面是面词表的子集，且不含 settings（那页不注入 DSH，没有覆盖可言）", () => {
  for (const face of FORCE_FOLLOW_CANDIDATES) {
    assert.ok(
      FACE_VIEWS.includes(face),
      "候选面 " + face + " 不在 face-role.ts 的词表里：面词表只有那一处事实源",
    );
  }
  assert.ok(!FORCE_FOLLOW_CANDIDATES.includes("settings"), "settings 不该可选");
  // 会注入 DSH 的面一个不少：以后加了新的注入面而这里没跟，这条会红。
  const injectable = FACE_VIEWS.filter((v) => v !== "settings");
  assert.deepEqual(
    [...FORCE_FOLLOW_CANDIDATES].sort(),
    [...injectable].sort(),
    "候选面应恰好是「会注入 DSH 的那些面」",
  );
  // 缺省值必须落在候选里，否则设置页读回来的值与候选表对不上。
  for (const face of FORCE_FOLLOW_FACES) assert.ok(isForceFollowFace(face));
});

test("认面：词表内的值才算可选", () => {
  for (const face of FORCE_FOLLOW_CANDIDATES) assert.equal(isForceFollowFace(face), true);
  for (const bad of ["", "settings", "MAIN", "sidebar ", "unknown", null, undefined, 1, {}]) {
    assert.equal(isForceFollowFace(bad), false, "不属于候选表的值一律不可选：" + String(bad));
  }
});

test("校验：词表外的值 / 重复项 / 非数组一律拒（不静默丢弃脏值）", () => {
  assert.deepEqual(normalizeForceFollowFaces([]), [], "空表合法：一个都不强制");
  assert.deepEqual(normalizeForceFollowFaces(["main", "sidebar"]), ["main", "sidebar"], "顺序原样保留");
  for (const bad of [null, undefined, "sidebar", 1, {}]) {
    assert.throws(() => normalizeForceFollowFaces(bad), /必须是数组/, "应拒绝 " + JSON.stringify(bad));
  }
  assert.throws(() => normalizeForceFollowFaces(["settings"]), /不可选/, "settings 不可选");
  assert.throws(() => normalizeForceFollowFaces(["nope"]), /不可选/);
  assert.throws(() => normalizeForceFollowFaces(["sidebar", "sidebar"]), /重复/);
});

test("属性编解码：空表编成空串，缺席按缺省兜底（缺席与空串是两回事）", () => {
  assert.equal(FORCE_FOLLOW_ATTR, "data-dshana-force-follow");
  assert.equal(encodeForceFollowFaces([]), "", "空表 = 显式一个都不强制");
  assert.equal(encodeForceFollowFaces(["sidebar"]), "sidebar");
  assert.equal(encodeForceFollowFaces(["default", "main"]), "default,main");
  assert.deepEqual(decodeForceFollowFaces(""), []);
  assert.deepEqual(decodeForceFollowFaces("main, sidebar"), ["main", "sidebar"], "容忍空格");
  assert.deepEqual(decodeForceFollowFaces(null), ["sidebar"], "属性缺席（老页面 / 设置还没到）按缺省兜底");
  assert.deepEqual(decodeForceFollowFaces(undefined), ["sidebar"]);
});
