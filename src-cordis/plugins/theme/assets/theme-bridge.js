// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/theme 的注入桥脚本（独立文件，review 修订：内容文件化）。
// 本文件 = 原内嵌于 index.js 的 BRIDGE 字符串正文（逐字节搬移，仅一处插值改造）：
// 经 tapIndex 注入每个 index 响应的 <head>，运行时由 index.js 读取并包
// <script id="@dshana/theme-bridge"> 后注入。
//
// 插值约定：正文唯一动态点是数据表注入行
//     var m = __DSH_THEME_TOKENS__;
// 服务端读取本文件后，把占位符 __DSH_THEME_TOKENS__ 替换为 compileRules(TOKEN_MAP) 的
// 序列化结果——每个条目是 [token, cssValue, hostVars] 三元组（见
// src-cordis/plugins/theme/adapter.ts）。取值规则在服务端编译成 CSS 值串（var(…) /
// color-mix(…) / 字面量），桥只按 hostVars 判空后原样写进覆盖，不重复一份编译逻辑。
// 其余正文无插值，保持纯浏览器 JS（var/ES5 风格，无 import）。
// cordis 子插件散装分发（不经 rspack，文件随包复制进
// dist/cordis/theme/），pack.mjs 静态压缩按 script 语义
// terser（module=false）。语义与配套见 index.js 头注释（主题注入/明暗/preference）。
(function () {
  // 适配层规则（全文件唯一插值点：服务端把本行占位符换成 compileRules(TOKEN_MAP) 的序列化
  // 结果）。每项 = [token, cssValue, hostVars]。
  // 注意：服务端用的是 String.replace(pattern, …)，**只换第一处**，所以这行必须全局唯一。
  var m = __DSH_THEME_TOKENS__;
  // 父窗口（宿主壳页）origin（postMessage 定向 + 回执校验；无 ancestorOrigins 时为 null）
  var parentOrigin = null;
  try {
    if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
      parentOrigin = window.location.ancestorOrigins[0];
    }
  } catch (e) { /* 忽略 */ }
  var cur = null;
  // vY（T7b 后 dsh 0.1.2）：preference 默认 system——跟随宿主配色（壳桥 vars 即应用）；
  // 读 dsh settings/describe 失败/缺失时按 system 处理，主题不因此失效。
  var pref = "system";
  // 偏好是否已知；未得知前不动手（否则会先按 system 压一遍 Hana 配色、再被纠正，中间可见闪烁）。
  var prefKnown = false;
  // 自举偏好（bootPref）：壳页随主题载荷下发的值，来源 = DSH index 的 boot-theme 行字面量
  // （ui-theme/src/boot-theme.ts）。官方把这行定位成 "the browser's pre-plugin interval"——
  // 插件树激活前浏览器手里只有它。为什么需要它：权威来源是我们 client 半投影的属性，而
  // client 半是**插件**，插件就位前属性不存在、门关着，于是注入完成到插件就位之间 DSH 一直
  // 穿自己的内置配色（注入完成到插件就位之间的空窗）：借这行字面量把门提前打开。
  // 权威归属不变：属性一旦出现，readPreference() 优先取属性，本值退场。
  var bootPref = null;
  /** 读偏好：① client 半投影的属性（权威）→ ② 壳页载荷里的 boot-theme 字面量（自举）。 */
  function readPreference() {
    try {
      var v = document.documentElement.getAttribute("data-dsh-theme-preference");
      if (v === "light" || v === "dark" || v === "system") return v;
    } catch (e) { /* 忽略 */ }
    return bootPref;
  }
  // 这一面声明的底座 token（壳页写在 <html> 的 data-dshana-backdrop 上，值 = 该面可见底那格
  // DSW token 名）。壳页那侧的同源实现在 src/lib/seed-tokens.ts。
  function backdropKey() {
    try {
      var k = document.documentElement.getAttribute("data-dshana-backdrop");
      if (k && k.charAt(0) === "-") return k;
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function cssOf(v) {
    // 底座那一格按面取：DSH 的 .frame 与它的启动屏都画 var(--dsw-alias-bg-base, …)，而规则表是
    // 一张、没有面的概念——一律把 base 压成 --bg，侧栏面（可见底是 --dsw-specific-sidebar-fill）
    // 的启动屏就会先亮一次中列色。这里取那一格规则**依赖的第一个宿主变量**（垫片用的是同一处
    // 事实：src/lib/seed-tokens.ts）。
    var baseKey = "--dsw-alias-bg-base";
    var back = backdropKey();
    var baseCss = "";
    if (back && back !== baseKey) {
      for (var j = 0; j < m.length; j++) {
        if (m[j][0] !== back) continue;
        var deps = m[j][2];
        for (var k = 0; k < deps.length; k++) {
          if (v[deps[k]]) { baseCss = "var(" + deps[k] + ")"; break; }
        }
        break;
      }
    }
    var c = "";
    for (var i = 0; i < m.length; i++) {
      var css = m[i][1], need = m[i][2], ok = true;
      for (var n = 0; n < need.length; n++) { if (!v[need[n]]) { ok = false; break; } }
      if (!ok) continue; // 空值不出手：空自定义属性会让 var() “无效于计算值”（bg 系变 transparent）
      if (baseCss && m[i][0] === baseKey) css = baseCss;
      c += m[i][0] + ":" + css + "!important;";
    }
    return c;
  }
  function applyOrRemove() {
    var st = document.getElementById("@dshana/theme-dyn");
    if (followHost() && cur) {
      if (!st) { st = document.createElement("style"); st.id = "@dshana/theme-dyn"; document.head.appendChild(st); }
      st.textContent = "body{" + cssOf(cur) + "}";
    } else if (st) {
      st.remove();
    }
  }
  // 壳页写在 <html> 的宿主明暗（light | dark，见 src/ui/app-shell.ts）。
  function hostAppearance() {
    try {
      var a = document.documentElement.getAttribute("data-appearance");
      return a === "light" || a === "dark" ? a : null;
    } catch (e) { return null; }
  }
  // 壳页垫片在 body 内联样式上写过的 token（src/lib/seed-tokens.ts 的 VIEW_SEEDS）：它垫的是
  // 宿主底色，为的是注入前不闪白。一旦 dsh 自己选了 light/dark（我们不再跟随），必须一并抹掉，
  // 否则 dsh 自己的主题切不干净（body 内联钉着宿主色，桥的 <style> 撤了也没用）。
  // 名单与 seed-tokens 同源，由单测盯着（"桥退出时抹的名单 = 壳页垫过的 token"）。
  var seedKeys = ["--dsw-alias-bg-base", "--dsw-specific-sidebar-fill", "--dsh-boot-bg"];
  // 退出跟随时抹掉垫片。自定义属性按名单抹，另加 body 自身的 background-color
  // （壳页为了压住首帧样式里那句 `body{background-color:#151517}` 而垫的实色）。
  function clearSeed() {
    var bodyEl = null;
    try { bodyEl = document.body; } catch (e) { return; }
    if (!bodyEl || !bodyEl.style) return;
    for (var i = 0; i < seedKeys.length; i++) {
      try { bodyEl.style.removeProperty(seedKeys[i]); } catch (e) { /* 忽略 */ }
    }
    try { bodyEl.style.removeProperty("background-color"); } catch (e) { /* 忽略 */ }
  }
  // 明暗也跟随宿主。dsh 自己的明暗取自**浏览器系统**的 prefers-color-scheme（它 index 里的
  // boot 样式是 @media(prefers-color-scheme:dark)，ThemePresenter 取 preference === 'dark'
  // || systemDark）。系统暗色而宿主浅色时，body 上仍挂着 data-ds-dark-theme，于是那些不走
  // alias 层、按该标记自己翻明暗的组件（JsonTree 与 shiki 的语法色、启动页、GuideBody）就取了
  // 深色档——浅底上放浅色字。这里在跟随宿主时把两样对齐：
  //   · <html> 的 inline color-scheme → 原生 UA 控件（滚动条、表单）一起跟；
  //   · body 的 data-ds-dark-theme → 按宿主摘戴。
  // 只在**已知**偏好且为 system 时动手；dsh 自己选了 light/dark 时撤掉自己的 inline
  // color-scheme 与垫片，明暗交还它的 presenter。偏好未知时（presenter 的属性与壳页推送都还没
  // 到）一律不动手：此刻抹垫片等于把首帧交回 dsh 的 boot 样式，而它认的是**浏览器系统**——
  // 宿主浅 + 系统深就是那一帧黑屏。
  function syncHostScheme() {
    var root = null;
    try { root = document.documentElement; } catch (e) { return; }
    if (!root) return;
    if (!prefKnown) return;
    if (!followHost()) {
      try { if (root.style.colorScheme) root.style.removeProperty("color-scheme"); } catch (e) { /* 忽略 */ }
      clearSeed();
      return;
    }
    var a = hostAppearance();
    if (!a) {
      try { if (root.style.colorScheme) root.style.removeProperty("color-scheme"); } catch (e) { /* 忽略 */ }
      return;
    }
    // 写前比现值：html 的 style 属性也在观察名单里（presenter 会往同一个属性写 colorScheme），
    // 同值重写会自己触发自己，比一下就不写了。
    try { if (root.style.colorScheme !== a) root.style.setProperty("color-scheme", a); } catch (e) { /* 忽略 */ }
    var bodyEl = null;
    try { bodyEl = document.body; } catch (e) { bodyEl = null; }
    if (!bodyEl) return; // 桥脚本在 <head> 里执行，body 往往还没解析出来；DOMContentLoaded 后再来
    try {
      var want = a === "dark";
      if (bodyEl.hasAttribute("data-ds-dark-theme") !== want) {
        bodyEl.toggleAttribute("data-ds-dark-theme", want);
      }
    } catch (e) { /* 忽略 */ }
  }
  // 同文档注入形态（当前主路径）：桥与壳页在同一**文档**里，主题变量直接从文档根算就行，
  // 不经 parent/壳页往返。此处不能按旧拓扑校验消息来源（`e.source !== window.parent` 就丢）：
  // 壳页是自投（e.source === window），那样会把消息全丢掉，内层 dsh WebUI 拿不到主题。
  function readDocumentVars() {
    var cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) { return null; }
    var v = {};
    var hits = 0;
    for (var i = 0; i < m.length; i++) {
      var deps = m[i][2];
      for (var d = 0; d < deps.length; d++) {
        var key = deps[d];
        if (v[key]) continue;
        var val = "";
        try { val = (cs.getPropertyValue(key) || "").trim(); } catch (e2) { val = ""; }
        if (val) { v[key] = val; hits++; }
      }
    }
    return hits ? v : null;
  }
  function followHost() {
    // 仅在**已知且明确**偏好为 system 时跟随宿主；已知为 light/dark 时完全原生；
    // 尚未得知偏好时不动手（等壳页首次推送）。
    return prefKnown && pref === "system";
  }
  // 从文档根读取并应用；读到有效变量返 true。
  function pull() {
    // 先采纳偏好（presenter 写的 html 属性；属性一变就重新算门——事件驱动，无轮询）。
    var p = readPreference();
    if (p !== null) { pref = p; prefKnown = true; }
    var v = readDocumentVars();
    if (!v) return false;
    cur = v;
    applyOrRemove();
    syncHostScheme();
    return true;
  }
  // 已无静态 fallback 可撤：拿不到宿主主题时就保持 dsh 内置 token（官方明暗）——
  // 不从宿主搬固定值充数。
  // 
  function ask() {
    // 旧拓扑（iframe 套 iframe）里壳页是本页的 parent；同文档注入后本页的 parent 是**宿主**，
    // 投过去没人答。两个目标都投一份：自身（现壳页的 message 监听就在同文档里）与 parent（兼容）。
    try { window.postMessage({ dshHanaThemeRequest: true }, "*"); } catch (e) { }
    try { window.parent.postMessage({ dshHanaThemeRequest: true }, parentOrigin || "*"); } catch (e) { }
  }
  window.addEventListener("message", function (e) {
    // 来源校验：只认壳页。同文档注入下壳页的自投消息 e.source === window；旧 iframe 形式下
    // e.source === window.parent；两者都收，其余来源一律忽略。
    if (e.source !== window && e.source !== window.parent) return;
    if (e.source !== window && parentOrigin && e.origin !== parentOrigin) return;
    if (e.data && e.data.dshHanaTheme) {
      // 先采纳自举偏好（若载荷带了）：插件树之前只有它。属性存在时 readPreference() 优先属性。
      var bp = e.data.dshHanaTheme.preference;
      if (bp === "light" || bp === "dark" || bp === "system") bootPref = bp;
      // 值以文档根为权威（同文档下我们读得到）；读不到才回退用载荷里的 vars。
      // pull() 内部已 applyOrRemove()，所以换门后不必再跑一遍。
      if (!pull()) {
        var v = e.data.dshHanaTheme.vars;
        if (v && typeof v === "object" && Object.keys(v).length) {
          cur = v;
          applyOrRemove();
        }
      }
    }
  });
  // 偏好来源两段（都不打 RPC、都不轮询）：启动段 = 壳页载荷里的 boot-theme 字面量（本文件
  // bootPref）；稳态段 = 我们 client 半投影的 html 属性（权威）。旧实现的 settings/describe
  // 该 RPC 信封在 0.1.5 未验：读不到就永远停在 system 把 UI 钉住，所以不走它。
  // 不轮询：载荷由壳页在注入完成时推一次、此后每次主题变化再推一次（hana.theme.changed），
  // 加上首次 ask() 的应答与下面的 MutationObserver——三条都是事件，不轮询。
  // 主题切换（壳页写 documentElement 的 data-theme / data-appearance）即时感知，不等 1s 轮询。
  // 另两处也听，因为它们的写入者是 dsh 的 ThemePresenter（ui-layout/theme-presenter.ts），它的
  // apply() 晚于本桥（插件树激活在注入之后），而我们早先对齐的那两格会被它按**自己的解析**
  // （preference=system 时用浏览器系统的 prefers-color-scheme）重新写上：
  //   · html 的 inline color-scheme；
  //   · body[data-ds-dark-theme]——JsonTree 与 shiki 的语法色按这个标记翻明暗，浅底上就是浅字。
  // 写前都比过现值，所以我们自己的写入不会再触发一轮，不会自激。
  try {
    var mo = new MutationObserver(function () { pull(); });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-appearance", "data-dsh-theme-preference", "style"],
    });
    var watchBody = function () {
      try {
        var bodyEl = document.body;
        if (!bodyEl) return false;
        var bodyMo = new MutationObserver(function () { pull(); });
        bodyMo.observe(bodyEl, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
        return true;
      } catch (e) { /* 忽略 */ return true; }
    };
    if (!watchBody()) {
      document.addEventListener("DOMContentLoaded", function () { watchBody(); }, { once: true });
    }
  } catch (e) { /* 忽略 */ }
  pull();
  ask();
  // 系统偏好变化时 dsh 的 presenter 会按系统重写 data-ds-dark-theme（它认的是 systemDark），
  // 而它不会因为宿主切主题而重算——听一下这个媒体查询，跟着把明暗拉回宿主。
  try {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq && mq.addEventListener) mq.addEventListener("change", function () { pull(); });
  } catch (e) { /* 忽略 */ }
  // 桥脚本在 <head> 里跑，body 常常还没解析出来（data-ds-dark-theme 挂在 body 上）。
  // DOMContentLoaded 之后补一次：那时 body 已在，明暗也对上了。
  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { pull(); });
    } else {
      pull();
    }
  } catch (e) { /* 忽略 */ }
})();
