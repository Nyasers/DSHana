// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/dev/dsh-sync-probe.mts — 判定某个上游 DSH 版本在 **npm 与 git 两条线上是否都已同步可跟**。
//
// 为什么需要它：跟进上游时「能开工了吗」不是一个 yes/no，而是两个独立问题——
//   ① git 侧：`dsh-v<版本>` 这个 tag 在上游出现了吗。源码镜像、overlay 漂移闸、provenance 闸
//      全以它为唯一坐标；没有这个 tag，pin 一动整套门禁一起红。
//   ② npm 侧：那一个版本能不能**完整解析成一棵依赖树**。顶层包存在只是必要条件，npm 发包是
//      逐包打的，漏包会让树缺一块——半套包装出来的东西到构建期或真机才报错，报得莫名其妙。
//
// 两侧都可能先更新：rc.3 就是 npm 先动（10-23 发布）、git 六天没跟的例子；反过来 git 先打 tag、
// npm 稍后才发也发生过。所以给的是分侧结论，不是一个笼统的「还不能跟」。
//
// **npm 侧为什么交给包管理器自己解**：曾经手写过一版逐包比对，按「子包版本号 = 主版本号」去查，
// 报出 5 个「缺发」——全是假警报（`@deepseek-ai/cordis` / `schemastery` / `cordis-plugin-*` 走各自的
// 版本线）。依赖的 spec 有精确版本、有 `~`/`^`、有 `||` 组合，自己解析就是在重写 resolver。
// 现在的做法是写一份只含一条依赖的临时清单，让包管理器按真实语义解一遍。
//
// **用 pnpm 而不是 npm**：本仓 `packageManager` 声明的是 pnpm，安装树也由 pnpm 解——用别的
// resolver 去证明「本仓能装」不成立。而且 pnpm 的**版本必须与仓库声明的那个一致**：临时目录里没有
// `packageManager` 字段时 pnpm 会用全局默认版（本机实测全局是 12.4.1、仓库是 11.28.5），两个
// resolver 语义不同，等于用错的工具出了一份看着对的结论。所以临时清单里显式写入仓库声明的
// `packageManager`，并走 corepack 解析到同一版本。
//
// 两个 lock 格式的包数不可直接比（pnpm 9 的 `snapshots` 与 npm 的 `packages` 计数口径不同，
// 实测同一棵树一个是 490 一个是 685）。这里只把包数当活跃观测点打印，判定看的是**退出码**。
//
// 用法：
//   node scripts/dev/dsh-sync-probe.mts                     # 查 packages/host 里 pin 的版本
//   node scripts/dev/dsh-sync-probe.mts 0.2.1-rc.3       # 查指定版本
//   node scripts/dev/dsh-sync-probe.mts --latest            # 查 npm 的 next 指向哪个版本并查它
//   node scripts/dev/dsh-sync-probe.mts --json              # 机器可读
//
// 退出码：0 两侧都已同步（可以开工）；1 有未就位项（打印缺哪一侧）；2 网络或参数错误。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDirectRun } from "../shared/run.mts";
import { dshPin, readPkg } from "../shared/version.mts";

const REGISTRY = "https://registry.npmjs.org/";
const MIRROR = "vendor/deepseek-harness";
const ROOT_PACKAGE = "@deepseek-ai/dsh";

/** npm 精简 packument（install-v1 格式，约 200 KB；完整格式大好几倍）。 */
async function packument(name: string): Promise<any> {
  const url = REGISTRY + name.replace("/", "%2f");
  const res = await fetch(url, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
  if (!res.ok) throw new Error(`${name} packument 取不到：HTTP ${res.status}`);
  return res.json();
}

/** npm 的 dist-tags（next / latest / alpha 各自指向哪个版本）。 */
async function distTags(): Promise<Record<string, string>> {
  const root = await packument(ROOT_PACKAGE);
  return root["dist-tags"] ?? {};
}

/** 上游 git 的 dsh-v* tag 列表，按语义化版本从新到旧排。 */
function gitTags(): string[] {
  const out = execFileSync("git", ["-C", MIRROR, "ls-remote", "--tags", "origin"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const versions = out
    .split("\n")
    .map((line) => line.split("refs/tags/")[1] ?? "")
    .filter((t) => t.length > 0 && !t.endsWith("^{}") && t.startsWith("dsh-v"))
    .map((t) => t.slice("dsh-v".length));
  return versions.sort(compareSemverDesc);
}

/**
 * 仓库声明的 packageManager（corepack 格式：`pnpm@11.28.5+sha512.…`）。
 * 原样照抄，**不能只要版本号**：sha512 是 corepack 的完整性检查，丢了它就失去了「装的确实是那版」
 * 的保证。仓库根已经声明过这件事，这里只是把它带进临时目录。
 */
function declaredPackageManager(): string {
  const raw = (readPkg("package.json")?.packageManager as string | undefined) ?? "";
  if (!/^pnpm@\d+\.\d+\.\d+/.test(raw)) {
    throw new Error(`根 package.json 没有可用的 packageManager（现有：${raw || "空"}）`);
  }
  return raw;
}

/**
 * 让 pnpm 自己解一遍这一版的依赖树。
 *
 * **为什么要临时目录**：不是为了避免声明哪个版本（那个版本仓库根早就用 corepack 格式声明了），
 * 而是为了避免副作用。直接在本仓跑 `install` 会改写 `pnpm-lock.yaml`、碰 `node_modules`，
 * 而这是个**只读判定**——它不应该把仓库弄脏。临时目录让整件事变成“拿一份一次性清单问
 * pnpm：这一版解得开吗”，无论结果如何仓库都不变。另外它也让判定与仓库当前状态解耦：
 * 本仓锁文件里可能钉着旧版，那会掩盖新版解不开的事实。
 *
 * 临时清单照拄根的 `packageManager`（含 sha512），**corepack 会照着这个字段自动切到同一版本**，
 * 所以直接跑 `pnpm` 就行——不需要 `npx pnpm@<版>`，也不需要 `pnpm dlx`。
 *
 * （实测过两条弯路：`npx --yes pnpm@<版>` 能跑，但每次要联网确认版本存在，断网就挂；
 * `pnpm dlx pnpm@<版> install` 也能跑且结论一致，但它多一层自己的解析器（会输两行 Done，
 * 内层 11.28.5、外层 12.4.1），冷启动慢一倍，且语义不对——dlx 是「下载并运行一个包的
 * 可执行文件」，而我们要的是「在一个项目里用项目自己声明的那版工具干活」。）
 *
 * 成功看退出码；缺包时 pnpm 报 `ERR_PNPM_NO_MATCHING_VERSION` 并给出该包的最新版本与各通道。
 */
function pnpmResolves(version: string): { ok: boolean; detail: string; ms: number } {
  const packageManager = declaredPackageManager();
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)/.exec(packageManager)![1];
  const dir = mkdtempSync(join(tmpdir(), "dsh-sync-probe-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "dsh-sync-probe",
          version: "0.0.0",
          private: true,
          packageManager,
          dependencies: { [ROOT_PACKAGE]: version },
        },
        null,
        2,
      ),
      "utf8",
    );
    const started = Date.now();
    try {
      execFileSync(
        "pnpm",
        // corepack 会按临时清单里的 packageManager 切到仓库那版；不用 npx / dlx（见函数头注）。
        // 不传 --reporter=silent：它会把错误一并吞掉（实测缺包时 stderr 完全为空），
        // append-only 保留错误行又不刷进度条。
        ["install", "--lockfile-only", "--ignore-scripts", "--reporter=append-only"],
        {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
          timeout: 15 * 60 * 1000,
        },
      );
      const ms = Date.now() - started;
      const lock = join(dir, "pnpm-lock.yaml");
      // pnpm 9 lockfile 把实际安装集放在 `snapshots:` 段；只当活跃观测点，不参与判定
      let snapshots = 0;
      if (existsSync(lock)) {
        const text = readFileSync(lock, "utf8");
        const at = text.indexOf("snapshots:");
        if (at >= 0) snapshots = (text.slice(at).match(/^ {2}\S.*:$/gm) ?? []).length;
      }
      return { ok: true, detail: `pnpm@${pnpmVersion} 解出 ${snapshots} 个包`, ms };
    } catch (e) {
      const ms = Date.now() - started;
      // pnpm 把错误写 stdout（不是 stderr），两处都收；stdout 优先，它带着 ERR_PNPM_* 与版本提示。
      const raw = `${(e as { stdout?: unknown }).stdout ?? ""}\n${(e as { stderr?: unknown }).stderr ?? ""}`;
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("Progress:") && !l.startsWith("[WARN]"));
      // 只要最关键的两行：ERR_PNPM_* 那行与它的原因行
      const head = lines.filter((l) => l.includes("ERR_PNPM") || l.startsWith("No matching") || l.startsWith("This error"));
      return { ok: false, detail: (head.length > 0 ? head : lines).slice(0, 2).join("；") || "pnpm 解析失败", ms };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 本地镜像的某个 tag 是否已 fetch。 */
function mirrorHas(version: string): boolean {
  try {
    const out = execFileSync("git", ["-C", MIRROR, "rev-parse", "--verify", "--quiet", `refs/tags/dsh-v${version}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** 语义化版本降序：先比主次修订，再按预发布段逐段比（alpha < rc，数字按数值比）。 */
export function compareSemverDesc(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split("-");
    return { nums: core.split(".").map(Number), pre: pre === undefined ? null : pre.split(".") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return y.nums[i] - x.nums[i];
  }
  if (x.pre === null && y.pre !== null) return -1;
  if (x.pre !== null && y.pre === null) return 1;
  if (x.pre === null && y.pre === null) return 0;
  const len = Math.max(x.pre!.length, y.pre!.length);
  for (let i = 0; i < len; i++) {
    const p = x.pre![i];
    const q = y.pre![i];
    if (p === undefined) return 1;
    if (q === undefined) return -1;
    const pn = Number(p);
    const qn = Number(q);
    if (!Number.isNaN(pn) && !Number.isNaN(qn) && pn !== qn) return qn - pn;
    if (Number.isNaN(pn) && !Number.isNaN(qn)) return 1;
    if (!Number.isNaN(pn) && Number.isNaN(qn)) return -1;
    if (p !== q) return q < p ? -1 : 1;
  }
  return 0;
}

export interface Verdict {
  version: string;
  gitTagged: boolean;
  mirrorFetched: boolean;
  npmResolved: boolean;
  npmDetail: string;
  npmMs: number;
  gitTagsLatest: string[];
  ready: boolean;
}

export async function probe(version: string): Promise<Verdict> {
  const gitAll = gitTags();
  const resolution = pnpmResolves(version);
  return {
    version,
    gitTagged: gitAll.includes(version),
    mirrorFetched: mirrorHas(version),
    npmResolved: resolution.ok,
    npmDetail: resolution.detail,
    npmMs: resolution.ms,
    gitTagsLatest: gitAll.slice(0, 5),
    ready: gitAll.includes(version) && resolution.ok,
  };
}

function render(v: Verdict, tags: Record<string, string>): void {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const secs = (v.npmMs / 1000).toFixed(1);
  console.log(`\n目标版本 ${v.version}（npm next=${tags.next ?? "-"} / latest=${tags.latest ?? "-"}）\n`);
  console.log(`  ${mark(v.gitTagged)} git ：上游 tag dsh-v${v.version} ${v.gitTagged ? "已存在" : "不存在"}`);
  if (v.gitTagged) {
    console.log(`      ${mark(v.mirrorFetched)} 镜像：本地 ${v.mirrorFetched ? "已 fetch" : "未 fetch（sync:vendor:dsh 会拉）"}`);
  }
  console.log(`  ${mark(v.npmResolved)} npm ：${v.npmDetail}（${secs}s）`);
  console.log(`\n最近的上游 tag：${v.gitTagsLatest.join(" / ")}`);
  console.log(v.ready ? "\n两侧已同步 —— 可以开工。" : "\n尚未同步 —— 还不能跟。");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const wantLatest = argv.includes("--latest");
  const explicit = argv.find((a) => !a.startsWith("--"));

  const tags = await distTags();
  let version = explicit ?? dshPin();
  if (wantLatest) version = tags.next ?? tags.latest ?? version;
  if (!version) {
    console.error("[dsh-sync-probe] 没有目标版本：packages/host/package.json 未声明，也没给参数");
    process.exit(2);
  }

  const verdict = await probe(version);
  if (asJson) console.log(JSON.stringify({ ...verdict, distTags: tags }, null, 2));
  else render(verdict, tags);
  process.exit(verdict.ready ? 0 : 1);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`[dsh-sync-probe] ${(e as Error).message}`);
    process.exit(2);
  });
}
