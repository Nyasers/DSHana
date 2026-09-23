// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/targets.mts — 打包目标表，以及按目标改写 pnpm-workspace.yaml。
//
// assets 是出包前的 fail-closed 闸：物化完依赖树后逐个断言这些包在树里（缺一个即拒包）。
// 覆盖三族预编译依赖（koffi / node-addon-require-builtin / sharp）与 LibreOffice 转换栈。
//
// 目标集 = 六个 os × cpu 组合：macOS arm64 / macOS x64 / Windows x64 / Windows arm64 /
// Linux x86_64（glibc）/ Linux arm64（glibc），外加通用兜底包。
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
  /** 该目标必须随包的平台资产：物化后逐个断言 `node_modules/<包名>/package.json` 存在，缺一个即拒包。 */
  assets: string[];
}

/** LibreOffice 转换栈的包名根：wrapper 以可选依赖带一组按平台切分的 kit，各自带 os/cpu 门。 */
const LO_KIT = "@deepseek-ai/libreoffice-kit";

/**
 * 一个目标必须随包的 LibreOffice 件：wrapper + 该平台的原生 kit。Linux 没有原生 kit，
 * 那条形态是 `-wasm`（它的 os 门就是 linux），故四个原生形态之外另有一条 wasm 形态。
 */
function libreOfficeAssets(kit: "wasm" | "darwin-arm64" | "darwin-x64" | "win32-x64" | "win32-arm64"): string[] {
  return [LO_KIT, `${LO_KIT}-${kit}`];
}

// 各平台目标：六个 os × cpu 组合都进发布矩阵，CI 按这份表并发出包。
// 注：darwin / linux 的 libvips 单独分包（@img/sharp-libvips-*），Windows 则内联在
// @img/sharp-win32-x64 里、无独立 libvips 包——断言清单按平台实际形态写（实测得出）。
const PLATFORM_TARGETS: TargetSpec[] = [
  { name: "darwin-arm64", os: ["darwin"], cpu: ["arm64"], assets: ["@koromix/koffi-darwin-arm64", "node-addon-require-builtin-darwin-arm64", "@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64", ...libreOfficeAssets("darwin-arm64")] },
  { name: "darwin-x64", os: ["darwin"], cpu: ["x64"], assets: ["@koromix/koffi-darwin-x64", "node-addon-require-builtin-darwin-x64", "@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64", ...libreOfficeAssets("darwin-x64")] },
  { name: "linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"], assets: ["@koromix/koffi-linux-x64", "node-addon-require-builtin-linux-x64-gnu", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", ...libreOfficeAssets("wasm")] },
  { name: "win32-x64", os: ["win32"], cpu: ["x64"], assets: ["@koromix/koffi-win32-x64", "node-addon-require-builtin-win32-x64-msvc", "@img/sharp-win32-x64", ...libreOfficeAssets("win32-x64")] },
  { name: "linux-arm64", os: ["linux"], cpu: ["arm64"], libc: ["glibc"], assets: ["@koromix/koffi-linux-arm64", "node-addon-require-builtin-linux-arm64-gnu", "@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64", ...libreOfficeAssets("wasm")] },
  { name: "win32-arm64", os: ["win32"], cpu: ["arm64"], assets: ["@koromix/koffi-win32-arm64", "node-addon-require-builtin-win32-arm64-msvc", "@img/sharp-win32-arm64", ...libreOfficeAssets("win32-arm64")] },
];

// 通用兜底包：os × cpu 全叉乘。命名与平台包同源（无目标后缀），覆盖面比上面六个更宽，
// 代价是体量更大。断言清单要盖住它声明的全部 os×cpu，所以各平台目标的资产都在内（缺哪个
// 资产就该当场拒包，而不是静默通过）。去重：跨目标重复的条目在这里只留一份（wrapper 每个
// 目标都点，wasm 那条两个 linux 目标都点）。
const UNIVERSAL_TARGET: TargetSpec = {
  name: "universal",
  os: ["win32", "darwin", "linux"],
  cpu: ["x64", "arm64"],
  assets: [...new Set(PLATFORM_TARGETS.flatMap((t) => t.assets))],
};

/** 目标名 → 目标描述（未知名返回 null）。 */
export function targetSpec(name: string): TargetSpec | null {
  if (name === "universal") return UNIVERSAL_TARGET;
  return PLATFORM_TARGETS.find((t) => t.name === name) || null;
}

/** 支持的目标名全集（用法提示与校验共用）。 */
export function supportedTargetNames() {
  return ["universal", ...PLATFORM_TARGETS.map((t) => t.name)];
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
