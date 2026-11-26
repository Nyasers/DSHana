// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/dev/dsh-release-watch.mts — 盯上游 @deepseek-ai/dsh 是否发了比当前 pin 更新的版本，
// 并给出「现在能不能跟」的判定。给本地定时任务与 CI 定时作业共用。
//
// 与 dsh-sync-probe 的分工：probe 回答「这个指定版本能不能跟」，本脚本回答「有没有该跟的新版本」。
// 前者要人报版本号，后者从 registry 的版本全集自己找。
//
// **为什么不看 dist-tags**：rc 通道的 next / latest 由发布者手动推，实测会出现 tag 已打、
// next 仍指旧版的状态（0.2.2-rc.2 就是：git 侧 11-11 已打 tag，npm 版本集里始终没有它，
// next 与 latest 都还停在 rc.1）。所以取版本全集 + 语义化比较，不信通道指针。
//
// 判定只认 probe 的两侧结论：git 侧有 dsh-v<版本> 的 tag、npm 侧那一版能解析成完整依赖树。
// 只有一侧就位就不算「可以跟」——缺 tag 会让 vendored 镜像、overlay 漂移闸、provenance 闸
// 一起红；缺 npm 包会让 pnpm install 直接 ERR_PNPM_NO_MATCHING_VERSION。
//
// 用法：
//   node scripts/dev/dsh-release-watch.mts          # 人读
//   node scripts/dev/dsh-release-watch.mts --json   # 机读
//
// 退出码：
//   0 没有比 pin 更新的版本（常态）
//   1 有新版本，两侧就绪，可以跟
//   2 有新版本，但只有一侧或都没有就位（等）
//   3 出错（取不到 registry、pin 未声明等）
import { isDirectRun } from "../shared/run.mts";
import { dshPin, readHostPkg, readPkg } from "../shared/version.mts";
import { compareSemverDesc, packument, probe } from "./dsh-sync-probe.mts";

const ROOT_PACKAGE = "@deepseek-ai/dsh";

/**
 * 组合层与宿主里钉着当前 pin 的依赖条数——跟进去时要一起换的就是这些。
 * 只数**精确等于 pin** 的条目：`~`/`^` 范围与 vendor 线（cordis / schemastery 各自走版本线）不在此列，
 * 它们是否要动取决于新内核声明了什么范围，属于跟进决策，不该由这里代答。
 */
function pinFootprint(pin: string): { host: number; app: number; peer: number; total: number } {
  const host = readHostPkg() as { dependencies?: Record<string, string> } | undefined;
  const app = readPkg("packages/dsh/app/package.json") as
    | { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    | undefined;
  const count = (obj: Record<string, string> | undefined): number =>
    Object.values(obj ?? {}).filter((spec) => spec === pin).length;
  const hostN = count(host?.dependencies);
  const appN = count(app?.dependencies);
  const peerN = count(app?.peerDependencies);
  return { host: hostN, app: appN, peer: peerN, total: hostN + appN + peerN };
}

export interface WatchResult {
  current: string;
  publishedVersions: number;
  newer: string[];
  target: string | null;
  gitTagged: boolean;
  npmResolved: boolean;
  npmDetail: string;
  mirrorFetched: boolean;
  footprint: { host: number; app: number; peer: number; total: number };
  verdict: "up-to-date" | "ready" | "waiting";
}

export async function watch(): Promise<WatchResult> {
  const pin = dshPin();
  if (!pin) throw new Error("packages/host/package.json 未声明 dependencies['@deepseek-ai/dsh']");

  const root = await packument(ROOT_PACKAGE);
  const versions: string[] = Object.keys(root?.versions ?? {});
  // compareSemverDesc 是降序比较器：a 比 b 新返回负值，故 < 0 即「比 pin 更新」。
  const newer = versions.filter((v) => compareSemverDesc(v, pin) < 0).sort(compareSemverDesc);
  const footprint = pinFootprint(pin);
  const base = { current: pin, publishedVersions: versions.length, newer, footprint };

  if (newer.length === 0) {
    return {
      ...base,
      target: null,
      gitTagged: false,
      npmResolved: false,
      npmDetail: "",
      mirrorFetched: false,
      verdict: "up-to-date",
    };
  }

  const target = newer[0];
  const v = await probe(target);
  return {
    ...base,
    target,
    gitTagged: v.gitTagged,
    npmResolved: v.npmResolved,
    npmDetail: v.npmDetail,
    mirrorFetched: v.mirrorFetched,
    verdict: v.ready ? "ready" : "waiting",
  };
}

function render(r: WatchResult): void {
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  console.log(`[dsh-watch] 当前 pin：${r.current}`);
  console.log(`[dsh-watch] registry 已发布版本：${r.publishedVersions} 个`);
  if (r.verdict === "up-to-date") {
    console.log("[dsh-watch] 没有比 pin 更新的版本，无更新。");
    return;
  }
  const older = r.newer.slice(1, 4);
  console.log(`[dsh-watch] 发现更新的版本：${r.target}${older.length > 0 ? `（另有 ${older.join(" / ")}）` : ""}`);
  console.log(`[dsh-watch]   ${mark(r.gitTagged)} git tag dsh-v${r.target}`);
  console.log(`[dsh-watch]   ${mark(r.npmResolved)} npm：${r.npmDetail}`);
  if (r.gitTagged && !r.mirrorFetched) {
    console.log(`[dsh-watch]   （镜像未 fetch 该 tag，sync:vendor:dsh 时会拉）`);
  }
  console.log(
    `[dsh-watch] 跟随面：host 声明 ${r.footprint.host} 条 / 组合层 dependencies ${r.footprint.app} 条 / peer ${r.footprint.peer} 条，共 ${r.footprint.total} 条`,
  );
  console.log(
    r.verdict === "ready"
      ? "[dsh-watch] 两侧就绪 —— 可以跟。"
      : "[dsh-watch] 尚未同步 —— 还不能跟（缺的那一侧见上）。",
  );
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  try {
    const result = await watch();
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else render(result);
    process.exit(result.verdict === "up-to-date" ? 0 : result.verdict === "ready" ? 1 : 2);
  } catch (e) {
    console.error(`[dsh-watch] ${(e as Error).message}`);
    process.exit(3);
  }
}

if (isDirectRun(import.meta.url)) main();
