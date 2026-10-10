// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/targets.mts — 打包目标矩阵，以及按目标改写 pnpm-workspace.yaml。
//
// 目标是一棵 os → cpu 的两层树，名字就是路径：
//   universal        整棵树（os × cpu 全叉乘，一份覆盖所有部署）
//   win32            t.win32（该 os 的 cpu 全收，双架构包）
//   win32-x64        t.win32.x64（单个叶子，平台包）
// 三种粒度是同一份矩阵的三个投影——加一个 cpu 只多一个叶子，双架构包与通用包自动跟上，不会出现
// 「平台包加了、兜底包忘了」这种漂移。取前缀即取组合，不另立一套命名规则。
//
// 随包的平台资产**不在这里**：那是「这一条链上哪些包按平台切分」的问题，由 assets.mts 从物化后的
// 锁文件派生。这份文件只管「有哪些目标」以及每个目标的 os/cpu/libc。
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../../shared/root.mts";
import { prepareStubs } from "./exclude.mts";

/**
 * 打包目标描述。libc 仅 linux 目标声明（用于 supportedArchitectures.libc）；显式给出形状，
 * 否则数组字面量会推成"部分成员含 libc"的联合，访问 s.libc 报 TS2339。
 */
export interface TargetSpec {
  name: string;
  os: string[];
  cpu: string[];
  libc?: string[];
}

/** 叶子上的额外约束：当前只有 linux 的 libc 维度。 */
interface LeafSpec {
  libc?: string[];
}

/**
 * 目标矩阵 os → cpu → 叶子约束。哪些 os/cpu 进发布在这里表达，加一个平台只改这一处。
 * 注：darwin / linux 的 libvips 单独分包（@img/sharp-libvips-*），Windows 则内联在
 * @img/sharp-win32-x64 里、无独立 libvips 包——那是包自己的形态，与目标表无关（资产由锁派生）。
 */
const MATRIX: Record<string, Record<string, LeafSpec>> = {
  win32: { x64: {}, arm64: {} },
  darwin: { x64: {}, arm64: {} },
  linux: { x64: { libc: ["glibc"] }, arm64: { libc: ["glibc"] } },
};

const ALL_OSES = Object.keys(MATRIX);
const ALL_CPUS = [...new Set(ALL_OSES.flatMap((os) => Object.keys(MATRIX[os])))];
const ALL_LIBC = [...new Set(ALL_OSES.flatMap((os) => Object.values(MATRIX[os]).flatMap((l) => l.libc ?? [])))];

/** 一个叶子：`<os>-<cpu>`。 */
function leafSpec(os: string, cpu: string): TargetSpec {
  const leaf = MATRIX[os][cpu];
  return { name: `${os}-${cpu}`, os: [os], cpu: [cpu], ...(leaf.libc ? { libc: leaf.libc } : {}) };
}

/** 一个 os 行：该 os 的 cpu 全收。命名就用 os 本身——没有架构后缀即「两个架构都在」。 */
function rowSpec(os: string): TargetSpec {
  const libc = [...new Set(Object.values(MATRIX[os]).flatMap((l) => l.libc ?? []))];
  return { name: os, os: [os], cpu: Object.keys(MATRIX[os]), ...(libc.length > 0 ? { libc } : {}) };
}

/** 整棵树：os × cpu 全叉乘，一份覆盖所有部署。 */
const UNIVERSAL_TARGET: TargetSpec = {
  name: "universal",
  os: ALL_OSES,
  cpu: ALL_CPUS,
  ...(ALL_LIBC.length > 0 ? { libc: ALL_LIBC } : {}),
};

/** 平台包（叶子）全集。 */
export function platformTargets(): TargetSpec[] {
  return ALL_OSES.flatMap((os) => Object.keys(MATRIX[os]).map((cpu) => leafSpec(os, cpu)));
}

/** 双架构包（行）全集。 */
export function dualArchTargets(): TargetSpec[] {
  return ALL_OSES.map((os) => rowSpec(os));
}

/**
 * 目标名 → 目标描述（未知名返回 null）。名字按 `-` 切成路径段，逐段走矩阵：
 * 零段（`universal`）取整棵树、一段（`win32`）取一行、两段（`win32-x64`）取一个叶子。
 */
export function targetSpec(name: string): TargetSpec | null {
  if (name === "universal") return UNIVERSAL_TARGET;
  const segs = name.split("-");
  const os = segs[0];
  if (!Object.prototype.hasOwnProperty.call(MATRIX, os)) return null;
  if (segs.length === 1) return rowSpec(os);
  if (segs.length === 2 && Object.prototype.hasOwnProperty.call(MATRIX[os], segs[1])) return leafSpec(os, segs[1]);
  return null;
}

/** 平台目标名（叶子；发布矩阵按它对齐，双架构包与通用包不进 CI 矩阵）。 */
export function platformTargetNames(): string[] {
  return platformTargets().map((t) => t.name);
}

/** 支持的目标名全集（用法提示与校验共用）：整棵树、每行、每个叶子。 */
export function supportedTargetNames(): string[] {
  return ["universal", ...ALL_OSES, ...platformTargetNames()];
}

// 仓库 pnpm-workspace.yaml 中的 supportedArchitectures 由本脚本按目标替换（标记块内）
const PT_START = "# >>> pack-targets";
const PT_END = "# <<< pack-targets";

/** 生成该目标的 pnpm-workspace.yaml（只替换标记块内的 supportedArchitectures）。
 * 源是**仓库根**那份：工位只留服务出包的那部分配置（allowBuilds / 平台块），`packages` 这些
 * 工作区字段随文件带过去也不生效（工位里没有 packages/），不必另维护第二份名单。 */
export function stagingWorkspaceYaml(spec: TargetSpec): string {
  const repoWs = fs.readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = [
    "supportedArchitectures:",
    "  os:",
    ...spec.os.map((v) => `    - ${v}`),
    "  cpu:",
    ...spec.cpu.map((v) => `    - ${v}`),
    ...(spec.libc ? ["  libc:", ...spec.libc.map((v) => `    - ${v}`)] : []),
    "",
  ].join("\n");
  const i = repoWs.indexOf(PT_START);
  const j = repoWs.indexOf(PT_END);
  const body = i >= 0 && j > i
    ? repoWs.slice(0, i + PT_START.length) + "\n" + block + repoWs.slice(j)
    : repoWs + "\n" + block;
  // nodeLinker 必须在工作区文件里（CLI 传参形式实测不生效）
  const base = "# scripts/release/pack/index.mts 生成（每次打包重建，勿手改）\nnodeLinker: hoisted\n\n" + body;
  // 不要的表层 bundle：override 成 stub（见 exclude.mts），真件不下载、不进闭包。
  // 必须**并进已有的 overrides 块**（仓库根那份里有 @hana/* 的本地 tgz 映射，整份被带过来）：
  // 另起一个 `overrides:` 是重复键，pnpm 直接以 "duplicated mapping key" 拒掉。
  const { overrides } = prepareStubs();
  const names = Object.keys(overrides).sort();
  const lines = names.map((n) => `  "${n}": "${overrides[n]}"`).join("\n");
  const existing = /^overrides:\s*$/mu;
  if (existing.test(base)) return base.replace(existing, (key) => `${key}\n${lines}`);
  return base + `\noverrides:\n${lines}\n`;
}

/**
 * 目标选择：`--target <名字>` / `--target=<名字>`（必须显式给，无默认）。
 * 未指定 / 不支持的目标 / 解析失败三种情况一律 failUsage：打印支持目标列表并退出码 2。
 * 多目标由 CI 并行矩阵各自跑一次，或本地逐个跑 `pnpm run package:<os>[:<cpu>]`；不支持 `all`。
 */
export function failUsage(detail: string): never {
  console.error(`[pack] ${detail}`);
  console.error("[pack] 支持的目标：");
  for (const n of supportedTargetNames()) {
    const s = targetSpec(n);
    // supportedTargetNames() 由同一张矩阵派生，理论上必能解析；此守卫只为收窄类型
    if (!s) continue;
    console.error(`  ${n.padEnd(14)} os=[${s.os.join(",")}] cpu=[${s.cpu.join(",")}]${s.libc ? " libc=[" + s.libc.join(",") + "]" : ""}`);
  }
  console.error("[pack] 用法：node scripts/release/pack/index.mts --target <名字>（或 pnpm run package --target=<名字>）");
  process.exit(2);
}
