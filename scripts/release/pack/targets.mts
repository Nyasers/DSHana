// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/targets.mts — 打包目标表，以及按目标改写 pnpm-workspace.yaml。
//
// 目标集对着**宿主支持矩阵**写，不对着「我们顺带能装出来的东西」写：macOS arm64 / macOS x64 /
// Windows x64 / Linux x86_64（glibc），外加通用兜底包。另有若干不进 CI 主线、只能点名的目标。
import fs from "fs-extra";
import { join } from "node:path";

import { ROOT } from "../../shared/root.mts";

/**
 * 打包目标描述。libc 仅 linux 目标声明（用于 supportedArchitectures.libc）；显式给出形状，
 * 否则数组字面量会推成"部分成员含 libc"的联合，访问 s.libc 报 TS2339。
 */
interface TargetSpec {
  name: string;
  os: string[];
  cpu: string[];
  libc?: string[];
  assets: string[];
}

const HOST_TARGETS: TargetSpec[] = [
  // 注：darwin / linux 的 libvips 单独分包（@img/sharp-libvips-*），Windows 则内联在
  // @img/sharp-win32-x64 里、无独立 libvips 包——断言清单按平台实际形态写（实测得出）。
  { name: "darwin-arm64", os: ["darwin"], cpu: ["arm64"], assets: ["@koromix/koffi-darwin-arm64", "node-addon-require-builtin-darwin-arm64", "@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"] },
  { name: "darwin-x64", os: ["darwin"], cpu: ["x64"], assets: ["@koromix/koffi-darwin-x64", "node-addon-require-builtin-darwin-x64", "@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"] },
  { name: "linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"], assets: ["@koromix/koffi-linux-x64", "node-addon-require-builtin-linux-x64-gnu", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"] },
  { name: "win32-x64", os: ["win32"], cpu: ["x64"], assets: ["@koromix/koffi-win32-x64", "node-addon-require-builtin-win32-x64-msvc", "@img/sharp-win32-x64"] },
];

// 非宿主矩阵、**仅手动编译**的目标（不进 CI 主线）：宿主未承诺这些平台，但预编译资产实测存在，
// 需要时点名出包（`package:<os>:<cpu>` 别名已备）。资产清单同样按实测形态写。
// 注：这些目标不进 `--targets=all`，只能点名；否则 CI 会产出宿主不支持的包。
const EXTRA_TARGETS: TargetSpec[] = [
  { name: "linux-arm64", os: ["linux"], cpu: ["arm64"], libc: ["glibc"], assets: ["@koromix/koffi-linux-arm64", "node-addon-require-builtin-linux-arm64-gnu", "@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"] },
  { name: "win32-arm64", os: ["win32"], cpu: ["arm64"], assets: ["@koromix/koffi-win32-arm64", "node-addon-require-builtin-win32-arm64-msvc", "@img/sharp-win32-arm64"] },
];

// 通用兜底包：os × cpu 全叉乘（比宿主矩阵多出 win32-arm64 / linux-arm64 等）；体量更大，
// 用于兜底（用户在宿主矩阵外也能跑，代价是下载大）。断言清单要盖住它声明的全部 os×cpu，
// 所以 HOST 与 EXTRA 的资产都在内（缺哪个 arm64 资产就该当场拒包，而不是静默通过）。
const UNIVERSAL_TARGET: TargetSpec = {
  name: "universal",
  os: ["win32", "darwin", "linux"],
  cpu: ["x64", "arm64"],
  assets: [...HOST_TARGETS, ...EXTRA_TARGETS].flatMap((t) => t.assets),
};

/** 目标名 → 目标描述（未知名返回 null）。 */
export function targetSpec(name: string): TargetSpec | null {
  if (name === "universal") return UNIVERSAL_TARGET;
  return HOST_TARGETS.find((t) => t.name === name) || EXTRA_TARGETS.find((t) => t.name === name) || null;
}

/** 支持的目标名全集（用法提示与校验共用）。 */
export function supportedTargetNames() {
  return ["universal", ...HOST_TARGETS.map((t) => t.name), ...EXTRA_TARGETS.map((t) => t.name)];
}

// 仓库 pnpm-workspace.yaml 中的 supportedArchitectures 由本脚本按目标替换（标记块内）
const PT_START = "# >>> pack-targets";
const PT_END = "# <<< pack-targets";

/** 生成该目标的 pnpm-workspace.yaml（只替换标记块内的 supportedArchitectures）。
 * 源是**交付面**那份（packaging/pnpm-workspace.yaml）：工位只吃交付面的配置（allowBuilds 等），
 * 与仓库根那份（服务本地开发安装）分开。 */
export function stagingWorkspaceYaml(spec) {
  const repoWs = fs.readFileSync(join(ROOT, "packaging", "pnpm-workspace.yaml"), "utf8");
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
  return "# scripts/release/pack/index.mts 生成（每次打包重建，勿手改）\nnodeLinker: hoisted\n\n" + body;
}

/**
 * 目标选择：`--target <名字>` / `--target=<名字>`（必须显式给，无默认）。
 * 未指定 / 不支持的目标 / 解析失败三种情况一律 failUsage：打印支持目标列表并退出码 2。
 * 多目标由 CI 并行矩阵各自跑一次，或本地逐个跑 `pnpm run package:<os>:<cpu>`；不支持 `all`。
 */
export function failUsage(detail: string): never {
  console.error(`[pack] ${detail}`);
  console.error("[pack] 支持的目标：");
  for (const n of supportedTargetNames()) {
    const s = targetSpec(n);
    // supportedTargetNames() 由同一张目标表派生，理论上必能解析；此守卫只为收窄类型
    if (!s) continue;
    console.error(`  ${n.padEnd(14)} os=[${s.os.join(",")}] cpu=[${s.cpu.join(",")}]${s.libc ? " libc=[" + s.libc.join(",") + "]" : ""}`);
  }
  console.error("[pack] 用法：node scripts/release/pack/index.mts --target <名字>（或 pnpm run package --target=<名字>）");
  process.exit(2);
}
