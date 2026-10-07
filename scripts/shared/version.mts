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
// 位置先划一半：packages/dsh/ 下住的是 **DSH 侧的包**（宿侧源码域住在 packages/ 的其余目录），
// 形态再由包自己那份描述文件说：子插件（一行）带 cordis.config.mjs，组合层（一层）带 dsh.bundle。
// 两者都不是的目录直接抛（位置给了归属，描述给不出形态就是放错了）。子插件另要依赖方向成立：
// @dshana/app 必须把这几个 **包名** 写进自己的 dependencies（spec §2 的 app → 子插件那条边），
// 静默漏构建。组合层包（packages/dsh/app）不经这里构建，版本同步另见 bundlePkgPaths()。
export function cordisPkgDirs() {
  const declared = new Set(Object.keys(readPkg("packages/app/package.json")?.dependencies ?? {}));
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, "packages", "dsh"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = `packages/dsh/${entry.name}`;
    const isPlugin = fs.existsSync(path.join(ROOT, dir, "cordis.config.mjs"));
    if (!isPlugin) {
      if (readPkg(`${dir}/package.json`)?.dsh?.bundle) continue; // 组合层：形态是 bundle，不经这里构建
      throw new Error(`${dir} 在 packages/dsh/ 下，但既不是子插件（缺 cordis.config.mjs）也不是组合层（缺 dsh.bundle）`);
    }
    const name = cordisPkgFullName(dir);
    if (!declared.has(name)) {
      throw new Error(`${dir} 是 cordis 子插件（${name}），但 packages/app/package.json 未声明它`);
    }
    dirs.push(dir);
  }
  if (dirs.length === 0) throw new Error("没找到 cordis 子插件包（判据：packages/dsh/*/cordis.config.mjs）");
  return dirs.sort();
}

/**
 * 子插件包名（@dshana/dsh-provider）：取自它自己的 package.json，形状必须是 @dshana/dsh-*。
 * 交付树里的目录名取 cordisPkgName()（去 scope 的那段）：DSH 按**包名**解析安装树，两者必须对得上。
 */
export function cordisPkgFullName(dir: string) {
  const name = readPkg(`${dir}/package.json`)?.name;
  if (typeof name !== "string" || !/^@dshana\/dsh-[a-z0-9-]+$/.test(name)) {
    throw new Error(`${dir}/package.json 的 name 不是 @dshana/dsh-* 包名：${name}`);
  }
  return name;
}

/** 子插件在 .cache/cordis 与安装树里的目录名（包名去 scope：@dshana/dsh-provider → dsh-provider）。 */
export function cordisPkgName(dir: string) {
  return cordisPkgFullName(dir).slice("@dshana/".length);
}

/** 上面那批包各自的 package.json（版本同步的写回目标）。 */
export function cordisPkgPaths() {
  return cordisPkgDirs().map((dir) => `${dir}/package.json`);
}

// 组合层包（packages/dsh/app）：它不是 cordis 子插件（没有自持构建描述、也不进 .cache/cordis），
// 但同样是随包发布、随主版本同步的包，所以版本写回单列一条——漏了它不会报错，只会静默落后一版。
export function bundlePkgPaths() {
  return ["packages/dsh/app/package.json"];
}

// 派生同步目标（随主版本同步的文件）：manifest.json（仓库根，App 契约）+ cordis 包 + 组合层包
//（不含主 package.json——主是事实源，由 bump 阶段改；这里指"跟随"它的文件）
export function derivedVersionTargets() {
  return ["manifest.json", ...cordisPkgPaths(), ...bundlePkgPaths()];
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
 * 交付面的运行时依赖：内核声明（host 的 dependencies） ∪ 组合层包的 dependencies，
 * 两者都剔除 workspace 在仓项。
 *
 * 为什么是并集：树 = **内核闭包 ∪ 组合层闭包**。内核（@deepseek-ai/dsh）的闭包给 boot 机制
 * 与共享底座；组合层包（packages/dsh/app）的依赖才是那 121 个表层插件包——它们以前是
 * 随官方 web-app 自己进来的（官方那份声明了同样一批），现在那一层归我们，就得由这里说。
 * 同名依赖必须同规格（通常是内核 pin 的版本），不同就当场拒——两个写手写同一个事实是漏的温床。
 * 仓内包（@dshana/*）在构建期被 rspack 内联进各自 bundle，安装树里没有对应物，也解析不了
 * workspace 协议；交付面只列能物化的 registry 依赖（组合层包的 @dshana/* 由 pack 落位）。
 */
export function shipDependencies() {
  const deps = readHostPkg()?.dependencies ?? {};
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === "string" && spec.startsWith("workspace:")) continue;
    out[name] = spec as string;
  }
  const bundlePkg = readPkg("packages/dsh/app/package.json");
  for (const [name, spec] of Object.entries(bundlePkg?.dependencies ?? {})) {
    if (typeof spec !== "string" || spec.startsWith("workspace:")) continue;
    const existing = out[name];
    if (existing !== undefined && existing !== spec) {
      throw new Error(
        `交付面依赖规格冲突：${name} 在内核声明里是 ${existing}，在组合层包里是 ${spec}（两处必须同规格）`,
      );
    }
    out[name] = spec;
  }
  return out;
}
