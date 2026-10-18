// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/boot-bloom.mts — 把 DSH 启动页的转圈环换成四花绽放。
//
// 为什么在打包层而不是 integrations/：那一层贴的是**上游源码**（`git show <tag>` 读文件、
// 校验 upstreamSha256、编译 overlay）。启动页的源码在 `packages/client/web`，它只作为
// workspace 依赖存在、没有发布到 npm，DSHana 的依赖树里根本没有这个包；DSHana 拿到的是官方
// 发好的 `@deepseek-ai/dsh-web-frontend` 压缩 dist，`dist/` 也不在上游源码树里。所以这一处
// 只能对**产物**做定点替换，而产物替换的守卫不是 upstreamSha256，是下面两条锚点断言。
//
// 幂等：每次都从刚铺好的官方 dist 重读再改，跑几遍结果一样。锚点找不到就抛错——上游产物
// 变了就该重做这处替换，不能让启动页静默退回转圈环。
import fs from "fs-extra";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** 交付树里前端产物的位置（相对 node_modules）。 */
const FRONTEND_PACKAGE = "@deepseek-ai/dsh-web-frontend";

/* ---------- 花形数据（与 app 内思考指示器同一套几何） ---------- */

const PLUM = "M0,-2 C-3.8,-2.8 -4.8,-9 0,-9.3 C4.8,-9 3.8,-2.8 0,-2Z";
const SAKURA = "M0,-2 C-3.4,-3 -4.8,-7.8 -2,-9.3 L0,-7.9 L2,-9.3 C4.8,-7.8 3.4,-3 0,-2Z";
const LOTUS = "M0,0 C-4,-3 -3.8,-9.8 0,-13.2 C3.8,-9.8 4,-3 0,0Z";
const ORCHID = "M0,-1.2 C-2.8,-3.6 -2.9,-8 0,-10.2 C2.9,-8 2.8,-3.6 0,-1.2Z";
const LIP = "M0,-1 C-2.6,-1.6 -3,-4.8 0,-5.4 C3,-4.8 2.6,-1.6 0,-1Z";

const radial = (n) => Array.from({ length: n }, (_, i) => (i * 360) / n);

/** 四种花：花心半径、竖直落座偏移、若干组花瓣。 */
const FLOWERS = [
  { core: 1, baseY: 0, groups: [{ d: PLUM, angles: radial(5) }] },
  { core: 0.9, baseY: 0, groups: [{ d: SAKURA, angles: radial(5) }] },
  {
    core: 0,
    baseY: 5.5,
    groups: [
      { d: LOTUS, angles: [-34, 34] },
      { d: LOTUS, angles: [-62, 0, 62], lengths: [0.78, 1, 0.78] },
    ],
  },
  {
    core: 0.8,
    baseY: 0.6,
    groups: [
      { d: ORCHID, angles: [0, -118, 118] },
      { d: LIP, angles: [180] },
    ],
  },
];

/** 花瓣与花心的类名；CSS 里同名规则驱动动画。 */
const PETAL_CLASS = "_bloomPetal_boot";
const CORE_CLASS = "_bloomCore_boot";

/** 每朵花接手的间隔（秒）。 */
const CYCLE_SEC = 1.9;

/** 一轮动画周期：前三朵的起点 3×1.9 + 最后一朵活到散完 2.35。 */
const PERIOD_SEC = 3 * CYCLE_SEC + 2.35;

/** 生成四朵叠放的 SVG 标记。 */
function bloomMarkup() {
  return FLOWERS.map((flower, fi) => {
    // animation-delay 写在 <g class="petal"> 上，不继承父 <svg> 的 delay：
    // 每朵的花瓣必须自己叠上花朵 offset，否则四朵的花瓣会在每轮同一刻同时张开。
    const flowerOffset = fi * CYCLE_SEC;
    let petals = "";
    flower.groups.forEach((group, gi) => {
      group.angles.forEach((angle, pi) => {
        const length = group.lengths?.[pi] ?? 1;
        const delay = flowerOffset + gi * 0.16 + pi * 0.04;
        petals +=
          `<g transform="rotate(${String(angle)})">` +
          `<g class="${PETAL_CLASS}" style="animation-delay:${delay.toFixed(2)}s">` +
          `<g transform="scale(1 ${String(length)})"><path d="${group.d}"/></g>` +
          `</g></g>`;
      });
    });
    const core =
      flower.core === 0
        ? ""
        : `<circle class="${CORE_CLASS}" r="${String(flower.core)}" style="animation-delay:${(flowerOffset + 0.4).toFixed(2)}s" transform="scale(0)"/>`;
    return (
      `<svg viewBox="-10.5 -10.5 21 21">` +
      `<g transform="translate(0 ${String(flower.baseY)})">${petals}${core}</g>` +
      `</svg>`
    );
  }).join("");
}

/**
 * 关键帧百分比。参考实现的四段：花苞 0.35、绽放 1.0、保持 0.55、消散 0.45（单朵共 2.35）。
 * 百分比乘周期，得到与参考一致的秒数。
 */
const K_BUD = (0.35 / PERIOD_SEC) * 100;
const K_FULL = (1.35 / PERIOD_SEC) * 100;
const K_HOLD = (1.9 / PERIOD_SEC) * 100;
const K_END = (2.35 / PERIOD_SEC) * 100;

/** 替换掉转圈环的样式，换成花瓣动画。 */
const BLOOM_CSS = [
  "._spinner_u7vgf_45{position:relative;width:20px;height:20px;color:var(--dsw-alias-brand-primary, var(--dsh-boot-brand))}",
  `._spinner_u7vgf_45 svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;display:block;opacity:0;animation:_bloomLife_boot var(--dsh-boot-pace,${PERIOD_SEC.toFixed(2)}s) linear infinite both}`,
  "._spinner_u7vgf_45 svg:nth-child(1){animation-delay:0s}",
  `._spinner_u7vgf_45 svg:nth-child(2){animation-delay:${String(CYCLE_SEC)}s}`,
  `._spinner_u7vgf_45 svg:nth-child(3){animation-delay:${(CYCLE_SEC * 2).toFixed(2)}s}`,
  `._spinner_u7vgf_45 svg:nth-child(4){animation-delay:${(CYCLE_SEC * 3).toFixed(2)}s}`,
  "._spinner_u7vgf_45 path{fill:none;stroke:currentColor;stroke-width:1.68;stroke-linejoin:round}",
  `.${PETAL_CLASS}{transform-origin:0 0;animation:_bloomPetal_boot var(--dsh-boot-pace,${PERIOD_SEC.toFixed(2)}s) linear infinite both}`,
  `.${CORE_CLASS}{fill:currentColor;stroke:none;transform-origin:0 0;animation:_bloomCore_boot var(--dsh-boot-pace,${PERIOD_SEC.toFixed(2)}s) linear infinite both}`,
  // 缓动挂在关键帧上时作用于「到下一个关键帧」那一段：开花与消散两段需要 easeInOutCubic 的形状，
  // 保持段参考实现本来就是直线。花瓣与花心用带回弹的曲线，保留过冲。
  `@keyframes _bloomLife_boot{0%{opacity:0;transform:rotate(-50deg) scale(.7)}` +
    `${K_BUD.toFixed(2)}%{opacity:1;transform:rotate(-50deg) scale(1);animation-timing-function:cubic-bezier(.6,-.08,.4,1.08)}` +
    `${K_FULL.toFixed(2)}%{opacity:1;transform:rotate(0) scale(1)}` +
    `${K_HOLD.toFixed(2)}%{opacity:1;transform:rotate(4deg) scale(1);animation-timing-function:cubic-bezier(.6,-.08,.4,1.08)}` +
    `${K_END.toFixed(2)}%{opacity:0;transform:rotate(30deg) scale(.82)}` +
    "100%{opacity:0;transform:rotate(30deg) scale(.82)}}",
  `@keyframes _bloomPetal_boot{0%,${K_BUD.toFixed(2)}%{transform:scale(.38,.5);animation-timing-function:cubic-bezier(.36,1.36,.72,.96)}` +
    `${(((0.35 + 0.6) / PERIOD_SEC) * 100).toFixed(2)}%,100%{transform:scale(1,1)}}`,
  `@keyframes _bloomCore_boot{0%,${((0.4 / PERIOD_SEC) * 100).toFixed(2)}%{transform:scale(0);animation-timing-function:cubic-bezier(.36,1.36,.72,.96)}` +
    `${((1.0 / PERIOD_SEC) * 100).toFixed(2)}%{transform:scale(1.05)}` +
    `${K_FULL.toFixed(2)}%,100%{transform:scale(1)}}`,
  "@media (prefers-reduced-motion:reduce){._spinner_u7vgf_45 svg{animation:none;opacity:1;transform:none}._spinner_u7vgf_45 svg:not(:first-child){display:none}._bloomPetal_boot,._bloomCore_boot{animation:none;transform:none}}",
].join("");

/**
 * 取 dist/assets 下唯一匹配前缀与后缀的文件名。
 * @param {string} dir assets 目录
 * @param {string} prefix 文件名前缀
 * @param {string} ext 扩展名
 * @returns {string} 文件名
 */
function assetOf(dir, prefix, ext) {
  const names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(ext));
  if (names.length !== 1) {
    throw new Error(`boot-bloom: 期望 ${prefix}*${ext} 恰好一个，实得 ${names.length} 个：${names.join(", ")}`);
  }
  return names[0];
}

/**
 * 把一处锚点替换成新内容；锚点必须存在且唯一，否则抛错。
 * @param {string} text 原文本
 * @param {string} anchor 锚点
 * @param {string} replacement 替换内容
 * @param {string} what 出错时报告的位置
 * @returns {string} 替换后的文本
 */
function replaceOnce(text, anchor, replacement, what) {
  const at = text.indexOf(anchor);
  if (at < 0) {
    throw new Error(`boot-bloom: 锚点缺失（${what}）—— 上游产物已变，需要重做这处替换`);
  }
  if (text.indexOf(anchor, at + 1) >= 0) {
    throw new Error(`boot-bloom: 锚点不唯一（${what}）—— 命中多处，拒绝猜测`);
  }
  return text.slice(0, at) + replacement + text.slice(at + anchor.length);
}

/**
 * 把交付树里官方前端 dist 的启动页转圈环换成花瓣动画。
 * @param {string} nodeModulesDir 交付树的 node_modules
 * @returns {boolean} 是否做了替换
 */
export function applyBootBloom(nodeModulesDir) {
  const pkgDir = join(nodeModulesDir, FRONTEND_PACKAGE);
  if (!fs.pathExistsSync(pkgDir)) {
    // 该构成不含前端 dist（静态 worker preview 那种），没什么可换的。
    return false;
  }
  const assets = join(pkgDir, "dist", "assets");
  const jsName = assetOf(assets, "index-", ".js");
  const cssName = assetOf(assets, "index-", ".css");
  const jsPath = join(assets, jsName);
  const cssPath = join(assets, cssName);

  let js = fs.readFileSync(jsPath, "utf8");
  let css = fs.readFileSync(cssPath, "utf8");

  // 已经改过（重复打包时）就别再插一遍。
  if (js.includes(PETAL_CLASS) || css.includes("_bloomLife_boot")) {
    console.log("[pack] 启动页花瓣：已经是改写后的产物，跳过");
    return false;
  }

  // 1) JS：在 spinner 建好后把花瓣标记塞进去。
  const jsAnchor = 'this.spinner.dataset.dshBootSpinner="",';
  js = replaceOnce(
    js,
    jsAnchor,
    `${jsAnchor}this.spinner.innerHTML=${JSON.stringify(bloomMarkup())},`,
    "JS boot page spinner",
  );

  // 2) CSS：整段换掉转圈环规则（含它的旋转关键帧）。
  const cssFrom = css.indexOf("._spinner_u7vgf_45{position:relative");
  const cssEndAnchor = "}@keyframes _spin_u7vgf_45{to{transform:rotate(360deg)}}";
  if (cssFrom < 0) {
    throw new Error("boot-bloom: 锚点缺失（CSS spinner）—— 上游产物已变，需要重做这处替换");
  }
  const cssTo = css.indexOf(cssEndAnchor, cssFrom);
  if (cssTo < 0) {
    throw new Error("boot-bloom: 锚点缺失（CSS spin keyframes）—— 上游产物已变，需要重做这处替换");
  }
  css = css.slice(0, cssFrom) + BLOOM_CSS + css.slice(cssTo + cssEndAnchor.length);

  fs.writeFileSync(jsPath, js);
  fs.writeFileSync(cssPath, css);

  const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 8);
  console.log(
    `[pack] 启动页花瓣：已改写 ${jsName}（+${String(bloomMarkup().length)}B 标记）与 ${cssName}` +
      `（摘要 ${digest(js)}/${digest(css)}）`,
  );
  return true;
}
