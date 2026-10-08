// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/host-theme.ts — 让 App 页面跟上宿主主题的那一步「贴样式表」。
//
// 两个阶段，分工不同，别混：
//   · 真正的首帧（第一次绘制之前）：由每个页面 <head> 里的内联片段做——五个页面逐字相同的
//     dshana:first-frame-theme 块（main / default / sidebar / settings / stream.html，回归闸
//     tests/ui/first-frame-theme.test.mjs）。它同步读 URL 参数、把 data-theme / data-appearance
//     写到 <html>、append 一张 <link>；<link> 阻塞首次绘制，所以第一帧就是宿主配色。
//     本模块不参与那一步，也不该参与：模块要等一次 fetch，赶不上第一次绘制。
//   · 快照与订阅（本模块）：首屏读一次快照兜住「内联片段因故没跑」的页面，此后每次主题变化
//     经 hana.theme.changed 到达，本模块把新主题写进 <html> 并贴样式表。
//
// 为什么首帧必须由页面自己做：宿主只把主题参数附在 App surface iframe 的 URL 上
// （hana-theme / hana-css / hana-theme-appearance），变化时再推 hana.theme.changed；
// 把样式表贴进页面这件事宿主不代劳。而 @hana/plugin-sdk 只在收到 hana.theme.changed
// 时才应用 cssUrl——初始化时只把 URL 参数读进内存快照，不贴样式表。所以页面若不自己
// 「首帧贴一次」，就会一路吃 HTML 里写死的纸张 fallback，直到第一次主题变化才跟上
// （不自贴的页面就是这个症状：首帧暖纸，切一次主题才跟随）。
//
// 去重（与内联片段的两半契约）：内联片段把「已经贴过的样式表 URL」记在 <html> 的
// THEME_CSS_ATTR 上；本模块遇到同一个 URL 就跳过那次 fetch——内联那张 <link> 早已在文档里
// （它挡过首次绘制），再取一遍只是白花一次请求（主题 CSS 可达 47KB）。
// 片段**没贴**时（主题完全未知，见 themeCssUrlFor 第 ③ 档）那条属性根本不写，本模块读回空串、
// 与任何非空 URL 都比不上，于是不会误判「已贴过」——该取就取。反过来，本模块自己也不会在主题
// 未知时贴表（不贴一张默认主题的），两边的「未知」口径一致。
//
// 壳页与设置页两处同此纪律，共用这一份实现，免得各写一套再各自漂移。
// 分工：本模块只管通用部分（贴样式表、写 data-theme / data-appearance、首屏读快照与订阅）；
// 面相关的动作（壳页垫 DSH 首帧底色 token、推主题给内层桥）由调用方经钩子挂上。
//
// 主题回到内联片段那张 URL 时（用户把主题切回来）：本模块跳过 fetch，并摘掉自己先前那份
// <style>——它排在 <link> 之后，留着就会用上一个主题的正文盖住已经正确的那张 <link>。

export const THEME_STYLE_ATTR = "data-hana-theme-style";

/** 内联片段贴过的样式表 URL 记在 <html> 上的属性名（契约的另一半在页面 <head> 里）。 */
export const THEME_CSS_ATTR = "data-hana-theme-css";

/** 内联片段贴的那张 <link> 的标记属性：本模块据它核对「那张 <link> 还在、href 还是这条」。 */
export const THEME_INLINE_LINK_ATTR = "data-hana-theme-inline";

/** 读内联片段记下的样式表 URL；没有（片段没跑 / 没贴）时返回空串。 */
export function inlineThemeCssUrl(): string {
  try {
    return String(document.documentElement.getAttribute(THEME_CSS_ATTR) || "").trim();
  } catch {
    return "";
  }
}

/**
 * 主题载荷 → 该贴的样式表 URL（三档，与页面 <head> 内联片段里那段同一条规则，两侧各半）：
 *   ① 有 cssUrl —— 直接用（宿主给了 hana-css，主卡 / 设置页走这条）；
 *   ② 没 cssUrl 但有 theme —— 按主题拼宿主路由 `/api/apps/theme.css?theme=<id>`。FP
 *      （slot=function-panel）的 surface URL 只带 hana-theme / hana-theme-appearance、**不带
 *      hana-css**，所以这条是 FP 的主路径，不是罕见回退。
 *   ③ 两者都没有 —— 返回空串，调用方**不贴**。裸 `/api/apps/theme.css`（不带 theme）返回的是
 *      **默认主题**（暖纸），不是用户当前主题；贴一张概率上是错的主题表，比不贴更糟——宁可留白，
 *      让页面回落到自己 CSS 里的兜底色（官方口径：a failed swap keeps the current theme rather
 *      than falling back to a built-in palette）。猜出来的颜色比不画更糟。
 * encodeURIComponent 与内联片段用的是同一个，两边拼出的串逐字相同（去重靠这一点）。
 */
export function themeCssUrlFor(theme?: string | null, cssUrl?: string | null): string {
  const direct = typeof cssUrl === "string" ? cssUrl.trim() : "";
  if (direct) return direct;
  const id = typeof theme === "string" ? theme.trim() : "";
  if (!id) return "";
  return "/api/apps/theme.css?theme=" + encodeURIComponent(id);
}

/** 宿主主题载荷（hana.theme.getSnapshot() 与 hana.theme.changed 的同一形状）。 */
export interface HostThemeSnapshot {
  theme?: string;
  appearance?: string;
  cssUrl?: string;
}

/** 本模块用到的 SDK 面（结构类型：不绑定 SDK 类型，单测可直接传假实现）。 */
export interface HostThemeSdk {
  theme?: {
    getSnapshot?: () => HostThemeSnapshot | null;
    subscribe?: (listener: (snap: HostThemeSnapshot) => void) => unknown;
  };
}

export interface FollowHostThemeOptions {
  /** 每次载荷应用后调用（同步，含首屏那一次）。 */
  onApplied?: (snap: HostThemeSnapshot) => void;
  /** 样式表落地后调用（此刻 CSS 已进文档，读计算样式才有值）。 */
  onStylesApplied?: () => void;
  /** 写 data-appearance 时顺带同步 <html> 的 color-scheme。
   * 设置页要（原生控件与滚动条跟宿主明暗，不跟系统）；壳页不要——DSH 侧 presenter 对它有主张。 */
  syncColorScheme?: boolean;
}

/** 最近一次请求的样式表 URL：期间主题又变时，只让最后一次落地。 */
let pendingCssUrl: string | null = null;

/** 两条主题 URL 是不是同一条。先比原文，再比解析后的形态——片段用 `link.href = …` 赋值，
 *  浏览器会把属性写成解析后的绝对 URL，而快照里那串可能还是 `/api/apps/theme.css` 这种根相对写法。 */
function sameThemeUrl(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return new URL(a, document.baseURI).href === new URL(b, document.baseURI).href;
  } catch {
    return false; // 畸形 URL：当不同，退回「再取一次」（与去重前一样，不会更差）
  }
}

/** 内联片段贴过的那张 <link> 还在文档里、且 href 就是它记下的那条 URL 吗。
 *  不在了（被谁摘掉 / href 被改）就不能跳过 fetch——否则这一页会一直停在内联那张旧主题上。 */
function inlineThemeLinkMatches(url: string): boolean {
  try {
    const el = document.querySelector<HTMLLinkElement>("link[" + THEME_INLINE_LINK_ATTR + "]");
    return !!el && sameThemeUrl(el.getAttribute("href") || "", url);
  } catch {
    return false;
  }
}

/** 摘掉本模块自己那份 <style>（只摘带标记的那一个，内联片段的 <link> 不动）。
 *  主题回到内联片段那张 URL 时必须摘：本模块的 <style> 排在 <link> 之后，留着就会用上一个
 *  主题的正文把已经正确的那张 <link> 盖住。 */
function dropModuleThemeStyle(): void {
  try {
    const el = document.querySelector<HTMLStyleElement>("style[" + THEME_STYLE_ATTR + "]");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  } catch { /* 忽略 */ }
}

/** 把宿主主题样式表贴进本文档。每次调用都会取一次；落地以最后一次请求的 URL 为准。
 *
 *  去重：内联片段（<head> 里的 dshana:first-frame-theme）已经贴过同一条 URL 时跳过 fetch——
 *  那张 <link> 早就在文档里（它挡过首次绘制），再取一遍只是白花一次请求（主题 CSS 可达 47KB，
 *  字体那份更大）。此刻直接算「样式表已落地」：本模块只可能跑在内联片段之后（页面里的
 *  `<script type="module">` 是 deferred，且被它前面那张 <link> 阻塞），宿主主题变量已可读。
 *  两边的 URL 都是 URL 参数里那串原文（SDK 只把它读进快照、不改写），所以比得上；万一哪天
 *  某一侧做了归一化而对不上，也只是退回「再取一次」——与去重前一样，不会更差。 */
export function applyHostThemeStylesheet(cssUrl: string | null | undefined, onStylesApplied?: () => void): void {
  const url = typeof cssUrl === "string" ? cssUrl : "";
  if (!url) return;
  pendingCssUrl = url; // 无论走哪条路，这一次请求都让先前在途的那次作废（最后一次为准）
  if (sameThemeUrl(inlineThemeCssUrl(), url) && inlineThemeLinkMatches(url)) {
    dropModuleThemeStyle();
    if (onStylesApplied) {
      try { onStylesApplied(); } catch { /* 调用方自己的事，别拖垮主题 */ }
    }
    return;
  }
  fetch(url, { credentials: "same-origin", cache: "no-store" })
    .then((res) => (res.ok ? res.text() : ""))
    .then((css) => {
      if (pendingCssUrl !== url || !css) return; // 期间主题又变了，等新的那次落地
      let el = document.querySelector<HTMLStyleElement>("style[" + THEME_STYLE_ATTR + "]");
      if (!el) {
        el = document.createElement("style");
        el.setAttribute(THEME_STYLE_ATTR, "");
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) el.textContent = css;
      if (onStylesApplied) {
        try { onStylesApplied(); } catch { /* 调用方自己的事，别拖垮主题 */ }
      }
    })
    .catch(() => {
      /* 拿不到主题不致命：页面仍用 HTML 里写好的纸张 fallback 色。 */
    });
}

/**
 * 应用一次主题载荷：把主题身份写进 <html>（data-theme / data-appearance），再贴样式表。
 * 贴哪张由 themeCssUrlFor 定（cssUrl 优先，缺则按 theme 拼；两者都缺则**不贴**——见那里）。
 * 返回值与载荷同形，便于调用方接着做面相关的事。
 */
export function applyHostTheme(
  snap: HostThemeSnapshot | null | undefined,
  options: FollowHostThemeOptions = {},
): HostThemeSnapshot | null {
  if (!snap || typeof snap !== "object") return null;
  const root = document.documentElement;
  if (typeof snap.theme === "string" && snap.theme) root.setAttribute("data-theme", snap.theme);
  if (snap.appearance === "light" || snap.appearance === "dark") {
    root.setAttribute("data-appearance", snap.appearance);
    if (options.syncColorScheme) root.style.colorScheme = snap.appearance;
  } else {
    root.removeAttribute("data-appearance");
    // 明暗缺失/非法时也得把上一轮写的 color-scheme 收回去，否则原生控件停在旧明暗上。
    if (options.syncColorScheme) root.style.colorScheme = "";
  }
  // 主题未知时 themeCssUrlFor 给空串，applyHostThemeStylesheet 会直接返回：不贴错表。
  applyHostThemeStylesheet(themeCssUrlFor(snap.theme, snap.cssUrl), options.onStylesApplied);
  if (options.onApplied) {
    try { options.onApplied(snap); } catch { /* 忽略 */ }
  }
  return snap;
}

/**
 * 首屏快照 + 订阅（页面挂载时调用一次）：
 *   1) 读 sdk.theme.getSnapshot()（SDK 已把 URL 参数读进快照）；
 *   2) 拿不到再退 URL 参数（宿主白名单参数名）；
 *   3) 订阅 sdk.theme.changed，此后事件驱动，无轮询。
 * 首帧那张样式表不在这里——那是页面 <head> 内联片段的活（见文件头）。这一步兜的是「片段因故
 * 没跑」的页面，以及此后每一次主题变化。
 */
export function followHostTheme(sdk: HostThemeSdk, options: FollowHostThemeOptions = {}): void {
  let snap: HostThemeSnapshot | null = null;
  try {
    const read = sdk && sdk.theme && typeof sdk.theme.getSnapshot === "function" ? sdk.theme.getSnapshot() : null;
    snap = read && typeof read === "object" ? read : null;
  } catch {
    snap = null;
  }
  if (!snap) {
    try {
      const params = new URLSearchParams(location.search);
      if (params.get("hana-css") || params.get("hana-theme")) {
        snap = {
          theme: params.get("hana-theme") ?? undefined,
          cssUrl: params.get("hana-css") ?? undefined,
          appearance: params.get("hana-theme-appearance") ?? undefined,
        };
      }
    } catch { /* 忽略 */ }
  }
  if (snap) applyHostTheme(snap, options);
  try {
    if (sdk && sdk.theme && typeof sdk.theme.subscribe === "function") {
      sdk.theme.subscribe((next) => applyHostTheme(next, options));
    }
  } catch { /* SDK 主题订阅不可用则只靠首屏那一次 */ }
}
