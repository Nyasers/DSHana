// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/shared/version.mts — 版本域共享模块（release/version、derive、changelog 复用）
// 布局原则：跨脚本共享/流程性构件放 scripts/shared/，领域特有随各自域或源码（packages/app/src/cordis）。
// 提供 cordis 子插件包清单（packages/ 下带自持构建描述的包，见 cordisPkgDirs）与派生同步目标
// （manifest + cordis 包）——版本号两个写手各管一段：主号归 `pnpm version`（唯一入口），
// build metadata 段（`+dsh-…`）归 derive 从 host 声明的内核版本派生（见
// scripts/derive/version-metadata.mts；派生同步见 scripts/derive/index.mts，
// git 收口见 scripts/release/version.mts）。
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./root.mts";

export { ROOT };

// cordis 子插件包目录清单（相对 ROOT；随包发布、随主版本同步，不独立发版）。
// 判据是包内有自持构建描述 cordis.config.mjs，而依赖方向由包图声明：@dshana/app 必须把这几个
// 包写进自己的 dependencies（spec §2 的 app → clipboard / provider / theme 那条边），漏声明
// 直接抛——否则它会被静默漏构建。roster patch 是一份 cordis.patch.yml 文件（不是包），不在这里。
export function cordisPkgDirs() {
  const declared = new Set(Object.keys(readPkg("packages/app/package.json")?.dependencies ?? {}));
  const dirs: string[] = [];
  const packagesDir = path.join(ROOT, "packages");
  for (const name of fs.readdirSync(packagesDir)) {
    const dir = `packages/${name}`;
    if (!fs.existsSync(path.join(ROOT, dir, "cordis.config.mjs"))) continue;
    if (!declared.has(`@dshana/${name}`)) {
      throw new Error(`${dir} 是 cordis 子插件，但 packages/app/package.json 未声明 @dshana/${name}`);
    }
    dirs.push(dir);
  }
  if (dirs.length === 0) throw new Error("没找到 cordis 子插件包（判据：packages/*/cordis.config.mjs）");
  return dirs.sort();
}

/** 上面那批包各自的 package.json（版本同步的写回目标）。 */
export function cordisPkgPaths() {
  return cordisPkgDirs().map((dir) => `${dir}/package.json`);
}

// 派生同步目标（随主版本同步的文件）：manifest.json（仓库根，App 契约）+ cordis 包
//（不含主 package.json——主是事实源，由 bump 阶段改；这里指"跟随"它的文件）
export function derivedVersionTargets() {
  return ["manifest.json", ...cordisPkgPaths()];
}

// 版本文件全集（含主 package.json——version-hook 提交范围用：pnpm version 已改主待收口）
export function versionCommitFiles() {
  return ["package.json", ...derivedVersionTargets()];
}

export const readPkg = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
export const writePkg = (p, data) => {
  fs.writeFileSync(path.join(ROOT, p), JSON.stringify(data, null, 2) + "\n", "utf8");
};

// 干净号（去 build metadata）：1.0.0-beta.5+dsh-0.1.5-rc.2 → 1.0.0-beta.5。
// 补丁包版本戳要用它（版本串里不能再嵌一个 "+"），所以与 derive/version-hook 同处一份实现。
export function cleanVersion(version) {
  return String(version).split("+")[0];
}

// 补丁包（集成覆盖产物）版本戳：<上游版本>+dshana-<主干净版本>。
// 形状与主版本互镜：主版本带上游 DSH 版本，补丁包带我们的版本，两侧互相点名。
// 版本段只有一个来源——主 package.json（与 derive/version-hook 同一份实现）；
// 不另设修订号：同一版本里改两次覆盖层应当由发版流程 bump 版本，而不是在这里编计数。
export function patchVersion(upstreamVersion) {
  return `${cleanVersion(upstreamVersion)}+dshana-${cleanVersion(readPkg("package.json").version)}`;
}

// 完整版号：主号（剥掉既有 build 段）+ build metadata 段 `+dsh-<内核 pin>`。
// 这段 metadata 的来源只有一处——packages/host/package.json 的 @deepseek-ai/dsh 声明；pnpm version
// 算号会把 build 段剥掉，所以 bump 时由 version 钩子拼回，平时由 derive 的 version-metadata
// 任务守着（pin 一动版号就跟，不等到下次 bump）。pin 未声明时只剩主号。
export function fullVersion(version, dsh = dshPin()) {
  const base = cleanVersion(version);
  return dsh ? `${base}+dsh-${dsh}` : base;
}

// ---- 内核声明（packages/host/package.json）----
// 内核 @deepseek-ai/dsh 的声明住 host：壳（@dshana/app）不声明内核，声明它的是 @dshana/host。
// 这里是全链唯一的编程入口——派生、vendor 镜像 tag、集成漂移闸的 tag、产物版本串里的 `+dsh-…`
// 都从 dshPin() 取。根 package.json 另留一条同名 devDependencies 供开发侧装那棵树，由 integrations
// 闸守一致。
export const HOST_PKG_REL = "packages/host/package.json";

/** 内核宿主包清单（packages/host/package.json）。 */
export const readHostPkg = () => readPkg(HOST_PKG_REL);

/** 声明的 DSH 版本（未声明返回 null）。 */
export function dshPin() {
  const v = readHostPkg()?.dependencies?.["@deepseek-ai/dsh"];
  return typeof v === "string" && v ? v : null;
}

// ---- 交付面（构建期生成，不进树）----
// 交付树包根那份 package.json 与它的锁文件都由 pack 在工位里现生成（对齐上游 desktop 的
// runtime 树：清单按内核声明写、锁以仓库锁文件为种子重解析），树里没有手写的交付面清单与锁。
// 内核声明住 host（见 dshPin），工位清单的运行时依赖从它派生（见 shipDependencies）。

/**
 * 交付面的运行时依赖：从 host 的 dependencies 派生，剔除 workspace 在仓项。
 * 仓内包（@dshana/*）在构建期被 rspack 内联进各自 bundle，安装树里没有对应物，也解析不了
 * workspace 协议；交付面只列能物化的 registry 依赖。
 */
export function shipDependencies() {
  const deps = readHostPkg()?.dependencies ?? {};
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === "string" && spec.startsWith("workspace:")) continue;
    out[name] = spec as string;
  }
  return out;
}
