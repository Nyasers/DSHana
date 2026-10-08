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
// 所以这里断言六件事：
//   ① 五个页面都带这个片段；
//   ② 片段**逐字相同**（一处改、五处一起改，否则各面首帧行为开始漂移）；
//   ③ 片段在 <head> 内、所有静态 <link rel="stylesheet"> 之后、模块脚本之前
//      （宿主变量必须排在组件自带样式之后才覆盖得住，且必须在模块脚本之前才叫首帧）；
//   ④ 样式表 URL 的三档规则：有 hana-css 用它；只有 hana-theme 时拼 `?theme=`（FP 的主路径——
//      它的 surface URL 不带 hana-css）；两者都无则**不贴**（裸 /api/apps/theme.css 是默认主题
//      暖纸，贴它 = 贴错色）；
//   ⑤ 去重契约的两半对得上：片段把贴过的 URL 记在 <html>，host-theme.ts 按同一个属性名跳过
//      那次重复 fetch；
//   ⑥ 片段的判定与 host-theme.ts 的 themeCssUrlFor 逐条同源（真跑一遍片段取它的 URL，跟模块
//      拼出来的比），免得两侧各改各的。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  applyHostThemeStylesheet,
  themeCssUrlFor,
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

test("片段读三个宿主参数并写主题身份；URL 规则不再裸回退", () => {
  const snippet = snippetOf(page("main.html"));
  assert.ok(snippet.includes("hana-css"), "片段没读 hana-css");
  assert.ok(snippet.includes("hana-theme"), "片段没读 hana-theme");
  assert.ok(snippet.includes("hana-theme-appearance"), "片段没读 hana-theme-appearance");
  assert.ok(snippet.includes('setAttribute("data-theme"'), "片段没写 data-theme");
  assert.ok(snippet.includes('setAttribute("data-appearance"'), "片段没写 data-appearance");
  // 明暗只认 light|dark（别的值不写，免得把非法值当主题身份）。
  assert.match(snippet, /appearance === "light" \|\| appearance === "dark"/, "data-appearance 应收窄到 light|dark");
  // 同步贴 <link>：这是「首帧」的全部依据。
  assert.match(snippet, /createElement\("link"\)/, "片段没贴 <link>");
  assert.match(snippet, /rel = "stylesheet"/, "那张 <link> 不是样式表");
  // 畸形 URL 不阻断页面。
  assert.ok(snippet.includes("URLSearchParams"), "片段没读 URL 参数");
  // 旧的裸回退必须消失：不带 theme 的 /api/apps/theme.css 返回默认主题（暖纸），不是用户当前主题。
  assert.ok(
    !/get\("hana-css"\)\s*\|\|\s*"\/api\/apps\/theme\.css"/.test(snippet),
    "片段还在裸回退 /api/apps/theme.css（那是默认主题暖纸，FP 首帧会错色）",
  );
  // 只有 hana-theme 时按主题拼 URL：必须带 ?theme= 且经 encodeURIComponent。
  assert.match(
    snippet,
    /if \(!css && theme\) css = "\/api\/apps\/theme\.css\?theme=" \+ encodeURIComponent\(theme\);/,
    "片段没有「只有 hana-theme 时按主题拼 URL」这一档",
  );
  // 两者都无时不贴：css 为空就跳过（不贴一张概率上是错的主题表）。
  assert.match(snippet, /if \(css\) \{/, "片段应在 css 为空时不贴 <link>");
});

// ---- 三档 URL 规则：真跑片段（vm + 最小 DOM），看它到底贴了什么 ----
/**
 * 跑一遍页面的首帧片段，返回它落下的结果。
 * @param search 页面 URL 的查询串（含 ?，如 "?hana-theme=midnight&hana-theme-appearance=dark"）
 */
function runSnippet(search) {
  const html = page("sidebar.html");
  const start = html.indexOf(MARKER);
  const code = /<script>([\s\S]*?)<\/script>/.exec(html.slice(start))[1];
  const attrs = new Map();
  const links = [];
  const documentElement = {
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
  };
  const document = {
    documentElement,
    head: {
      appendChild: (el) => {
        el.parentNode = document.head;
        links.push(el);
        return el;
      },
    },
    createElement: (tagName) => {
      const own = new Map();
      return {
        tagName,
        setAttribute: (k, v) => own.set(k, String(v)),
        getAttribute: (k) => (own.has(k) ? own.get(k) : null),
        set href(v) { own.set("href", String(v)); },
        get href() { return own.get("href") || ""; },
        set rel(v) { own.set("rel", String(v)); },
      };
    },
  };
  // vm 的新上下文只有 ECMAScript 内建：URLSearchParams 是宿主对象，不注入的话片段里那句
  // `new URLSearchParams(...)` 抛 ReferenceError 被自己的 catch 吞掉，于是所有参数都读成空串
  // （测试会以「什么都没贴」的样子假过/假败）。所以这里显式给它宿主那一份。
  const sandbox = { document, location: { search }, URLSearchParams };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox);
  return {
    theme: attrs.get("data-theme") ?? null,
    appearance: attrs.get("data-appearance") ?? null,
    recorded: attrs.get("data-hana-theme-css") ?? null,
    links: links.map((el) => el.getAttribute("href")),
  };
}

test("片段①：带 hana-css 时直接用宿主给的那张（不拼 theme）", () => {
  const given = "http://127.0.0.1:35058/api/apps/theme.css?theme=midnight&v=7";
  const out = runSnippet("?hana-theme=midnight&hana-theme-appearance=dark&hana-css=" + encodeURIComponent(given));
  assert.deepEqual(out.links, [given], "有 hana-css 时应原样用它");
  assert.equal(out.recorded, given, "贴过的 URL 要记在 <html> 上（模块侧去重靠它）");
  assert.equal(out.theme, "midnight");
  assert.equal(out.appearance, "dark");
});

test("片段②：只有 hana-theme 时拼 ?theme=（FP 的主路径，不带 hana-css）", () => {
  // 真机 FP 的 surface URL 就是这个形状：只有 hana-theme / hana-theme-appearance。
  const out = runSnippet("?appSurfaceSession=abc&hana-theme=midnight&hana-theme-appearance=dark");
  assert.deepEqual(out.links, ["/api/apps/theme.css?theme=midnight"], "应按主题拼出带 theme 的宿主路由");
  assert.equal(out.recorded, "/api/apps/theme.css?theme=midnight");
  assert.equal(out.theme, "midnight", "data-theme 照写");
  assert.equal(out.appearance, "dark", "data-appearance 照写");
});

test("片段②b：主题 id 里的特殊字符要 encode（拼出的 URL 不能带裸分隔符）", () => {
  const out = runSnippet("?hana-theme=a%2Fb%20c");
  assert.deepEqual(out.links, ["/api/apps/theme.css?theme=a%2Fb%20c"], "theme 应经 encodeURIComponent");
});

test("片段③：两者都没有时不贴表（宁可留白，不贴默认主题的错色）", () => {
  const out = runSnippet("?appSurfaceSession=abc");
  assert.deepEqual(out.links, [], "主题完全未知时不该贴任何 <link>（裸路由是暖纸）");
  assert.equal(out.recorded, null, "没贴就不该写 data-hana-theme-css（否则模块侧会误判已贴过）");
});

test("片段③b：只有明暗、没有主题 id 时同样不贴", () => {
  const out = runSnippet("?hana-theme-appearance=dark");
  assert.deepEqual(out.links, [], "没有主题 id 就拼不出确定的 URL，不贴");
  assert.equal(out.recorded, null);
  assert.equal(out.appearance, "dark", "明暗拿到了照写（不贴表不影响身份属性）");
});

test("片段与模块同源：三档拼出的 URL 与 themeCssUrlFor 逐条一致", () => {
  // ① 有 cssUrl
  const given = "http://h/api/apps/theme.css?theme=grass-aroma";
  assert.equal(themeCssUrlFor("grass-aroma", given), given);
  assert.deepEqual(runSnippet("?hana-theme=grass-aroma&hana-css=" + encodeURIComponent(given)).links, [given]);
  // ② 只有 theme
  const byTheme = themeCssUrlFor("midnight", undefined);
  assert.equal(byTheme, "/api/apps/theme.css?theme=midnight");
  assert.deepEqual(runSnippet("?hana-theme=midnight").links, [byTheme]);
  // ② 带特殊字符
  assert.equal(themeCssUrlFor("a/b c", ""), "/api/apps/theme.css?theme=a%2Fb%20c");
  // ③ 都缺
  assert.equal(themeCssUrlFor(undefined, undefined), "");
  assert.equal(themeCssUrlFor(null, null), "");
  assert.deepEqual(runSnippet("?x=1").links, []);
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

// ---- FP 真机形状的端到端：片段先跑，模块侧的订阅首屏随后到 ----
test("FP 形状（只有 hana-theme）：片段贴对主题，模块侧首屏不重复取、也不再贴错色", () => {
  // 真机 FP 的 surface URL：只有 hana-theme / hana-theme-appearance，没有 hana-css。
  const snippet = runSnippet("?appSurfaceSession=tok&hana-theme=midnight&hana-theme-appearance=dark");
  assert.deepEqual(snippet.links, ["/api/apps/theme.css?theme=midnight"], "片段应贴青夜那张，而不是默认暖纸");
  assert.equal(snippet.recorded, "/api/apps/theme.css?theme=midnight");

  // 把片段的落点搬进模块侧的桩：<html> 记的是**根相对** URL（真机实测就是这条），
  // <link> 的 href 被浏览器解析成了绝对 URL——两串不同形，去重必须仍然认得出是同一条。
  const dom = stubDom();
  dom.document.documentElement.setAttribute(THEME_CSS_ATTR, snippet.recorded);
  const link = dom.document.createElement("link");
  link.setAttribute(THEME_INLINE_LINK_ATTR, "");
  // 浏览器按文档 base 解析 href 属性；桩的 baseURI 就是同一份，所以这里照样推一次。
  link.href = new URL(snippet.recorded, dom.document.baseURI).href;
  dom.document.head.appendChild(link);

  const savedDocument = globalThis.document;
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.document = dom.document;
  globalThis.fetch = () => { fetches += 1; return Promise.resolve({ ok: true, text: () => Promise.resolve(":root{}") }); };
  try {
    // 模块侧首屏拿到的快照就是这个形状（FP 没有 cssUrl，只有 theme）——它必须拼出与片段同一条 URL，
    // 于是命中去重、不重复取，也绝不会去取那张裸路由（默认暖纸）。
    const url = themeCssUrlFor("midnight", undefined);
    assert.equal(url, snippet.recorded, "模块侧拼出的 URL 应与片段记下的逐字相同");
    applyHostThemeStylesheet(url, undefined);
    assert.equal(fetches, 0, "同一张主题表不该被取第二次（根相对 vs 绝对也要认得出是同一条）");
  } finally {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedFetch === undefined) delete globalThis.fetch; else globalThis.fetch = savedFetch;
  }
});

test("主题未知时模块侧也不贴：themeCssUrlFor 给空串，applyHostThemeStylesheet 直接返回", () => {
  const dom = stubDom();
  const savedDocument = globalThis.document;
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.document = dom.document;
  globalThis.fetch = () => { fetches += 1; return Promise.resolve({ ok: true, text: () => Promise.resolve(":root{}") }); };
  try {
    const url = themeCssUrlFor(undefined, undefined);
    assert.equal(url, "", "主题与 cssUrl 都缺时应给空串（不发明 URL）");
    applyHostThemeStylesheet(url, undefined);
    assert.equal(fetches, 0, "空 URL 不该触发 fetch");
    assert.deepEqual(dom.nodes, [], "主题未知时不该贴任何东西（不贴默认主题的错色）");
  } finally {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedFetch === undefined) delete globalThis.fetch; else globalThis.fetch = savedFetch;
  }
});
