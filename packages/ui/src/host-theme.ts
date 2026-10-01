// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/host-theme.ts — 让 App 页面跟上宿主主题的那一步「贴样式表」。
//
// 为什么必须由页面自己做：宿主只把主题参数附在 App surface iframe 的 URL 上
// （hana-theme / hana-css / hana-theme-appearance），变化时再推 hana.theme.changed；
// 把样式表贴进页面这件事宿主不代劳。而 @hana/plugin-sdk 只在收到 hana.theme.changed
// 时才应用 cssUrl——初始化时只把 URL 参数读进内存快照，不贴样式表。所以页面若不自己
// 「首帧贴一次」，就会一路吃 HTML 里写死的纸张 fallback，直到第一次主题变化才跟上
// （不自贴的页面就是这个症状：首帧暖纸，切一次主题才跟随）。
//
// 壳页与设置页两处同此纪律，共用这一份实现，免得各写一套再各自漂移。
// 分工：本模块只管通用部分（贴样式表、写 data-theme / data-appearance、首屏读快照与订阅）；
// 面相关的动作（壳页垫 DSH 首帧底色 token、推主题给内层桥）由调用方经钩子挂上。

export const THEME_STYLE_ATTR = "data-hana-theme-style";

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

/** 把宿主主题样式表贴进本文档。每次调用都会取一次；落地以最后一次请求的 URL 为准。 */
export function applyHostThemeStylesheet(cssUrl: string | null | undefined, onStylesApplied?: () => void): void {
  const url = typeof cssUrl === "string" ? cssUrl : "";
  if (!url) return;
  pendingCssUrl = url;
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
  applyHostThemeStylesheet(snap.cssUrl, options.onStylesApplied);
  if (options.onApplied) {
    try { options.onApplied(snap); } catch { /* 忽略 */ }
  }
  return snap;
}

/**
 * 首屏跟随 + 订阅（页面挂载时调用一次）：
 *   1) 读 sdk.theme.getSnapshot()（SDK 已把 URL 参数读进快照）；
 *   2) 拿不到再退 URL 参数（宿主白名单参数名）；
 *   3) 订阅 sdk.theme.changed，此后事件驱动，无轮询。
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
