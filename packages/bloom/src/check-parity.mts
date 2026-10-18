// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/bloom/src/check-parity.mts — 校验独立包 hana-bloom 与本包的时间参数一致。
//
// 为什么需要这道闸：这套花有两份实现，一份在这里（壳页 + DSH 启动页用），一份在独立的
// hana-bloom 包里（可移植的 React 组件）。它们**不能共用代码**——独立包不该依赖 App 的
// workspace 包，否则拷到别处就坏；App 也不该依赖一个外部 npm 包。所以只能共守参数。
//
// 参数一漂，两处的观感就差开：周期改了但延迟没改，四朵会挤在一起；阶段改了但关键帧
// 没改，花瓣与整朵的动作就不同步。这类问题在截图上看不出来，只能靠比对数值。
//
// 用法：node packages/bloom/src/check-parity.mts [hana-bloom 的路径]
// 默认找 HANA_BLOOM_PATH 环境变量，再退到同盘的 workspace/hana-bloom。

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// 仅为加载 Node 版本断言（本入口以 TypeScript 直跑，依赖原生类型剥离；仓库纪律：每个 CLI 入口都得触达它）
import { ROOT } from "../../../scripts/shared/root.mts";
import { CYCLE, LIFETIME, PERIOD, PHASE, GROUP_LIFT, PETAL_STAGGER } from "./geometry.ts";

/** 本包应当与之保持一致的那些数。 */
const EXPECTED = {
  bud: PHASE.bud,
  bloom: PHASE.bloom,
  hold: PHASE.hold,
  fade: PHASE.fade,
  cycle: CYCLE,
  lifetime: LIFETIME,
  // 独立包按序列无限轮换（posesAt 叠不出第四朵被截），没有“四朵总周期”这个概念；
  // 这一项是壳页 CSS 专有的，不参与比对。
  period: PERIOD,
  groupLift: GROUP_LIFT,
  petalStagger: PETAL_STAGGER,
};

/** 从独立包的源码里抠出这些数（它是零依赖的单文件，读文本即可）。 */
function readIndependent(path: string): Record<string, number> | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const num = (re: RegExp): number | null => {
    const m = re.exec(text);
    return m ? Number.parseFloat(m[1]!) : null;
  };
  // PHASE 对象里的四个值
  const phase = /PHASE = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(text);
  if (!phase) return null;
  const field = (name: string): number | null => {
    const m = new RegExp(`${name}\\s*:\\s*([0-9.]+)`).exec(phase[1]!);
    return m ? Number.parseFloat(m[1]!) : null;
  };
  const bud = field("bud");
  const bloom = field("bloom");
  const hold = field("hold");
  const fade = field("fade");
  const groupLift = num(/GROUP_LIFT\s*=\s*([0-9.]+)/);
  const petalStagger = num(/PETAL_STAGGER\s*=\s*([0-9.]+)/);
  if (bud === null || bloom === null || hold === null || fade === null) return null;
  if (groupLift === null || petalStagger === null) return null;
  const cycle = bud + bloom + hold;
  return {
    bud, bloom, hold, fade,
    cycle,
    lifetime: cycle + fade,
    // 独立包按序列无限轮换，没有“四朵总周期”这个概念；这一项不参与比对。
    period: Number.NaN,
    groupLift,
    petalStagger,
  };
}

const candidates = [
  process.env.HANA_BLOOM_PATH,
  // 默认位置：与 dshana 仓库同级的兄弟目录（两个工程并行开发时的常见布局）。
  resolve(join(ROOT, "..", "hana-bloom", "hana-bloom.js")),
  "H:/workspace/hana-bloom/hana-bloom.js",
].filter((p): p is string => typeof p === "string" && p !== "");

let found: { path: string; values: Record<string, number> } | null = null;
for (const p of candidates) {
  const values = readIndependent(p);
  if (values !== null) {
    found = { path: p, values };
    break;
  }
}

if (found === null) {
  console.log("[bloom-parity] 跳过：找不到 hana-bloom.js（设 HANA_BLOOM_PATH 可指定）");
  process.exit(0);
}

/** 浮点比对：差值小于 1e-9 视为相同。 */
const same = (a: number, b: number): boolean =>
  Number.isNaN(a) && Number.isNaN(b) ? true : Math.abs(a - b) < 1e-9;

const problems: string[] = [];
/** 只在本包成立、独立包没有对应概念的项。 */
const MINE_ONLY = new Set(["period"]);
for (const [key, mine] of Object.entries(EXPECTED)) {
  if (MINE_ONLY.has(key)) continue;
  const theirs = found.values[key];
  if (theirs === undefined || same(mine, theirs)) continue;
  problems.push(`  ${key}: 本包 ${String(mine)} vs 独立包 ${String(theirs)}`);
}

if (problems.length > 0) {
  console.error(
    `[bloom-parity] 两处实现的时间参数已经漂开（${found.path}）：\n${problems.join("\n")}\n` +
      "这套花有两份实现，代码不共用，只靠参数一致。改一处必须同步另一处。",
  );
  process.exit(1);
}

console.log(`[bloom-parity] 参数一致（${found.path}）`);
