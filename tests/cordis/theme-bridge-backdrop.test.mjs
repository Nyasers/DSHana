// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// 底座色按面取值 + 明暗跟随：壳页在 <html> 上声明 data-dshana-backdrop（这一面可见底那格
// DSW token）、data-dshana-face（这一面的面名）与 data-appearance（宿主明暗），桥拿它们去规则
// 表里取宿主变量、并校准 dsh 自己的明暗标记。这里把 assets/theme-bridge.js 真实跑一遍
// （vm + 最小 DOM 桩），断言：
//   · 没声明底座时 base 就是表里的 --bg（老行为不变）；
//   · 声明了就换成那格对应的宿主变量（侧栏面 = --sidebar-bg）；
//   · 声明的 token 不在表里时原样退回 --bg（不凭空造值）；
//   · 每个面：桥给出的 base 与壳页垫片（seed-tokens）给的值同源；
//   · 跟随宿主时 body[data-ds-dark-theme] 与 html 的 color-scheme 都按宿主摘戴（dsh 自己的
//     判定取自浏览器系统的 prefers-color-scheme，宿主与系统不一致时会错档）；
//   · dsh 自己选了 light/dark 时，桥不动明暗（交还它的 presenter）；
//   · 覆盖的层叠形状分两档力度、一种选择器形状：非强制面不带 !important，靠 html body /
//     html body[data-ds-dark-theme] 赢过 dsh 自己那张调色板（body 与 body[data-ds-dark-theme]，
//     后于本桥注入），同时让位给任何按属性收窄的请求（body[attr]，以及暗色下
//     body[data-ds-dark-theme][attr]）——即“宿主色生效，属性请求改写同一格时属性请求赢”；
//     强制面（侧栏）反过来，声明一律带 !important，元素级/属性级请求都不得改写它；
//     全程不特判任何具体属性名；
//   · 桥一落地就把壳页垫的内联底色抹掉（内联只有 !important 压得住，留着就把上面那条让位堵死）；
//   · 跟随时桥把明暗两格（html 的 inline color-scheme 与 body[data-ds-dark-theme]）按**宿主**写；
//     退出跟随时要按 **dsh 自己那一档**写回去（不是不碰）：presenter 只在快照发布时写那两格，
//     而取消勾选不发布快照——只不碰的话它们就停在我们写过的宿主值上（宿主亮 + dsh 选暗
//     = 整片退回亮色）。从未跟随过（没写过）则不碰，不凭空调。
//   · 哪些面恒跟随宿主（无视 dsh 自己的 light/dark 偏好）由 <html> 的 data-dshana-force-follow
//     决定（逗号分隔的面名）：属性缺席 = 缺省名单（只有侧栏面），空串 = 一个都不强制——两者
//     是两回事；名单里的面同时决定覆盖带不带 !important，两处判定共用同一函数；
//   · 其余面仍遵偏好。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import { TOKEN_MAP } from "../../packages/dsh/theme/token-map.ts";
import { compileRules } from "../../packages/dsh/theme/adapter.ts";
import { FACE_BACKDROP, VIEW_SEEDS, SEED_TOKEN_KEYS, seedTokensForView, seedsForDshPreference } from "@dshana/ui/seed-tokens.ts";
import { FACE_VIEWS } from "@dshana/ui/face-role.ts";
import { FORCE_FOLLOW_ATTR, FORCE_FOLLOW_FACES } from "@dshana/shared/face-theme.ts";

const BRIDGE_SRC = readFileSync(
  new URL("../../packages/dsh/theme/assets/theme-bridge.js", import.meta.url),
  "utf8",
);
const SHELL_SRC = readFileSync(new URL("../../packages/ui/src/app-shell.ts", import.meta.url), "utf8");
const HOST_THEME_SRC = readFileSync(new URL("../../packages/ui/src/host-theme.ts", import.meta.url), "utf8");

const BG = "#101010";
const SIDEBAR_BG = "#202020";
const HOST_VARS = { "--bg": BG, "--sidebar-bg": SIDEBAR_BG };

/**
 * 跑一次桥脚本，返回它写进 @dshana/dsh-theme-dyn 的 CSS 正文与它校准过的明暗状态。
 * @param backdrop 壳页写在 <html> 的 data-dshana-backdrop（null → 不写该属性）
 * @param options  appearance（宿主明暗）/ preference（dsh 侧偏好，默认 system；显式传 null =
 *                 属性尚未被 presenter 投影，即偏好未知）/ face（壳页写在 <html> 的
 *                 data-dshana-face，null → 不写该属性）/ forceFollow（壳页写在 <html> 的
 *                 data-dshana-force-follow，即强制面名单；不传 → 属性缺席，走缺省兜底；
 *                 传 "" → 属性存在且为空串，一个面都不强制）
 */
function runBridge(backdrop, options) {
  const opts = options || {};
  const styleTags = [];
  const observers = [];
  const attrs = {};
  if (opts.preference !== null) attrs["data-dsh-theme-preference"] = opts.preference || "system";
  if (backdrop) attrs["data-dshana-backdrop"] = backdrop;
  if (opts.face) attrs["data-dshana-face"] = opts.face;
  if (opts.appearance) attrs["data-appearance"] = opts.appearance;
  // 只认字符串：undefined = 属性缺席（桥按缺省兜底），"" = 显式一个都不强制。
  if (typeof opts.forceFollow === "string") attrs["data-dshana-force-follow"] = opts.forceFollow;
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
    createElement: () => {
      const el = { id: "", textContent: "", remove: () => {} };
      // 退出跟随时桥会 remove() 掉它自己建的 <style>：真从表里摘掉，否则再建一个时
      // getElementById 会命回旧的那个（读到上一轮的门）。
      el.remove = () => {
        const at = styleTags.indexOf(el);
        if (at >= 0) styleTags.splice(at, 1);
      };
      return el;
    },
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
      getPropertyValue: (name) => {
        const vars = opts.hostVars || HOST_VARS;
        return name in vars ? vars[name] : "";
      },
    }),
  };
  // 注：占位符在文件头注释里也出现过，所以这里与生产侧的 replace 不同，一次全换（生产侧靠
  // pack 的 terser 去注释，见 index.ts 与 pack.mjs）。
  const code = BRIDGE_SRC.replaceAll("__DSH_THEME_TOKENS__", JSON.stringify(compileRules(TOKEN_MAP)));
  vm.runInNewContext(code, sandbox);
  // 这几格用 getter：观察者回调会再写一次，快照式取值会把断言变成空转（读到的是跑桥那一刻的值）。
  // css 每读一次现查：桥可能在这之后才建出 <style>（例如面改成侧栏后才开始跟随）。
  const dynTag = () => styleTags.find((el) => el.id === "@dshana/dsh-theme-dyn");
  return {
    get css() { const tag = dynTag(); return tag ? tag.textContent : ""; },
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
  // 前边界取 ; 或 {：桥写的是 {token:值;…} 一条长串，只有第一格紧跟 {
  const hit = new RegExp("(?:[;{]|^)" + token + ":([^;]+);").exec(css);
  return hit ? hit[1] : null;
}

/** 取覆盖规则的正文（选择器列表与声明块分开，层叠题要看的就是这两半）。 */
function dynRule(css) {
  const hit = /^([^{]*)\{([^}]*)\}$/.exec(css.trim());
  return hit ? { selectors: hit[1].split(",").map((s) => s.trim()), body: hit[2] } : null;
}

/** 选择器特异性 [id, 类/属性/伪类, 元素]。 */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|::?[\w-]+/g) || []).length;
  const stripped = selector.replace(/\[[^\]]+\]/g, "").replace(/::?[\w-]+/g, "");
  const elements = (stripped.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids, classes, elements];
}

/** a 的特异性是否严格高于 b。 */
function outranks(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
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

test("桥：dsh 自己选了 light/dark 时，明暗写成它自己那一档（不是不管）", () => {
  // 从未跟随过（偏好一开始就是显式的）→ 桥没写过那两格 → 退出时也不该碰。
  const untouched = runBridge(null, { appearance: "dark", preference: "light" });
  assert.equal(untouched.dark, false, "dsh 显式 light 时不该被挂上 dark 标记");
  assert.equal(untouched.colorScheme, undefined, "没跟随过就不该留我们的 inline color-scheme");
});

test("桥：退出跟随时把明暗还给 dsh 自己那一档（宿主亮 + dsh 选暗 = 不该退回亮色）", () => {
  // 真机踩到：宿主亮、dsh 自己选了暗，取消勾选强制面后整片退回亮色。
  // 机制：跟随时桥把两格写成宿主值（light），而 presenter 只在快照发布时写它们，取消勾选不发布。
  const bridge = runBridge(null, { appearance: "light", preference: "system", face: "main" });
  assert.equal(bridge.colorScheme, "light", "起点：跟随时按宿主亮写");
  assert.equal(bridge.dark, false, "起点：宿主亮时不该挂深色标记");
  // 用户把 dsh 外观改成显式暗（偏好属性随之变）→ 退出跟随。
  bridge.setRootAttr("data-dsh-theme-preference", "dark");
  bridge.fireObservers();
  assert.equal(bridge.colorScheme, "dark", "退出跟随该把 color-scheme 写成 dsh 自己那一档（dark）");
  assert.equal(bridge.dark, true, "退出跟随该按 dsh 自己那一档挂回深色标记");
  assert.equal(bridge.css, "", "退出跟随该撤掉覆盖");
});

test("桥：退出跟随时反向也对（宿主暗 + dsh 选亮 = 该摘掉深色标记）", () => {
  const bridge = runBridge(null, { appearance: "dark", preference: "system", face: "main" });
  assert.equal(bridge.colorScheme, "dark", "起点：跟随时按宿主暗写");
  assert.equal(bridge.dark, true, "起点：宿主暗时该挂深色标记");
  bridge.setRootAttr("data-dsh-theme-preference", "light");
  bridge.fireObservers();
  assert.equal(bridge.colorScheme, "light", "退出跟随该写回 dsh 自己那一档（light）");
  assert.equal(bridge.dark, false, "退出跟随该摘掉深色标记");
});

test("桥：把面移出名单也算退出跟随，明暗同样还回去", () => {
  // 非强制面（main）在 system 偏好下也跟随；把偏好改成显式暗即退出，与取消勾选同一条路。
  const bridge = runBridge(null, { appearance: "light", preference: "system", face: "main" });
  assert.equal(bridge.colorScheme, "light");
  bridge.setRootAttr("data-dsh-theme-preference", "dark");
  bridge.fireObservers();
  assert.equal(bridge.colorScheme, "dark", "退出跟随该还回 dsh 自己那一档");
  assert.equal(bridge.dark, true, "该挂回深色标记");
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

test("桥：切到 dsh 显式偏好后，那两格写成 dsh 自己那一档（不抹、也不留我们的宿主值）", () => {
  // 起点：跟随宿主（偏好 system + 宿主浅）→ 桥把 html 的 color-scheme 写成 light。
  const bridge = runBridge(null, { appearance: "light" });
  assert.equal(bridge.colorScheme, "light", "跟随时该自己写上宿主明暗");
  // 用户把 dsh 外观改成显式深色：presenter 往同一格写 dark（标记它自己的 UA 明暗），偏好属性随之出现。
  bridge.setRootAttr("data-dsh-theme-preference", "dark");
  bridge.rootStyle.set("color-scheme", "dark");
  bridge.fireObservers();
  // 我们区分不了那一格的值是谁写的，所以**写而不是删**：删了会落在 presenter 写入之后，把它的值
  // 抹掉、UA 明暗退回系统档；写成 dsh 自己那一档则与 presenter 同值，幂等。
  assert.equal(bridge.colorScheme, "dark", "该写成 dsh 自己那一档（与 presenter 同值）");
});

test("桥：退出跟随时抹掉壳页垫的底色（主题切得干净）", () => {
  // dsh 自己选了 light → 不跟随 → 垫片该被抹掉（否则 body 内联钉着宿主色，切不干净）
  const off = runBridge(null, { appearance: "dark", preference: "light" });
  assert.deepEqual(off.seededKeys, [], "退出跟随时不该留着壳页垫的宿主底色");
});

test("桥：桥一落地也抹掉壳页垫的底色（内联只有 !important 压得住，留着就把后手堵死）", () => {
  // 壳页垫片（seed-tokens 的 VIEW_SEEDS）写在 body 内联样式上，目的只是桥落地前那一帧。
  // 桥落地后它只剩副作用：内联声明只有 !important 压得住，而非强制面正是靠不带 !important 才把
  // 「按属性请求改写同一格」的路让出来——垫片留着，那个请求就永远输给内联。
  for (const preference of ["system", "light", "dark"]) {
    const on = runBridge(null, { appearance: "light", preference });
    assert.deepEqual(
      on.seededKeys,
      [],
      "桥落地后不该留着壳页垫的内联底色（preference=" + preference + "）",
    );
  }
});

test("桥：底座那一格没被接管时不抹垫片（抹了就把首帧交回 DSH 的 boot 样式）", () => {
  // 宿主变量这一格暂时读不到（主题样式表还没落地）时，覆盖里根本没有底座那一格；
  // 此刻抹掉壳页垫的内联值 = 把首帧交回 DSH 的 boot 样式，而它认的是浏览器系统偏好。
  const bridge = runBridge(null, { appearance: "light", hostVars: { "--sidebar-bg": SIDEBAR_BG } });
  assert.equal(
    declaredValue(bridge.css, "--dsw-alias-bg-base"),
    null,
    "读不到 --bg 时覆盖里不该有底座那一格",
  );
  assert.equal(
    declaredValue(bridge.css, "background-color"),
    null,
    "底座那一格没被接管时不该写 body 背景（写了就是拿空值顶替）",
  );
  assert.ok(bridge.seededKeys.includes("--dsw-alias-bg-base"), "底座没接管时垫片该留着");
  assert.ok(bridge.seededKeys.includes("background-color"), "底座没接管时 body 背景垫片该留着");
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
  assert.equal(unknown.css, "", "偏好未知时不该写覆盖（门还关着）");
});

/** 声明块 → [属性, 值] 列表（取值里不含 ;）。 */
function declarations(body) {
  return body.split(";").filter(Boolean).map((d) => {
    const at = d.indexOf(":");
    return [d.slice(0, at), d.slice(at + 1)];
  });
}

test("桥：非强制面的覆盖不带 !important，靠特异性赢 dsh 调色板、并把属性请求让出去", () => {
  // 层叠事实（机制层，与任何具体插件无关）：
  //   · dsh 的调色板在 body 与 body[data-ds-dark-theme] 上声明同一批 token，且**后于**本桥
  //     注入（插件树激活晚于注入）——同特异性后手赢，所以裸 body 会被压回它的近白/近黑；
  //   · 属性选择器进特异性第二列，所以 body[attr] 压过 html body（元素数），
  //     但压不过 html body[data-ds-dark-theme][attr]（属性数 2 > 1）。
  // 覆盖因此是「html body + html body[data-ds-dark-theme] 共用一张声明表」的一种选择器形状、
  // 两档力度：非强制面（本用例）靠 specificity 赢 vendor、同时把属性请求让出去；强制面（侧栏，
  // 另一个用例）带 !important——它本来就不看特异性，元素级/属性级请求都改写不了它。
  const open = runBridge(null, { appearance: "dark", preference: "system" });
  assert.notEqual(open.css, "", "跟随时该有覆盖");
  assert.equal(open.css.includes("!important"), false, "非强制面的覆盖里不该出现 !important（它会堵死后手的改写）");
  const openRule = dynRule(open.css);
  assert.ok(openRule, "覆盖该是一条规则：" + open.css);
  // 明暗两档共用一张声明表：两档的宿主取值相同，暗色下 dsh 那条特异性更高，必须同样抬一档。
  assert.deepEqual(
    openRule.selectors,
    ["html body", "html body[data-ds-dark-theme]"],
    "覆盖该是 html body 与 html body[data-ds-dark-theme] 两条同声明的规则",
  );
  // 宿主变量照旧复用（不是搬值）：底座与侧栏填色都还指向宿主变量。
  assert.equal(declaredValue(open.css, "--dsw-alias-bg-base"), "var(--bg)");
  assert.equal(declaredValue(open.css, "--dsw-specific-sidebar-fill"), "var(--sidebar-bg)");
  // body 自身底色跟着底座那一格走（壳页垫的内联背景已被桥抹掉，这一格得有人接管）。
  assert.equal(declaredValue(open.css, "background-color"), "var(--dsw-alias-bg-base)");
  // 非强制面的四条层叠事实，逐条钉住（特异性 = [id, 属性/类, 元素]）：
  // ① 浅档：html body (0,0,2) > vendor 的 body (0,0,1)，宿主色赢（裸 body 会被 vendor 后手压掉）。
  assert.ok(outranks(specificity("html body"), specificity("body")), "html body 该压过 body");
  // ② 暗档：html body[data-ds-dark-theme] (0,1,2) > vendor 的 body[data-ds-dark-theme] (0,1,1)。
  assert.ok(
    outranks(specificity("html body[data-ds-dark-theme]"), specificity("body[data-ds-dark-theme]")),
    "暗档那条该压过 vendor 的同名属性规则",
  );
  // ③ 让位：请求方在浅档带一个属性就赢（(0,1,1) > (0,0,2)）；
  assert.ok(
    outranks(specificity("body[data-any-request]"), specificity("html body")),
    "浅档：按属性收窄的请求该压过覆盖",
  );
  // ④ 暗档要带上当时的明暗属性才赢（(0,2,1) > (0,1,2)）——覆盖暗档那条为了压过 vendor 的
  //    暗色调色板必须到 (0,1,2)，请求方要比它更具体就只能再收窄一层。这是层叠的算术，
  //    不是本桥的偏心；也正因如此，请求方在暗档若只带自己的属性（(0,1,1)）会输给覆盖。
  assert.ok(
    outranks(specificity("body[data-ds-dark-theme][data-any-request]"), specificity("html body[data-ds-dark-theme]")),
    "暗档：按当前明暗收窄的请求该压过覆盖",
  );
  assert.ok(
    outranks(specificity("html body[data-ds-dark-theme]"), specificity("body[data-any-request]")),
    "暗档：未按明暗收窄的请求输给覆盖（它同时也输给 vendor 的暗色调色板）",
  );
});

test("桥：强制面（侧栏）的覆盖一律带 !important（选择器形状不变）", () => {
  // 强制面（侧栏，偏好未投影也恒跟随）：同样的选择器形状，但每条声明都带 !important——
  // 那一面的跟随是强制的，元素级/属性级请求都不得改写它。
  const forced = runBridge(null, { appearance: "dark", face: "sidebar" });
  assert.notEqual(forced.css, "", "强制面跟随时该有覆盖");
  const forcedRule = dynRule(forced.css);
  assert.ok(forcedRule, "覆盖该是一条规则：" + forced.css);
  assert.deepEqual(
    forcedRule.selectors,
    ["html body", "html body[data-ds-dark-theme]"],
    "强制面与其余面共用同一种选择器形状（!important 不需要另一套选择器）",
  );
  const forcedDecls = declarations(forcedRule.body);
  assert.ok(forcedDecls.length > 0, "强制面的声明表不该为空");
  for (const [prop, value] of forcedDecls) {
    assert.ok(
      value.endsWith("!important"),
      "强制面每条声明都该以 !important 收尾：" + prop + ":" + value,
    );
  }
  // 底座与 background-color 同样带——这两格不在规则表里或以 var() 写成，单独钉一遍。
  assert.equal(declaredValue(forced.css, "--dsw-alias-bg-base"), "var(--bg)!important");
  assert.equal(declaredValue(forced.css, "background-color"), "var(--dsw-alias-bg-base)!important");
  // 取值本身不变：只是同一批声明被抬到 !important，宿主变量照旧复用。
  assert.equal(declaredValue(forced.css, "--dsw-specific-sidebar-fill"), "var(--sidebar-bg)!important");
});

test("桥：覆盖对两个明暗档给同一张声明表（明暗由 body 属性与宿主取值决定，不由选择器决定）", () => {
  const light = runBridge(null, { appearance: "light" });
  const dark = runBridge(null, { appearance: "dark" });
  assert.equal(light.css, dark.css, "两档的覆盖正文该逐字相同（宿主取值一样，明暗靠 body 属性选档）");
  assert.notEqual(light.css, "", "跟随时该有覆盖");
  // 强制面同样按这一条走：明暗只由 body 属性与宿主取值决定，!important 不参与选档。
  const forcedLight = runBridge(null, { appearance: "light", face: "sidebar" });
  const forcedDark = runBridge(null, { appearance: "dark", face: "sidebar" });
  assert.equal(forcedLight.css, forcedDark.css, "强制面两档的覆盖正文也该逐字相同");
  assert.equal(forcedLight.css.includes("!important"), true, "强制面的覆盖该带 !important");
});

test("桥：侧栏面恒跟随宿主（无视 dsh 自己的 light/dark 偏好）", () => {
  // 侧栏整幅嵌在宿主框架里，用 dsh 自己的明暗会与四周不同调——这一面恒跟随。
  const explicitLight = runBridge(null, { appearance: "dark", preference: "light", face: "sidebar" });
  assert.notEqual(explicitLight.css, "", "侧栏面在 dsh 显式 light 下也该有覆盖");
  assert.equal(explicitLight.colorScheme, "dark", "侧栏面该继续对齐宿主明暗");
  assert.equal(explicitLight.dark, true, "宿主深色时侧栏面该挂着深色标记");
  assert.deepEqual(explicitLight.seededKeys, [], "桥落地后垫片该被抹掉（恒跟随的面同样）");
  // 跟随是强制的：这一面的覆盖带 !important，元素级/属性级请求改写不了它。
  assert.equal(
    explicitLight.css.includes("!important"),
    true,
    "侧栏面（强制面）的覆盖该带 !important",
  );
  const forcedRule = dynRule(explicitLight.css);
  assert.ok(forcedRule, "侧栏面的覆盖该是一条规则");
  for (const [prop, value] of declarations(forcedRule.body)) {
    assert.ok(value.endsWith("!important"), "侧栏面每条声明都该以 !important 收尾：" + prop + ":" + value);
  }
  const explicitDark = runBridge(null, { appearance: "light", preference: "dark", face: "sidebar" });
  assert.notEqual(explicitDark.css, "", "侧栏面在 dsh 显式 dark 下也该有覆盖");
  assert.equal(explicitDark.colorScheme, "light", "侧栏面该继续对齐宿主明暗");
  assert.equal(explicitDark.dark, false, "宿主浅色时侧栏面不该挂着深色标记");
});

// ---- 强制面名单：由 <html> 的 FORCE_FOLLOW_ATTR 决定（缺省 = FORCE_FOLLOW_FACES）----
// 名单是唯一的那件事：在名单里 ⇒ 恒跟随宿主（无视 dsh 的 light/dark 偏好）+ 覆盖带 !important；
// 不在 ⇒ 仅 preference=system 时跟随、覆盖不带 !important。缺省名单里只有侧栏面，所以本组
// 用例的第一条就是「现在的行为一字不变」。

/** 这一面的覆盖是否带 !important（空覆盖 = 门关着，不带）。 */
function isForcedCover(css) {
  return css.includes("!important");
}

test("桥：强制面名单缺席时按缺省兜底——只有侧栏面恒跟随且带 !important，其余面遵偏好、不带", () => {
  // 缺省 = FORCE_FOLLOW_FACES（缺席是「老页面 / 壳页还没拉到设置」，不是「一个都不强制」）。
  assert.deepEqual([...FORCE_FOLLOW_FACES], ["sidebar"], "缺省名单该只有侧栏面");
  const sidebar = runBridge(null, { appearance: "dark", preference: "light", face: "sidebar" });
  assert.notEqual(sidebar.css, "", "缺省下侧栏面该恒跟随（dsh 显式 light 也照样有覆盖）");
  assert.equal(isForcedCover(sidebar.css), true, "缺省下侧栏面的覆盖该带 !important");
  assert.equal(sidebar.colorScheme, "dark", "缺省下侧栏面该对齐宿主明暗");
  for (const view of FACE_VIEWS) {
    if (view === "sidebar") continue;
    const other = runBridge(null, { appearance: "dark", preference: "light", face: view });
    assert.equal(other.css, "", "缺省下 " + view + " 面在 dsh 显式 light 时该遵偏好、不跟随");
    assert.equal(other.colorScheme, undefined, "缺省下 " + view + " 面不该留我们的 inline color-scheme");
    const following = runBridge(null, { appearance: "dark", preference: "system", face: view });
    assert.notEqual(following.css, "", "缺省下 " + view + " 面在 system 偏好下该跟随");
    assert.equal(
      isForcedCover(following.css),
      false,
      "缺省下 " + view + " 面不是强制面，覆盖不该带 !important",
    );
  }
});

test("桥：属性显式写成缺省名单（\"sidebar\"）时与缺席同结果", () => {
  const absent = runBridge(null, { appearance: "dark", preference: "light", face: "sidebar" });
  const explicit = runBridge(null, {
    appearance: "dark", preference: "light", face: "sidebar", forceFollow: "sidebar",
  });
  assert.equal(explicit.css, absent.css, "显式写缺省名单该与缺席逐字同结果");
  assert.equal(isForcedCover(explicit.css), true, "显式写缺省名单时侧栏面仍是强制面");
  assert.equal(explicit.colorScheme, absent.colorScheme, "明暗对齐也该一致");
});

test("桥：属性写成空串时一个面都不强制（缺席与空串是两回事）", () => {
  // 空串 = 用户显式清空了名单：连侧栏面也退回「遵 dsh 偏好」那一档，覆盖不带 !important。
  const empty = runBridge(null, { appearance: "dark", preference: "light", face: "sidebar", forceFollow: "" });
  assert.equal(empty.css, "", "空串下侧栏面在 dsh 显式 light 时该遵偏好、不跟随");
  assert.equal(empty.colorScheme, undefined, "空串下侧栏面不该留我们的 inline color-scheme");
  // 缺省与空串的差别正在这里：同一个面、同一个偏好，缺席时跟随、空串时不跟随。
  const absent = runBridge(null, { appearance: "dark", preference: "light", face: "sidebar" });
  assert.notEqual(absent.css, "", "对照组：缺席时侧栏面该跟随（两者不能合并）");
  // 偏好为 system 时仍跟随，但力度降到非强制档（不带 !important）。
  const following = runBridge(null, { appearance: "dark", preference: "system", face: "sidebar", forceFollow: "" });
  assert.notEqual(following.css, "", "空串只是不强制，system 偏好下该面仍跟随");
  assert.equal(isForcedCover(following.css), false, "空串下侧栏面不该再带 !important");
});

test("桥：名单改成 main 时 main 面恒跟随且带 !important，侧栏面退回遵偏好、不带", () => {
  const mainForced = runBridge(null, { appearance: "dark", preference: "light", face: "main", forceFollow: "main" });
  assert.notEqual(mainForced.css, "", "main 面进名单后该恒跟随（dsh 显式 light 也照样有覆盖）");
  assert.equal(isForcedCover(mainForced.css), true, "main 面进名单后覆盖该带 !important");
  assert.equal(mainForced.colorScheme, "dark", "main 面进名单后该对齐宿主明暗");
  const sidebarOff = runBridge(null, { appearance: "dark", preference: "light", face: "sidebar", forceFollow: "main" });
  assert.equal(sidebarOff.css, "", "名单换成 main 后侧栏面该退回遵偏好、不跟随");
  assert.equal(sidebarOff.colorScheme, undefined, "侧栏面退回后不该留我们的 inline color-scheme");
});

test("桥：名单写成 sidebar,stream 时两面都强制", () => {
  for (const face of ["sidebar", "stream"]) {
    const forced = runBridge(null, {
      appearance: "dark", preference: "light", face, forceFollow: "sidebar,stream",
    });
    assert.notEqual(forced.css, "", face + " 面在名单里该恒跟随");
    assert.equal(isForcedCover(forced.css), true, face + " 面在名单里该带 !important");
    assert.equal(forced.colorScheme, "dark", face + " 面该对齐宿主明暗");
  }
  // 名单外的面照旧：不在名单里就不强制。
  const outside = runBridge(null, { appearance: "dark", preference: "light", face: "main", forceFollow: "sidebar,stream" });
  assert.equal(outside.css, "", "名单外的 main 面该遵偏好、不跟随");
});

test("桥：壳页中途写属性（模拟拉到设置）后经 observer 重算，门跟着翻", () => {
  // 起点：属性还没到（壳页拉设置与 DSH boot 并行），侧栏面按缺省恒跟随。
  const bridge = runBridge(null, { appearance: "dark", preference: "light", face: "sidebar" });
  assert.notEqual(bridge.css, "", "起点该按缺省跟随");
  assert.equal(isForcedCover(bridge.css), true, "起点该是强制档");
  // 壳页拉到设置：显式清空名单 → observer 该重算，门翻过去（连覆盖一起撤）。
  bridge.setRootAttr(FORCE_FOLLOW_ATTR, "");
  bridge.fireObservers();
  assert.equal(bridge.css, "", "名单清空后该重算并退出跟随");
  // 再写回一份把 main 放进去的名单 → main 面该接管（属性一变就重算，无轮询）。
  bridge.setRootAttr("data-dshana-face", "main");
  bridge.setRootAttr(FORCE_FOLLOW_ATTR, "main");
  bridge.fireObservers();
  assert.notEqual(bridge.css, "", "名单改成 main 后该重算并跟随");
  assert.equal(isForcedCover(bridge.css), true, "重算后的 main 面该是强制档");
});

test("桥：壳页认面修正后（<html> 的 face 变了）桥跟着重算门", () => {
  // 壳页的面初值取自页面静态声明；宿主 slot 才认出来的面要到 begin() 才写出来（seedDshTokens →
  // publishFace）。桥要能看见那一笔，否则未声明面的 FP 会一直按 default 的门走。
  const bridge = runBridge(null, { appearance: "light", preference: "light" });
  assert.equal(bridge.css, "", "起点（default 面 + dsh 显式 light）不该有覆盖");
  bridge.setRootAttr("data-dshana-face", "sidebar");
  bridge.fireObservers();
  assert.notEqual(bridge.css, "", "面改成侧栏后该恒跟随、重新写出覆盖");
  assert.equal(bridge.colorScheme, "light", "重算后该继续对齐宿主明暗");
});

test("桥：其余面仍遵 dsh 偏好（侧栏面的恒跟随不外溢）", () => {
  for (const view of FACE_VIEWS) {
    if (view === "sidebar") continue;
    for (const preference of ["light", "dark"]) {
      const bridge = runBridge(null, { appearance: "dark", preference, face: view });
      assert.equal(bridge.css, "", view + " 面在 dsh 显式 " + preference + " 下不该有覆盖");
      assert.equal(
        bridge.colorScheme,
        undefined,
        view + " 面在 dsh 显式 " + preference + " 下不该留我们的 inline color-scheme",
      );
    }
  }
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
  // 宿主明暗由壳页经共享的 host-theme 写：壳页接上跟随、共享件落 data-appearance。
  assert.ok(SHELL_SRC.includes("followHostTheme"), "壳页没接上共享的宿主主题跟随");
  assert.ok(HOST_THEME_SRC.includes("data-appearance"), "共享件没把宿主明暗写出来");
  assert.ok(BRIDGE_SRC.includes("data-dshana-backdrop"), "桥没读 data-dshana-backdrop");
  assert.ok(BRIDGE_SRC.includes("data-appearance"), "桥没读宿主明暗");
  // 面的单一事实源：壳页把 seedView 写成 <html> 的面名属性，桥读同一处判「恒跟随的面」。
  // 壳页侧走 shared 的 FACE_ATTR 常量（属性名不长出第二份字面量），桥是散装浏览器 JS、只能读字面量。
  assert.ok(SHELL_SRC.includes("FACE_ATTR"), "壳页没写面名属性（该走 shared 的 FACE_ATTR）");
  assert.ok(BRIDGE_SRC.includes("data-dshana-face"), "桥没读 data-dshana-face");
  // 桥不另立一份面词表：面词表只有 face-role.ts 那一处（壳页经 isFaceView 校验后写属性），
  // 桥只按 <html> 上的名单比对面名，不枚举词表、也不按底色 token 反推面。唯一允许出现的
  // 面名字面量是缺省名单本身（= FORCE_FOLLOW_FACES，属性缺席时的兜底）；别的面名一律不许
  // 写死在桥里，否则「哪些面强制跟随」就有了第二个事实源。
  for (const view of FACE_VIEWS) {
    if (FORCE_FOLLOW_FACES.includes(view)) continue;
    assert.equal(
      BRIDGE_SRC.includes('"' + view + '"'),
      false,
      "桥里出现了面名 " + view + "：面词表该只有 face-role.ts 那一处事实源",
    );
  }
  // 名单从属性读：桥得认 FORCE_FOLLOW_ATTR 这个属性名（壳页写它、桥跟着重算）。
  assert.ok(
    BRIDGE_SRC.includes(FORCE_FOLLOW_ATTR),
    "桥没读 " + FORCE_FOLLOW_ATTR + "（强制面名单该从 <html> 的属性读）",
  );
  // 单一事实源：壳页写的面就是它认出来的那一面（seedView），不另立词表；
  // 且这次写入发生在顶层（注入可能早于首次主题载荷那次 seedDshTokens）。
  // 属性名走 shared 的 FACE_ATTR（每一处写它的页面都用同一个常量，免得属性名长出第二份字面量）。
  assert.match(SHELL_SRC, /setAttribute\(FACE_ATTR, seedView\)/, "壳页该写这一面的面名");
  assert.ok(SHELL_SRC.includes("publishFace();"), "壳页该在顶层先把面写出来（注入可能早于首次垫片）");
  const atPublish = SHELL_SRC.indexOf("publishFace();");
  const atFollow = SHELL_SRC.indexOf("followHostTheme(hana,");
  assert.ok(atPublish < atFollow, "面的声明该在顶层 followHostTheme 之前写出");
});

// ---- 垫片的「面」必须在首帧之前就定下来 ----
// 回归闸：未就绪的面（FP 停在「未启动」/「已停止」时）走不到 startInjection，而顶层那次
// followHostTheme 的 onApplied 已经会调 seedDshTokens。若 seedView 在那里还是个写死的
// "default"，整页就按中列面垫成 --bg：真机实测 FP 未启动帧 bodyInlineBg=rgb(59,74,84)
// （青夜 --bg），该是 #34424B（--sidebar-bg）。
test("壳页：垫片的面由页面静态声明先定下来，不写死 default", () => {
  // 面的初值必须读页面自己的声明（meta / 壳属性），而不是钉成一个常量。
  const init = /var seedView = ([^;]+);/.exec(SHELL_SRC);
  assert.ok(init, "壳页找不到 seedView 的初始化");
  assert.match(init[1], /declaredView\(/, "seedView 初值应取页面静态声明的面（未就绪的面只有这一个来源）");
  assert.ok(
    !/^\s*["']default["']\s*$/.test(init[1]),
    "seedView 初值不能写死 default：未就绪的 FP 会整页垫成中列色 --bg",
  );
  // 时机：必须在顶层 followHostTheme（首屏那次 onApplied）之前，否则第一次垫片已经用错面跑过了。
  const atSeed = SHELL_SRC.indexOf("var seedView =");
  const atFollow = SHELL_SRC.indexOf("followHostTheme(hana,");
  assert.ok(atFollow > atSeed, "seedView 必须在顶层 followHostTheme 之前定下来（那一次就会垫色）");
  // 认面用的是页面自己的声明，与 begin() 里那条完整判据同一份实现。
  assert.match(SHELL_SRC, /function declaredView\(/, "壳页应有 declaredView（页面静态声明的读法）");
});

test("壳页：begin() 拿到完整判据后与初值不一致就重垫一次", () => {
  // 页面没声明面、只靠宿主 slot 才认出来的情形：begin() 里那次校正必须重垫，
  // 否则整页底色停在那一个猜测上。
  assert.match(
    SHELL_SRC,
    /if \(view !== seedView\) \{ seedView = view; seedDshTokens\(\); \}/,
    "begin() 应在完整判据与初值不一致时重垫一次",
  );
});

test("各页面的静态声明覆盖到垫片要的每一个面（FP 是 sidebar）", () => {
  // 垫片按面取宿主变量，所以每个页面的声明都得能落到词表里；认不出就退回 default（中列色）。
  const pages = [
    ["main.html", "main"],
    ["default.html", "default"],
    ["sidebar.html", "sidebar"],
    ["settings.html", "settings"],
    ["stream.html", "stream"],
  ];
  for (const [name, view] of pages) {
    const html = readFileSync(new URL("../../packages/ui/src/" + name, import.meta.url), "utf8");
    assert.match(
      html,
      new RegExp('<meta name="hana-dshana-role" content="' + view + '">'),
      name + " 缺静态面声明（未就绪时垫片只能猜，会垫错色）",
    );
  }
  // FP 那一面垫的是侧栏色，与中列面不同源——这正是这条闸要防的那一档。
  assert.notEqual(FACE_BACKDROP.sidebar, FACE_BACKDROP.main, "侧栏面与主卡面的底座 token 应不同源");
  assert.equal(new Map(seedTokensForView("sidebar")).get("--dsw-alias-bg-base"), "--sidebar-bg");
  assert.equal(new Map(seedTokensForView("main")).get("--dsw-alias-bg-base"), "--bg");
});
