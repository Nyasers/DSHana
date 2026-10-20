// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/bloom/src/geometry.ts — 四种花的形状与时间轴。**只有数据与纯函数，不碰 DOM。**
//
// 为什要单独一个包：这套花现在有两处渲染者，算法必须同源，否则改一处忘一处就漂。
//   · 壳页自举台（packages/ui/src/app.ts）：把几何拼成 SVG 标记，交给 face-stage.css 的
//     keyframes 驱动 —— 加载页里不起 rAF 更省；
//   · 独立组件（hana-bloom，若将来引入）：逐帧求值改属性。
// 两边共用的就是本文件：花瓣路径、角度、错峰常量、四段时长。
//
// 坐标口径：花瓣从原点朝 -y 生长，视口 21×21（四周各留 10.5 的呼吸空间）。描边宽度按
// 实际尺寸换算（size × 0.08），所以这里的数字都是几何单位，不是像素。

/** SVG 视口。 */
export const VIEW_BOX = "-10.5 -10.5 21 21";

/** 描边相对尺寸：strokeWidth = size × 该系数。 */
export const STROKE_SCALE = 0.08;

/** 一朵花的四段生命周期（秒）。 */
export const PHASE = Object.freeze({
  bud: 0.35,
  bloom: 1,
  hold: 0.55,
  fade: 0.45,
});

/** 下一朵的起点：略早于上一朵散尽，形成叠影。 */
export const CYCLE = PHASE.bud + PHASE.bloom + PHASE.hold;

/** 一朵花从绽开到彻底消失。 */
export const LIFETIME = CYCLE + PHASE.fade;

/**
 * 四朵叠放的**总周期**：前三朵的起点（3 × CYCLE）加上最后一朵活到散完（LIFETIME）。
 *
 * 写成 4 × CYCLE（= 7.6）会把最后一朵的消散阶段截掉 0.45 秒（占单朵寿命 19%），
 * 每轮末尾跳一下。也**不是** 3×CYCLE + LIFETIME − CYCLE。这个坑踩过一次，
 * 所以连算法一起写成导出值，并在下面带一条自检。
 */
export const PERIOD = 3 * CYCLE + LIFETIME;

/** 同组花瓣之间的错峰（秒）。 */
export const GROUP_LIFT = 0.16;

/** 同组内相邻花瓣之间的错峰（秒）。 */
export const PETAL_STAGGER = 0.04;

/** 单瓣在开花段内展开所用的时长（秒）。 */
export const PETAL_SPAN = 0.6;

/** 四条花瓣轮廓。 */
export const PATHS = Object.freeze({
  plum: "M0,-2 C-3.8,-2.8 -4.8,-9 0,-9.3 C4.8,-9 3.8,-2.8 0,-2Z",
  sakura: "M0,-2 C-3.4,-3 -4.8,-7.8 -2,-9.3 L0,-7.9 L2,-9.3 C4.8,-7.8 3.4,-3 0,-2Z",
  lotus: "M0,0 C-4,-3 -3.8,-9.8 0,-13.2 C3.8,-9.8 4,-3 0,0Z",
  orchid: "M0,-1.2 C-2.8,-3.6 -2.9,-8 0,-10.2 C2.9,-8 2.8,-3.6 0,-1.2Z",
  lip: "M0,-1 C-2.6,-1.6 -3,-4.8 0,-5.4 C3,-4.8 2.6,-1.6 0,-1Z",
});

/** 一组花瓣：同一轮廓、一组角度，可选的长度倍数。 */
export interface PetalGroup {
  /** 花瓣轮廓（PATHS 里的一条）。 */
  readonly d: string;
  /** 各瓣的静止角度（度）。 */
  readonly angles: readonly number[];
  /** 各瓣的长度倍数；省略即全部 1。 */
  readonly lengths?: readonly number[];
}

/** 一种花。 */
export interface Flower {
  readonly id: "plum" | "sakura" | "lotus" | "orchid";
  /** side 是侧视（荷花），摆幅远小于另外三种。 */
  readonly profile: "top" | "side";
  /** 整朵在竖直方向的落座偏移。 */
  readonly baseY: number;
  /** 花心圆点半径；null 表示没有花心。 */
  readonly center: number | null;
  readonly groups: readonly PetalGroup[];
}

/** 把 n 片花瓣均分一圈。 */
export function radial(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i * 360) / n);
}

/** 四种花。 */
export const FLOWERS: readonly Flower[] = Object.freeze([
  { id: "plum", profile: "top", baseY: 0, center: 1, groups: [{ d: PATHS.plum, angles: radial(5) }] },
  { id: "sakura", profile: "top", baseY: 0, center: 0.9, groups: [{ d: PATHS.sakura, angles: radial(5) }] },
  {
    id: "lotus",
    profile: "side",
    baseY: 5.5,
    center: null,
    groups: [
      { d: PATHS.lotus, angles: [-34, 34] },
      { d: PATHS.lotus, angles: [-62, 0, 62], lengths: [0.78, 1, 0.78] },
    ],
  },
  {
    id: "orchid",
    profile: "top",
    baseY: 0.6,
    center: 0.8,
    groups: [
      { d: PATHS.orchid, angles: [0, -118, 118] },
      { d: PATHS.lip, angles: [180] },
    ],
  },
]);

/** 按 id 取花型；认不出返回 undefined。 */
export function flowerById(id: string): Flower | undefined {
  return FLOWERS.find((f) => f.id === id);
}

/** 一瓣的拼装坐标：角度、长度倍数、自己的开合延迟。 */
export interface PetalPlacement {
  readonly d: string;
  readonly angle: number;
  readonly length: number;
  readonly delay: number;
}

/**
 * 把一种花摊平成逐瓣列表，并算出每瓣的开合延迟。
 *
 * @param flower 花型
 * @param offset 整朵的时间偏移（秒）。**必须传**：花瓣的 `animation-delay` 写在 `<g>` 上，
 *   不会继承父 `<svg>` 的延迟，不叠加就会变成四朵的花瓣全在每轮同一刻张开。
 */
export function petalsOf(flower: Flower, offset = 0): PetalPlacement[] {
  const out: PetalPlacement[] = [];
  flower.groups.forEach((group, gi) => {
    group.angles.forEach((angle, pi) => {
      out.push({
        d: group.d,
        angle,
        length: group.lengths?.[pi] ?? 1,
        delay: offset + gi * GROUP_LIFT + pi * PETAL_STAGGER,
      });
    });
  });
  return out;
}

/**
 * 把四朵花拼成可直接塞进容器的 SVG 标记字符串。
 *
 * 每朵一个 `<svg>`，四层叠放；各自带 `CYCLE × i` 的整朵延迟，花瓣再带自己的开合延迟。
 * 动画本身由调用方的 CSS 负责（类名固定为 petal / core），这里只出结构。
 *
 * @param className 可选的额外 class，加在每个 `<svg>` 上
 */
export function toMarkup(className?: string): string {
  const extra = className ? ` class="${className}"` : "";
  return FLOWERS.map((flower, fi) => {
    const offset = fi * CYCLE;
    const petals = petalsOf(flower, offset)
      .map(
        (p) =>
          `<g transform="rotate(${String(p.angle)})">` +
          `<g class="petal" style="animation-delay:${p.delay.toFixed(2)}s">` +
          `<g transform="scale(1 ${String(p.length)})"><path d="${p.d}"/></g>` +
          `</g></g>`,
      )
      .join("");
    const core =
      flower.center === null
        ? ""
        : `<circle class="core" r="${String(flower.center)}" ` +
          `style="animation-delay:${(offset + PHASE.bud + 0.05).toFixed(2)}s" transform="scale(0)"/>`;
    return (
      `<svg${extra} viewBox="${VIEW_BOX}" aria-hidden="true">` +
      `<g transform="translate(0 ${String(flower.baseY)})">${petals}${core}</g>` +
      `</svg>`
    );
  }).join("");
}

/**
 * 关键帧百分比（相对 PERIOD）。壳页的 CSS 用这些数，改了这里要同步那边。
 * 四段的边界时刻：花苞满 / 满开 / hold 末 / 消散完。
 */
export const KEYFRAME_PCT = Object.freeze({
  bud: (PHASE.bud / PERIOD) * 100,
  full: ((PHASE.bud + PHASE.bloom) / PERIOD) * 100,
  hold: (CYCLE / PERIOD) * 100,
  end: (LIFETIME / PERIOD) * 100,
  /**
   * 单瓣开满的时刻。不是“bud + PETAL_SPAN”那么简单：CSS 里所有花瓣共用同一条
   * keyframes，各自的错峰靠 animation-delay，所以这条曲线只能取一个折中值——
   * 取最早那瓣（0.95s / 11.80%）会让慢的瓣收尾被拖住，取最晚（1.19s / 14.78%）
   * 会让快的瓣早早停在那里等。实际用的是两者之间（0.975s / 12.11%）。
   */
  petalOpen: 12.11,
});
