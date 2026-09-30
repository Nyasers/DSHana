// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pnpm.mts — 交付链（derive 派生锁文件 + pack 物化）的 pnpm 解析、断言与锁文件护栏。
//
// 洞：这两处原先调的是**裸名 pnpm**、cwd 又在仓内，于是版本由「跑包的哪台机器」决定——PATH 上
// 那份 pnpm 读到仓根 `packageManager` 会**自换**到声明的那一份；换个环境（仓外 cwd、别的 PATH、
// 别的机器）就停在别处。构建链把版本钉在检出里并放进缓存键，交付链却是环境决定：**交付树的形状
// 由此随机器漂移**，与「同一 tag + 同一工具链 = 同一份产物」自相矛盾。
//
// 口径（Nyaser 已定）：构建链继续用检出/vendor 里那份（上游 pin）；**交付链统一用本仓
// `packageManager` 声明的那一份**。实现上**不自己拼 pnpm 入口**，走同一套「声明决定版本」的机制：
// cwd 放在**仓内**（.tmp 工位也在仓内），pnpm 自带的版本管理便读到仓根那份声明。
//
// 声明 ≠ 实际，所以三件是硬要求：
//   ① **断言 + 记录**：pnpm 收尾行 `using pnpm vX` 是判据；派生锁文件的 `lockfileVersion` 作交叉
//      校验（版本大改会改锁格式，这里要显式认账而不是随它变）。实际版本另记进包集清单的交付侧
//      那一格（`build.deliveryPnpm`）。
//   ② **受限环境的退路也必须落在声明那一份上**：解析不到、取不到、或跑出来不是那一份，一律
//      **失败说清**，绝不静默换版本——宁可不出包，也不出一个工具链不明的交付树。
//   ③ **锁文件护栏**：交付链绝不能让隐式自换改到仓根 `pnpm-lock.yaml` 或 `packaging/pnpm-lock.yaml`
//      （后者只允许 derive 自己写）。运行前后各取一次哈希，变了即拒。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT } from "../shared/root.mts";

/**
 * 交付链必须保持不动的两份锁文件（相对仓根，正斜杠）。
 *
 * 仓根那份服务本地开发与**构建链**；packaging 那份是 derive 派生的**交付锁**。两者都不该被
 * 「跑一次物化」顺手改掉——历史上正是隐式自换把目标落到了仓根那份。
 */
export const GUARDED_LOCKFILES = ["pnpm-lock.yaml", "packaging/pnpm-lock.yaml"];

/** 交付链 pnpm 输出落盘处：受限沙箱里管道 stdio 会被拒（EPERM），统一走文件。 */
export const DELIVERY_PNPM_LOG_DIR = path.join(ROOT, ".tmp", "pnpm-logs");

/** 声明出来的 pnpm（`package.json#packageManager`）。 */
export interface PnpmDeclaration {
  /** 原样声明（含 `+sha512…` 段）。 */
  raw: string;
  /** 版本段，如 `12.8.2`。 */
  version: string;
  /** 主版本号（锁文件格式按它查表）。 */
  major: number;
}

/**
 * 读本仓的 pnpm 声明。**唯一真源**是仓根 `packageManager`（交付链在本仓里干活）。
 *
 * 只接受 `pnpm@<版本>` 形式：其它包管理器/缺声明都当场报，不猜、不退化到「手边那个版本」。
 * @param rootDir - 仓根（测试可注入）。
 */
export function readPnpmDeclaration(rootDir: string = ROOT): PnpmDeclaration {
  const manifestPath = path.join(rootDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const raw = manifest.packageManager;
  if (typeof raw !== "string" || raw === "") {
    throw new Error("package.json 未声明 packageManager：交付链的 pnpm 版本无从确定（不能拍一个）");
  }
  const matched = /^pnpm@([^+\s]+)/u.exec(raw);
  if (matched === null) {
    throw new Error(`packageManager 不是 pnpm 声明形式（要求 \`pnpm@<版本>\`）：${raw}`);
  }
  const version = matched[1];
  const major = Number(version.split(".")[0]);
  if (!Number.isInteger(major) || major <= 0) {
    throw new Error(`packageManager 的版本段读不出主版本：${raw}`);
  }
  return { raw, version, major };
}

/**
 * 交付链的进程环境：三条环境纪律（与构建链同一套，见 scripts/vendor/build.mts#baseEnv）。
 *
 * 三条各自挡什么：
 *  - `CI=true`：关掉交互式提问与进度花哨输出，让日志可判读。
 *  - `npm_config_verify_deps_before_run=false`：`pnpm run`/`pnpm exec` 默认会先做依赖状态检查、
 *    必要时**隐式补跑一次 install**。交付链自己管安装，不要这种计划外动作。
 *  - `npm_config_manage_package_manager_versions=false`：拦住 pnpm「替换自己」那条路径——
 *    它会把目标版本装进全局/项目目录并重建入口，在受限环境（只读全局目录、无网）里这步会失败。
 *
 * **关键澄清（实测，别按字面误解）**：最后一个变量**不参与**「按声明选版本」这件事，两者不冲突。
 * 选版本发生在更早的一层（pnpm 自己的引导：读 `packageManager`/`packageManagerDependencies` 后
 * 拉起对应那份），该变量是在**已选定**的进程内才被读到的。实测证据：声明一个**未安装**的版本时，
 * 无论该变量为 `false` 还是缺省、无论写成 npm_config_ 还是 pnpm_config_ 前缀，pnpm 都一样去
 * registry 取那一份（报 `No matching version found for pnpm@12.99.99 while fetching it`）。
 * 也就是说：**版本由声明决定；这个变量管不了它**。若哪天要与声明对齐，正确做法是让 `pnpm` 能取到
 * 声明的那份（见 readPnpmDeclaration），而不是靠这个变量。
 */
export function deliveryPnpmEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    CI: "true",
    npm_config_verify_deps_before_run: "false",
    npm_config_manage_package_manager_versions: "false",
  };
}

/** 起一次 pnpm 并把输出落到文件（受限沙箱里管道 stdio 会被拒）。 */
function spawnCaptured(args: string[], options: { label: string; cwd: string; env: NodeJS.ProcessEnv }) {
  fs.mkdirSync(DELIVERY_PNPM_LOG_DIR, { recursive: true });
  const outPath = path.join(DELIVERY_PNPM_LOG_DIR, options.label + ".out");
  const errPath = path.join(DELIVERY_PNPM_LOG_DIR, options.label + ".err");
  const outFd = fs.openSync(outPath, "w");
  const errFd = fs.openSync(errPath, "w");
  let status: number;
  try {
    const result = spawnSync("pnpm", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", outFd, errFd],
      // 裸名 + shell：这正是「由 packageManager 声明决定版本」那条机制（pnpm 自带的版本管理）。
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    status = result.status ?? -1;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { status, stdout: fs.readFileSync(outPath, "utf8"), stderr: fs.readFileSync(errPath, "utf8") };
}

/**
 * 从 pnpm 输出里读**实际**版本。
 *
 * 两个来源：`install` 成功时的收尾行 `Done in … using pnpm vX`（首选判据），或 `--version` 的裸输出。
 * 读不出返回 null——调用方必须把它当失败处理（不接受「跑过了就算」）。
 */
export function parseReportedPnpmVersion(text: string): string | null {
  const body = String(text);
  const finished = /using pnpm v?(\d+\.\d+\.\d+[^\s]*)/u.exec(body);
  if (finished !== null) return finished[1];
  const bare = body.trim().split(/\s+/u)[0] ?? "";
  return /^\d+\.\d+\.\d+/u.test(bare) ? bare : null;
}

/**
 * 断言「实际解析到的 pnpm == 声明的那个」，返回实际版本。
 *
 * 在交付链**开工前**先跑它：早失败，且错误里说清声明是什么、该怎么办。
 */
export function assertDeliveryPnpmVersion(
  decl: PnpmDeclaration = readPnpmDeclaration(),
  options: { label?: string; cwd?: string } = {},
): string {
  const out = spawnCaptured(["--version"], {
    cwd: options.cwd ?? ROOT,
    env: deliveryPnpmEnv(),
    label: options.label ?? "pnpm-version",
  });
  const detail = (out.stderr || out.stdout).trim().slice(0, 600);
  if (out.status !== 0) {
    throw new Error(
      `解析交付链 pnpm 失败（\`pnpm --version\` 退出码 ${out.status}）。声明的是 ${decl.raw}。\n` +
        "  受限环境里取不到那一份时，请先把声明的那份装好（别让交付链退到手边的版本）。\n" +
        (detail === "" ? "" : "  输出：" + detail),
    );
  }
  const actual = parseReportedPnpmVersion(out.stdout) ?? parseReportedPnpmVersion(out.stderr);
  if (actual === null) {
    throw new Error(`读不出 pnpm 实际版本（--version 输出：${detail || "（空）"}）`);
  }
  if (actual !== decl.version) {
    throw new Error(
      `交付链 pnpm 实际版本 ≠ 声明版本：实际 ${actual} ≠ 声明 ${decl.version}（package.json#packageManager）。\n` +
        "  为什么必须拒：交付树的形状由 pnpm 决定，版本漂了这份树就不再是「我们声明的那份」。\n" +
        `  修法：让 \`pnpm\` 能取到 ${decl.version}，或在受限环境里把它装好；不要改声明去迁就手边的版本。`,
    );
  }
  return actual;
}

/**
 * 跑一条交付链 pnpm 命令并断言实际版本。
 *
 * 目标一律用 `--dir` 钉在**工位**（不用 cwd 表达目标）：cwd 留给仓根，让声明机制读到本仓那份
 * `packageManager`；目标工位在仓内（.tmp/…），于是声明对两边都成立。
 *
 * @param args - 子命令与参数（不含 `--dir`，本函数补）。
 * @param options.projectDir - 工位（`--dir` 的值）。
 * @param options.label - 日志文件名（同时用于错误前缀）。
 * @param options.log - 输出回显（默认静默）。
 * @param options.allowFailure - true 时非零退出不抛，交由调用方判（inspect 的 frozen 探针用）。
 */
export function runDeliveryPnpm(
  args: string[],
  options: { projectDir: string; label: string; log?: (m: string) => void; allowFailure?: boolean; decl?: PnpmDeclaration },
) {
  const decl = options.decl ?? readPnpmDeclaration();
  const projectDir = path.resolve(options.projectDir);
  const out = spawnCaptured(["--dir", projectDir, ...args], { cwd: ROOT, env: deliveryPnpmEnv(), label: options.label });
  const body = (out.stdout + out.stderr).trim();
  if (options.log !== undefined && body !== "") options.log(body);
  const reported = parseReportedPnpmVersion(out.stdout) ?? parseReportedPnpmVersion(out.stderr);
  if (out.status !== 0) {
    if (options.allowFailure === true) return { status: out.status, stdout: out.stdout, stderr: out.stderr, reportedVersion: reported, decl };
    throw new Error(`pnpm ${args.join(" ")} 失败（退出码 ${out.status}，工位 ${projectDir}）：\n${body.slice(-2000)}`);
  }
  if (reported === null) {
    throw new Error(
      `pnpm ${args.join(" ")} 成功，但收尾行里没有 \`using pnpm vX\`：无法断言实际版本。\n` +
        `  输出尾部：\n${body.slice(-800)}`,
    );
  }
  if (reported !== decl.version) {
    throw new Error(
      `交付链 pnpm 实际版本 ≠ 声明版本：实际 ${reported} ≠ 声明 ${decl.version}` +
        "（package.json#packageManager）——拒绝用它产出的交付树。",
    );
  }
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, reportedVersion: reported, decl };
}

/**
 * pnpm 主版本 → 它写出的 `lockfileVersion`。
 *
 * 为什么要表而不是只读实际值：这是**交叉校验**——版本跨大版本时会改锁格式，那属于要人认账的
 * 变更，不该由「跑一次就默默变成新格式」带过去。表里没有的 major 一律报错（不猜）。
 * 实测：11.7.0（上游 pin）与 12.8.2 都写 `9.0`，所以两个版本共用同一份锁是可行的。
 */
const LOCKFILE_VERSION_BY_MAJOR: Record<number, string> = { 9: "9.0", 10: "9.0", 11: "9.0", 12: "9.0" };

/** 该 major 应有的 lockfileVersion；未知 major 当场报（fail-closed，不默认通过）。 */
export function expectedLockfileVersion(major: number): string {
  const want = LOCKFILE_VERSION_BY_MAJOR[major];
  if (want === undefined) {
    throw new Error(`不知道 pnpm ${major}.x 的 lockfileVersion：确认后加进 LOCKFILE_VERSION_BY_MAJOR（不猜）`);
  }
  return want;
}

/** 读锁文件头部的 lockfileVersion（pnpm 有时写成 '9.0' 带引号）。 */
export function readLockfileVersion(lockText: string): string {
  const matched = /^lockfileVersion:\s*['"]?([^'"\s]+)['"]?/mu.exec(String(lockText));
  if (matched === null) throw new Error("锁文件里没有 lockfileVersion 行");
  return matched[1];
}

/** 断言锁文件的 lockfileVersion 与声明版本相符（交付链的交叉校验）。 */
export function assertLockfileVersion(lockText: string, decl: PnpmDeclaration, label: string): string {
  const actual = readLockfileVersion(lockText);
  const want = expectedLockfileVersion(decl.major);
  if (actual !== want) {
    throw new Error(
      `${label}：锁文件 lockfileVersion ${actual} ≠ pnpm ${decl.version} 应有的 ${want}` +
        "——版本或锁格式变了，请显式认账（重派生并提交）后再继续",
    );
  }
  return actual;
}

/**
 * pnpm 主版本 → 它写的锁文件里**是否含** `packageManagerDependencies` 段。
 *
 * 为什么 `lockfileVersion` 不够、还得有这张表：11.x 与 12.x 都写 `9.0`，那一格**区分不了**这两个大
 * 版本。而声明从 12.x 降回 11.x 时，旧锁里那段 12.x 的 `packageManagerDependencies` 会被 11.x
 * **整个忽略**（11.x 早于这个机制），frozen 探针照旧放行——高版本那半段就静默留下了（实测踩到过）。
 * 「这一段在不在」正好当指纹。
 *
 * 实测（本机，六组）：声明 11.7.0 / 11.24.0 / 无声明 → 无段；声明 12.6.0 / 12.8.2 → 有段（specifier
 * 等于声明值）。且**跟随声明、不跟随实际运行的二进制**：拿 12.8.2 的 exe 跑、把声明写成 11.7.0，
 * 段仍不写。9/10 两行按版本先后推得（早于 11.x，同样无此机制）。表里没有的 major 一律报错（不猜）。
 */
const PACKAGE_MANAGER_DEPENDENCIES_BY_MAJOR: Record<number, boolean> = { 9: false, 10: false, 11: false, 12: true };

/** 该 major 是否应在锁文件里写 `packageManagerDependencies`；未知 major 当场报（fail-closed）。 */
export function expectsPackageManagerDependencies(major: number): boolean {
  const want = PACKAGE_MANAGER_DEPENDENCIES_BY_MAJOR[major];
  if (want === undefined) {
    throw new Error(`不知道 pnpm ${major}.x 会不会写 packageManagerDependencies：确认后加进表（不猜）`);
  }
  return want;
}

/** 读锁文件里 `packageManagerDependencies` 段的 specifier；无段返回 null。 */
export function readPackageManagerDependency(lockText: string): string | null {
  const matched = /^\s*packageManagerDependencies:[\s\S]*?^\s+specifier:\s*['"]?([^'"\s]+)/mu.exec(String(lockText));
  return matched === null ? null : matched[1];
}

/**
 * 断言锁文件的 `packageManagerDependencies` 指纹与声明相符——**两个方向都判**。
 *
 * 正向（声明不写该段）：锁里出现该段即拒——正是「声明降级、旧锁留下高版本半段」那种静默残留。
 * 反向（声明应写该段）：锁里没有该段也拒，而不是默默放过。另外有段时 specifier 必须等于声明版本。
 *
 * 前提：这份锁由**带声明的工位**派生（install-source 保证工位清单写有 packageManager）。因此
 * 「12.x 却不带段」只可能来自更早的声明，不会是「工位没声明」那种正常情形。
 *
 * @returns 该声明是否应写该段（供调用方记录）。
 */
export function assertLockfilePnpmSection(lockText: string, decl: PnpmDeclaration, label: string): boolean {
  const expected = expectsPackageManagerDependencies(decl.major);
  const specifier = readPackageManagerDependency(lockText);
  if (!expected && specifier !== null) {
    throw new Error(
      `${label}：pnpm ${decl.version} 不写 packageManagerDependencies，锁文件里却有（specifier ${specifier}）` +
        "——这是声明降级时旧锁留下的高版本半段，pnpm 11.x 会整个忽略它。重派生该锁文件后再继续",
    );
  }
  if (expected && specifier === null) {
    throw new Error(
      `${label}：pnpm ${decl.version} 应写 packageManagerDependencies，锁文件里却没有` +
        "——这份锁是更早的声明派生的（或不完整）。重派生该锁文件后再继续",
    );
  }
  if (specifier !== null && specifier !== decl.version) {
    throw new Error(
      `${label}：锁文件 packageManagerDependencies 的 specifier ${specifier} ≠ 声明 ${decl.version}——重派生`,
    );
  }
  return expected;
}

/** 受护栏锁文件的哈希快照（存在性与内容都记）。 */
export function lockfileSnapshot(rootDir: string = ROOT) {
  return GUARDED_LOCKFILES.map((rel) => {
    const absolute = path.join(rootDir, rel);
    const exists = fs.existsSync(absolute);
    return {
      rel,
      exists,
      sha256: exists ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : null,
    };
  });
}

/** 与快照比对；任何一份变了就拒（附前后哈希前缀，看得见是哪一份）。 */
export function assertLockfilesUnchanged(before: ReturnType<typeof lockfileSnapshot>, label: string, rootDir: string = ROOT): void {
  const changed: string[] = [];
  for (const snap of before) {
    const absolute = path.join(rootDir, snap.rel);
    const exists = fs.existsSync(absolute);
    const now = exists ? crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") : null;
    if (now !== snap.sha256) {
      const from = snap.sha256 === null ? "不存在" : snap.sha256.slice(0, 12);
      const to = now === null ? "不存在" : now.slice(0, 12);
      changed.push(`${snap.rel}（${from} → ${to}）`);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `${label}：仓里的锁文件被改了（拒绝继续）——${changed.join("、")}。\n` +
        "  交付链只允许写 .tmp 工位里的锁文件；packaging/pnpm-lock.yaml 仅由 derive 写。\n" +
        "  通常意味着 pnpm 的目标没钉在工位（--dir 之外还改了仓里的那份）。",
    );
  }
}
