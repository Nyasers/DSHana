// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ui/first-frame-theme.test.mjs — 首帧主题（五个页面 <head> 里的内联片段）
//
// 平台契约（APPS.md）：「初始主题样式沿用 Creator 模板中的 hana-css 加载方式，之后 SDK 跟随
// 主题变化。」首帧样式表必须由**页面自己**按 URL 参数同步加载：@hana/plugin-sdk 只在收到
// hana.theme.changed 时才应用 cssUrl，初始化只把 URL 参数读进快照、不贴样式表。
//
// 这条闸守的就是「以后新增页面忘了贴首帧」：页面里的模块脚本要等一次 fetch，赶不上第一次
// 绘制——不贴，第一帧就是样式表里写死的纸张 fallback（#F5EFE4），切一次主题才跟上。
// 所以这里断言五件事：
//   ① 五个页面都带这个片段；
//   ② 片段**逐字相同**（一处改、五处一起改，否则各面首帧行为开始漂移）；
//   ③ 片段在 <head> 内、所有静态 <link rel="stylesheet"> 之后、模块脚本之前
//      （宿主变量必须排在组件自带样式之后才覆盖得住，且必须在模块脚本之前才叫首帧）；
//   ④ 片段真的读 hana-css，并在为空时回退宿主路由；
//   ⑤ 去重契约的两半对得上：片段把贴过的 URL 记在 <html>，host-theme.ts 按同一个属性名跳过
//      那次重复 fetch。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  applyHostThemeStylesheet,
  THEME_CSS_ATTR,
  THEME_INLINE_LINK_ATTR,
} from "@dshana/ui/host-theme.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "..", "packages", "ui", "src");
const page = (name) => readFileSync(join(SRC, name), "utf8");
const HOST_THEME_SRC = readFileSync(join(SRC, "host-theme.ts"), "utf8");

/** 五个面各自的页面（壳页三态 + 会话卡 + 设置页）。新增页面就得进这张表。 */
const PAGES = ["main.html", "default.html", "sidebar.html", "settings.html", "stream.html"];

// 读的是**源码**页（packages/ui/src/*.html），不是 dist 产物：标记注释会被构建期的 HTML 压缩
// （scripts/build/minify-assets.mts 的 removeComments）去掉，产物里比对不了。这条闸守的是
// 「新页面在源码里就别忘了贴」，位置与内容都在源码层判定。

const MARKER = "<!-- dshana:first-frame-theme";
/** 取标记注释起、到该片段的 </script> 止——片段的完整文本。 */
function snippetOf(html) {
  const start = html.indexOf(MARKER);
  assert.ok(start >= 0, "缺首帧主题片段（标记注释 " + MARKER + "）");
  const end = html.indexOf("</script>", start);
  assert.ok(end > start, "首帧主题片段没有闭合的 </script>");
  return html.slice(start, end + "</script>".length);
}

test("五个页面都带首帧主题片段", () => {
  for (const name of PAGES) {
    const html = page(name);
    assert.ok(html.includes(MARKER), name + " 没贴首帧主题片段（首帧会吃纸张 fallback）");
  }
});

test("片段逐字相同：一处改、五处一起改", () => {
  const [first, ...rest] = PAGES.map((name) => ({ name, snippet: snippetOf(page(name)) }));
  for (const other of rest) {
    assert.equal(
      other.snippet,
      first.snippet,
      other.name + " 的首帧主题片段与 " + first.name + " 不一致（各面首帧行为开始漂移）",
    );
  }
});

test("片段在 <head> 内、所有静态样式表之后、模块脚本之前", () => {
  for (const name of PAGES) {
    const html = page(name);
    const at = html.indexOf(MARKER);
    const headEnd = html.indexOf("</head>");
    assert.ok(at < headEnd, name + "：片段必须在 <head> 内（首帧样式表要在绘制前落地）");

    // 片段之后到 </head> 之间不得再有静态样式表（<link rel="stylesheet" href=…> 或 <style>）：
    // 宿主主题变量要排在组件自带样式之后才覆盖得住。片段自身用 createElement + rel 赋值，它那句
    // 标记注释里的 `<link rel="stylesheet">` 也不带 href，所以都不会被这两条正则误判。
    const tail = html.slice(at, headEnd);
    assert.equal(
      /<link\s+rel="stylesheet"\s+href=/.exec(tail),
      null,
      name + "：片段之后还有静态 <link rel=\"stylesheet\">（宿主变量会被它盖住）",
    );
    assert.equal(
      /<style[\s>]/.exec(tail),
      null,
      name + "：片段之后还有 <style>（宿主变量会被它盖住）",
    );

    // 模块脚本在片段之后：模块那条路径要等一次 fetch，不能拿它当首帧。
    const moduleScript = html.indexOf('<script type="module"');
    assert.ok(moduleScript > at, name + "：片段必须在模块脚本之前（那才是第一次绘制之前）");
  }
});

test("静态样式表确实排在片段之前（正面例：壳页引了 face-stage.css / settings.css）", () => {
  const expect = {
    "main.html": "./face-stage.css",
    "default.html": "./face-stage.css",
    "stream.html": "./face-stage.css",
    "settings.html": "./settings.css",
  };
  for (const [name, href] of Object.entries(expect)) {
    const html = page(name);
    const at = html.indexOf(MARKER);
    const linkAt = html.indexOf('<link rel="stylesheet" href="' + href + '">');
    assert.ok(linkAt >= 0, name + " 少了静态样式表 " + href);
    assert.ok(linkAt < at, name + "：" + href + " 必须排在首帧片段之前（宿主变量才覆盖得住）");
  }
  // sidebar 面没有外链样式表，它自带 <style>——同样得排在片段之前。
  const sidebar = page("sidebar.html");
  assert.ok(sidebar.indexOf("<style>") < sidebar.indexOf(MARKER), "sidebar.html：自带 <style> 必须排在片段之前");
});

test("片段读 hana-css（缺则回退宿主路由）并写主题身份", () => {
  const snippet = snippetOf(page("main.html"));
  assert.ok(snippet.includes("hana-css"), "片段没读 hana-css");
  assert.ok(snippet.includes("hana-theme"), "片段没读 hana-theme");
  assert.ok(snippet.includes("hana-theme-appearance"), "片段没读 hana-theme-appearance");
  // 宿主没带 hana-css 时的回退：/api/apps/theme.css 是宿主路由（公开），不是本 App 的资源。
  assert.match(snippet, /get\("hana-css"\)\s*\|\|\s*"\/api\/apps\/theme\.css"/, "片段缺宿主主题路由回退");
  assert.ok(snippet.includes('setAttribute("data-theme"'), "片段没写 data-theme");
  assert.ok(snippet.includes('setAttribute("data-appearance"'), "片段没写 data-appearance");
  // 明暗只认 light|dark（别的值不写，免得把非法值当主题身份）。
  assert.match(snippet, /appearance === "light" \|\| appearance === "dark"/, "data-appearance 应收窄到 light|dark");
  // 同步贴 <link>：这是「首帧」的全部依据。
  assert.match(snippet, /createElement\("link"\)/, "片段没贴 <link>");
  assert.match(snippet, /rel = "stylesheet"/, "那张 <link> 不是样式表");
  // 畸形 URL 不阻断页面。
  assert.ok(snippet.includes("URLSearchParams"), "片段没读 URL 参数");
});

test("去重契约：片段记下贴过的 URL，host-theme.ts 按同一个属性名跳过重复 fetch", () => {
  const snippet = snippetOf(page("main.html"));
  // 两半契约的落点：片段写、模块读。
  assert.ok(snippet.includes('setAttribute("data-hana-theme-css", css)'), "片段没把贴过的 URL 记在 <html>");
  assert.match(
    HOST_THEME_SRC,
    /THEME_CSS_ATTR\s*=\s*"data-hana-theme-css"/,
    "host-theme.ts 的 THEME_CSS_ATTR 与片段记的属性名对不上",
  );
  // 内联那张 <link> 的标记属性同理：模块靠它确认「那张 <link> 还在、href 还是这条」才敢跳过 fetch。
  assert.ok(snippet.includes('setAttribute("data-hana-theme-inline", "")'), "片段没给那张 <link> 打标记");
  assert.match(
    HOST_THEME_SRC,
    /THEME_INLINE_LINK_ATTR\s*=\s*"data-hana-theme-inline"/,
    "host-theme.ts 的 THEME_INLINE_LINK_ATTR 与片段打的标记对不上",
  );
  assert.ok(
    HOST_THEME_SRC.includes("inlineThemeCssUrl()") && HOST_THEME_SRC.includes("inlineThemeLinkMatches("),
    "host-theme.ts 没按这份契约去重（应读属性 + 核对那张 <link> 仍在）",
  );
});

// ---- 去重行为（真跑一遍模块，DOM / fetch 用最小桩）----
/** 最小 DOM：只实现 host-theme.ts 用到的那几处（属性、head 的 append/remove、两个 querySelector）。 */
function stubDom() {
  const attrs = new Map();
  const nodes = [];
  const makeEl = (tagName) => {
    const own = new Map();
    return {
      tagName,
      textContent: "",
      setAttribute: (k, v) => own.set(k, String(v)),
      getAttribute: (k) => (own.has(k) ? own.get(k) : null),
      set href(v) { own.set("href", String(v)); },
      get href() { return own.get("href") || ""; },
      set rel(v) { own.set("rel", String(v)); },
      parentNode: null,
    };
  };
  const documentElement = {
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    style: {},
  };
  const head = {
    appendChild: (el) => { el.parentNode = head; nodes.push(el); return el; },
    removeChild: (el) => { nodes.splice(nodes.indexOf(el), 1); el.parentNode = null; return el; },
  };
  const document = {
    documentElement,
    head,
    // 片段用 `link.href = …` 赋值，浏览器会把属性写成解析后的绝对 URL——桩里也要有个 base 可比。
    baseURI: "https://hana.local/api/apps/dshana/ui/main.html",
    createElement: makeEl,
    querySelector: (sel) => {
      const m = /^(link|style)\[([\w-]+)\]$/.exec(sel);
      if (!m) return null;
      return nodes.find((n) => n.tagName === m[1] && n.getAttribute(m[2]) !== null) || null;
    },
  };
  return { document, attrs, nodes };
}

test("去重：内联片段已贴同一条 URL 时不再 fetch（省掉一次真实重复请求）", async () => {
  const dom = stubDom();
  const inlineUrl = "https://hana.local/api/apps/theme.css?theme=warm-paper";
  const otherUrl = "https://hana.local/api/apps/theme.css?theme=dusk";
  // 复刻内联片段的落点：<html> 上的属性 + 那张 <link>。
  dom.document.documentElement.setAttribute(THEME_CSS_ATTR, inlineUrl);
  const link = dom.document.createElement("link");
  link.setAttribute(THEME_INLINE_LINK_ATTR, "");
  link.href = inlineUrl;
  dom.document.head.appendChild(link);

  const savedDocument = globalThis.document;
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  let applied = 0;
  globalThis.document = dom.document;
  globalThis.fetch = () => { fetches += 1; return Promise.resolve({ ok: true, text: () => Promise.resolve(":root{}") }); };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    // ① 首屏快照就是内联那张 URL：跳过 fetch，但「已落地」的钩子照跑。
    applyHostThemeStylesheet(inlineUrl, () => { applied += 1; });
    assert.equal(fetches, 0, "同一个 URL 不该再取一次（主题 CSS 可达 47KB）");
    assert.equal(applied, 1, "跳过 fetch 也要算「样式表已落地」，调用方的钩子照常跑");

    // ② 换成别的主题：真取，并落一份模块自己的 <style>。
    applyHostThemeStylesheet(otherUrl, undefined);
    assert.equal(fetches, 1, "换主题必须重新取");
    await settle();
    assert.ok(
      dom.nodes.some((n) => n.tagName === "style"),
      "换主题后模块应贴出自己那份 <style>",
    );

    // ③ 主题切回内联那张 URL：再跳过 fetch，并且必须摘掉自己那份 <style>——它排在 <link> 之后，
    //    留着就会用上一个主题的正文盖住已经正确的那张 <link>。
    applyHostThemeStylesheet(inlineUrl, undefined);
    assert.equal(fetches, 1, "回到内联那张 URL 时不该再取");
    assert.ok(
      !dom.nodes.some((n) => n.tagName === "style"),
      "回到内联那张 URL 时必须摘掉模块自己的 <style>",
    );

    // ④ 内联那张 <link> 不在了（被摘掉 / href 被改）：不能跳过——否则这一页会一直停在那张旧主题上。
    dom.nodes.length = 0;
    applyHostThemeStylesheet(inlineUrl, undefined);
    assert.equal(fetches, 2, "内联 <link> 不在时不能跳过 fetch");
    await settle(); // 让在途的 then 链在桩还装着的时候跑完
  } finally {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedFetch === undefined) delete globalThis.fetch; else globalThis.fetch = savedFetch;
  }
});
