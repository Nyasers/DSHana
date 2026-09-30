// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/vendor/build.mts — 从钉住的 vendor tag 编出一套 DSH 包集（树外构建 + 缓存）。
//
// 用法：
//   node scripts/vendor/build.mts            # 未命中缓存就构建，产物落进缓存目录
//   node scripts/vendor/build.mts --check    # 只报键与命中情况，不构建（未命中 exit 1）
//
// 为什么构建必须在树外：tsdown 的 workspace 通配 `packages/*/*` 会把 vendor 工作树里任何两级
// 目录当成员；残留空目录会让它拿仓根配置去解根包入口，报 `[@deepseek-ai/dsh-root] Cannot find
// entry: [...]`——症状指向根包，与真实成因无关。这里用 `git archive <tag>` 导出到 `.tmp` 下的
// 检出，于是 scratch 树里连 `.git` 都没有，submodule 的 git 配置冲突（postinstall 里
// `core.worktree` 与 `extensions.worktreeConfig`）也无从发生。
//
// 为什么构建进程必须带 CI=true：vendor 的 `scripts/install-lefthook.mjs` 在 CI/GITHUB_ACTIONS
// 为真时早退；否则 postinstall 会在上面那条冲突上失败。
//
// 为什么构建进程必须带 npm_config_verify_deps_before_run=false：`pnpm run`/`pnpm exec` 会先做
// 依赖状态检查、必要时隐式补跑一次 `pnpm install`，把那条 postinstall 再炸一遍，报错点与真实
// 步骤无关。
//
// 缓存：键 = tag + 构建配方版本 + Node 版本 + vendored pnpm-lock.yaml 的哈希 + 集成 delta 的内容哈希
// （见 buildCacheKey 与 scripts/integrations/delta.mts 的 deltaContentHash）。命中即跳过全部
// 构建，直接用缓存里的包集。构建是 `(commit, 工具链)` 的纯函数，而 vendor 站在 tag 上（HEAD
// 与 tag 双向一致由 sync:vendor:dsh / derive vendor 守着），所以 tag 就是 commit 的诚实替身。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT } from "../shared/root.mts";
import { isDirectRun } from "../shared/run.mts";
import { applyGeneratedPatches, deltaContentHash, stageDelta } from "../integrations/delta.mts";
import { dshPin } from "../shared/version.mts";
import { extractTar } from "./tar-extract.mts";

/** 构建配方版本：改动构建步骤/工具链口径就 +1，历史缓存随即失效。
 * 2：集成 delta 从 pack 期前移到构建期（铺进 scratch 检出 + generatedPatches 挂生成之后）。 */
export const RECIPE_VERSION = "2";

/** 缓存根（相对仓库根）。刻意不放 `.tmp`：那一区会被各类脚本清理。 */
export const CACHE_REL = path.join(".cache", "dsh-build");

/** vendor 镜像相对仓库根的路径。 */
const VENDOR_REL = path.join("vendor", "deepseek-harness");

/** 树外检出的工作区根（相对仓库根）。 */
const SCRATCH_REL = path.join(".tmp", "dsh-build");

/** 一条已执行步骤的记录（进 build-recipe.json）。 */
interface StepRecord {
  name: string;
  durationMs: number;
  exitCode: number;
}

/** 子进程捕获结果；输出走文件而非管道，见 spawnCapture 的说明。 */
interface SpawnOutcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** pnpm 的调用前缀：要么是 `node <pnpm 的 JS 入口>`，要么退化成裸名 + shell。 */
interface PnpmInvocation {
  command: string;
  prefix: string[];
  shell: boolean;
}

/** 步骤日志目录；检出就绪后指向 scratch 下的 logs。 */
let logDir = path.join(ROOT, SCRATCH_REL, "logs");

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function slug(name: string): string {
  return name.replace(/[^0-9A-Za-z]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase();
}

function tail(text: string, lines = 40): string {
  const all = text.split(/\r?\n/u).filter((line, index, array) => line !== "" || index < array.length - 1);
  return all.slice(-lines).join("\n").trim();
}

/**
 * 起一个子进程，把 stdout/stderr 分别落到文件，返回退出码与全文。
 *
 * 走文件而不是管道：本仓脚本会在受限沙箱里跑，那里 Node 的管道 stdio 会被拒（EPERM），而文件
 * 描述符不受影响。附带好处是每步留下一份完整日志，失败时能报出真正的尾部而不是被截断的流。
 */
function spawnCapture(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean; label: string },
): SpawnOutcome {
  fs.mkdirSync(logDir, { recursive: true });
  const outPath = path.join(logDir, `${options.label}.out`);
  const errPath = path.join(logDir, `${options.label}.err`);
  const outFd = fs.openSync(outPath, "w");
  const errFd = fs.openSync(errPath, "w");
  let status: number;
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", outFd, errFd],
      shell: options.shell ?? false,
    });
    if (result.error) throw result.error;
    status = result.status ?? -1;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { status, stdout: fs.readFileSync(outPath, "utf8"), stderr: fs.readFileSync(errPath, "utf8") };
}

/** 跑一条构建步骤：打印耗时与退出码，非零退出报出步骤名与输出尾部。 */
function runStep(
  steps: StepRecord[],
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean },
): void {
  console.log(`[build-dsh] → ${name}`);
  const started = Date.now();
  const outcome = spawnCapture(command, args, { ...options, label: `${String(steps.length).padStart(2, "0")}-${slug(name)}` });
  const durationMs = Date.now() - started;
  const body = tail(`${outcome.stdout}\n${outcome.stderr}`);
  if (body !== "") console.log(body);
  steps.push({ name, durationMs, exitCode: outcome.status });
  console.log(
    `[build-dsh] ${outcome.status === 0 ? "ok" : "FAIL"} ${name} exit=${outcome.status} ${(durationMs / 1000).toFixed(1)}s`,
  );
  if (outcome.status !== 0) {
    throw new Error(`步骤 ${name} 退出码 ${outcome.status}；输出尾部：\n${tail(`${outcome.stdout}\n${outcome.stderr}`, 60)}`);
  }
}

/** 从 startDir 向上找 pnpm 的 JS 入口（`node_modules/pnpm/bin/pnpm.cjs|mjs`）。 */
function findPnpmEntry(startDir: string): string | null {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    for (const entry of ["bin/pnpm.cjs", "bin/pnpm.mjs"]) {
      const candidate = path.join(dir, "node_modules", "pnpm", entry);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * 解析 pnpm 的调用方式，取第一个可用项：
 *
 *   1. `DSH_BUILD_PNPM` 显式指定（指向 pnpm 的 JS 入口；固定版本与排查用，压过下面全部）；
 *   2. **检出自己的 `node_modules/pnpm`**——上游 devDependencies 把 pnpm 版本钉在检出里，
 *      装完依赖后就用它：解析器版本因此是「这份 tag 声明的那一个」，不随构建机漂移；
 *   3. **vendor 工作树的 `node_modules/pnpm`**——首次 install 前检出还没有 `node_modules`，
 *      这一步是引导用的；仓库镜像必然已装好，且与检出同一份钉法（HEAD == tag，见 main）；
 *   4. 启动本脚本的那个 pnpm（`npm_execpath` 指向 pnpm 的 JS 入口时用当前 Node 直跑，避开
 *      Windows 上 `.CMD` 垫片 spawnSync 起不来的问题）；
 *   5. 仓库根向上能找到的 pnpm；
 *   6. 退化到裸名 + shell，与本仓 `scripts/derive/package-lock.mts` 同一取舍。
 *
 * 为什么 2/3 要压过启动者带来的那份（4）：启动者的 pnpm 由构建机决定（场景不同可能是 11 / 12 /
 * corepack 垫片），而包集是 `(源码, 工具链)` 的函数——同一 tag 用不同 pnpm 打出来的 tarball 未必
 * 逐字节相同。把版本钉在检出里，缓存键才有确定含义（键含 pnpm 版本，见 buildCacheKey）。
 *
 * 能定位到 JS 入口的都归约成 `node <JS 入口>`：既不依赖 PATH，也不用 shell 解析批处理垫片。
 * 2/3 特意排在裸名之前——裸名会落到 corepack/全局垫片上，而 pnpm 见到检出里
 * `packageManager: pnpm@<版本>` 会先下载那个版本再跑（下载目录不可写时整步失败，报错点是
 * `create the package-manager env directory`，与真实步骤无关）。
 */
export function resolvePnpm(checkoutDir: string): PnpmInvocation {
  const explicit = process.env.DSH_BUILD_PNPM;
  if (explicit !== undefined && explicit !== "") {
    if (!fs.existsSync(explicit)) throw new Error(`DSH_BUILD_PNPM 指向的入口不存在：${explicit}`);
    return { command: process.execPath, prefix: [explicit], shell: false };
  }
  const entry = findPnpmEntry(checkoutDir) ?? findPnpmEntry(path.join(ROOT, VENDOR_REL)) ?? findPnpmEntry(ROOT);
  if (entry !== null) return { command: process.execPath, prefix: [entry], shell: false };
  const execpath = process.env.npm_execpath;
  if (execpath !== undefined && /[\\/]pnpm[\\/]/u.test(execpath) && /\.[cm]?js$/u.test(execpath)) {
    return { command: process.execPath, prefix: [execpath], shell: false };
  }
  return { command: "pnpm", prefix: [], shell: process.platform === "win32" };
}

/**
 * 讲出这份 pnpm 的版本，供缓存键使用。
 *
 * 定位到 JS 入口时直接读它旁边的 `package.json`，不起子进程：`pnpm --version` 的 cwd 决定它看不
 * 看得见某个 `packageManager` 字段，而 pnpm 见到就会先切到那个版本（不在本地则下载）——探版本
 * 这一下会因此变成一次网络往返或一次失败，报错点与版本本身无关。
 *
 * 退化到裸名时没有入口可读，只能起一次进程；cwd 用系统临时目录，那里向上没有 package.json，
 * 也就不会触发版本切换。
 */
export function pnpmVersionOf(pnpm: PnpmInvocation): string | null {
  const entry = pnpm.prefix[0];
  if (entry !== undefined) {
    const manifest = path.join(path.dirname(path.dirname(entry)), "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
      if (parsed.name === "pnpm" && typeof parsed.version === "string" && parsed.version !== "") {
        return parsed.version;
      }
    } catch {
      return null;
    }
    return null;
  }
  const outcome = spawnCapture(pnpm.command, ["--version"], {
    cwd: os.tmpdir(),
    env: { ...process.env, npm_config_manage_package_manager_versions: "false" },
    shell: pnpm.shell,
    label: "pnpm-version",
  });
  const version = outcome.stdout.trim();
  return outcome.status === 0 && version !== "" ? version : null;
}

/** 读一条 git 输出（走文件捕获；失败返回 null）。 */
function gitOut(args: string[], cwd: string): string | null {
  const outcome = spawnCapture("git", args, { cwd, env: process.env, label: `git-${slug(args.join("-"))}` });
  return outcome.status === 0 ? outcome.stdout.trim() : null;
}

/**
 * 重步的内存护栏阈值（空闲物理内存）。
 *
 * 为什么是 3 GiB：实测这条构建链在本机（32 GiB）能同时压住四件事——检出 node_modules 的
 * 依赖图、tsc 两面的 program、tsdown/rspack 按核数开的 worker、以及**宿主 DSH 本身**。
 * tsc 的堆上限是 2 GiB，但 rspack 的 worker 是「按核数各占一份」，峰值不体现在单个进程上，
 * 单看 tsc 的 2 GiB 会严重低估。留 3 GiB 是给「构建 + 宿主 + 编辑器」同时在场留的余量；
 * 低于它时继续跑就是在赌 OOM——本仓已经被这么干掉过一次（.partial 留下、scratch 数个 GB）。
 * 宁可停下来说清楚，也不要让内核随机挑一个进程杀（被杀的可能是宿主的会话，损失大得多）。
 *
 * **这不是防线，是地板**：它只拦「起跑时就已经紧张」，管不住「起跑够、跑到一半峰值超了」
 * （那件事只能靠上面那些堆上限压峰值）。别把这句护栏当成"内存一定够"的保证。
 */
export const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;

/**
 * 内存护栏的判定（**纯函数**，便于单测两个分支而不必真的把机器压到阈值以下）。
 *
 * 只判定与描述，不做等待/重试：内存是别人也让出来的东西，本脚本等不来；把现场交回给人
 * （关掉宿主/编辑器再跑）比自动重试更诚实。os.freemem() 报的是**空闲物理内存**，
 * 不含可回收的缓存（Windows 上另有 standby list，这里不假设它可被立即征用）。
 *
 * @param freeBytes - 当前空闲物理内存（os.freemem() 的值）。
 * @param step - 即将执行的重步名（进错误信息，便于对照日志）。
 * @param minBytes - 阈值；默认 MIN_FREE_BYTES（测试可覆写）。
 * @returns 够用返回 null；不够返回给人看的说明。
 */
export function memoryGuardError(freeBytes: number, step: string, minBytes: number = MIN_FREE_BYTES): string | null {
  if (freeBytes >= minBytes) return null;
  const free = (freeBytes / 1024 / 1024 / 1024).toFixed(2);
  const want = (minBytes / 1024 / 1024 / 1024).toFixed(0);
  return (
    `空闲物理内存不足，停在「${step}」之前：${free} GiB < 阈值 ${want} GiB。` +
    "关掉宿主/编辑器等占内存的进程后重跑；构建一旦 OOM，被内核杀掉的可能是宿主会话。" +
    "（本次不自动重试：内存等不来。）"
  );
}

/** 进重步之前查一次空闲物理内存；不够就抛（fail-closed，不赌 OOM）。 */
function assertMemoryForStep(step: string): void {
  const message = memoryGuardError(os.freemem(), step);
  if (message !== null) throw new Error(message);
}

/** 交付面声明的 dsh 版本对应的 tag。 */
export function dshBuildTag(): string {
  const pin = dshPin();
  if (!pin) throw new Error("package.json 未声明 devDependencies['@deepseek-ai/dsh']：构建源无从确定");
  return `dsh-v${pin}`;
}

/** vendored pnpm-lock.yaml 的内容哈希（缓存键的一半）。 */
export function vendoredLockHash(): string {
  const lockPath = path.join(ROOT, VENDOR_REL, "pnpm-lock.yaml");
  return crypto.createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex");
}

export interface CacheKeyInput {
  tag: string;
  recipeVersion: string;
  nodeVersion: string;
  /** 实际驱动构建的 pnpm 版本：同一 tag 换一份 pnpm，产物未必逐字节相同。 */
  pnpmVersion: string;
  lockSha256: string;
  /**
   * 集成 delta 的**内容哈希**（src-integrations/**；见 delta.mts#deltaContentHash）。
   *
   * 为什么 delta 必须进键：T5 起 delta 在构建期烤进产物，它就是产物字节的一部分。改了 overlay
   * 而键不变，就会命中一份「没有这次改动」的包集——比改错更坏的是清单的 sha512 还会替它背书。
   *
   * 为什么键里**没有** dshana 版本：版本戳（`+dshana-<干净版本>`）仍写在 pack 期，不进检出。
   * 若把它算进来，每发一版都换键，缓存再也跨不了 dshana 版本——而包集是 ~15 分钟级的产物，
   * 跨版本复用是硬约束（spec §6.7）。deltaContentHash 只含集成声明/overlay 字节/上游哈希，
   * 与我们的版本号无关，故同一条目可被多个 dshana 版本复用。
   */
  deltaHash: string;
}

/**
 * 缓存键：六项输入的 sha256 前 16 位。
 *
 * pnpm 进键的理由：包集是 `(源码, 工具链)` 的函数，而 pnpm 决定依赖树布局与 tarball 内容；
 * 只有 tag + Node 不足以判定"同一份产物"（Node 管编译，pnpm 管依赖）。
 * delta 进键的理由见 CacheKeyInput#deltaHash。
 */
export function buildCacheKey(input: CacheKeyInput): string {
  const material = [
    input.tag,
    input.recipeVersion,
    input.nodeVersion,
    input.pnpmVersion,
    input.lockSha256,
    input.deltaHash,
  ].join("\n");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** 缓存条目是否可用（清单在、包集非空、条数自洽）。完整性清单归 T2，这里只挡住半成品。 */
function readCacheEntry(entryDir: string): Record<string, unknown> | null {
  const recipePath = path.join(entryDir, "build-recipe.json");
  const distDir = path.join(entryDir, "dist-npm");
  if (!fs.existsSync(recipePath) || !fs.existsSync(distDir)) return null;
  let recipe: Record<string, unknown>;
  try {
    recipe = JSON.parse(fs.readFileSync(recipePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tarballs = fs.readdirSync(distDir).filter((name) => name.endsWith(".tgz"));
  const artifact = recipe.artifact as { tarballs?: unknown } | undefined;
  if (tarballs.length === 0) return null;
  if (typeof artifact?.tarballs === "number" && artifact.tarballs !== tarballs.length) return null;
  return recipe;
}

/** 在 scratch 里准备树外检出：本地导出，不联网，也不产生符号链接。 */
function prepareCheckout(tag: string, checkoutDir: string, tarPath: string, steps: StepRecord[]): void {
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(tarPath), { recursive: true });
  runStep(steps, "checkout: git archive", "git", [
    "-C", VENDOR_REL,
    "archive",
    "--format=tar",
    `--output=${tarPath}`,
    tag,
  ], { cwd: ROOT, env: process.env });
  const counts = extractTar(tarPath, checkoutDir);
  fs.rmSync(tarPath, { force: true });
  console.log(
    `[build-dsh] 检出 ${tag} → ${path.relative(ROOT, checkoutDir)}（${counts.files} 文件 / ${counts.directories} 目录 / ${counts.symlinks} 链接）`,
  );
  if (!fs.existsSync(path.join(checkoutDir, "package.json"))) {
    throw new Error(`检出缺少 package.json：${checkoutDir}`);
  }
}

/** 跑完 build:web 之后补写 client 构建记录（release:pack 的 family 校验要读它）。 */
async function writeClientRecord(
  checkoutDir: string,
  clientEnv: Record<string, string>,
): Promise<{ fileCount: number }> {
  const moduleUrl = pathToFileURL(path.join(checkoutDir, "scripts", "client-build-environment.ts")).href;
  const implementation = (await import(moduleUrl)) as {
    writeClientBuildRecord: (root: string, environment: Record<string, string>) => { artifacts: { fileCount: number } };
  };
  const record = implementation.writeClientBuildRecord(checkoutDir, clientEnv);
  console.log(`[build-dsh] client 构建记录已写：${record.artifacts.fileCount} 个产物（文件数在两面构建与 build:web 之后才成立）`);
  return { fileCount: record.artifacts.fileCount };
}

/** 已发布包集的 release tag 前缀（资产见 .github/workflows/dsh-package-set.yml）。 */
const PUBLISHED_SET_TAG_PREFIX = "dsh-set-";

/** 取仓库 origin 的 `owner/repo`（拼下载地址用）；认不出来返回 null。 */
function githubRepoSlug(): string | null {
  const url = gitOut(["remote", "get-url", "origin"], ROOT);
  if (!url) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * 尝试把这次构建的包集从**已发布的资产**取回来（自愈的第一跳）。
 *
 * 为什么有这条路：包集是构建产物、按 key 可寻址，但 `release:pack` 的字节不可跨机复现，
 * 所以“各机器各自重建”必然让清单里的 sha512 在别处对不上。让所有地方都用**同一份** tarball
 * 是唯一站得住的办法：包集按 key 发布一次（`dsh-set-<key>` release 下的
 * `dsh-package-set-<key>.tar`，内部产物、不是发行包），缺缓存时先下载。
 *
 * 校验：解出的每个 tarball 的字节数与 sha512 对照仓库里那份清单（清单描述的就是这份包集）。
 * 任一不符即整体丢弃返回 false——宁可自己重建，也不落一份可疑字节。
 *
 * @param key - T1 缓存键。
 * @param entryDir - 缓存条目目录（`<cache>/<key>`）。
 * @returns 是否已成功落进缓存。
 */
async function tryFetchPublishedSet(key: string, entryDir: string): Promise<boolean> {
  const manifestPath = path.join(ROOT, "packaging", "dsh-package-set.json");
  if (!fs.existsSync(manifestPath)) {
    console.log("[build-dsh] 取不回包集：仓库里没有 packaging/dsh-package-set.json（直接重建）");
    return false;
  }
  const slug = githubRepoSlug();
  if (!slug) {
    console.log("[build-dsh] 取不回包集：origin 不是 GitHub 仓库（直接重建）");
    return false;
  }
  const asset = `dsh-package-set-${key}.tar`;
  const url = `https://github.com/${slug}/releases/download/${PUBLISHED_SET_TAG_PREFIX}${key}/${asset}`;
  const partialDir = `${entryDir}.partial`;
  fs.rmSync(partialDir, { recursive: true, force: true });
  fs.mkdirSync(partialDir, { recursive: true });
  try {
    console.log(`[build-dsh] 取已发布的包集：${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const archivePath = path.join(partialDir, asset);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    extractTar(archivePath, partialDir);
    fs.rmSync(archivePath, { force: true });
    const fetchedDir = path.join(partialDir, key);
    if (!fs.existsSync(fetchedDir)) throw new Error(`归档里没有 ${key}/ 目录`);

    // 逐包对照清单（bytes + sha512）：清单描述的就是这份包集，比不过就是另一份
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      packages?: { file?: unknown; bytes?: unknown; sha512?: unknown }[];
    };
    const expected = new Map<string, { bytes: number; sha512: string }>();
    for (const p of manifest.packages ?? []) {
      if (typeof p.file === "string" && typeof p.bytes === "number" && typeof p.sha512 === "string") {
        expected.set(p.file, { bytes: p.bytes, sha512: p.sha512 });
      }
    }
    if (expected.size === 0) throw new Error("清单里没有可对照的包条目");
    const tarDir = path.join(fetchedDir, "dist-npm");
    const seen = new Set<string>();
    for (const name of fs.readdirSync(tarDir).filter((n) => n.endsWith(".tgz"))) {
      const want = expected.get(name);
      if (!want) throw new Error(`${name} 不在清单里`);
      const body = fs.readFileSync(path.join(tarDir, name));
      if (body.length !== want.bytes) throw new Error(`${name} 字节数不符：清单 ${want.bytes} ≠ 实际 ${body.length}`);
      const digest = "sha512-" + crypto.createHash("sha512").update(body).digest("base64");
      if (digest !== want.sha512) throw new Error(`${name} sha512 与清单不符`);
      seen.add(name);
    }
    if (seen.size !== expected.size) throw new Error(`tarball 数不符：清单 ${expected.size} ≠ 实际 ${seen.size}`);
    if (!readCacheEntry(fetchedDir)) throw new Error("取回的条目自身不完整（缺 build-recipe.json / dist-npm）");

    fs.rmSync(entryDir, { recursive: true, force: true });
    fs.renameSync(fetchedDir, entryDir);
    const artifact = readCacheEntry(entryDir)?.artifact as { tarballs?: number; bytes?: number } | undefined;
    console.log(
      `[build-dsh] 已从发布资产取回并校验：${path.relative(ROOT, entryDir)}（${seen.size} tarball / ${formatBytes(artifact?.bytes ?? 0)}）——跳过全部构建`,
    );
    return true;
  } catch (error) {
    console.log(`[build-dsh] 取发布资产未成（${error instanceof Error ? error.message : String(error)}）——改为本地重建`);
    fs.rmSync(partialDir, { recursive: true, force: true });
    return false;
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  // 只打印现算的缓存键：CI 的 Actions 缓存键与自愈路径的判定都用它，不做任何别的动作。
  if (process.argv.includes("--print-key")) {
    console.log(currentBuildIdentity().key);
    return;
  }
  const tag = dshBuildTag();
  const vendorDir = path.join(ROOT, VENDOR_REL);

  // 只读地确认构建源：tag 存在，且工作树 HEAD 与它一致（否则同一份上游会被读成两个版本）。
  if (!fs.existsSync(vendorDir)) throw new Error(`vendor 镜像不存在：${vendorDir}`);
  const commit = gitOut(["-C", VENDOR_REL, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], ROOT);
  if (commit === null || !/^[0-9a-f]{7,40}$/u.test(commit)) {
    throw new Error(`vendor/deepseek-harness 没有 ${tag}（镜像未 fetch 到该 tag？）——先跑 pnpm run sync:vendor:dsh`);
  }
  const head = gitOut(["-C", VENDOR_REL, "rev-parse", "HEAD"], ROOT);
  if (head !== commit) {
    throw new Error(
      `vendor/deepseek-harness 工作树 HEAD（${head ?? "（无）"}）≠ ${tag}（${commit}）：构建源不唯一。` +
        "跑 pnpm run sync:vendor:dsh 归位后再构建。",
    );
  }

  const lockSha256 = vendoredLockHash();
  // 键要在检出之前算出来（命中时不该付出解包成本），所以这里问的是**引导用**的那份 pnpm：
  // 检出还没 node_modules，resolvePnpm 会落到 vendor 工作树那份（或显式/启动者/裸名兜底）。
  // 装完依赖后再解析一次（那时检出自己那份就位），两者版本必须一致——不一致说明工具链在
  // 构建中途发生了替换，产物落不到当前键下，宁可直接失败也不要写错条目。
  const bootstrapPnpm = resolvePnpm(path.join(ROOT, SCRATCH_REL, "pending", "harness"));
  const pnpmVersion = pnpmVersionOf(bootstrapPnpm);
  if (pnpmVersion === null) {
    throw new Error("拿不到 pnpm 版本（--version 失败）：缓存键要把工具链记进去，版本未知就不构建");
  }
  // delta 的内容哈希要在检出之前算出来（命中时不该付出解包成本），而它只读仓库里的
  // src-integrations/**，不依赖检出，所以放在这里正合适。算不出来（声明坏了）就当场失败：
  // 键必须覆盖产物字节，宁可构建前炸，也不要编出一份"键撒谎"的包集。
  const deltaHash = deltaContentHash();
  const key = buildCacheKey({
    tag,
    recipeVersion: RECIPE_VERSION,
    nodeVersion: process.versions.node,
    pnpmVersion,
    lockSha256,
    deltaHash,
  });
  const cacheDir = path.join(ROOT, CACHE_REL);
  const entryDir = path.join(cacheDir, key);
  const cached = fs.existsSync(entryDir) ? readCacheEntry(entryDir) : null;

  console.log(
    `[build-dsh] tag=${tag} commit=${commit.slice(0, 12)} node=${process.versions.node} pnpm=${pnpmVersion} recipe=${RECIPE_VERSION}`,
  );
  console.log(`[build-dsh] lock=${lockSha256.slice(0, 12)} delta=${deltaHash.slice(0, 12)} key=${key}`);

  if (cached) {
    const artifact = cached.artifact as { tarballs?: number; bytes?: number } | undefined;
    console.log(
      `[build-dsh] cache hit：${path.relative(ROOT, entryDir)}（${artifact?.tarballs ?? "?"} tarball / ${formatBytes(artifact?.bytes ?? 0)}）——跳过全部构建`,
    );
    return;
  }

  console.log(`[build-dsh] cache miss：${path.relative(ROOT, entryDir)} 不存在或不完整`);
  if (checkOnly) {
    console.error("[build-dsh] --check：缓存未命中，需跑 node scripts/vendor/build.mts 构建");
    process.exitCode = 1;
    return;
  }

  // 自愈第一跳：先试取已发布的包集（同 key 的可寻址资产），取到并逐包校验后跳过全部构建。
  if (await tryFetchPublishedSet(key, entryDir)) return;

  const scratchDir = path.join(ROOT, SCRATCH_REL, key);
  const checkoutDir = path.join(scratchDir, "harness");
  const tarPath = path.join(scratchDir, `${tag}.tar`);
  const partialDir = `${entryDir}.partial`;
  logDir = path.join(scratchDir, "logs");
  const steps: StepRecord[] = [];

  fs.rmSync(partialDir, { recursive: true, force: true });
  fs.mkdirSync(partialDir, { recursive: true });

  try {
    prepareCheckout(tag, checkoutDir, tarPath, steps);

    // 集成 delta 铺进检出（时机前移，spec §6.7）：铺之前先过 upstreamSha256 闸——闸校的是**上游**
    // 文件哈希，上游动过就当场失败并点名要 rebase 哪个文件。铺完产物自带 delta，清单的 sha512
    // 于是描述的就是交付内容；pack 期不再有 applyIntegrations。
    // 位置必须在 install 之前：检出要先"是我们的"，后面的每一步才都作用在同一份源上。
    const staged = stageDelta(checkoutDir, tag, { log: (m) => console.log(m) });
    console.log(
      `[build-dsh] 集成 delta 已铺入检出：${staged.integrations.packages} 个集成 / ${staged.files} 个文件` +
        `（漂移闸：${staged.integrations.files} 个 overlay 的上游哈希全中）`,
    );

    // 三条纪律里的两条在这里一次性落实；后面每一步都继承它。
    // 第三条 manage-package-manager-versions=false 也是同一类护栏：检出把 packageManager 钉在
    // 上游那份 pnpm 上，pnpm 12 见到就会去下那个版本、在只读的全局目录里建 env 目录并失败
    // （`create the package-manager env directory ... 拒绝访问`），报错点同样与真实步骤无关。
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      npm_config_verify_deps_before_run: "false",
      npm_config_manage_package_manager_versions: "false",
    };
    for (const name of Object.keys(baseEnv)) {
      if (name.startsWith("DSH_CLIENT_") || name === "DSH_BUILD_CLIENT_PROFILE") delete baseEnv[name];
    }

    const clientModule = (await import(
      pathToFileURL(path.join(checkoutDir, "scripts", "client-build-environment.ts")).href
    )) as {
      repositoryClientBuildEnvironment: (root: string, environment: NodeJS.ProcessEnv) => Record<string, string>;
      resolveClientBuildEnvironment: (environment: NodeJS.ProcessEnv, profile: string) => Record<string, string>;
      clientBuildProcessEnvironment: (
        environment: NodeJS.ProcessEnv,
        clientEnvironment: Record<string, string>,
      ) => NodeJS.ProcessEnv;
    };
    // scratch 没有 .git，所以 commit 显式给（取自 tag），不让它回退去读 git 元数据。
    const repositoryEnvironment = clientModule.repositoryClientBuildEnvironment(checkoutDir, {
      ...baseEnv,
      DSH_CLIENT_COMMIT_HASH: commit,
    });
    const clientEnv = clientModule.resolveClientBuildEnvironment(repositoryEnvironment, "official");
    const buildEnv = clientModule.clientBuildProcessEnvironment(baseEnv, clientEnv);

    // 重步跑之前先过内存护栏（见 MIN_FREE_BYTES 的注释）。串行执行，不并行——并行会把峰值乘起来。
    // 所有重步都带上 NODE_OPTIONS 的堆上限：tsc 自己有 --max-old-space-size，而 tsdown/rspack 与
    // build:web 是从 NODE_OPTIONS 读的（rspack 按核数开 worker，最可能爆的就是它）。
    // 上限 2048：够编这份树（实测 tsc 两面都在 2 GiB 内完成），又不给 rspack 的 worker 留出
    // 「每个都往 4 GiB 长」的余地。
    const heavyEnv: NodeJS.ProcessEnv = {
      ...buildEnv,
      NODE_OPTIONS: [buildEnv.NODE_OPTIONS, "--max-old-space-size=2048"].filter(Boolean).join(" "),
    };
    const pnpmStep = (name: string, args: string[]): void => {
      assertMemoryForStep(name);
      runStep(steps, name, pnpm.command, [...pnpm.prefix, ...args], { cwd: checkoutDir, env: heavyEnv, shell: pnpm.shell });
    };
    const nodeStep = (name: string, args: string[]): void => {
      assertMemoryForStep(name);
      runStep(steps, name, process.execPath, args, { cwd: checkoutDir, env: heavyEnv });
    };

    // install 用**引导**那份 pnpm（检出此时还没有 node_modules，resolvePnpm 落到 vendor 工作树）。
    // 也过一遍内存护栏：这一步会拉起整棵依赖图的构建脚本（koffi/node-pty 等），是重步之一。
    assertMemoryForStep("pnpm install --frozen-lockfile");
    runStep(steps, "pnpm install --frozen-lockfile", bootstrapPnpm.command, [...bootstrapPnpm.prefix, "install", "--frozen-lockfile"], {
      cwd: checkoutDir,
      env: baseEnv,
      shell: bootstrapPnpm.shell,
    });

    // 依赖装完，检出自己那份 pnpm 就位；构建的其余步骤一律用它（上游 devDependencies 钉的版本）。
    // 与引导那份版本不同就直接失败：缓存键记的是引导版本，中途换工具链会让产物落不到当前键下。
    const pnpm = resolvePnpm(checkoutDir);
    const activePnpmVersion = pnpmVersionOf(pnpm);
    if (activePnpmVersion === null) {
      throw new Error("拿不到检出 pnpm 的版本（--version 失败）");
    }
    if (activePnpmVersion !== pnpmVersion) {
      throw new Error(
        `pnpm 版本在构建中途不同：键用 ${pnpmVersion}（引导），后续步骤解析到 ${activePnpmVersion}` +
          `（${pnpm.prefix.join(" ") || "裸名 pnpm"}）。缓存键必须覆盖实际工具链，请让两者一致后重跑。`,
      );
    }
    console.log(
      `[build-dsh] pnpm=${activePnpmVersion} ${pnpm.prefix.length > 0 ? pnpm.prefix.join(" ") : "（裸名 pnpm + shell）"}`,
    );

    // host 面：上游 build:lib:host 的次序，但**不跑**结尾那句 desktop bundle（要 Electron，我们不用）。
    nodeStep("host: tsc -b tsconfig.host.json", [
      // 4096 不是随手给的：实测 2048 时 tsc 自己撞堆顶中止（exit 134，V8 native 栈里 OnFatalError），
      // 而 4096 是 T1 跑通过的取值。tsc 的堆与 tsdown/rspack 不同源（后两者走 NODE_OPTIONS 的 2048），
      // 这里单独给大；峰值风险由 memoryGuardError 的起跑前检查兜。
      "--max-old-space-size=4096",
      "./node_modules/typescript/bin/tsc",
      "-b",
      "tsconfig.host.json",
    ]);
    pnpmStep("host: tsdown", ["--config.verify-deps-before-run=false", "exec", "tsdown", "--env.DSH_BUILD_FACE", "host"]);

    // 生成物补丁必须挂在这里：host tsdown 跑完 dsh-typert-generator 才产出 lib/typert.host.js，
    // 而 release:pack 只做 pnpm pack（不再生成）——"生成之后、打包之前"就是这一刻。
    //
    // T5 实测结论（与预想不同，记下来免得后人再猜）：delta 铺进检出**之后**，生成器会从我们的
    // src/types.ts 自己把 request 级 model 字段推出来（session_create/prompt 两份 schema 都有了，
    // 且与我们的规范形状逐字一致）。时机前移因此兑现了「生成物不再打补丁」。
    // 但这一手不撤：它是**兜底**——生成器哪天不再从那个类型面推（上游换了 FaceModel 的取法、
    // 收窄了 Remote 导出面），这里仍要保证边界字段不被 zod 剥掉。三态语义见 patchGeneratedRequestModel。
    const patched = applyGeneratedPatches(checkoutDir, { log: (m) => console.log(m) });
    console.log(
      patched > 0
        ? `[build-dsh] 生成物补丁已应用：${patched} 处（生成之后、打包之前）`
        : "[build-dsh] 生成物补丁无需应用：生成器已从我们的 types.ts 推出该字段（T5 的最好情形）",
    );

    // client 面
    nodeStep("client: tsc -b tsconfig.client.json", [
      // 同 host 面：2048 会撞顶（exit 134），用 T1 跑通过的 4096。
      "--max-old-space-size=4096",
      "./node_modules/typescript/bin/tsc",
      "-b",
      "tsconfig.client.json",
    ]);
    pnpmStep("client: tsdown", ["--config.verify-deps-before-run=false", "exec", "tsdown", "--env.DSH_BUILD_FACE", "client"]);

    pnpmStep("build:web", ["--config.verify-deps-before-run=false", "run", "build:web"]);

    // 记录必须在两面与 build:web 之后写：它记的是当前产物的 sha256 与文件数。
    const recordStarted = Date.now();
    await writeClientRecord(checkoutDir, clientEnv);
    steps.push({ name: "client: write build record", durationMs: Date.now() - recordStarted, exitCode: 0 });

    const distDir = path.join(partialDir, "dist-npm");
    pnpmStep("release:pack --family dsh", [
      "--config.verify-deps-before-run=false",
      "run",
      "release:pack",
      "--family",
      "dsh",
      "--out",
      distDir,
    ]);

    const tarballs = fs.existsSync(distDir) ? fs.readdirSync(distDir).filter((name) => name.endsWith(".tgz")) : [];
    if (tarballs.length === 0) throw new Error(`release:pack 未产出 tarball：${distDir}`);
    const bytes = tarballs.reduce((sum, name) => sum + fs.statSync(path.join(distDir, name)).size, 0);

    const recipe = {
      formatVersion: 1,
      tag,
      pin: dshPin(),
      commit,
      key,
      recipeVersion: RECIPE_VERSION,
      node: process.versions.node,
      pnpm: pnpmVersion,
      lockSha256,
      steps,
      artifact: { tarballs: tarballs.length, bytes, directory: "dist-npm" },
      // 集成 delta 的身份：内容哈希进缓存键，铺入计数进档案——事后要能回答"这份包集含哪版 delta"。
      integrations: { deltaHash, stagedFiles: staged.files, packages: staged.packages },
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(partialDir, "build-recipe.json"), `${JSON.stringify(recipe, null, 2)}\n`);

    // 落盘原子化：只有整链成功才把 .partial 换名成正式条目，失败不留半成品。
    fs.rmSync(entryDir, { recursive: true, force: true });
    fs.renameSync(partialDir, entryDir);
    fs.rmSync(scratchDir, { recursive: true, force: true });

    console.log(
      `[build-dsh] 构建完成：${tarballs.length} tarball / ${formatBytes(bytes)} → ${path.relative(ROOT, entryDir)}`,
    );
    for (const step of steps) {
      console.log(`[build-dsh]   ${step.name}: exit=${step.exitCode} ${(step.durationMs / 1000).toFixed(1)}s`);
    }
  } catch (error) {
    // fail-closed：半成品（.partial，可能被误当成命中）与庞大的检出（node_modules 数 GB）都清掉；
    // 只把每步日志挪到 scratch 之外留下——报错尾部已经在上面打印过，日志是事后复核用的。
    fs.rmSync(partialDir, { recursive: true, force: true });
    const failedLogs = path.join(path.dirname(scratchDir), `${key}-failed-logs`);
    fs.rmSync(failedLogs, { recursive: true, force: true });
    if (fs.existsSync(logDir)) fs.renameSync(logDir, failedLogs);
    fs.rmSync(scratchDir, { recursive: true, force: true });
    console.error(`[build-dsh] 构建失败（每步日志留在 ${path.relative(ROOT, failedLogs)}）`);
    throw error;
  }
}

/**
 * 现算"当前应命中的缓存标识"——纯推导，不构建、不写盘。
 *
 * T2 的清单要指向**当前**这份包集，而不是它自己上一版记的键：否则换了 tag/依赖/工具链后，
 * 派生任务会一直照着老键校验（清单永远"自洽"，却指着上一份产物）。所以这里把 T1 算键的那几项
 * 按同一口径重算一遍。
 *
 * @returns tag/commit/键与各项输入；键对应的缓存条目是否存在由调用方自行判断。
 */
export function currentBuildIdentity(): {
  tag: string;
  commit: string;
  key: string;
  recipeVersion: string;
  node: string;
  pnpm: string;
  lockSha256: string;
  deltaHash: string;
} {
  const tag = dshBuildTag();
  const commit = gitOut(["-C", VENDOR_REL, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], ROOT);
  if (commit === null || !/^[0-9a-f]{7,40}$/u.test(commit)) {
    throw new Error(`vendor/deepseek-harness 没有 ${tag}（先跑 pnpm run sync:vendor:dsh）`);
  }
  const lockSha256 = vendoredLockHash();
  const pnpmVersion = pnpmVersionOf(resolvePnpm(path.join(ROOT, SCRATCH_REL, "pending", "harness")));
  if (pnpmVersion === null) throw new Error("拿不到 pnpm 版本（--version 失败）");
  // 与 main 同一口径：键含 delta 内容（否则 derive 会照着一个不含 delta 的老键去校验清单）。
  const deltaHash = deltaContentHash();
  return {
    tag,
    commit,
    key: buildCacheKey({ tag, recipeVersion: RECIPE_VERSION, nodeVersion: process.versions.node, pnpmVersion, lockSha256, deltaHash }),
    recipeVersion: RECIPE_VERSION,
    node: process.versions.node,
    pnpm: pnpmVersion,
    lockSha256,
    deltaHash,
  };
}

if (isDirectRun(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`[build-dsh] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}