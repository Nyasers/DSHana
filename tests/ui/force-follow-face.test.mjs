// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/force-follow-face.test.mjs — 每一面自己把面名与强制面名单写到 <html> 上。
//
// 盯两个真机踩过的 bug（都是「勾了不生效」那一类）：
//   ① 桥读 data-dshana-face 判面，但只有壳页（app-shell）写过它。会话卡走的是
//      stream-entry / stream-stage，根本不经过壳页——桥读回 null，勾了会话卡永远不生效。
//      所以每个会注入 DSH 的页面都得自己写面名，steam 面在**两个挂载态**都写
//      （「本页是 stream 面」与「装不装 DSH」是两件事）。
//   ② 设置页保存在**另一个文档**（宿主设置区那个 iframe）里，切过去时卡片的 visibilityState
//      不变、visibilitychange 不触发。所以设置页保存后必须广播一条，接收侧靠它即时重读；
//      可见性/焦点只当兜底。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FACE_ATTR, FORCE_FOLLOW_ATTR, FORCE_FOLLOW_CHANNEL, FORCE_FOLLOW_CHANGED } from "@dshana/shared/face-theme.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, "..", "..", "packages", "ui", "src", name), "utf8");
const sharedSrc = (name) => readFileSync(join(here, "..", "..", "packages", "shared", "src", name), "utf8");

test("属性名只有一份字面量：写它的页面都引 shared 的常量", () => {
  // 属性名散成字面量时，改一处漏一处就是「某面不生效」这类 bug 的温床。
  const bridge = readFileSync(
    join(here, "..", "..", "packages", "dsh", "theme", "assets", "theme-bridge.js"),
    "utf8",
  );
  // 桥是散装浏览器 JS（无 import），它只能读字面量——那一处是刻意的，由另一条闸守着值一致。
  assert.ok(bridge.includes(FORCE_FOLLOW_ATTR), "桥没读 " + FORCE_FOLLOW_ATTR);
  assert.ok(bridge.includes('"data-dshana-face"') || bridge.includes("data-dshana-face"), "桥没读面名属性");
  // TS 侧：壳页与会话卡都用常量，不再各写一遍字面量。
  for (const name of ["app-shell.ts", "stream-entry.ts"]) {
    const text = src(name);
    assert.ok(text.includes("FACE_ATTR"), name + " 该引 shared 的 FACE_ATTR（不自己写属性名字面量）");
    assert.ok(
      !/setAttribute\("data-dshana-face"/.test(text),
      name + " 里出现了面名属性的字面量：该走 FACE_ATTR 常量",
    );
  }
  assert.ok(sharedSrc("face-theme.ts").includes('FACE_ATTR = "data-dshana-face"'), "FACE_ATTR 的声明该在 shared");
});

test("会话卡（stream 面）自己写面名：两个挂载态都写，不依赖壳页", () => {
  const entry = src("stream-entry.ts");
  // 面名投影这件事在 boot() 里做（认挂载态之前），所以两个挂载态都覆盖到。
  assert.ok(/function publishFace\(/.test(entry), "stream-entry.ts 该有自己的 publishFace");
  assert.match(entry, /publishFace\(\);/, "boot() 该调一次 publishFace");
  assert.ok(entry.includes("declaredFaceView"), "面该取自页面静态声明");
  const atPublish = entry.indexOf("publishFace();");
  const atDecide = entry.indexOf("let decided");
  assert.ok(atPublish >= 0 && atDecide >= 0 && atPublish < atDecide, "写面名该在认挂载态之前（两态都覆盖）");
  // 面名取自 <meta>，不是写死的 "stream"：面的事实源只有页面自己的声明。
  assert.ok(
    !/setAttribute\(FACE_ATTR, "stream"\)/.test(entry),
    "面名不该写死：它的事实源是页面静态声明（declaredFaceView）",
  );
});

test("stream 面的静态声明与它写出的面名对得上", () => {
  const html = src("stream.html");
  assert.match(html, /<meta name="hana-dshana-role" content="stream">/);
  assert.match(html, /data-dshana-view="stream"/);
});

test("设置页保存后广播一条，接收侧（壳页 / 会话卡）都挂了监听", () => {
  assert.equal(FORCE_FOLLOW_CHANNEL, "dshana.force-follow");
  assert.equal(FORCE_FOLLOW_CHANGED, "force-follow-changed");
  const force = src("force-follow.ts");
  assert.ok(force.includes("notifyForceFollowChanged"), "force-follow.ts 该有发送侧");
  assert.ok(force.includes("watchForceFollowChanges"), "force-follow.ts 该有接收侧");
  assert.ok(force.includes("FORCE_FOLLOW_CHANNEL"), "发送与接收该用同一个频道名常量");

  const settings = src("settings.tsx");
  assert.ok(settings.includes("notifyForceFollowChanged()"), "设置页保存后该广播");
  assert.ok(settings.includes("watchForceFollowChanges()"), "设置页自己也该听（多标签页一致）");

  for (const name of ["app-shell.ts", "stream-entry.ts"]) {
    assert.ok(src(name).includes("watchForceFollowChanges()"), name + " 该挂上变化监听");
  }
});

test("接收侧不只靠 visibilitychange（并排 iframe 切过去时它不触发）", () => {
  const force = src("force-follow.ts");
  // 广播是主力；可见性与焦点是兜底。三条都在。
  assert.ok(/addEventListener\("message"/.test(force), "该听同源广播的 message");
  assert.ok(/addEventListener\("visibilitychange"/.test(force), "该有可见性兜底");
  assert.ok(/addEventListener\("focus"/.test(force), "该有焦点兜底");
  // 广播那条必须是主力：收到就重读，不靠可见性。
  const atMessage = force.indexOf('addEventListener("message"');
  assert.ok(atMessage > 0, "广播监听该在");
  assert.ok(
    !/publishForceFollowOnVisible/.test(force),
    "不该只留一个可见性监听（那个在并排 iframe 场景下不触发）",
  );
});
