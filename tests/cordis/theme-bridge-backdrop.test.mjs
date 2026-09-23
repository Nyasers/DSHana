// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// 底座色按面取值 + 明暗跟随：壳页在 <html> 上声明 data-dshana-backdrop（这一面可见底那格
// DSW token）与 data-appearance（宿主明暗），桥拿它们去规则表里取宿主变量、并校准 dsh 自己的
// 明暗标记。这里把 assets/theme-bridge.js 真实跑一遍（vm + 最小 DOM 桩），断言：
//   · 没声明底座时 base 就是表里的 --bg（老行为不变）；
//   · 声明了就换成那格对应的宿主变量（侧栏面 = --sidebar-bg）；
//   · 声明的 token 不在表里时原样退回 --bg（不凭空造值）；
//   · 每个面：桥给出的 base 与壳页垫片（seed-tokens）给的值同源；
//   · 跟随宿主时 body[data-ds-dark-theme] 与 html 的 color-scheme 都按宿主摘戴（dsh 自己的
//     判定取自浏览器系统的 prefers-color-scheme，宿主与系统不一致时会错档）；
//   · dsh 自己选了 light/dark 时，桥不动明暗（交还它的 presenter）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { TOKEN_MAP } from "../../src-cordis/plugins/theme/token-map.ts";
import { compileRules } from "../../src-cordis/plugins/theme/adapter.ts";
import { FACE_BACKDROP, VIEW_SEEDS, SEED_TOKEN_KEYS, seedTokensForView, seedsForDshPreference } from "../../src/lib/seed-tokens.ts";
import { FACE_VIEWS } from "../../src/lib/face-role.ts";

const BRIDGE_SRC = readFileSync(
  new URL("../../src-cordis/plugins/theme/assets/theme-bridge.js", import.meta.url),
  "utf8",
);
const SHELL_SRC = readFileSync(new URL("../../src/ui/app-shell.ts", import.meta.url), "utf8");

const BG = "#101010";
const SIDEBAR_BG = "#202020";
const HOST_VARS = { "--bg": BG, "--sidebar-bg": SIDEBAR_BG };

/**
 * 跑一次桥脚本，返回它写进 @dshana/theme-dyn 的 CSS 正文与它校准过的明暗状态。
 * @param backdrop 壳页写在 <html> 的 data-dshana-backdrop（null → 不写该属性）
 * @param options  appearance（宿主明暗）/ preference（dsh 侧偏好，默认 system；显式传 null =
 *                 属性尚未被 presenter 投影，即偏好未知）
 */
function runBridge(backdrop, options) {
  const opts = options || {};
  const styleTags = [];
  const observers = [];
  const attrs = {};
  if (opts.preference !== null) attrs["data-dsh-theme-preference"] = opts.preference || "system";
  if (backdrop) attrs["data-dshana-backdrop"] = backdrop;
  if (opts.appearance) attrs["data-appearance"] = opts.appearance;
  const rootStyle = new Map();
  const documentElement = {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = value; },
    removeAttribute: (name) => { delete attrs[name]; },
    style: {
      setProperty: (k, v) => { rootStyle.set(k, v); },
      removeProperty: (k) => { rootStyle.delete(k); },
    },
  };
  const bodyAttrs = new Set();
  // 模拟壳页已经垫上的底色（注入前写进 body 内联样式的那两个 token）
  const bodyStyle = new Map([
    ["--dsw-alias-bg-base", "#fff"],
    ["--dsw-specific-sidebar-fill", "#eee"],
    ["--dsh-boot-bg", "#fff"],
    ["background-color", "#fff"],
  ]);
  const body = {
    style: {
      setProperty: (k, v) => { bodyStyle.set(k, v); },
      removeProperty: (k) => { bodyStyle.delete(k); },
    },
    hasAttribute: (name) => bodyAttrs.has(name),
    setAttribute: (name) => { bodyAttrs.add(name); },
    removeAttribute: (name) => { bodyAttrs.delete(name); },
    toggleAttribute: (name, force) => {
      if (force) bodyAttrs.add(name);
      else bodyAttrs.delete(name);
      return force;
    },
  };
  const document = {
    documentElement,
    body,
    readyState: "complete",
    head: { appendChild: (el) => { styleTags.push(el); } },
    createElement: () => ({
      id: "",
      textContent: "",
      // 退出跟随时桥会 remove() 掉它自己建的 <style>；harness 里只需不报错。
      remove: () => {},
    }),
    getElementById: (id) => styleTags.find((el) => el.id === id) || null,
    addEventListener: () => {},
  };
  const windowStub = {
    addEventListener: () => {},
    postMessage: () => {},
    location: {},
    matchMedia: () => ({ addEventListener: () => {} }),
  };
  windowStub.parent = windowStub;
  const sandbox = {
    document,
    window: windowStub,
    // 记下每个观察者：桥靠它们纠 presenter 后写的明暗标记，测试里手动触发回调模拟那一笔。
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      fire() { this.cb([]); }
    },
    getComputedStyle: () => ({
      getPropertyValue: (name) => (name in HOST_VARS ? HOST_VARS[name] : ""),
    }),
  };
  // 注：占位符在文件头注释里也出现过，所以这里与生产侧的 replace 不同，一次全换（生产侧靠
  // pack 的 terser 去注释，见 index.ts 与 pack.mjs）。
  const code = BRIDGE_SRC.replaceAll("__DSH_THEME_TOKENS__", JSON.stringify(compileRules(TOKEN_MAP)));
  vm.runInNewContext(code, sandbox);
  const tag = styleTags.find((el) => el.id === "@dshana/theme-dyn");
  // 这几格用 getter：观察者回调会再写一次，快照式取值会把断言变成空转（读到的是跑桥那一刻的值）。
  return {
    get css() { return tag ? tag.textContent : ""; },
    get dark() { return bodyAttrs.has("data-ds-dark-theme"); },
    get colorScheme() { return rootStyle.get("color-scheme"); },
    get seededKeys() { return [...bodyStyle.keys()]; },
    bodyAttrs,
    rootStyle,
    setRootAttr: (name, value) => { attrs[name] = value; },
    fireObservers: () => observers.forEach((o) => o.fire()),
  };
}

function declaredValue(css, token) {
  // 前边界取 ; 或 {：桥写的是 body{token:值!important;…} 一条长串，只有第一格紧跟 {
  const hit = new RegExp("(?:[;{]|^)" + token + ":([^!;]+)!important;").exec(css);
  return hit ? hit[1] : null;
}

test("桥：没声明底座 token 时，base 仍是表里的 --bg", () => {
  const { css } = runBridge(null);
  assert.equal(declaredValue(css, "--dsw-alias-bg-base"), "var(--bg)");
  assert.equal(declaredValue(css, "--dsw-specific-sidebar-fill"), "var(--sidebar-bg)");
});

test("桥：声明了底座 token 就换成那格的宿主变量", () => {
  const { css } = runBridge("--dsw-specific-sidebar-fill");
  assert.equal(declaredValue(css, "--dsw-alias-bg-base"), "var(--sidebar-bg)", "侧栏面的 base 该跟侧栏列同源");
  assert.equal(declaredValue(css, "--dsw-specific-sidebar-fill"), "var(--sidebar-bg)");
});

test("桥：声明的 token 不在表里时原样退回 --bg（不凭空造值）", () => {
  const { css } = runBridge("--dsw-alias-not-in-table");
  assert.equal(declaredValue(css, "--dsw-alias-bg-base"), "var(--bg)");
});

test("桥与壳页垫片：每个面给出的 base 值一致（两处写法不同、值同源）", () => {
  const hostVarOf = new Map(compileRules(TOKEN_MAP).map(([token, , deps]) => [token, deps[0]]));
  for (const view of FACE_VIEWS) {
    const backdrop = FACE_BACKDROP[view];
    const hostVar = hostVarOf.get(backdrop);
    const { css } = runBridge(backdrop);
    assert.equal(
      declaredValue(css, "--dsw-alias-bg-base"),
      "var(" + hostVar + ")",
      view + " 面：桥的 base 值不对",
    );
    // 垫片给的是宿主变量名，两边取值前先落到同一格变量上（规则表那格 → 变量）
    const seededHostVar = new Map(seedTokensForView(view)).get("--dsw-alias-bg-base");
    assert.equal(
      seededHostVar,
      hostVar,
      view + " 面：壳页垫片（" + seededHostVar + "）与桥不同源",
    );
  }
});

test("桥：跟随宿主时明暗跟着宿主走（dsh 认的系统偏好不算数）", () => {
  // 宿主浅色 → body 不挂 dark 标记，html 的 inline color-scheme = light
  const light = runBridge(null, { appearance: "light" });
  assert.equal(light.dark, false, "宿主浅色时不该挂着深色标记");
  assert.equal(light.colorScheme, "light");
  // 宿主深色 → 挂上 dark 标记，color-scheme = dark
  const dark = runBridge(null, { appearance: "dark" });
  assert.equal(dark.dark, true, "宿主深色时该挂上深色标记");
  assert.equal(dark.colorScheme, "dark");
});

test("桥：dsh 自己选了 light/dark 时，明暗交还它的 presenter", () => {
  const css = runBridge(null, { appearance: "dark", preference: "light" });
  assert.equal(css.dark, false, "dsh 显式 light 时不该被挂上 dark 标记");
  assert.equal(css.colorScheme, undefined, "dsh 显式偏好时不该留我们的 inline color-scheme");
});

test("桥：presenter 在插件树激活时写的明暗标记会被纠回来", () => {
  // 时序：壳页注入时桥先对齐 → ui-layout 的 ThemePresenter 随后 apply()，它按 dsh 自己的解析
  // （preference=system 时看浏览器系统）写 html.style.colorScheme='dark' 与 body[data-ds-dark-theme]。
  // 只盯 data-* 属性的话这两笔没人纠：JsonTree / shiki 语法色按那个标记翻明暗，浅底上就是浅字
  // （“手动切深色再切回跟随宿主才正常”就是这个原因——偏好属性一变才又跑一次 pull）。
  const bridge = runBridge(null, { appearance: "light" });
  assert.equal(bridge.dark, false, "注入对齐后不该挂着深色标记");
  bridge.bodyAttrs.add("data-ds-dark-theme");
  bridge.rootStyle.set("color-scheme", "dark");
  bridge.fireObservers();
  assert.equal(bridge.dark, false, "presenter 写完 dark 标记后该被纠回宿主明暗");
  assert.equal(bridge.colorScheme, "light", "html 的 inline color-scheme 该被纠回宿主明暗");
});

test("桥：切到 dsh 显式偏好后，presenter 写的那格 color-scheme 不被抹掉", () => {
  // 起点：跟随宿主（偏好 system + 宿主浅）→ 桥把 html 的 color-scheme 写成 light。
  const bridge = runBridge(null, { appearance: "light" });
  assert.equal(bridge.colorScheme, "light", "跟随时该自己写上宿主明暗");
  // 用户把 dsh 外观改成显式深色：presenter 往同一格写 dark（标记它自己的 UA 明暗），偏好属性随之出现。
  bridge.setRootAttr("data-dsh-theme-preference", "dark");
  bridge.rootStyle.set("color-scheme", "dark");
  bridge.fireObservers();
  // 我们区分不了那一格的值是谁写的，所以退出跟随时不能抹：抹了就会落在 presenter 写入之后，
  // 把它的 UA 明暗退回系统档。
  assert.equal(bridge.colorScheme, "dark", "presenter 的值该留着");
});

test("桥：退出跟随时抹掉壳页垫的底色（主题切得干净）", () => {
  // dsh 自己选了 light → 不跟随 → 垫片该被抹掉（否则 body 内联钉着宿主色，切不干净）
  const off = runBridge(null, { appearance: "dark", preference: "light" });
  assert.deepEqual(off.seededKeys, [], "退出跟随时不该留着壳页垫的宿主底色");
  assert.equal(
    off.seededKeys.includes("background-color"),
    false,
    "退出跟随时 body 自身的背景也要还回去（首帧那句背景色）",
  );
  // 仍在跟随时垫片保留（它还要垫底防闪白）
  const on = runBridge(null, { appearance: "light" });
  assert.ok(on.seededKeys.includes("--dsw-alias-bg-base"), "跟随时垫片该保留");
  assert.ok(on.seededKeys.includes("background-color"), "跟随时 body 背景垫片该保留");
});

test("桥：退出时抹的名单与壳页垫过的 token 同源", () => {
  const listed = /var seedKeys = \[([^\]]*)\]/.exec(BRIDGE_SRC);
  assert.ok(listed, "桥里找不到 seedKeys 名单");
  const keys = listed[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .sort();
  const seeded = [...new Set(Object.values(VIEW_SEEDS).flat().map(([token]) => token))].sort();
  assert.deepEqual(keys, seeded, "桥退出时抹的名单与 seed-tokens 的垫片 token 不一致");
  assert.deepEqual([...SEED_TOKEN_KEYS].sort(), seeded, "壳页那道撤垫片名单与垫片 token 不一致");
});

test("桥：偏好未知时不动手（首帧垫片留着，不交回 dsh 的系统判定）", () => {
  // presenter 的属性还没投影、壳页载荷也还没到：此刻抹垫片 = 把首帧交给 dsh 的
  // @media(prefers-color-scheme:dark) —— 宿主浅 + 系统深就是那一帧黑屏。
  const unknown = runBridge(null, { preference: null, appearance: "light" });
  assert.ok(unknown.seededKeys.includes("background-color"), "偏好未知时不该抹掉 body 背景垫片");
  assert.ok(unknown.seededKeys.includes("--dsw-alias-bg-base"), "偏好未知时不该抹掉 token 垫片");
  assert.equal(unknown.colorScheme, undefined, "偏好未知时不该替 dsh 决定 color-scheme");
  assert.equal(unknown.dark, false, "偏好未知时不该动 dsh 的明暗标记");
});

test("壳页：dsh 自选明暗时不垫首帧底色（那一段归它自己的 boot 样式）", () => {
  assert.equal(seedsForDshPreference("system"), true);
  assert.equal(seedsForDshPreference(null), true, "还没读到 index 时属于未知，按 system 处理");
  assert.equal(seedsForDshPreference("light"), false);
  assert.equal(seedsForDshPreference("dark"), false);
});

test("壳页确实把这一面的底座 token 与宿主明暗写上了（桥的入口契约）", () => {
  assert.ok(SHELL_SRC.includes("data-dshana-backdrop"), "壳页没写 data-dshana-backdrop");
  assert.ok(SHELL_SRC.includes("backdropTokenForView"), "壳页没按面取底座 token");
  assert.ok(SHELL_SRC.includes("data-appearance"), "壳页没把宿主明暗写出来");
  assert.ok(BRIDGE_SRC.includes("data-dshana-backdrop"), "桥没读 data-dshana-backdrop");
  assert.ok(BRIDGE_SRC.includes("data-appearance"), "桥没读宿主明暗");
});
