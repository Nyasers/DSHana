// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/dsh/theme/token-map.ts — DSH token 的适配规则表（纯数据，零依赖）。
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
  // turn-trigger 是会话里那个收/展回合的触发节点（TurnTriggerNodeView）：它的静态底上游就
  // 指到 markdown-code-block，跟紧同一档；悬停那格上游指到 interactive-bg-hover，本表那格
  // 接的是 --accent-light（悬停面的统一判法），跟齐不另起。
  ["--dsw-alias-turn-trigger-bg", { of: "--bg", shift: 8 }],
  ["--dsw-alias-turn-trigger-bg-hover", "--accent-light"],
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
  // border-selected：选中态描边（上游两套主题同一支 bluish-400）。"选中"在本站就是品牌色那条边，
  // 与 ghost-active-border / settings-card-stroke 同属语义明确的线 → --accent。
  ["--dsw-alias-border-selected", "--accent"],
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
  // 思考态那行的「深度求索中」：上游是自带的一支蓝（deep-diving），与它的扫光
  // （deep-diving-shimmer，同色反向偏一档）成对。接宿主强调色时两格一起接，否则扫过去
  // 那一下会串成另一个色。shimmer 的 shift 30 方向与上游的配对一致（浅色主题压深、深色提亮）。
  ["--dsw-alias-label-deep-diving", "--accent"],
  ["--dsw-alias-label-deep-diving-shimmer", { of: "--accent", shift: 30 }],
  // hovercard（悬浮预览卡）：rc.2 起上游把它从一支固定深色（#2C2C2E）改成 alias 层的一对
  // 深浅值，并把卡内的标签色单列成 hovercard-label-*。本表一直把它当**随主题走的内容面**
  // （旧的 --dsw-hovercard-bg 就接 --bg-card），标签色就必须跟着换气：接成上游那支近白，
  // 浅色主题上就是白字压白卡。三档标签按 label-primary / secondary / tertiary 的读法走。
  ["--dsw-hovercard-bg", "--bg-card"],
  ["--dsw-alias-hovercard-bg", "--bg-card"],
  ["--dsw-alias-hovercard-label-primary", "--text"],
  ["--dsw-alias-hovercard-label-secondary", "--text-light"],
  ["--dsw-alias-hovercard-label-tertiary", "--text-muted"],
  ["--dsw-alias-hovercard-state-error", "--danger"],

  // ---- 卡片填充色：调色板值被当成随主题走的层次位 ----
  // ChangedFiles / Deliverables / PlanPreview 三组把填充色存在组件私有变量里（--changes-fill
  // 等），值取调色板 static-neutral-50 / 100（浅色）与 850 / 800（深色），再由
  // body[data-ds-dark-theme] 自己翻明暗——调色板在这里承担的是**随主题走的层次位**语义。
  // 私有变量写在组件规则上，桥的 body 层覆盖压不住（元素自身声明优先于继承），
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
  // 侧栏玻璃层（macOS vibrancy 下「新建会话」那颗纽的底）：上游是中性白洗（浅 55% / 深 15%）
  // 叠在系统毛玻璃上。宿主没有毛玻璃，侧栏已经是实色的 --sidebar-bg，所以这里的洗色按本站
  // 悬停语的读法接 —— accent 透明遮罩，与 nav-item-hover / button-floating-hover 同一格。
  // collapsed-fill 上游就是 transparent（折叠时不要底），照旧给透明。
  ["--dsw-specific-sidebar-glass-fill", "--accent-light"],
  ["--dsw-specific-sidebar-glass-hover", "--accent-light"],
  ["--dsw-specific-sidebar-glass-collapsed-hover", "--accent-light"],
  // tint / wash：侧栏顶上的一层染色与上下两端的渐变洗（上游固定蓝/紫透明色）。两格一色 + 两格
  // 到全透明，拼出来的就是从 accent 洗色淡到无的渐变；不跟随上游的蓝紫双色相，否则侧栏里
  // 会多出一支与主题无关的紫。
  ["--dsw-specific-sidebar-tint", "--accent-light"],
  ["--dsw-specific-sidebar-wash-top", "--accent-light"],
  ["--dsw-specific-sidebar-wash-bottom", "--accent-light"],
  // 侧栏右缘的高光闪：浅色取品牌蓝、深色取纯白，要的是「一道强调光」而不是某个面 → --accent。
  ["--dsw-specific-sidebar-right-flash", "--accent"],
  ["--dsw-specific-tip", "--accent-light"],

  // ---- 设置卡片 / 引导面 / 菜单面 ----
  // settings-card-fill 上游取 bg-layer-2（内容面），与上面 layer-1/2 → --bg-card 同一格；
  // stroke 上游取 border-l4，但这一条的语义就是“卡片描边”——语义明确的线，不是层次位，
  // 与 separator-primary / ghost-active-border 同族 → --border。
  ["--dsw-alias-settings-card-fill", "--bg-card"],
  ["--dsw-alias-settings-card-stroke", "--border"],
  // 引导面（DesktopOnboarding / onboarding.css）：accent 是引导自己的强调色，接 --accent
  // 让欢迎页与整站同调；card-fill 上游是中性面掺 80% 透明 → 内容面；secondary-fill 是
  // “比它再低一档的表面” → 层次偏移；checkbox-border 是控件描边 → --border。
  ["--dsw-alias-onboarding-accent", "--accent"],
  ["--dsw-alias-onboarding-card-fill", "--bg-card"],
  ["--dsw-alias-onboarding-secondary-fill", { of: "--bg", shift: 8 }],
  ["--dsw-alias-onboarding-checkbox-border", "--border"],
  // menu-icon 是菜单里的图标色（浅色取中性深灰、深色取 label-primary-dimmed），与 label-secondary 同读法。
  ["--dsw-alias-menu-icon", "--text-light"],
  // menu-surface-fill 是弹出菜单的底，与 --dsw-specific-menu 同源（上游把后者指到它），归宿一致。
  ["--dsw-menu-surface-fill", "--sidebar-bg"],
  // menu-group-header-fill 是分组标题吸顶（data-stuck）时的底：上游给的是同一支白更不透明的
  // 一档（0.94 对菜单底的 0.58），要的正是「遮住底下滚过去的内容」。本表的菜单面本来就是实色，
  // 两格落同一处即可，也恰好满足吸顶要不透明的本意。
  ["--dsw-alias-menu-group-header-fill", "--sidebar-bg"],

  // ---- rc.2 新增：卡片 / 轨迹 / 引导条 / 上传槽 ----
  // card-fill 与 bg-layer-1/2 同值（浅 neutral-50 / 深 850），是内容与面板面 → --bg-card，
  // 与 settings-card-fill 同一格；card-fill-hover 是它深一档的悬停态 → 本站悬停语 --accent-light。
  ["--dsw-alias-card-fill", "--bg-card"],
  ["--dsw-alias-card-fill-hover", "--accent-light"],
  // trajectory-accent 是轨迹里那支强调蓝（两套主题都是 blue-500），与 brand 同读法。
  ["--dsw-alias-trajectory-accent", "--accent"],
  // guide-hero 是引导页顶图条的中性面（浅 200 / 深 700，随明暗翻转）→ 层次偏移。
  ["--dsw-specific-guide-hero", { of: "--bg", shift: 8 }],
];

/**
 * 显式不接管清单：命中的 --dsw-* 保持 DSH 原生值。
 * 这张表存在是为了让"全量"名副其实——每个在用的 token 都要有归宿，要么在上面接了，
 * 要么在这里写明为什么不接。判据同文件头纪律②：看配对关系，不看名字。
 */
export const PASSTHROUGH: ReadonlyArray<{ match: RegExp; why: string }> = [
  {
    match: /^--dsw-(font|elevation|shadow|corner|radius|mask-blur|linear|gradient)/,
    why: "字体、投影、圆角、模糊与渐变：与主题配色无关，跟着 dsh 自己的设计语言走。",
  },
  {
    match: /^--dsw-static-/,
    why: "调色板：固定色值本身不随主题走。上面单列的四个 neutral 值是例外——它们被组件当层次位用。",
  },
  {
    match: /^--dsw-alias-(tooltip-bg|tooltip-key-bg|tooltip-label|toast-bg|toast-label|toast-action)$/,
    why: "深色浮层 + 硬编码反白字的功能性配对：接成宿主卡片色会白底白字（key-bg 是 tooltip 底色掺白的按键底，tooltip-label 是那层上的字，toast-action 是深底上的链接色，同属这一层）。",
  },
  {
    match: /^--dsw-focus-ring-/,
    why: "焦点环：宽度是几何值；颜色在根作用域本就没有定义（取值处自带 state-business-primary 兜底，指针模态下被置 transparent），接管等于替上游补定义。",
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
    match: /^--dsw-alias-(bg|label)-document-(preview|selection)$/,
    why: "文档预览面：深底 + 浅字的成对配色（浅色主题下也是深色预览区）。只接背景会白底白字，不拆对；正文选区（bg-document-selection）就压在这层深底上，同一个面同一个判法。",
  },
  {
    match: /^--dsw-alias-label-shimmer$/,
    why: "通用扫光叠色（压在文字上的一次高光，浅色主题中性深、深色主题中性浅），别处也在用，动的面比思考态那行大得多，先保持 DSH 原生；思考态那行自己把 shimmer 重指到了 deep-diving-shimmer，那一格已在本表接上。",
  },
  {
    match: /^--dsw-alias-switch-thumb$/,
    why: "开关旋钮：本表未接管开关整族，thumb 与 track 是对比配对，单接一头会破坏开关开合的辨识。",
  },
  {
    match: /^--dsw-alias-illustration-[a-z]+$/,
    why: "空态插画内部的六层中性层次（浅 55/90/310、深 700/750/850）：它们描的是插画自身的结构，宿主没有“插画面”这一层语义位；接成宿主灰阶会把插画压成同一色块，接成面则与卡片底贴死。",
  },
  {
    match: /^--dsw-alias-(state-done-primary|hovercard-state-done)$/,
    why: "“已完成”标记色（浅 violet-600 / 深 violet-400）：上游特意与 success（绿）分开——接成 --green 就与“成功”同读，接成 --accent 就与品牌色混同，宿主调色板里没有紫色语义位，保持原生。悬浮预览卡里的 hovercard-state-done 是同一支 violet 的标记色，同一个判法。",
  },
  {
    match: /^--dsw-alias-chart-(messages|system|tools)$/,
    why: "统计图的三支分类色（蓝 / 中性灰蓝 / 紫）：它们是**一组**要被看成不同东西的语汇，不是“底色深一档”。宿主调色板里只有一两个可用的语义色（--accent / --text-light），接过去会把三分类压成一种颜色，反而不如上游自己的调色板。",
  },
  {
    match: /^--dsw-alias-json-tree-[a-z]+$/,
    why: "JSON 树的语法着色（关键词蓝 / 字符红 / 数字 / 属性 / 标点 / 图标 / 悬停底）：这是代码着色语汇，与编辑器、shiki 同族，本身不随主题色相走；接成宿主色会把语法层拆开（字符串与错误同色）。",
  },
  {
    match: /^--dsw-alias-label-on-color$/,
    why: "彩色面上的反白字（两套主题都是近白）：宿主没有“坐在彩色面上”这个语义位。接 --bg-card 在浅色主题碰巧对（近白），深色主题就变成暗字压蓝底；保持原生。",
  },
  {
    match: /^--dsw-alias-card-tile-fill$/,
    why: "卡片内的瓦片用一层中性白（浅 50% / 深 5%）：它是一个**半透明叠加**，不是层次位——靠上游自己的明暗两套 alpha 随着底算，接偏移会把它变成实色、跟卡片底贴死。",
  },
  {
    match: /^--dsw-specific-file-upload-track$/,
    why: "上传进度槽：上游两套主题都用同一支 8% 黑叠底（槽总是比面深），是最接近系统原生槽的画法；宿主没有“叠加加深”这种变量，shift 会在深色主题反向提亮，所以保持原生。",
  },
  {
    match: /^--dsw-specific-sidebar-(glass-collapsed-fill|wash-(top|bottom)-clear)$/,
    why: "上游给的就是 transparent（折叠时不要底、渐变的两个透明端点）：它们要的就是“没有颜色”，本表能给的也只有透明，保持原生最直白。",
  },
];
