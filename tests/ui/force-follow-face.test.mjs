// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/force-follow-face.test.mjs — 面名与强制面名单的属性名字面量只有一处。
//
// 只守「字面量不许散落」：属性名散进各页面后，改一处漏一处就是「某面不生效」那类 bug 的温床。
// 页面是否真把面名写到了 <html> 上属于浏览器里的行为（会话卡走 stream-entry 而不是壳页，
// 两个挂载态各写一次；设置页在另一个文档里保存，visibilitychange 不触发，所以得广播）——
// 那种事不在单测里用源码文本断言：重命名就红，删掉调用也能被新写法绕过。留给真机验收。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FACE_ATTR, FORCE_FOLLOW_ATTR } from "@dshana/shared/face-theme.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, "..", "..", "packages", "ui", "src", name), "utf8");
const sharedSrc = (name) => readFileSync(join(here, "..", "..", "packages", "shared", "src", name), "utf8");

test("属性名只有一份字面量：写它的页面都引 shared 的常量", () => {
  // 属性名散成字面量时，改一处漏一处就是「某面不生效」这类 bug 的温床。
  const bridge = readFileSync(
    join(here, "..", "..", "packages", "dsh", "theme", "assets", "theme-bridge.js"),
    "utf8",
  );
  // 桥是散装浏览器 JS（无 import），它只能读字面量——那一处是刻意的：下面那行 includes 就是那条闸，
  // 常量改了而桥没跟上就会红。
  assert.ok(bridge.includes(FORCE_FOLLOW_ATTR), "桥没读 " + FORCE_FOLLOW_ATTR);
  assert.ok(bridge.includes('"data-dshana-face"') || bridge.includes("data-dshana-face"), "桥没读面名属性");
  // TS 侧：壳页与会话卡都用常量，不再各写一遍字面量。
  for (const name of ["app.ts", "stream-entry.ts"]) {
    const text = src(name);
    assert.ok(
      !/setAttribute\("data-dshana-face"/.test(text),
      name + " 里出现了面名属性的字面量：该走 FACE_ATTR 常量",
    );
  }
  assert.ok(sharedSrc("face-theme.ts").includes('FACE_ATTR = "data-dshana-face"'), "FACE_ATTR 的声明该在 shared");
});

test("会话卡（stream 面）不把面名写死", () => {
  const entry = src("stream-entry.ts");
  // 面的事实源只有页面自己的静态声明（<meta> / body 属性），不写死 "stream"。
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
