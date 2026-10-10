// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/market-pr.mts — 生成投稿 PR 的标题与正文（只出文本，不提交）。
//
// 为什么是这个形态：
//   官方目录（liliMozi/hana-marketplace）只收登记 PR，包本身放在我们自己的 Release 里。登记信息几乎
//   全部可从本仓与 Release 派生：kind/id/repository/publisher 见 market/enrollment.json，tag 就是
//   manifest 的版本号，sha256 照抄 Release 里那份投稿条目的 archive.sha256（市场要求照抄，不自己算）。
//   条目的 sha256 由出包作业对最终产物现算，所以这里等 Release 就绪再去取，而不拿本地包的哈希去登记。
//
//   本脚本**只产出标题与正文**：改 registry/approvals、推分支、开 PR 都在 DSHana 侧完成。生成与提交
//   分开——提交是署名动作，由人收口；脚本只把能自证的事实备齐，不替人做不可逆的对外动作。
//
//   取正文前做一次**不下包**的核对：条目的 archive.sha256/size 与 Release 资产在 API 上的
//   digest/size 逐字比（等价于「把包下下来再哈希」，但一个字节都不下），再拿已上架索引比一次主号不
//   倒退。完整性真正的强校验（下载 + 哈希）留给市场 PR 的 CI 在远端做，本地不重复付那 153 MB。
//
// 正文形状对齐维护者（liliMozi）的更新型 PR：
//   标题 `chore: approve <kind>/<id> <tag>`；
//   正文 = Release / SHA-256（+ 有则 Changes）几行 + 一行本地核对说明 + Changelog 段。
//   · Changes 只用于声明**权限变更等重要变更**，由 --changes 现给；其余「改了什么」下沉到 Changelog
//     段——取自本仓 CHANGELOG.md 的本版本段（含各提交链接），不在这里另写一份，也就不会与它漂移。
//   · 图标预览、截图、自测报告几栏是作者按维护者要求补的审阅材料（见上游 CONTRIBUTING 第 3 节），
//     不由脚本生成：脚本出的是可提交的骨，这几栏按 PR 当期情况手补。
//
// 用法：
//   node scripts/release/market-pr.mts                      # 打印标题与正文
//   node scripts/release/market-pr.mts --changes "…"        # 补 Changes 行（权限变更等重要变更）
//   node scripts/release/market-pr.mts --out .tmp/market-pr # 同时落盘 title.txt / body.md
//   node scripts/release/market-pr.mts --no-wait            # Release 未就绪就报错，不等出包
//   node scripts/release/market-pr.mts --tag v1.0.2+dsh-0.2.0-rc.2
//   node scripts/release/market-pr.mts --tag recipe-2026-10-08   # skill/recipe 无版本号，tag 必须显式给
//
// 进度走 stderr、文本走 stdout：管道那侧拿到的就是标题与正文本身。
// 退出码 0：文本已产出（打印，或按 --out 落盘）。
import fs from "fs-extra";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT } from "../shared/root.mts";
import { manifestPath } from "../shared/contract-assets.mts";

/** 取件用的临时目录：在 .cache/ 下（已 gitignore），用完即删，不留痕。 */
const SCRATCH = join(ROOT, ".cache", "market-pr");
/** skill / recipe 没有版本号：按内容哈希更新，`entry.version` 恒为 `0.0.0`，条目名也不带版本
 *  （`<kind>-<id>.entry.json`），Release tag 由作者自己定（形如 `recipe-2026-10-08`）。
 *  app / connector / role / bundle 走 `<kind>-<id>-<version>.entry.json` 与 `v<version>`。 */
const VERSIONLESS_KINDS = new Set(["skill", "recipe"]);
/** 等 Release 就绪的上限：CI 出六个平台包加通用包，实测十几分钟。 */
const WAIT_MS = 40 * 60 * 1000;
const POLL_MS = 15 * 1000;

interface Enrollment {
  kind: string;
  id: string;
  repository: string;
  publisher: string;
  upstream: string;
}

function arg(name: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

const noWait = process.argv.includes("--no-wait");
const outDir = arg("--out");
const cliChanges = arg("--changes");
const log = (m: string): void => console.error(`[market-pr] ${m}`);

/** 无代理环境下跑 gh，并给 git 固定 HTTP/1.1。
 *  宿主环境里的 HTTP(S)_PROXY 可能指向已停的代理，会让 gh 连接失败；而 HTTP/2 过某些代理中转会
 *  Recv failure: Connection was reset。两者都在这里绕开，不依赖跑脚本的人先改好环境。
 *  maxBuffer 显式抬到 64 MB：execFileSync 默认只有 1 MB，而上游索引单份就 2.6 MB，
 *  超限会以 ENOBUFS 抛出而不报是缓冲太小。 */
function exec(bin: string, args: string[], cwd = ROOT): string {
  const env = { ...process.env };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]) delete env[k];
  const finalArgs = bin === "git" ? ["-c", "http.version=HTTP/1.1", ...args] : args;
  return execFileSync(bin, finalArgs, { cwd, encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }).trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** gh release view 取回的那几栏。写成命名接口，不用 `typeof info`：在 `let info: T | null = null`
 *  之后，`typeof info` 取到的是已被收窄成 null 的类型，解码出来的对象就落到 never 上。 */
interface ReleaseInfo {
  isDraft: boolean;
  isPrerelease: boolean;
  assets: { name: string; size: number; digest?: string }[];
}

/** 条目里 archive.url 的形态是 `{{BASE_URL}}/<zip 名>`（协议要求），取出 ZIP 名好在本 Release 里核对它真在。 */
function zipNameOf(url: string): string | null {
  const m = /^\{\{BASE_URL\}\}\/([^/]+\.zip)$/.exec(String(url || ""));
  return m ? m[1] : null;
}

/** 等投稿条目就位（CI 出包），并确认 Release 已可上架；返回条目的 sha256/publisher。
 *  市场只收既不是 draft、也不是 prerelease 的正式 Release，而流水线建的是 draft pre-release、publish
 *  只去 draft 而保留 prerelease——标稳定版（--prerelease=false --latest）是「要不要上架」的人工决定，
 *  不属于发版流程，所以这里**不等**它：已经稳定就继续，否则直接报错并给出该跑的命令。
 *  条目本身要等（CI 出包要十几分钟），那是构建在跑、不是人在决策。
 *  条目与它所指的 ZIP 必须同属这个 Release：市场侧按 approvals 的记录去那个 Release 取件，只传了
 *  条目、漏传 ZIP 的话要等那边下载才炸；这里就地核对（存在 + 字节数与条目一致），fail-fast。
 *  `wait=false` 时连条目也只探一次。 */
async function waitForRelease(
  tag: string,
  repo: string,
  entryName: string,
  wait: boolean,
): Promise<{ sha256: string; size: number; publisher: string }> {
  const deadline = Date.now() + (wait ? WAIT_MS : 0);
  // 命中那次的资产清单：条目下载完要拿它核对条目所指的 ZIP（名称 + 字节数）。
  let assets: { name: string; size: number }[] = [];
  for (;;) {
    let info: ReleaseInfo | null = null;
    try {
      const raw = exec("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft,isPrerelease,assets"]);
      info = JSON.parse(raw) as ReleaseInfo;
    } catch {
      // Release 尚未创建：出包作业还在跑，下一轮再看
    }
    const hasEntry = info !== null && info.assets.some((a: { name: string }) => a.name === entryName);
    const stable = info !== null && !info.isDraft && !info.isPrerelease;
    if (hasEntry) {
      if (!stable) {
        throw new Error(
          `${tag} 还不是可上架的正式 Release（draft=${info!.isDraft} prerelease=${info!.isPrerelease}）。\n` +
            `  要上架就先标稳定版，再跑本脚本：\n` +
            `    gh release edit ${tag} --repo ${repo} --prerelease=false --latest`,
        );
      }
      assets = info!.assets;
      break;
    }
    if (!wait) {
      throw new Error(
        info === null ? `${tag} 还不存在——--no-wait 不等出包` : `${tag} 还没有 ${entryName}——--no-wait 不等出包`,
      );
    }
    if (Date.now() > deadline) throw new Error(`等 ${tag} 的 ${entryName} 超时（${WAIT_MS / 60000} 分钟）`);
    log(`等 ${entryName} 就位（出包作业在跑）…`);
    await sleep(POLL_MS);
  }
  fs.removeSync(SCRATCH);
  fs.ensureDirSync(SCRATCH);
  exec("gh", ["release", "download", tag, "--repo", repo, "--pattern", entryName, "--dir", SCRATCH, "--clobber"]);
  const entry = fs.readJsonSync(join(SCRATCH, entryName)) as {
    archive: { url: string; sha256: string; size: number };
  };
  fs.removeSync(SCRATCH);
  const zipName = zipNameOf(entry.archive.url);
  if (!zipName) throw new Error(`条目里的 archive.url 不是 {{BASE_URL}}/<zip> 形态：${entry.archive.url}`);
  const zip = assets.find((a) => a.name === zipName);
  if (!zip) throw new Error(`${tag} 里没有条目所指的 ZIP ${zipName}（只传了条目？先补齐资产再上架）`);
  if (zip.size !== entry.archive.size) {
    throw new Error(`${zipName} 字节数与条目不符：Release 资产 ${zip.size} ≠ 条目 archive.size ${entry.archive.size}`);
  }
  // 完整性用 API 核对，不下包：Release 资产自带 sha256 digest（上传时由 GitHub 算），把它与条目
  // archive.sha256 逐字比，等价于「下下来再哈希」。digest 缺失（旧资产）时退化成只核字节数并说明。
  const declared = String(entry.archive.sha256).trim().toLowerCase();
  const digest = String(zip.digest || "").replace(/^sha256:/i, "").toLowerCase();
  if (digest && digest !== declared) {
    throw new Error(`${zipName} 的 sha256 与条目不符：资产 digest ${digest} ≠ 条目 archive.sha256 ${declared}`);
  }
  if (!digest) log(`注意：${zipName} 在 API 上没有 digest，只核了字节数（完整性留给市场侧核）`);
  return { sha256: declared, size: entry.archive.size, publisher: String(entry.publisher || "") };
}

/** 版本主号（major.minor.patch）逐段比：只用来拦「明显往回打」，pre 段的细则交给市场侧。 */
function coreDowngrade(next: string, prev: string): boolean {
  const parts = (v: string): number[] =>
    String(v)
      .replace(/^v/, "")
      .split("+")[0]
      .split("-")[0]
      .split(".")
      .map((n) => Number(n) || 0);
  const a = parts(next);
  const b = parts(prev);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** 上游已上架索引（index.v2.json）：只读一次，读不到就返回 null（离线或首次上架时跳过版本比对）。
 *  走 gh api 的 raw 媒体类型：这份索引已过 1 MB，contents API 对内联内容有 1 MB 上限（超了只回
 *  元数据、content 为空），默认形态会静默拿到空串。拿它只为比一次主号不倒退，不为此拉工作副本。 */
function publishedIndex(
  upstream: string,
): { items: { kind: string; id: string; version: string; publisher?: string }[] } | null {
  try {
    const raw = exec("gh", [
      "api",
      `repos/${upstream}/contents/index.v2.json`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as {
      items: { kind: string; id: string; version: string; publisher?: string }[];
    };
  } catch {
    return null;
  }
}

/** 出正文前补身份与版本：条目里的 publisher 要跟登记一致；版本主号不得往回打。带 pre 段的完整排序不在
 *  本地重造——市场侧的 historyFor 会据已上架索引拒降级，而那道闸跑在 PR 检查里。
 *
 *  返回**已上架的那个版本**（读不到索引、首次上架、或该 kind 无版本号时为 null）：它同时是 Changelog 段
 *  的区间起点——上次登记到现在跳过的那几版要并进同一条 PR 的正文，见 changelogSection。 */
function preflightPublished(enr: Enrollment, version: string, entryPublisher: string): string | null {
  if (entryPublisher && entryPublisher !== enr.publisher) {
    throw new Error(
      `条目里的 publisher（${entryPublisher}）与登记（${enr.publisher}）不一致，市场会拒：` +
        `先对齐 market/enrollment.json 与出包时的 --publisher`,
    );
  }
  const idx = publishedIndex(enr.upstream);
  if (!idx) {
    log("读不到上游 index.v2.json，跳过版本比对");
    return null;
  }
  const pub = idx.items.find((i) => i.kind === enr.kind && i.id === enr.id);
  if (!pub) {
    log(`索引里还没有 ${enr.kind}/${enr.id}（首次上架）`);
    return null;
  }
  if (pub.publisher && pub.publisher !== enr.publisher) {
    log(`注意：发布者与已上架不同（${pub.publisher} → ${enr.publisher}），PR 正文里要写明登记变更`);
  }
  // skill / recipe 按内容哈希更新，`0.0.0` 不是版本语义，比版本没意义（市场侧 historyFor 同样跳过）。
  if (VERSIONLESS_KINDS.has(enr.kind)) {
    log(`${enr.kind} 没有版本号（按内容哈希），跳过版本比对`);
    return null;
  }
  if (coreDowngrade(version, pub.version)) {
    throw new Error(`版本倒退：本次 ${version} < 已上架 ${pub.version}，市场侧的 historyFor 会拒`);
  }
  log(`已上架 ${pub.version} → 本次 ${version}（主号不降级）`);
  return pub.version;
}

/** CHANGELOG.md 里的一个版本段：版本号、标题带的 compare 链接，以及标题行之后的原文。 */
interface VersionSection {
  version: string;
  url: string;
  lines: string[];
}

/** 按 `## [版本](链接)` 把 CHANGELOG.md 切成版本段（文件里新版本在前）。 */
function parseChangelog(text: string): VersionSection[] {
  const lines = text.split(/\r?\n/);
  const heads: { index: number; version: string; url: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^## \[([^\]]+)\]\(([^)]+)\)/.exec(lines[i]);
    if (m) heads.push({ index: i, version: m[1], url: m[2] });
  }
  return heads.map((h, i) => ({
    version: h.version,
    url: h.url,
    lines: lines.slice(h.index + 1, i + 1 < heads.length ? heads[i + 1].index : lines.length),
  }));
}

/** 段内的分节（`### 标题` 与其后的 `* ` 条目），条目行原样保留（带各自的提交链接）。 */
function parseSubsections(lines: string[]): { title: string; items: string[] }[] {
  const out: { title: string; items: string[] }[] = [];
  let cur: { title: string; items: string[] } | null = null;
  for (const line of lines) {
    const head = /^### (.+)$/.exec(line);
    if (head) {
      cur = { title: head[1].trim(), items: [] };
      out.push(cur);
      continue;
    }
    if (cur && /^\* /.test(line)) cur.items.push(line.trim());
  }
  return out.filter((s) => s.items.length > 0);
}

/** 分节的 house 顺序（与 CHANGELOG.md 的生成顺序一致）；表外的标题排在其后，按首次出现。 */
const SECTION_ORDER = ["Features", "Bug Fixes", "Performance Improvements"];

/**
 * Changelog 段：取 **上次已上架版本 → 本次版本** 这个区间的改动，中间跳过的版本一并并入。
 *
 * 区间而不是单版本，是因为市场只按 approvals 的记录读 Release：上次登记之后直接跳过的那几版
 * 从没出现在任何 PR 正文里，只列本次会把它们丢掉（#30 就是这样把 v1.0.3 并进 v1.0.4 那段的）。
 * 段落按分节归并（同一标题只出一个），条目按版本从新到旧、版本内保持 CHANGELOG 的原序；
 * compare 链接也按区间拼（上次已上架 → 本次），而不是照抄 CHANGELOG 标题里那对相邻版本。
 *
 * 取不到本次版本段就返回 null，调用方省掉 Changelog 段而不是塞一句内部口吻的占位。
 * 纯函数（文本进、段落出），好让跳版本的合并逻辑能被测试直接钉住。
 */
export function buildChangelogSection(
  text: string,
  currentVersion: string,
  sinceVersion: string | null,
  repo: string,
): { url: string; body: string } | null {
  const sections = parseChangelog(text);
  const curAt = sections.findIndex((s) => s.version === currentVersion);
  if (curAt < 0) return null;
  // 上次已上架版本比本次旧（在文件里更靠后）→ 区间含它到本次之间的所有版本；否则只取本次
  // （首次上架、读不到索引、或重跑同一版本都是后者）。
  const sinceAt = sinceVersion ? sections.findIndex((s) => s.version === sinceVersion) : -1;
  const end = sinceAt > curAt ? sinceAt : curAt + 1;
  const range = sections.slice(curAt, end);
  const buckets = new Map<string, string[]>();
  for (const sec of range) {
    for (const sub of parseSubsections(sec.lines)) {
      buckets.set(sub.title, [...(buckets.get(sub.title) ?? []), ...sub.items]);
    }
  }
  const rank = (t: string): number => {
    const at = SECTION_ORDER.indexOf(t);
    return at >= 0 ? at : SECTION_ORDER.length;
  };
  const titles = [...buckets.keys()].sort((a, b) => rank(a) - rank(b));
  const body = titles.map((t) => `### ${t}\n\n${buckets.get(t)!.join("\n")}`).join("\n\n");
  const enc = (t: string): string => t.replace(/\+/g, "%2B");
  const url =
    sinceAt >= 0 && sinceAt !== curAt
      ? `https://github.com/${repo}/compare/${enc(`v${sinceVersion}`)}...${enc(`v${currentVersion}`)}`
      : sections[curAt].url;
  if (range.length > 1) {
    log(`Changelog 段并入 ${range.length} 个版本段（${sinceVersion} 之后到 ${currentVersion}）`);
  }
  return { url, body };
}

/** 读本仓 CHANGELOG.md 拼 Changelog 段（拼装逻辑见 buildChangelogSection）。 */
function changelogSection(
  currentVersion: string,
  sinceVersion: string | null,
  repo: string,
): { url: string; body: string } | null {
  const file = join(ROOT, "CHANGELOG.md");
  if (!fs.existsSync(file)) return null;
  return buildChangelogSection(String(fs.readFileSync(file, "utf8")), currentVersion, sinceVersion, repo);
}

async function main(): Promise<void> {
  const enr = fs.readJsonSync(join(ROOT, "market", "enrollment.json")) as Enrollment;
  const manifest = fs.readJsonSync(manifestPath(ROOT)) as { version: string };
  const versioned = !VERSIONLESS_KINDS.has(enr.kind);
  // 默认 tag 只有带版本的扩展推得出来（`v<manifest 版本>`）；skill / recipe 没有版本号，必须显式给 --tag。
  const tag = arg("--tag") || (versioned ? `v${manifest.version}` : null);
  if (!tag) {
    throw new Error(
      `${enr.kind} 没有版本号（按内容哈希更新），默认 tag 推不出来——用 --tag 指定 Release tag（形如 recipe-2026-10-08）`,
    );
  }
  // 条目名按**所选 tag** 的版本取，不按本地 manifest：--tag 指旧版本时，拿当前 manifest 去搜那个 Release
  // 只会一直等不到。两者不一致时提示一声（正常发版流程里它们相等）。
  const version = tag.replace(/^v/, "");
  if (versioned && version !== manifest.version) {
    log(`注意：--tag ${tag} 与本地 manifest 的 ${manifest.version} 不同，按 tag 的版本找条目`);
  }
  // 条目名分两形：带版本的扩展带版本段，skill / recipe 不带（它们的 entry.version 恒为 0.0.0）。
  const entryName = versioned
    ? `${enr.kind}-${enr.id}-${version}.entry.json`
    : `${enr.kind}-${enr.id}.entry.json`;

  log(`登记 ${enr.kind}/${enr.id} · tag ${tag}${versioned ? "" : "（无版本号，按内容哈希）"}`);
  const { sha256, publisher } = await waitForRelease(tag, enr.repository, entryName, !noWait);
  log(`条目 sha256 ${sha256}`);
  const publishedVersion = preflightPublished(enr, version, publisher);

  const title = `chore: approve ${enr.kind}/${enr.id} ${tag}`;
  const releaseUrl = `https://github.com/${enr.repository}/releases/tag/${tag.replace(/\+/g, "%2B")}`;
  const changelog = changelogSection(version, publishedVersion, enr.repository);
  // Release / SHA-256 是脚本能自证的事实；Changes 只放重要变更（--changes 现给）；其余改了什么归 Changelog 段。
  const body = [
    `Approve the new ${enr.id} ${enr.kind} release.`,
    "",
    `- Release: ${releaseUrl}`,
    `- SHA-256: \`${sha256}\``,
    ...(cliChanges ? [`- Changes: ${cliChanges}`] : []),
    "",
    "Local check: 条目与 Release 资产按 API 核对一致（sha256 digest + 字节数），未下载安装包。",
    ...(changelog ? ["", `## [Changelog](${changelog.url})`, "", changelog.body] : []),
  ].join("\n");

  if (cliChanges) log("Changes 行取自 --changes");
  else log("未给 --changes：正文不带 Changes 行（它只用于权限变更等重要变更，其余见 Changelog 段）");
  if (!changelog) log(`注意：CHANGELOG 里没有 ${version} 那一段，正文不带 Changelog 段`);
  log("本脚本只出文本：registry/approvals 的改动、推分支与开 PR 在 DSHana 侧完成");

  if (outDir) {
    fs.ensureDirSync(outDir);
    fs.writeFileSync(join(outDir, "title.txt"), `${title}\n`, "utf8");
    fs.writeFileSync(join(outDir, "body.md"), `${body}\n`, "utf8");
    log(`已落盘：${join(outDir, "title.txt")} / ${join(outDir, "body.md")}`);
  }
  process.stdout.write(`${title}\n\n${body}\n`);
}

// 直跑才执行主流程：纯函数（Changelog 段拼装）被测试导入时，不应触发整条网络流程。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
