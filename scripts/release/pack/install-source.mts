// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/install-source.mts — 物化工位的安装输入（由 T2 的包集清单派生）。
//
// 换源的意义：出包不再从 registry 取 @deepseek-ai/dsh 成品包，而以 T1 编出的包集为源、以 T2 的
// 清单为准。清单给出每个包的 name/version/file/bytes/sha512，这里据此生成工位里那份「可审的
// 安装输入」：
//
//   <projectDir>/package.json         根 = @deepseek-ai/dsh（A 口径，见 spec §6.4.2：不换根）
//   <projectDir>/packages/*.tgz       包集 tarball（从 T1 缓存拷入）
//   <projectDir>/pnpm-workspace.yaml  overrides: 每个包名 -> file:./packages/<file>
//
// 为什么根是 @deepseek-ai/dsh 而不是清单里的 roots（两者语义不同，别混）：
//   · 清单 roots = 产品**意图加载**的集合（web 模板 ∪ OPTIONAL_BUNDLES ∪ @dshana），供根集闸用；
//   · 安装根 = 我们**从谁那儿装** = @deepseek-ai/dsh 自己的声明（A 口径），是 roots 的超集。
//     装它等于「不换根」：T2.2 实测换根只值 0.6% 体积，却要接手一份从编译产物扫出来的壳声明。
//
// 为什么用 file: **相对**路径：pnpm 的 allowBuilds 键是 name@spec 形状，绝对路径拼不出稳定键；
// 而且相对路径让六个目标共用同一份锁文件（各目标工位布局一致）。
//
// 两道 sha512 校验（都是代码，不是口头，但**只在同源时逐字节**：`release:pack` 的字节不可跨机
// 复现，见 scripts/shared/package-set-digest.mts）：
//   · 前：拷进工位的 tarball 逐个比对清单的 bytes/sha512（少一个字节就拒装；不同源则只校在不在）；
//   · 后：pnpm 记进锁文件的 file: 条目 integrity 与清单比对，且装出来的 @deepseek-ai/* 版本
//         必须与清单一致（对不上就拒包）。
import fs from "node:fs";
import path from "node:path";

import { cacheEntryDir, integrityOfFile, readBuildRecipe } from "../package-set.mts";
import { isSameOriginAsSet } from "../../shared/package-set-digest.mts";
import { readPnpmDeclaration } from "../pnpm.mts";
import type { DshPackageSet, PackageRecord } from "../package-set.mts";

/** 工位里放包集 tarball 的子目录名（锁文件里的 file: 路径依赖它，改名要重出锁文件）。 */
export const PACKAGE_DIR = "packages";

/** 安装根的包名：A 口径，不换根（见文件头与 spec §6.4.2）。 */
export const INSTALL_ROOT = "@deepseek-ai/dsh";

/**
 * 工位里那份派生出来的 package.json 的形状。
 *
 * `packageManager` 是**必须**的，不是可选装饰：pnpm 解析「该用哪个版本」时从目标目录向上找最近的
 * package.json，**找到了就停**（没有才继续向上）。工位清单缺这个字段时，解析就落到 PATH 上那份
 * ——实测同一台机器、同一条命令：工位有声明 → 12.8.2，无声明 → 11.24.0。而工位恰恰是用
 * `--dir` 指过去的那个目录，于是「交付链用哪个 pnpm」又由跑包的机器决定，正是要堵的洞。
 */
export interface StagingManifest {
  name: string;
  version: string;
  private: boolean;
  type: string;
  /** pnpm 声明（原样照抄本仓 packageManager 的**交付链**那一份）。 */
  packageManager: string;
  dependencies: Record<string, string>;
}

/** 包集 tarball 在工位里的相对 spec（锁文件与 workspace overrides 共用同一形状）。 */
export function tarballSpec(record: PackageRecord): string {
  return "file:./" + PACKAGE_DIR + "/" + record.file;
}

/**
 * 校验清单与 T1 缓存里的 tarball 逐字节一致（物化**前**的校）。
 *
 * 为什么值得在拷贝前做一次：清单是声明，磁盘是事实。清单可以自洽却指向被换过的字节（换包集、
 * 半成品残留、手工替换），而物化一旦装上坏字节，后面的断言只会看到「包在、版本对」，察觉不到。
 *
 * @param set - 落盘清单。
 * @returns 每个包的校验记录（清单里的 file/bytes/integrity 与实算值）。
 * @throws 缺文件、字节数不符、sha512 不符时点名抛出。
 */
export function verifyTarballs(set: DshPackageSet): Array<{ record: PackageRecord; absolute: string }> {
  const entryDir = cacheEntryDir(set.build.cacheKey);
  const distDir = path.join(entryDir, "dist-npm");
  if (!fs.existsSync(distDir)) {
    throw new Error("包集目录不存在：" + distDir + "（先跑 node scripts/vendor/build.mts）");
  }
  // 字节对拍只在同源时做：release:pack 的 tarball 字节不可跨机复现（win32 CRLF 对 linux LF +
  // gzip mtime），清单里那些字节只对"造它那次构建"成立。不同源时只校"在不在"——结构与身份
  // 另有各自的闸。
  let sameOrigin = false;
  try {
    sameOrigin = isSameOriginAsSet(set.packages, readBuildRecipe(set.build.cacheKey));
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    console.log("[pack] 包集与清单不同源（字节不可跨机复现）——只校 tarball 在不在，不逐字节比");
  }
  const out: Array<{ record: PackageRecord; absolute: string }> = [];
  for (const record of set.packages) {
    const absolute = path.join(distDir, record.file);
    if (!fs.existsSync(absolute)) {
      throw new Error("清单记录了但包集里没有：" + record.file + "（缓存条目被换过？）");
    }
    if (sameOrigin) {
      const actual = integrityOfFile(absolute);
      if (actual.bytes !== record.bytes) {
        throw new Error(record.file + " 字节数不符：清单 " + record.bytes + " ≠ 实际 " + actual.bytes);
      }
      if (actual.integrity !== record.integrity) {
        throw new Error(record.file + " sha512 不符：清单 " + record.integrity + " ≠ 实际 " + actual.integrity);
      }
    }
    out.push({ record, absolute });
  }
  return out;
}

/**
 * 物化**后**的校：包集里的包若出现在树中，版本必须与清单一致；且清单里的包不得缺位。
 *
 * 为什么不能只看「包在不在」：物化是 pnpm 跑的，override 一旦漏了某个包名，pnpm 会**悄悄从
 * registry 取同版成品**——树看起来是齐的、版本也对，但源已经不是我们的包集了。
 *
 * 为什么不能要求「树里每个 @deepseek-ai/* 都在清单里」：清单只覆盖我们自己编的 318 个包，
 * 而 @deepseek-ai/cordis、@deepseek-ai/schemastery、@deepseek-ai/libreoffice-kit 一族**从来
 * 就是 registry 包**（上游把它们发在外面，不在构建产物里）。那些「清单外的 @deepseek-ai/*」
 * 是合法的三方依赖，不能当违规。
 *
 * 因此两条断言：
 *   ① 树里每个「清单内」包的版本必须等于清单版本；
 *   ② 清单里的包不得**缺位**——但只对生产闭包内的包要求（测试工具包不在闭包里，本就不该在）。
 *
 * @param modules - 装出来的 node_modules。
 * @param set - 落盘清单。
 * @returns 校验过的包数。
 * @throws 版本不一致或清单内包缺位时。
 */
export function verifyMaterializedModules(modules: string, set: DshPackageSet): number {
  const expected = new Map(set.packages.map((p) => [p.name, p.version]));
  const scopeDir = path.join(modules, "@deepseek-ai");
  if (!fs.existsSync(scopeDir)) throw new Error("物化树里没有 @deepseek-ai/ 作用域：" + scopeDir);
  const installed = new Map<string, string>();
  for (const entry of fs.readdirSync(scopeDir)) {
    const manifestPath = path.join(scopeDir, entry, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: unknown };
    installed.set("@deepseek-ai/" + entry, typeof manifest.version === "string" ? manifest.version : "");
  }
  // 只校「装出来的那些」：清单是**可发布的全部 318 个**，其中测试工具包（…-testkit）不在生产
  // 闭包里，本来就不该出现。所以不能要求 318 个都在，只能逐个校已知包。
  // "源是不是我们的包集"由 frozen 安装 + 锁文件的 file: 解析保证（这里再校版本，挡住 override
  // 被删掉后又从 registry 取同版成品那条路）。
  let checked = 0;
  const extra: string[] = [];
  for (const [name, got] of installed) {
    const want = expected.get(name);
    if (want === undefined) { extra.push(name); continue; }
    if (got !== want) {
      throw new Error("物化树里 " + name + " 版本 " + got + " ≠ 清单 " + want + "（源不是我们的包集？）");
    }
    checked += 1;
  }
  if (extra.length) {
    console.log("[pack] 清单外 @deepseek-ai/* " + extra.length + " 个（registry 三方包，非包集）：" + extra.sort().join(", "));
  }
  return checked;
}
/**
 * 生成工位：拷包集 tarball + 写派生的 package.json 与 overrides。
 *
 * overrides 覆盖清单里的**每一个**包（不只是根）：漏一个，pnpm 就会为它去 registry 取同版成品，
 * 于是「换源」只换了一半。根包也走 override——它的 file: 指向包集里的 tarball，声明照原样生效。
 *
 * @param projectDir - 工位目录（会被重建）。
 * @param set - 落盘清单。
 * @param workspaceYaml - 该目标的 pnpm 配置（allowBuilds + supportedArchitectures）。
 * @returns 派生出来的 manifest 与拷贝的包数。
 */
export function prepareInstallSource(
  projectDir: string,
  set: DshPackageSet,
  workspaceYaml: string,
): { manifest: StagingManifest; packages: number } {
  const verified = verifyTarballs(set);
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectDir, PACKAGE_DIR), { recursive: true });

  const rootRecord = set.packages.find((p) => p.name === INSTALL_ROOT);
  if (!rootRecord) throw new Error("清单里没有安装根 " + INSTALL_ROOT + "：无法确定从谁装");

  // 拷 tarball（用清单里的文件名，保持 file: 路径与锁文件一致）。
  for (const { record, absolute } of verified) {
    fs.copyFileSync(absolute, path.join(projectDir, PACKAGE_DIR, record.file));
  }

  const manifest: StagingManifest = {
    name: "dshana-staging",
    version: set.build.tag.replace(/^dsh-v/u, ""),
    private: true,
    type: "module",
    // 原样带上声明：工位是 pnpm 解析版本的落点（见 StagingManifest 注释）。用**现读**的声明而不是
    // 清单里记的那格：清单可能是在别的声明下派生的，而这里要保证的是「本次运行按当前声明选版本」。
    packageManager: readPnpmDeclaration().raw,
    dependencies: { [INSTALL_ROOT]: tarballSpec(rootRecord) },
  };
  fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(projectDir, "pnpm-workspace.yaml"), withOverrides(workspaceYaml, set), "utf8");
  return { manifest, packages: verified.length };
}

/**
 * 把清单的 overrides 注进工位的 pnpm 配置。
 *
 * 放在这里（而不是 targets.mts）是为了让「包名 -> tarball spec」这条映射只有一个写手：targets.mts
 * 只管平台块，映射的正确性由本模块与清单比对负责。
 *
 * @param workspaceYaml - 该目标的基础配置（allowBuilds + supportedArchitectures）。
 * @param set - 落盘清单。
 * @returns 附了 overrides 段的完整配置。
 */
export function withOverrides(workspaceYaml: string, set: DshPackageSet): string {
  const lines = set.packages
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => "  " + JSON.stringify(p.name) + ": " + JSON.stringify(tarballSpec(p)));
  const body = ["overrides:", ...lines, ""].join("\n");
  return (
    "# 由 scripts/release/pack/install-source.mts 生成（overrides 指向包集 tarball，勿手改）\n" +
    body +
    rewriteAllowBuilds(workspaceYaml, set)
  );
}

/** 清单里每个包名 -> tarball spec（审阅用；工位里由 withOverrides 写进配置）。 */
export function manifestOverrides(set: DshPackageSet): Record<string, string> {
  return Object.fromEntries(set.packages.map((p) => [p.name, tarballSpec(p)]));
}

/**
 * 把 allowBuilds 里指向包集包的键改写成 name@spec 形状。
 *
 * 为什么必须改：pnpm 11.24 起，依赖经 override 落到本地 tarball 时，allowBuilds 的键要带上
 * spec 才认得出来（实测报 [ERR_PNPM_IGNORED_BUILDS] 并点名…@file:packages/<file>.tgz）。
 * 三方依赖（koffi / node-pty / @google/genai / protobufjs）仍走 registry，键保持裸包名。
 *
 * @param workspaceYaml - 基础配置（scripts/release/pack/pnpm-workspace.yaml 的内容）。
 * @param set - 落盘清单。
 * @returns 改写过 allowBuilds 键的配置。
 */
export function rewriteAllowBuilds(workspaceYaml: string, set: DshPackageSet): string {
  const specByName = new Map(set.packages.map((p) => [p.name, tarballSpec(p)]));
  const out: string[] = [];
  let inAllowBuilds = false;
  for (const line of workspaceYaml.split("\n")) {
    if (/^allowBuilds:\s*$/.test(line)) { inAllowBuilds = true; out.push(line); continue; }
    if (inAllowBuilds && /^[A-Za-z_]/.test(line)) inAllowBuilds = false;
    if (!inAllowBuilds) { out.push(line); continue; }
    // 行形如: 两空格 + 引号包名 + : + 值
    const m = /^(\s+)(["\u0027]?)([^"\u0027:\s]+)\2:(.*)$/.exec(line);
    if (m === null) { out.push(line); continue; }
    const spec = specByName.get(m[3]);
    if (spec === undefined) { out.push(line); continue; }
    // pnpm 把 file:./x 归一成 file:x 用于 allowBuilds 键（与锁文件 importer 里的版本串同形）。
    out.push(m[1] + JSON.stringify(m[3] + "@" + spec.replace("file:./", "file:")) + ":" + m[4]);
  }
  return out.join("\n");
}

/**
 * 物化**前**的二次校（第一次在 verifyTarballs）：把工位那份锁文件里记录的 file: 条目
 * integrity 与清单的 sha512 对拍。
 *
 * 为什么这条不能省：verifyTarballs 证明「拷进工位的字节 == 清单」，而这条证明「pnpm 实际
 * 消费并装出来的那份字节 == 清单」——锁文件是 pnpm 自己算的摘要，不是我们写进去的。两者
 * 都过，才算「物化前后各用自己的清单 sha512 校过」。
 *
 * @param lockfileText - 工位里的 pnpm-lock.yaml 内容。
 * @param set - 落盘清单。
 * @returns 对拍成功的包数。
 * @throws 有本地 tarball 未进锁文件、或其 integrity 与清单不符时。
 */
export function verifyLockfileIntegrity(lockfileText: string, set: DshPackageSet): number {
  // 锁文件里本地 tarball 的记法：resolution: {integrity: sha512-…, tarball: file:packages/<file>}
  const recorded = new Map<string, string>();
  for (const line of lockfileText.split("\n")) {
    const m = /resolution: \{integrity: (sha512-[^,}]+), tarball: (file:[^}]+)\}/.exec(line);
    if (m === null) continue;
    const file = m[2].trim().replace(/^file:\.\//, "").replace(/^file:/, "");
    if (file.startsWith(PACKAGE_DIR + "/")) recorded.set(file.slice(PACKAGE_DIR.length + 1), m[1]);
  }
  let checked = 0;
  for (const record of set.packages) {
    const got = recorded.get(record.file);
    if (got === undefined) {
      // 不在生产闭包里的包（测试工具包等）本来就不会进锁文件，跳过不算失败。
      continue;
    }
    if (got !== record.integrity) {
      throw new Error("锁文件记录的 " + record.file + " integrity 与清单不符：锁 " + got + " ≠ 清单 " + record.integrity);
    }
    checked += 1;
  }
  if (checked === 0) throw new Error("锁文件里没有任何本地 tarball 条目：包集 override 没生效？");
  return checked;
}
