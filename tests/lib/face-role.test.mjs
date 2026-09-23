// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/face-role.test.mjs — 页面的「面」与 DSH 侧角色词（src/lib/face-role.ts）。
//
// 面的事实源是页面自己的静态声明（meta / body[data-dshana-view]），映射表在可单测的模块里。
// 这里盯两件事：① 词表与映射是封闭可判定的；② 每个角色词在 ui-layout 覆盖层的
// ROLE_SURFACES 里都真的有分支——任一侧加了面而另一侧没跟，测试就红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FACE_ROLE, FACE_VIEWS, isFaceView, roleForView } from "../../src/lib/face-role.ts";

test("壳页共用台面样式：三个面都引 face-stage.css，且不再各自拄一份", () => {
  const ui = (name) => readFileSync(join(here, "..", "..", "src", "ui", name), "utf8");
  const css = ui("face-stage.css");
  for (const rule of ["#dsh-stage {", ".wordmark {", ".diag-progress {", "#dsh-stage button {"]) {
    assert.ok(css.includes(rule), "共用样式里应有 " + rule);
  }
  for (const page of ["main.html", "default.html", "stream.html"]) {
    const html = ui(page);
    assert.match(html, /<link rel="stylesheet" href="\.\/face-stage\.css">/, page + " 应引共用台面样式");
    for (const rule of ["#dsh-stage {", ".wordmark {", ".diag-progress {"]) {
      assert.ok(!html.includes(rule), page + " 不应再自带 " + rule + "（台面样式只在 face-stage.css）");
    }
  }
  // sidebar 面画的是 .panel 侧栏 chrome，不是这副台面。
  assert.ok(!ui("sidebar.html").includes("face-stage.css"), "sidebar 不引台面样式");
});

test("只读会话流面：摘的是输入卡，不是整座（座位里挂着统计信息行）", () => {
  const css = readFileSync(join(here, "..", "..", "src-integrations", "ui-layout", "files", "src", "client", "AppFrame.module.css"), "utf8");
  assert.match(
    css,
    /\[data-dshana-surface="stream"\] \[data-composer-card\] \{\s*\n\s*display: none;/,
    "stream 面应收起输入卡（[data-composer-card]）",
  );
  assert.match(
    css,
    /\[data-dshana-surface="stream"\] \[data-conversation-header-corner\] \{\s*\n\s*display: none;/,
    "stream 面应收起 header 角落的右栏展开钮（没有可展开的栏）",
  );
  assert.ok(
    !/data-dshana-surface="stream"\][^{]*\[data-composer-seat\]/.test(css),
    "不该收整个座位：统计信息行（[data-composer-stats]）挂在座位里，一并收掉会把每轮的耗时/吞吐带走",
  );
});

test("只读会话流面：未钉住时跟随共用选中，不把会话清空", () => {
  const src = readFileSync(join(here, "..", "..", "src-integrations", "ui-session", "files", "src", "client", "index.ts"), "utf8");
  // 不带 sid 直接开页 = 跟随跨面共用的当前会话（见 ui/stream.html 的注释）。
  // 若这一支也报 MAX_SAFE_INTEGER，applyRemote 就会把它当成「最新的意思：没有会话」而 clear()。
  assert.match(src, /if \(sid === null\) return sharedSelection\(\)/, "未钉住要回落到共用选中");
  assert.ok(!/id: sid \?\? null/.test(src), "不再把「没钉住」当成「就是没有会话」");
});

const here = dirname(fileURLToPath(import.meta.url));
const APP_FRAME = join(here, "..", "..", "src-integrations", "ui-layout", "files", "src", "client", "AppFrame.tsx");

test("认面：词表内的值才算声明", () => {
  for (const view of FACE_VIEWS) assert.equal(isFaceView(view), true);
  for (const bad of ["", "MAIN", "sidebar ", "unknown", null, undefined, 1, {}]) {
    assert.equal(isFaceView(bad), false, "不属于词表的值一律当没声明：" + String(bad));
  }
});

test("映射：每个面都有角色词，认不出面时回到上游整幅 UI", () => {
  for (const view of FACE_VIEWS) {
    assert.equal(typeof FACE_ROLE[view], "string");
    assert.ok(FACE_ROLE[view].length > 0);
    assert.equal(roleForView(view), FACE_ROLE[view]);
  }
  assert.equal(roleForView(null), "standalone", "认不出面按上游本来的行为画整幅，不擅自少一列");
  assert.equal(roleForView("nope"), "standalone");
});

test("只读会话流面：角色词是 stream，且不与别的面共用", () => {
  assert.equal(roleForView("stream"), "stream");
  const others = FACE_VIEWS.filter((v) => v !== "stream").map((v) => FACE_ROLE[v]);
  assert.ok(!others.includes("stream"), "stream 是这一面专属的角色词");
});

test("ui-layout 覆盖层：每个角色词都有对应 surface 分支", () => {
  const source = readFileSync(APP_FRAME, "utf8");
  const block = /const ROLE_SURFACES[^=]*=\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(block, "AppFrame.tsx 里应有 ROLE_SURFACES 表");
  const words = new Set([...block[1].matchAll(/([A-Za-z][\w-]*)\s*:/g)].map((m) => m[1]));
  for (const role of new Set(Object.values(FACE_ROLE))) {
    assert.ok(words.has(role), "覆盖层缺角色词：" + role);
  }
});

test("侧栏收起：只在有轨的 default（standalone）面上生效，无轨面的折叠宽是 0", () => {
  const frame = readFileSync(APP_FRAME, "utf8");
  // 「本面有没有轨」（sidebarPresent）与「是不是收起」（sidebar===0 / narrowExpanded）分开算：
  // 混用会让 default 面的收起消失，或让没有侧栏的面被图标轨挤压。
  assert.match(frame, /const sidebarPresent = surface === 'standalone'/);
  assert.match(frame, /layoutInfo\.sidebar === 0/, "收起状态要认 sidebar===0");
  assert.match(frame, /layoutInfo\.narrowExpanded/, "窄幅收起要认 narrowExpanded");
  assert.ok(!/const sidebarCollapsed = false/.test(frame), "收起被钉成 false 了（default 面会丢掉收起）");
  // 收起宽度走上游的 collapsedWidth（桌面平台 0，其余 56px 图标轨）；本面无侧栏轨时传 0 把列整条藏掉。
  assert.match(frame, /const closedWidth = sidebarPresent \? collapsedWidth : 0/);
  assert.match(frame, /computeColumns\([^)]*closedWidth\)/, "computeColumns 应拿到本面的收起宽度");
  assert.match(frame, /const renderedSidebarWidth = sidebarPresent \? cols\.sidebar/);
  const sidebarRoot = readFileSync(join(here, "..", "..", "src-integrations", "ui-sidebar", "files", "src", "client", "SidebarRoot.tsx"), "utf8");
  assert.ok(!/surfaceRole !== 'standalone'/.test(sidebarRoot), "折叠钮不该排除 standalone（那一面的收起是真的）");
  assert.match(sidebarRoot, /toggleSidebar\(\)/, "折叠钮要真的能切换");
});

test("清单与页面：stream 面由 ui/stream.html 承担（卡页就是它，不另开卡）", () => {
  const html = readFileSync(join(here, "..", "..", "src", "ui", "stream.html"), "utf8");
  assert.match(html, /<meta name="hana-dshana-role" content="stream">/);
  assert.match(html, /data-dshana-view="stream"/);
  const manifest = JSON.parse(readFileSync(join(here, "..", "..", "src", "manifest.json"), "utf8"));
  const ids = manifest.contributes.cards.map((c) => c.id);
  assert.ok(!ids.includes("stream"), "会话流走工具的聊天流卡（details.card 指这一页），不占卡片中心一格");
});
