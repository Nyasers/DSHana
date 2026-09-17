// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// 底座色按面取值：壳页在 <html> 上声明 data-dshana-backdrop = 这一面可见底那格 DSW token，
// 桥拿它去同一张映射表里取宿主变量，替掉 base 那一格。这里把 assets/theme-bridge.js 真实跑
// 一遍（vm + 最小 DOM 桩），断言：
//   · 没声明时 base 就是表里的 --bg（老行为不变）；
//   · 声明了就换成那格对应的宿主变量（侧栏面 = --sidebar-bg）；
//   · 声明的 token 不在表里时原样退回 --bg（不凭空造值）；
//   · 每个面：桥给出的 base 与壳页垫片（seed-tokens）给的值一致——两处写法不同、值同源。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { TOKEN_MAP } from "../src-cordis/plugins/theme/token-map.ts";
import { FACE_BACKDROP, seedTokensForView } from "../src/lib/seed-tokens.ts";
import { FACE_VIEWS } from "../src/lib/face-role.ts";

const BRIDGE_SRC = readFileSync(
  new URL("../src-cordis/plugins/theme/assets/theme-bridge.js", import.meta.url),
  "utf8",
);
const SHELL_SRC = readFileSync(new URL("../src/ui/app-shell.ts", import.meta.url), "utf8");

const BG = "#101010";
const SIDEBAR_BG = "#202020";
const HOST_VARS = { "--bg": BG, "--sidebar-bg": SIDEBAR_BG };

/**
 * 跑一次桥脚本，返回它写进 @dshana/theme-dyn 的 CSS 正文。
 * backdrop = 壳页写在 <html> 的 data-dshana-backdrop（null → 不写该属性）。
 */
function runBridge(backdrop) {
  const styleTags = [];
  const attrs = { "data-dsh-theme-preference": "system" };
  if (backdrop) attrs["data-dshana-backdrop"] = backdrop;
  const documentElement = {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = value; },
  };
  const document = {
    documentElement,
    head: { appendChild: (el) => { styleTags.push(el); } },
    createElement: () => ({ id: "", textContent: "" }),
    getElementById: (id) => styleTags.find((el) => el.id === id) || null,
    addEventListener: () => {},
  };
  const windowStub = {
    addEventListener: () => {},
    postMessage: () => {},
    location: {},
  };
  windowStub.parent = windowStub;
  const sandbox = {
    document,
    window: windowStub,
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name in HOST_VARS ? HOST_VARS[name] : ""),
    }),
  };
  // 注：占位符在文件头注释里也出现过，所以这里与生产侧的 replace 不同，一次全换（生产侧靠
  // pack 的 terser 去注释，见 index.ts 与 pack.mjs）。
  const code = BRIDGE_SRC.replaceAll("__DSH_THEME_TOKENS__", JSON.stringify(TOKEN_MAP));
  vm.runInNewContext(code, sandbox);
  const tag = styleTags.find((el) => el.id === "@dshana/theme-dyn");
  return tag ? tag.textContent : "";
}

function declaredValue(css, token) {
  // 前边界取 ; 或 {：桥写的是 body{token:值!important;…} 一条长串，只有第一格紧跟 {
  const hit = new RegExp("(?:[;{]|^)" + token + ":([^!;]+)!important;").exec(css);
  return hit ? hit[1] : null;
}

test("桥：没声明底座 token 时，base 仍是表里的 --bg", () => {
  const css = runBridge(null);
  assert.equal(declaredValue(css, "--dsw-alias-bg-base"), BG);
  assert.equal(declaredValue(css, "--dsw-specific-sidebar-fill"), SIDEBAR_BG);
});

test("桥：声明了底座 token 就换成那格的宿主变量", () => {
  const css = runBridge("--dsw-specific-sidebar-fill");
  assert.equal(declaredValue(css, "--dsw-alias-bg-base"), SIDEBAR_BG, "侧栏面的 base 该跟侧栏列同源");
  assert.equal(declaredValue(css, "--dsw-specific-sidebar-fill"), SIDEBAR_BG);
});

test("桥：声明的 token 不在表里时原样退回 --bg（不凭空造值）", () => {
  const css = runBridge("--dsw-alias-not-in-table");
  assert.equal(declaredValue(css, "--dsw-alias-bg-base"), BG);
});

test("桥与壳页垫片：每个面给出的 base 值一致（两处写法不同、值同源）", () => {
  const hostVarOf = new Map(TOKEN_MAP);
  for (const view of FACE_VIEWS) {
    const backdrop = FACE_BACKDROP[view];
    const expected = HOST_VARS[hostVarOf.get(backdrop)];
    const css = runBridge(backdrop);
    assert.equal(declaredValue(css, "--dsw-alias-bg-base"), expected, view + " 面：桥的 base 值不对");
    // 垫片给的是宿主变量名，两边取值前先落到同一格变量上（表里那格 → 变量 → 值）
    const seededHostVar = new Map(seedTokensForView(view)).get("--dsw-alias-bg-base");
    assert.equal(
      HOST_VARS[seededHostVar],
      expected,
      view + " 面：壳页垫片（" + seededHostVar + "）与桥的值不同源",
    );
  }
});

test("壳页确实把这一面的底座 token 写上了（桥的入口契约）", () => {
  assert.ok(SHELL_SRC.includes("data-dshana-backdrop"), "壳页没写 data-dshana-backdrop");
  assert.ok(SHELL_SRC.includes("backdropTokenForView"), "壳页没按面取底座 token");
  assert.ok(BRIDGE_SRC.includes("data-dshana-backdrop"), "桥没读 data-dshana-backdrop");
});
