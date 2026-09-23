// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/theme-tokens.test.mjs — 适配规则表（src-cordis/plugins/theme/token-map.ts）与编译
// （src-cordis/plugins/theme/adapter.ts）的形状单测。
//
// 这张表是主题跟随的唯一数据面：服务端把规则编译成 [token, cssValue, hostVars] 三元组，
// 随桥脚本下发，浏览器侧逐条写成 body{--dsw-*: <cssValue>!important}。改错一个 token 名、
// 写错宿主变量名、或把偏移量写到越界，在真机上只会表现为“某处颜色不跟主题走”，很难定位——
// 所以在这里把形状钉死：
//   · LHS 必须是 --dsw-*（DSH 自己的 token 名）且不重复；
//   · RHS 是宿主主题变量（--foo）、偏移规则（{of, shift[, with]}）或 ~ 固定值；
//   · 引用的宿主变量必须在允许清单里（防止 --txet 这种手误）；
//   · 偏移量落在 (0, 100]。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOKEN_MAP, PASSTHROUGH } from "../src-cordis/plugins/theme/token-map.ts";
import { compileRules, compileTarget, targetHostVars } from "../src-cordis/plugins/theme/adapter.ts";
import { FACE_VIEWS } from "../src/lib/face-role.ts";
import { VIEW_SEEDS, FACE_BACKDROP, seedTokensForView } from "../src/lib/seed-tokens.ts";

// 宿主主题变量的允许清单（壳页从 hana.theme 拿到的 --* 变量；未选中的颜色绝不发明）
const HOST_VARS = new Set([
  "--bg",
  "--bg-card",
  "--sidebar-bg",
  "--text",
  "--text-light",
  "--text-muted",
  "--border",
  "--accent",
  "--accent-hover",
  "--accent-light",
  "--danger",
  "--green",
  "--user-bg",
  "--overlay-medium",
  "--overlay-strong",
  "--drop-overlay-bg",
]);

const COMPILED = compileRules(TOKEN_MAP);
/** token → 这条规则依赖的第一个宿主变量（固定值 / 纯字面量为 null）。 */
const hostVarOf = new Map(COMPILED.map(([token, , deps]) => [token, deps[0] || null]));

test("TOKEN_MAP：LHS 均为 --dsw-* 且不重复", () => {
  assert.equal(Array.isArray(TOKEN_MAP), true);
  const seen = new Set();
  for (const row of TOKEN_MAP) {
    assert.equal(Array.isArray(row) && row.length === 2, true, "每行必须是 [token, target]：" + JSON.stringify(row));
    const [token] = row;
    assert.match(token, /^--[a-z0-9-]+$/, "LHS 必须是 CSS 变量名：" + token);
    assert.equal(seen.has(token), false, "LHS 重复：" + token);
    seen.add(token);
  }
  // 下限是防误删的护栏（按当前规模校准，留出正常增删余量；当前 100+ 条）。
  assert.equal(TOKEN_MAP.length >= 90, true, "规则表条目过少（疑似被删）：" + TOKEN_MAP.length);
});

test("TOKEN_MAP：RHS 是宿主变量、偏移规则或登记过的固定值", () => {
  const literals = [];
  for (const [token, target] of TOKEN_MAP) {
    if (typeof target === "string") {
      if (target.startsWith("~")) {
        literals.push(token);
        continue;
      }
      assert.equal(HOST_VARS.has(target), true, token + " 指向了未知宿主变量：" + target);
      continue;
    }
    if ("fixed" in target) {
      assert.equal(typeof target.fixed, "string", token + " 的固定值必须是字符串");
      assert.ok(target.fixed.trim().length > 0, token + " 的固定值为空");
      continue;
    }
    assert.equal(HOST_VARS.has(target.of), true, token + " 的基色不是已知宿主变量：" + target.of);
    if (target.with !== undefined) {
      assert.equal(HOST_VARS.has(target.with), true, token + " 的对比色不是已知宿主变量：" + target.with);
    }
    if (target.shift !== undefined) {
      assert.equal(typeof target.shift, "number", token + " 的偏移量必须是数字");
      assert.ok(target.shift > 0 && target.shift <= 100, token + " 的偏移量越界：" + target.shift);
    }
  }
  // 只有滚动条这类与主题无关的可见构件允许用 ~ 字面量
  assert.deepEqual(literals, [
    "--dsw-alias-scrollbar-bg-l1",
    "--dsw-alias-scrollbar-bg-l2",
    "--dsw-alias-scrollbar-hover-l1",
    "--dsw-alias-scrollbar-hover-l2",
  ]);
});

test("适配层编译：直连 / 偏移 / 固定值三形态", () => {
  assert.equal(compileTarget("--bg"), "var(--bg)");
  assert.equal(compileTarget("~rgba(128,128,128,0.4)"), "rgba(128,128,128,0.4)");
  assert.equal(
    compileTarget({ of: "--bg", shift: 8 }),
    "color-mix(in srgb, var(--bg) 92%, var(--text) 8%)",
  );
  assert.equal(
    compileTarget({ of: "--bg", shift: 15, with: "--accent" }),
    "color-mix(in srgb, var(--bg) 85%, var(--accent) 15%)",
  );
  assert.equal(compileTarget({ of: "--bg", shift: 0 }), "var(--bg)", "零偏移等于直连");
  assert.equal(compileTarget({ fixed: "#2b2b2b" }), "#2b2b2b");
  assert.deepEqual(targetHostVars({ of: "--bg", shift: 8 }), ["--bg", "--text"]);
  assert.deepEqual(targetHostVars({ of: "--bg", shift: 8, with: "--bg" }), ["--bg"]);
  // 两端与编译同口径：零偏移只依赖基色，满偏移只依赖对比色（否则多列的那格变量缺一个，桥就会把
  // 这条规则整条丢掉）。
  assert.deepEqual(targetHostVars({ of: "--bg", shift: 0 }), ["--bg"]);
  assert.deepEqual(targetHostVars({ of: "--bg", shift: 100 }), ["--text"]);
  assert.deepEqual(targetHostVars("--bg"), ["--bg"]);
  assert.deepEqual(targetHostVars("~x"), []);
  assert.deepEqual(targetHostVars({ fixed: "#000" }), []);
});

test("TOKEN_MAP：alias 语义层的补漏条目在位", () => {
  const map = new Map(TOKEN_MAP);
  const expect = {
    "--dsw-alias-link": "--accent",
    "--dsw-alias-interactive-bg-hover-danger": { of: "--bg", shift: 8 },
    "--dsw-alias-label-error": "--danger",
    "--dsw-alias-bg-skeleton": { of: "--bg", shift: 8 },
    "--dsw-alias-separator-primary": "--border",
    "--dsw-alias-label-quaternary": "--text-muted",
    "--dsw-hovercard-bg": "--bg-card",
    "--dsw-alias-state-idle-primary": "--text-muted",
  };
  for (const [k, v] of Object.entries(expect)) {
    assert.deepEqual(map.get(k), v, k + " 规则缺失或改变");
  }
});

test("TOKEN_MAP：字体/静态调色板/阴影/几何/结构性深浅不接管（层次位例外见下）", () => {
  // 例外：这四个调色板值在 dsh 里被当“卡片填充/悬停的层次位”用（ChangedFiles / Deliverables /
  // PlanPreview 的 --*-fill / --*-hover，配 body[data-ds-dark-theme] 自己翻明暗）。它们不随主题走
  // 恰恰是漏覆盖的来源，按层次位偏移接入才对；消费者只有那三组（见 token-map 注释）。
  const STATIC_AS_LAYER = new Set([
    "--dsw-static-neutral-50",
    "--dsw-static-neutral-100",
    "--dsw-static-neutral-800",
    "--dsw-static-neutral-850",
  ]);
  for (const [token] of TOKEN_MAP) {
    if (STATIC_AS_LAYER.has(token)) continue;
    assert.equal(
      /^--dsw-(font|static|elevation|shadow|corner|mask-blur|linear|alias-tooltip-bg|alias-toast-bg)/.test(token),
      false,
      token + " 不该在规则表里",
    );
    // alias-border-l* 里只放行 l3：它兼作“占用环”的轨道色（ContextMeter 的 .track）；
    // 其余档是 elevation 的描边色来源（结构性：浅色主题黑、深色主题白，随明暗翻转），保持原生。
    if (/^--dsw-alias-border-l/.test(token)) {
      assert.equal(token, "--dsw-alias-border-l3", token + " 只有 l3 允许接管");
    }
  }
});

test("PASSTHROUGH：显式不接管清单每项都有正则与理由", () => {
  assert.ok(PASSTHROUGH.length > 0, "不接管清单为空");
  for (const entry of PASSTHROUGH) {
    assert.ok(entry.match instanceof RegExp, "每项必须有 match 正则");
    assert.ok(typeof entry.why === "string" && entry.why.trim().length > 0, "每项必须写理由");
  }
});

test("TOKEN_MAP：层次位用偏移（不拿面去顶，也不靠叠色变量）", () => {
  const map = new Map(TOKEN_MAP);
  // 这些是"比底略深"的表面。宿主只有一层 --bg-card，直接接上去差为 0（悬停与静止同色、
  // 按钮与输入框融为一体）；偏移档才能还原 dsh 的 5% 级明度差，且浅深主题自动反向。
  for (const token of [
    "--dsw-specific-selector",
    "--dsw-alias-interactive-bg-hover-solid",
    "--dsw-alias-bg-skeleton",
    "--dsw-alias-markdown-code-block",
  ]) {
    assert.deepEqual(map.get(token), { of: "--bg", shift: 8 }, token + " 应为 --bg 的 8% 偏移");
  }
  // 卡片填充族的静止档 = 8%、悬停档 = 15%；代码块 banner 与体差一档（见 token-map 注释）。
  for (const [token, want] of [
    ["--dsw-static-neutral-50", { of: "--bg", shift: 8 }],
    ["--dsw-static-neutral-850", { of: "--bg", shift: 8 }],
    ["--dsw-static-neutral-100", { of: "--bg", shift: 15 }],
    ["--dsw-static-neutral-800", { of: "--bg", shift: 15 }],
    ["--dsw-alias-markdown-code-block-banner", { of: "--bg", shift: 15 }],
  ]) {
    assert.deepEqual(map.get(token), want, token + " 的偏移档不符");
  }
});

test("TOKEN_MAP：layer-1 接宿主卡片面，不用自算档位", () => {
  const map = new Map(TOKEN_MAP);
  // 上游浅色下 layer-1 与 base 同值（分层靠描边），深色下才比 base 抬起两档——这个“明暗不等”
  // 的相对关系只有宿主自己那对 --bg / --bg-card 给得出：shift 的 N% 朝对比色在近白底与中间调
  // 深底上不等价，浅色会算出一档比宿主卡片差大几倍的颜色（轨迹表/JSON 树上的深带子）。
  assert.equal(map.get("--dsw-alias-bg-layer-1"), "--bg-card", "layer-1 该接卡片面，不该用偏移");
  // 宿主只给一层卡片面：层族其余两格同源，深色那条 875/850/800 阶梯不硬造。
  assert.equal(map.get("--dsw-alias-bg-layer-2"), "--bg-card");
  assert.equal(map.get("--dsw-alias-bg-layer-3"), "--bg-card");
});

test("闪白兜底：每面垫的底色 = 这一面可见底 token 在规则表里的宿主变量", () => {
  const referenced = new Set(COMPILED.flatMap(([, , deps]) => deps));
  for (const view of FACE_VIEWS) {
    const backdrop = FACE_BACKDROP[view];
    assert.ok(backdrop, view + " 面没声明可见底 token");
    const hostVar = hostVarOf.get(backdrop);
    assert.ok(hostVar, view + " 面的可见底 token 不在规则表里：" + backdrop);
    const spec = VIEW_SEEDS[view];
    assert.ok(spec && spec.length > 0, view + " 面没有垫片规格（注入时那一面会先画 DSH 的近白底）");
    const seeded = new Map(spec);
    assert.equal(
      seeded.get("--dsw-alias-bg-base"),
      hostVar,
      view + " 面：.frame / DSH 加载屏那一层垫的颜色与这一面的可见底不同源",
    );
    assert.equal(seeded.get(backdrop), hostVar, view + " 面：可见底那一格没垫成同源色");
    for (const [token, value] of spec) {
      assert.ok(referenced.has(value), token + " 垫的不是规则表里引用的宿主变量：" + value);
    }
  }
});

test("闪白兜底：垫的底色 = 这一面加载完之后真正显示的底色", () => {
  for (const view of ["default", "main", "stream", "settings"]) {
    assert.equal(
      new Map(seedTokensForView(view)).get("--dsw-alias-bg-base"),
      "--bg",
      view + " 面（中列）垫的颜色该是内容底色",
    );
  }
  // 侧栏面：可见区就是侧栏列（列画 --dsw-specific-sidebar-fill ← --sidebar-bg），
  // 所以列身后那一层（.frame / DSH 加载屏）也必须是侧栏色，否则自举台面已是侧栏色、
  // DSH 一加载又退回中列色——加载时换一次底，就是这条测试拦的事。
  assert.equal(
    new Map(seedTokensForView("sidebar")).get("--dsw-alias-bg-base"),
    "--sidebar-bg",
    "侧栏面的加载底色没跟侧栏列同源",
  );
});

test("侧栏面的加载底色与注入后同源（同一对规则 + 页面取色顺序）", () => {
  assert.equal(
    hostVarOf.get("--dsw-specific-sidebar-fill"),
    "--sidebar-bg",
    "“侧栏注入后用哪个色”是页面取色顺序的依据，这条规则变了页面也得改",
  );
  const html = readFileSync(new URL("../src/ui/sidebar.html", import.meta.url), "utf8");
  assert.match(
    html,
    /background:\s*var\(--dsw-specific-sidebar-fill,\s*var\(--sidebar-bg,\s*#F5EFE4\)\)/,
    "侧栏页底色要按「DSH token → 同一个宿主变量 → 纸张」逐级兜底，才能在注入前后不跳色",
  );
});

test("TOKEN_MAP：差异语义色接宿主绿红（文件对比与代码块用同一套读法）", () => {
  const map = new Map(TOKEN_MAP);
  // 上游这两族的值是硬编码调色板 tint（浅色 rgb(230,244,231)、深色 rgb(31,49,36)），不随主题走——
  // 不接的话同一张界面上会同时出现宿主的绿与 dsh 的绿。接法分两层：底与行号区是“绿/红掺进页面底”
  // 的淡色，标记 / 代码块差异底是饱和语义色。两族的档位关系不同（代码块差异底直接铺在页面上，
  // 没有代码块那一层垫底），所以不在同一个偏移量上。
  const expect = {
    "--dsw-alias-file-diff-added-bg": { of: "--bg", shift: 12, with: "--green" },
    "--dsw-alias-file-diff-added-gutter": { of: "--bg", shift: 6, with: "--green" },
    "--dsw-alias-file-diff-added-marker": "--green",
    "--dsw-alias-file-diff-deleted-bg": { of: "--bg", shift: 12, with: "--danger" },
    "--dsw-alias-file-diff-deleted-gutter": { of: "--bg", shift: 6, with: "--danger" },
    "--dsw-alias-file-diff-deleted-marker": "--danger",
    "--dsw-alias-code-diff-added": { of: "--bg", shift: 10, with: "--green" },
    "--dsw-alias-code-diff-deleted": { of: "--bg", shift: 10, with: "--danger" },
  };
  for (const [k, v] of Object.entries(expect)) {
    assert.deepEqual(map.get(k), v, k + " 规则缺失或改变");
  }
  // 掺色方向必须是绿/红本身，不能落到默认对比色（--text）上：那会把差异底染成灰调带子。
  for (const [k, v] of Object.entries(expect)) {
    if (typeof v !== "object") continue;
    assert.equal(typeof v.with, "string", k + " 的偏移没写定向掺色变量");
  }
});
