// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/theme/token-map.ts — DSH token 的适配规则表（纯数据，零依赖）。
// 单独成文件的理由：index.ts 顶部 import 了 assets/theme-bridge.js（默认导出由打包器注入的
// 构建期资源），普通 node 无法 import 那个模块，规则表也就没法被单测覆盖。拆出来两边共用。
//
// 写法与编译见 ./adapter.ts。右边三选一：直连宿主变量、基色加偏移、固定值。
//
// 四条容易踩的纪律：
//   ① **层次位用偏移，别拿面去顶。** dsh 靠 5% 级明度差分层（输入框近白 → hover 浅灰 →
//      selector 再深一档），而宿主只有**一层** --bg-card。把"比底略深"的表面接成 --bg-card，
//      差为 0 → 悬停与静止同色、按钮与输入框融为一体。{ of: "--bg", shift: N } 给得出任意
//      档位，且浅深主题自动反向。（例外见 layer-1：上游在浅色里与 base 同值，那里要的是宿主
//      自己那对 --bg / --bg-card，不是自算的档位。）
//   ② **结构性深浅不接。** border-l* / tooltip / toast 这一族随 dsh 自己的明暗翻转（或在
//      深底上配硬编码反白字），与宿主的单一色相 ink-line 语义不等价；接过去只会同色化（暖底
//      上的暖线 = 没画）或白底白字。判定一条该不该接，看这对变量的**配对关系**，不看名字。
//   ③ **固定值要登记。** { fixed } / "~…" 只给宿主确实没有的语义留口子，逐条写理由；能落到
//      宿主变量上的，一律不写死。
//   ④ **不接管也要有归宿。** 每个在用的 --dsw-* 要么在本表里，要么在下面的 PASSTHROUGH 里
//      写明为什么不接——"没列到"不等于"判断过"。

import type { AdapterRule } from "./adapter.ts";

export const TOKEN_MAP: ReadonlyArray<AdapterRule> = [
  // bg 层次：base 是页面/消息底；layer-1 是内容与面板面（轨迹表、JSON 树、卡片、输入框、
  // 设置表单）；layer-2 是浮起一档的面；layer-3 兼作“最亮的面”与**反白字**（见下）。
  // 宿主的层次只有两格（--bg 页面底、--bg-card 卡片面），所以 layer-1/2/3 收敛到卡片面上：
  // dsh 深色那套 875/850/800 的三档阶梯在宿主里没有对应物，不硬造。
  ["--dsw-alias-bg-base", "--bg"],
  // layer-1 不接偏移而接卡片面：dsh 浅色下它与 base 同值（都是纯白）——它的浅色分层靠描边、
  // 不靠填色，深色下才比 base 抬起两档（bluish-950 → 875）。宿主这一对变量自带那个差。
  // 反例是偏移：shift 的 N% 朝对比色在近白底上视觉损失远大于中间调深底，同一格在明暗两侧
  // 会失衡（草香浅色算出的一档比宿主自己的卡片差大四倍）。
  ["--dsw-alias-bg-layer-1", "--bg-card"],
  ["--dsw-alias-bg-layer-2", "--bg-card"],
  // layer-3 有两副面孔：作背景是“最亮的面”，作**反白字**时（Tag 的 solid tone、设置表单的
  // save 按钮、AgentPreset 的 brokenBadge / brokenTip 都写 color: var(--dsw-alias-bg-layer-3)）
  // 是“与 label-primary 相对”的色。宿主里同时满足两者的只有 --bg-card：它永远与 --text 反向
  // （浅色主题近白、深色主题暗），又比 --bg 亮一档，作背景就是浮起的面。接背景系的
  // --sidebar-bg 时，它在反白字位会与底色贴住。
  ["--dsw-alias-bg-layer-3", "--bg-card"],
  ["--dsw-alias-bg-module-platform", "--sidebar-bg"],
  ["--dsw-alias-bg-multi-select", "--accent-light"],
  ["--dsw-alias-bg-overlay", "--bg-card"],
  // bg-mask：全屏遮罩 / 拖放底板。遮罩要的是**中性**加深（黑或白），不是底色混色，所以直连
  // 宿主的遮罩变量，不用 shift（shift 会把 --text 的色相带进来）。photo 是图片上的固定黑底。
  ["--dsw-alias-bg-mask-1", "--overlay-strong"],
  ["--dsw-alias-bg-mask-2", "--overlay-medium"],
  ["--dsw-alias-bg-mask-3", "--drop-overlay-bg"],
  ["--dsw-alias-bg-mask-drop", "--drop-overlay-bg"],
  // brand
  ["--dsw-alias-brand-primary", "--accent"],
  ["--dsw-alias-brand-primary-invert", "--accent"],
  ["--dsw-alias-brand-primary-new-colorprimary-new-color", "--accent"],
  ["--dsw-alias-brand-text", "--text"],
  // button
  ["--dsw-alias-button-primary-fill", "--accent"],
  ["--dsw-alias-button-primary-hover", "--accent-hover"],
  ["--dsw-alias-button-primary-dimmed", "--accent-light"],
  ["--dsw-alias-button-contrast-fill", "--accent"],
  ["--dsw-alias-button-elevated-fill", "--bg-card"],
  ["--dsw-alias-button-floating-fill", "--bg-card"],
  ["--dsw-alias-button-floating-hover", "--accent-light"],
  ["--dsw-alias-button-info-fill", "--accent"],
  ["--dsw-alias-button-info-hover", "--accent-hover"],
  ["--dsw-alias-button-ghost-active-border", "--border"],
  ["--dsw-alias-button-ghost-active-fill", "--bg-card"],
  ["--dsw-alias-button-ghost-active-hover", "--accent-light"],
  // label 三阶
  ["--dsw-alias-label-primary", "--text"],
  ["--dsw-alias-label-primary-bluish", "--accent"],
  ["--dsw-alias-label-primary-dimmed", "--text-light"],
  ["--dsw-alias-label-secondary", "--text-light"],
  // 反白主文字：wordmark 的 badge 文字、Toast、附件条等都在用它（漏了这一格的话，
  // 那几个地方只跟着 dsh 自己的明暗走，sidebar 品牌名处就会变色）。
  // 它读作“坐在主文字色块上的反白字”，对应宿主的页面底色。
  ["--dsw-alias-label-primary-inverted", "--bg"],
  ["--dsw-alias-label-tertiary", "--text-muted"],
  ["--dsw-alias-label-caption", "--text-muted"],
  ["--dsw-alias-label-dimmed", "--text-muted"],
  // border：**整族不接**（保持 dsh 原生），只有 l3 单列在下面。
  // 这五档不只是"画线"，还是 elevation 的描边色来源——宿主在 gradient-shadow-text.css 里把
  // --dsw-elevation-stroke-color 默认绑到 l4，Menu / InputBar / ChatView / AttachmentRail 又
  // 各自重绑 l1 / l2 / l2-darkmode-thin / l3。而 l* 是**结构性深浅线**（浅色主题黑 4–16%、
  // 深色主题白 6–20%，随明暗翻转），宿主的 --border 却是**单一色相**的暖调 ink-line。接上去
  // 不是"变淡"而是"同色系"：暖底上的暖线等于没画，并且连带把整套 elevation（那一笔描边 +
  // panel/prominent/soft 三层投影）一起拖没。
  // 注：不接的只有 border-l*；--dsw-alias-separator-primary / border-inverted2 /
  // button-ghost-active-border 这些**语义明确的分隔线**仍走 --border。
  // l3 单列：它兼作“占用环”的轨道色（ContextMeter 的 .track），那里要的是宿主的分割线。
  // 代价明确：l3 同时也用于二十余处边框，且 ChatView 把 elevation 的描边重绑到它——
  // 那处浮层会跟着变暖调（elevation 默认的 l4 不受影响）。
  ["--dsw-alias-border-l3", "--border"],
  // interactive
  ["--dsw-alias-interactive-bg-hover", "--accent-light"],
  ["--dsw-alias-interactive-bg-active", "--accent-light"],
  ["--dsw-alias-interactive-bg-hover-accent", "--accent-light"],
  // hover-solid 是"实色悬停底"（圆按钮等），原值比纯白深约一档，属层次位 → 偏移。
  ["--dsw-alias-interactive-bg-hover-solid", { of: "--bg", shift: 8 }],
  // markdown
  ["--dsw-alias-markdown-inline-code", "--accent-light"],
  // 代码块（头 = banner 信息条，体 = .block 与 <pre> 两个盒子）：
  // dsh 靠**色相**把它与页面分开（浅色 bluish-50 对页面 bluish-00、深色 bluish-900 对
  // bluish-950，明度只差约 2%）。宿主只有暖调，色相接不出这个差，落到 --bg 便与页面同色。
  // 改用偏移：浅色压暗、深色提亮，方向与 dsh 那对级差一致，量级（8% / 15%）比原来的 ~2% 明显。
  // 结构上有两层：.block 与 <pre> 画同一个值（<pre> 区域两层叠色）；bannerWrap 用
  // --dsw-alias-bg-base 的实色垫底，banner 只剩一层。所以二者取相邻两档（15% / 8%）后，头体
  // 各落一位，整块从页面浮出而不互相打架。
  ["--dsw-alias-markdown-code-block", { of: "--bg", shift: 8 }],
  ["--dsw-alias-markdown-code-block-banner", { of: "--bg", shift: 15 }],
  ["--dsw-alias-markdown-code-segment-selected", "--accent-light"],
  ["--dsw-alias-markdown-code-segment-unselected", "--bg"],
  ["--dsw-alias-markdown-tag", "--accent-light"],
  ["--dsw-alias-markdown-placeholder", "--accent-light"],
  ["--dsw-alias-markdown-citation", "--bg-card"],
  // state 语义色
  ["--dsw-alias-state-business-primary", "--accent"],
  ["--dsw-alias-state-business-tertiary", "--accent-light"],
  ["--dsw-alias-state-error-primary", "--danger"],
  ["--dsw-alias-state-error-secondary", "--danger"],
  ["--dsw-alias-state-success-primary", "--green"],
  ["--dsw-alias-state-success-secondary", "--green"],
  // state 语义色：business/error/success 的 primary/secondary 之外还要覆盖 warn-* 系列——
  // DSH 自带的**连接状态指示灯**（ui-primitives 的 ConnectionIndicator，落在侧栏 footer 的
  // settings 区）用的就是它。宿主主题没有 amber 语义色（只有 --green / --danger），所以按
  // “只用宿主变量、不搬固定值”的纪律取最近的语义位：
  //   warn/success 的 tint 用层次偏移与强调浅色；标签色用 --danger / --green 保住语义读法。
  ["--dsw-alias-state-warn-primary", "--danger"],
  ["--dsw-alias-state-warn-label", "--danger"],
  ["--dsw-alias-state-warn-tertiary", { of: "--bg", shift: 8 }],
  ["--dsw-alias-state-success-label", "--green"],
  ["--dsw-alias-state-success-tertiary", "--accent-light"],
  ["--dsw-alias-state-error-label", "--danger"],
  ["--dsw-alias-state-error-tertiary", { of: "--bg", shift: 8 }],
  ["--dsw-alias-state-business-label", "--accent"],
  ["--dsw-alias-state-business-secondary", "--accent-light"],
  // idle 点是“连接空闲”态的着色（ui-primitives 的 StateDot），上游取中性灰（neutral-300 / 600）。
  // 宿主没有 idle 语义位，取最近的中性弱文字色，与 label-dimmed / label-caption 同源。
  ["--dsw-alias-state-idle-primary", "--text-muted"],
  // 差异语义色（绿=新增、红=删除）：两处消费方同属一族。
  //   · 文件对比（ui-deliverables 的 FileDiff.module.css）：--dsw-alias-file-diff-* 三档——
  //     代码区底、行号区底、行首标记；
  //   · 代码块内的行差异（ui-primitives 的 DiffBlock.module.css）：--dsw-alias-code-diff-*。
  // 上游给的是硬编码调色板 tint（浅色 rgb(230,244,231) 一族，深色 rgb(31,49,36) 一族），不跟主题
  // 走——不接的话同一张界面上会同时出现宿主的绿与 dsh 的绿。
  // 接法：底与行号区是“绿/红掺进页面底”的淡色（shift 定向掺 with，不用 --text 的对比方向），
  // 标记与代码块底是饱和语义色直连 --green / --danger。两套明暗自动成立，不必分写。
  // 档位关系对应上游：代码区底最浓、行号区更淡（上游那两个值也只有一点点差）。
  ["--dsw-alias-file-diff-added-bg", { of: "--bg", shift: 12, with: "--green" }],
  ["--dsw-alias-file-diff-added-gutter", { of: "--bg", shift: 6, with: "--green" }],
  ["--dsw-alias-file-diff-added-marker", "--green"],
  ["--dsw-alias-file-diff-deleted-bg", { of: "--bg", shift: 12, with: "--danger" }],
  ["--dsw-alias-file-diff-deleted-gutter", { of: "--bg", shift: 6, with: "--danger" }],
  ["--dsw-alias-file-diff-deleted-marker", "--danger"],
  ["--dsw-alias-code-diff-added", { of: "--bg", shift: 10, with: "--green" }],
  ["--dsw-alias-code-diff-deleted", { of: "--bg", shift: 10, with: "--danger" }],
  // ---- alias 层补漏 ----
  // 办法：从引擎自带的 DSH 前端 CSS/JS 反推全部 --dsw-* 用量，与规则表做差集。
  // 结论：font*、static-*（除下面单列的四个层次位）、elevation-/shadow-/mask、corner-shape
  // 与 linear-* 梯度属于字体/调色板/阴影/几何，本身不随主题走，不接也不该接。下面补齐差额：
  ["--dsw-alias-link", "--accent"],
  ["--dsw-alias-interactive-bg-hover-danger", { of: "--bg", shift: 8 }],
  ["--dsw-alias-label-primary-foreground", "--bg"],
  ["--dsw-alias-label-error", "--danger"],
  ["--dsw-alias-state-warn-secondary", "--danger"],
  ["--dsw-alias-border-inverted", "--text"],
  ["--dsw-alias-border-inverted2", "--border"],
  ["--dsw-alias-separator-primary", "--border"],
  ["--dsw-alias-bg-layer-4", "--bg-card"],
  ["--dsw-alias-bg-skeleton", { of: "--bg", shift: 8 }],
  ["--dsw-alias-bg-mask-photo", "--overlay-strong"],
  ["--dsw-alias-button-tool-bar-fill", "--bg-card"],
  ["--dsw-alias-button-tool-bar-hover", "--accent-light"],
  ["--dsw-alias-button-tool-bar-fill-invisible", "--bg-card"],
  ["--dsw-alias-fill-tertiary", { of: "--bg", shift: 8 }],
  ["--dsw-alias-fill-l2", { of: "--bg", shift: 8 }],
  ["--dsw-alias-fill-tsp-secondary", { of: "--bg", shift: 8 }],
  ["--dsw-alias-label-quaternary", "--text-muted"],
  ["--dsw-hovercard-bg", "--bg-card"],

  // ---- 卡片填充色：调色板值被当成随主题走的层次位 ----
  // ChangedFiles / Deliverables / PlanPreview 三组把填充色存在组件私有变量里（--changes-fill
  // 等），值取调色板 static-neutral-50 / 100（浅色）与 850 / 800（深色），再由
  // body[data-ds-dark-theme] 自己翻明暗——调色板在这里承担的是**随主题走的层次位**语义。
  // 私有变量写在组件规则上，桥的 body 层 !important 压不住（元素自身声明优先于继承），
  // 所以只能从值的源头接：静止档（浅色 50 / 深色 850）与悬停档（浅色 100 / 深色 800，更深一档）
  // 各接一个偏移档。浅深两档同名规则是刻意的：偏移方向随主题自动反向，与 dsh 那对调换一致。
  // 全局消费者只有这三组卡片（另两处调色板引用是 ui-theme 里的 alias 定义，已被本表直接覆盖）。
  ["--dsw-static-neutral-50", { of: "--bg", shift: 8 }],
  ["--dsw-static-neutral-850", { of: "--bg", shift: 8 }],
  ["--dsw-static-neutral-100", { of: "--bg", shift: 15 }],
  ["--dsw-static-neutral-800", { of: "--bg", shift: 15 }],

  // 滚动条：复刻宿主原生语言（中性灰，不主题化）——与主题无关的构件，写死值。
  ["--dsw-alias-scrollbar-bg-l1", "~rgba(128,128,128,0.2)"],
  ["--dsw-alias-scrollbar-bg-l2", "~rgba(128,128,128,0.2)"],
  ["--dsw-alias-scrollbar-hover-l1", "~rgba(128,128,128,0.4)"],
  ["--dsw-alias-scrollbar-hover-l2", "~rgba(128,128,128,0.4)"],
  // specific 层：bubble 用宿主 userBg（accent 透明遮罩，非实色卡片）
  ["--dsw-specific-bubble-highlight", "--accent-light"],
  ["--dsw-specific-bubble", "--user-bg"],
  ["--dsw-specific-input-major", "--bg-card"],
  ["--dsw-specific-login-input", "--bg"],
  ["--dsw-specific-menu", "--sidebar-bg"],
  // selector 是"选择器项"的底，原值比纯白的浅灰深一档，同属层次位 → 偏移。
  ["--dsw-specific-selector", { of: "--bg", shift: 8 }],
  ["--dsw-specific-sidebar-fill", "--sidebar-bg"],
  ["--dsw-specific-sidebar-nav-item-active-accent", "--accent-light"],
  ["--dsw-specific-sidebar-nav-item-active", "--accent-light"],
  ["--dsw-specific-sidebar-nav-item-hover", "--accent-light"],
  ["--dsw-specific-tip", "--accent-light"],
];

/**
 * 显式不接管清单：命中的 --dsw-* 保持 DSH 原生值。
 * 这张表存在是为了让"全量"名副其实——每个在用的 token 都要有归宿，要么在上面接了，
 * 要么在这里写明为什么不接。判据同文件头纪律②：看配对关系，不看名字。
 */
export const PASSTHROUGH: ReadonlyArray<{ match: RegExp; why: string }> = [
  {
    match: /^--dsw-(font|elevation|shadow|corner|mask-blur|linear)/,
    why: "字体、投影、圆角、模糊与渐变：与主题配色无关，跟着 dsh 自己的设计语言走。",
  },
  {
    match: /^--dsw-static-/,
    why: "调色板：固定色值本身不随主题走。上面单列的四个 neutral 值是例外——它们被组件当层次位用。",
  },
  {
    match: /^--dsw-alias-(tooltip-bg|toast-bg)$/,
    why: "深色浮层 + 硬编码反白字的功能性配对：接成宿主卡片色会白底白字。",
  },
  {
    match: /^--dsw-alias-border-l(?!3$)/,
    why: "结构性深浅描边，且是 elevation 的描边色来源；宿主只有单一色相的暖调 ink-line。",
  },
  {
    match: /^--dsw-(alias-bg-l1|alias-bg-l2|alias-fill-l1|alias-state-warning-primary)$/,
    why: "上游未定义这几个名字（使用处自带 fallback 或干脆透明）。接管等于替上游补定义、改变观感，不做。",
  },
  {
    match: /^--dsw-menu-backdrop-filter$/,
    why: "滤镜值（blur + saturate），不是颜色。",
  },
  {
    match: /^--dsw-alias-(bg|label)-document-preview$/,
    why: "文档预览面：深底 + 浅字的成对配色（浅色主题下也是深色预览区）。只接背景会白底白字，不拆对。",
  },
];
