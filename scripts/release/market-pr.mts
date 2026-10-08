// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/market-pr.mts — 把本版本的投稿备成一份针对上游目录的 draft PR。
//
// 为什么是这个形态：
//   官方目录（liliMozi/hana-marketplace）只收登记 PR，包本身放在我们自己的 Release 里。要往别人的仓库
//   开 PR，head 必须落在「我们有写权限、且是它的 fork」的仓库上（GitHub 要求 head 分支可写），所以数据
//   住上游、出口则是我们的 fork —— 脚本把这两头接起来，fork 只当一次性出口：main 恒等于上游，改动走
//   一次性分支，因此 fork 随时可以删掉重建。
//
//   登记内容几乎全部可从本仓派生：kind/id/repository/publisher 见 market/enrollment.json，tag 就是
//   manifest 的版本号，sha256 照抄 Release 里那份投稿条目的 archive.sha256（市场要求照抄，不自己算）。
//   条目的 sha256 由出包作业对最终产物现算，所以这里等 Release 就绪再去取，而不拿本地包的哈希去登记。
//
//   开 PR 前做一次**不下包**的核对：条目的 archive.sha256/size 与 Release 资产在 API 上的 digest/size
//   逐字比（等价于"把通用包下下来再哈希"，但一个字节都不下），再拿已上架索引比一次主号不倒退。
//   完整性真正的强校验（下载 + 哈希）留给市场 PR 的 CI 在远端做，本地不重复付那 153 MB；要在这边
//   也跑同一道强校验就加 --deep-check（它会下载已批准的包）。
//   开出来的 draft PR 形状对齐维护者（liliMozi）的更新型 PR：标题 `chore: approve <kind>/<id> <tag>`，
//   正文是 Release / SHA-256 / Changes（待人工补）三段 + 一行本地核对说明。skill / recipe 没有版本号
//   （`entry.version` 恒为 0.0.0、按内容哈希更新），标题那一位本来就是 tag，条目名也不带版本段。
//   审阅材料（PR 模板那几栏）不由脚本填，draft 留着人工补。
//
//   提交信息可以自己给（与 `git commit` 同规则）：`-m "标题" -m "正文段落"`（多段空行相连）或
//   `-F <文件>` 整份读；给了就用它（首行当标题）。只想补"这次改了什么"那一行就用 `--changes`，
//   其余（Release / SHA-256 / Local check）都是脚本能自证的事实，不用手抄。
//
//   署名与 GitHana 的 git_commit 同款：提交签名复用 GitHana 的隔离环（`GIT_CONFIG_GLOBAL` 指向它的
//   隔离 gitconfig、`GNUPGHOME` 指向它的 gnupg），身份与密钥都取自那份——密钥不出那个 App 的边界，
//   也不碰用户个人的 `~/.gitconfig` 与个人 GPG 环。签名 key 与提交身份对不上时 GitHub 会判
//   unknown_key / Unverified（PR #29 的 81fc18e 就是这样）；agent 的署名走 Co-authored-by 尾注。
//
// 用法：
//   node scripts/release/market-pr.mts                       # 等 Release 就绪 → API 侧核对 → 备 PR
//   node scripts/release/market-pr.mts --dry-run             # 只打印将要提交的标题/正文，不推不改远端
//   node scripts/release/market-pr.mts --deep-check          # 额外跑市场同步器的强校验（会下载已批准的包）
//   node scripts/release/market-pr.mts --changes "…"         # 只补 Changes 那行，其余自动生成
//   node scripts/release/market-pr.mts -m "chore: approve …" -m "正文段落"   # 自带提交信息（同 git commit）
//   node scripts/release/market-pr.mts -F .tmp/pr-body.md                    # 从文件读提交信息
//   node scripts/release/market-pr.mts --tag v1.0.2+dsh-0.2.0-rc.2
//   node scripts/release/market-pr.mts --tag recipe-2026-10-08   # skill/recipe 无版本号，tag 必须显式给
//
// 退出码 0 的三种情形：已备好 PR（打印 URL）、该版本已登记（无事可做）、--dry-run 走完。
import fs from "fs-extra";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { ROOT } from "../shared/root.mts";
import { manifestPath } from "../shared/contract-assets.mts";
import { errText } from "../shared/err-text.mts";

/** fork 的本地工作副本：在 .cache/ 下，随出包清缓存一起清掉，不留痕。 */
const WORK = join(ROOT, ".cache", "market-fork");
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
  fork: string;
  defaultBranch?: string;
}

function arg(name: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

const dryRun = process.argv.includes("--dry-run");
const deepCheck = process.argv.includes("--deep-check");
const log = (m: string): void => console.log(`[market-pr] ${m}`);

/** agent 的协作署名尾注：与 GitHana 的 git_commit 同款（提交身份是人，署名是 agent）。 */
const AGENT_SIGNATURE = "Co-authored-by: HanaAgent <313794804+HanaAgent@users.noreply.github.com>";

/** 收集一个可重复旗标的全部取值（`-m x -m y` / `--message x` / `--message=x` 三种写法都收）。
 *  与 `arg()` 的区别：后者只取第一个、且拒收以 `--` 开头的值；提交信息是多段的，得全收。 */
function values(name: string, short: string): string[] {
  const argv = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === name || a === short) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${a} 缺值`);
      out.push(next);
      i += 1;
      continue;
    }
    if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  }
  return out;
}

/** 提交信息（标题 + 正文）：规则与 `git commit` 一致——首行是标题，其余是正文；多个 `-m` 之间空行
 *  相连；也可以 `-F <文件>` 整份读进来（按当前工作目录解析）。两种只能用一种（同 git 规则）。
 *  什么都没给就返回 null，由调用方按市场形状生成。 */
function submissionMessage(): { title: string; body: string } | null {
  const messages = values("--message", "-m");
  const file = arg("--file") || arg("-F");
  if (messages.length && file) throw new Error("-m/--message 与 -F/--file 只能给一种（同 git commit）");
  const raw = file ? fs.readFileSync(file, "utf8") : messages.join("\n\n");
  if (!raw.trim()) return null;
  const lines = raw.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  const title = (lines.shift() || "").trim();
  if (!title) throw new Error("提交信息的首行是标题，不能为空");
  return { title, body: lines.join("\n").replace(/^\n+/, "") };
}

// 提交信息（命令行给的）：-m/-F 给整份，或 --changes 只补那一行，两者互斥。参数错要当场报，
// 不拖到跑完网络步骤才说。
const cliMessage = submissionMessage();
const cliChanges = arg("--changes");
if (cliMessage && cliChanges) throw new Error("已用 -m/-F 给整份提交信息，就不要再给 --changes");

/** 宿主根（GitHana 的隔离签名环在它的 app-data 下）。 */
const HANA_HOME = process.env.HANA_HOME || join(homedir(), ".hanako");

/** 提交签名复用 GitHana 的隔离环：`GIT_CONFIG_GLOBAL` 指向它的隔离 gitconfig（user.* / commit.gpgsign /
 *  gpg.program 都在那份里），`GNUPGHOME` 指向它的 gnupg。key 不出那个 App 的边界，也不碰用户个人的
 *  `~/.gitconfig` 与个人 GPG 环——签出来的是与 GitHana 的 git_commit 同一把钥匙（我们仓库里那些
 *  Verified 提交就是它签的）。缺了 fail-closed：没有隔离环就宁可停，不拿个人环偷偷签。 */
function signingEnv(): Record<string, string> {
  const dataDir = join(HANA_HOME, "app-data", "githana");
  const gitconfig = join(dataDir, "gitconfig");
  const gnupg = join(dataDir, "gnupg");
  if (!fs.existsSync(gitconfig) || !fs.existsSync(gnupg)) {
    throw new Error(`找不到 GitHana 的隔离签名环（${dataDir}）：先在 GitHana 里生成 GPG 密钥，再跑本脚本`);
  }
  return { GIT_CONFIG_GLOBAL: gitconfig, GNUPGHOME: gnupg, GIT_TERMINAL_PROMPT: "0" };
}

/** 无代理环境下跑 gh / git，并给 git 固定 HTTP/1.1。
 *  宿主环境里的 HTTP(S)_PROXY 可能指向已停的代理，会让 gh 连接失败；而 HTTP/2 过某些代理中转会
 *  Recv failure: Connection was reset。两者都在这里绕开，不依赖跑脚本的人先改好环境。 */
function exec(bin: string, args: string[], cwd = ROOT, extraEnv: Record<string, string> = {}): string {
  const env = { ...process.env, ...extraEnv };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"]) delete env[k];
  const finalArgs = bin === "git" ? ["-c", "http.version=HTTP/1.1", ...args] : args;
  return execFileSync(bin, finalArgs, { cwd, encoding: "utf8", env }).trim();
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

/** 等投稿条目就位（CI 出包），并确认 Release 已可上架；返回条目对象。
 *  市场只收既不是 draft、也不是 prerelease 的正式 Release，而流水线建的是 draft pre-release、publish
 *  只去 draft 而保留 prerelease——标稳定版（--prerelease=false --latest）是「要不要上架」的人工决定，
 *  不属于发版流程，所以这里**不等**它：已经稳定就继续，否则直接报错并给出该跑的命令。
 *  条目本身要等（CI 出包要十几分钟），那是构建在跑、不是人在决策。
 *  条目与它所指的 ZIP 必须同属这个 Release：市场侧按 approvals 的记录去那个 Release 取件，只传了
 *  条目、漏传 ZIP 的话要等那边下载才炸；这里就地核对（存在 + 字节数与条目一致），fail-fast。
 *  `wait=false` 时连条目也只探一次（--dry-run 用）。 */
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
        info === null ? `${tag} 还不存在——--dry-run 不等出包` : `${tag} 还没有 ${entryName}——--dry-run 不等出包`,
      );
    }
    if (Date.now() > deadline) throw new Error(`等 ${tag} 的 ${entryName} 超时（${WAIT_MS / 60000} 分钟）`);
    log(`等 ${entryName} 就位（出包作业在跑）…`);
    await sleep(POLL_MS);
  }
  const dir = join(WORK, "_entry");
  fs.removeSync(dir);
  fs.ensureDirSync(dir);
  exec("gh", ["release", "download", tag, "--repo", repo, "--pattern", entryName, "--dir", dir, "--clobber"]);
  const entry = fs.readJsonSync(join(dir, entryName)) as {
    archive: { url: string; sha256: string; size: number };
  };
  fs.removeSync(dir);
  const zipName = zipNameOf(entry.archive.url);
  if (!zipName) throw new Error(`条目里的 archive.url 不是 {{BASE_URL}}/<zip> 形态：${entry.archive.url}`);
  const zip = assets.find((a) => a.name === zipName);
  if (!zip) throw new Error(`${tag} 里没有条目所指的 ZIP ${zipName}（只传了条目？先补齐资产再上架）`);
  if (zip.size !== entry.archive.size) {
    throw new Error(`${zipName} 字节数与条目不符：Release 资产 ${zip.size} ≠ 条目 archive.size ${entry.archive.size}`);
  }
  // 完整性用 API 核对，不下包：Release 资产自带 sha256 digest（上传时由 GitHub 算），把它与条目
  // archive.sha256 逐字比，等价于"下下来再哈希"。digest 缺失（旧资产）时退化成只核字节数并说明。
  const declared = String(entry.archive.sha256).trim().toLowerCase();
  const digest = String(zip.digest || "").replace(/^sha256:/i, "").toLowerCase();
  if (digest && digest !== declared) {
    throw new Error(`${zipName} 的 sha256 与条目不符：资产 digest ${digest} ≠ 条目 archive.sha256 ${declared}`);
  }
  if (!digest) log(`注意：${zipName} 在 API 上没有 digest，只核了字节数（完整性留给市场侧核）`);
  return { sha256: declared, size: entry.archive.size, publisher: String(entry.publisher || "") };
}

/** 把 fork 的默认分支对齐到上游：main 恒等于上游，改动一律走一次性分支。 */
function syncFork(enr: Enrollment): void {
  const branch = enr.defaultBranch || "main";
  if (!fs.existsSync(join(WORK, ".git"))) {
    fs.removeSync(WORK);
    exec("git", ["clone", `https://github.com/${enr.fork}.git`, WORK]);
  } else {
    exec("git", ["fetch", "origin", "--prune"], WORK);
  }
  exec("git", ["checkout", branch], WORK);
  exec("git", ["reset", "--hard", `origin/${branch}`], WORK);
  // 上游远端：存在就改地址，避免重复 add 报错（fork 的工作副本会在 .cache 里留存复用）
  try {
    exec("git", ["remote", "get-url", "upstream"], WORK);
    exec("git", ["remote", "set-url", "upstream", `https://github.com/${enr.upstream}.git`], WORK);
  } catch {
    exec("git", ["remote", "add", "upstream", `https://github.com/${enr.upstream}.git`], WORK);
  }
  exec("git", ["fetch", "upstream", branch], WORK);
  exec("git", ["reset", "--hard", `upstream/${branch}`], WORK);
}

/** 在读写的两个登记文件里找本扩展那条。 */
function findBy<T extends { kind: string; id: string }>(list: T[], id: string, kind: string): T | undefined {
  return list.find((e) => e.id === id && e.kind === kind);
}

/** 开 PR 前**不下包**的核对：条目与 Release 资产的完整性那一半已在 waitForRelease 里做过（API digest），
 *  这里补身份与版本：条目里的 publisher 要跟登记一致；版本主号不得往回打。带 pre 段的完整排序不在本地
 *  重造——市场侧的 historyFor 会据已上架索引拒降级，而那道闸跑在 PR 检查里。 */
function preflightPublished(enr: Enrollment, version: string, entryPublisher: string): void {
  if (entryPublisher && entryPublisher !== enr.publisher) {
    throw new Error(
      `条目里的 publisher（${entryPublisher}）与登记（${enr.publisher}）不一致，市场会拒：` +
        `先对齐 market/enrollment.json 与出包时的 --publisher`,
    );
  }
  const indexPath = join(WORK, "index.v2.json");
  if (!fs.existsSync(indexPath)) {
    log("fork 里没有已上架索引（index.v2.json），跳过版本比对");
    return;
  }
  const idx = fs.readJsonSync(indexPath) as {
    items: { kind: string; id: string; version: string; publisher?: string }[];
  };
  const pub = idx.items.find((i) => i.kind === enr.kind && i.id === enr.id);
  if (!pub) {
    log(`索引里还没有 ${enr.kind}/${enr.id}（首次上架）`);
    return;
  }
  if (pub.publisher && pub.publisher !== enr.publisher) {
    log(`注意：发布者与已上架不同（${pub.publisher} → ${enr.publisher}），PR 正文里要写明登记变更`);
  }
  // skill / recipe 按内容哈希更新，`0.0.0` 不是版本语义，比版本没意义（市场侧 historyFor 同样跳过）。
  if (VERSIONLESS_KINDS.has(enr.kind)) {
    log(`${enr.kind} 没有版本号（按内容哈希），跳过版本比对`);
    return;
  }
  if (coreDowngrade(version, pub.version)) {
    throw new Error(`版本倒退：本次 ${version} < 已上架 ${pub.version}，市场侧的 historyFor 会拒`);
  }
  log(`已上架 ${pub.version} → 本次 ${version}（主号不降级）`);
}

/** 版本主号（major.minor.patch）逐段比：只用来拦"明显往回打"，pre 段的细则交给市场侧。 */
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

/** 强校验（可选，--deep-check）：跑市场仓库自己的同步器 --check。它与市场 PR 的 CI、维护者侧是同一道
 *  闸，但会按 approvals 的登记去真下载已批准的包（本扩展那条就是 153 MB 的通用包），所以默认不跑。 */
function runDeepMarketCheck(): void {
  const script = join(WORK, "scripts", "extension-market-sync.mjs");
  if (!fs.existsSync(script)) throw new Error(`市场仓库里没有同步器：${script}（fork 没同步到上游 main？）`);
  log("强校验：node scripts/extension-market-sync.mjs --check（会下载已批准的包，稍等）…");
  const argv = ["--registry", "registry.json", "--approvals", "approvals.json", "--previous", "index.v2.json", "--out", "index.v2.json", "--check"];
  try {
    const out = exec(process.execPath, [script, ...argv], WORK);
    log("强校验通过：" + (out.split(/\r?\n/).filter(Boolean).slice(-1)[0] || "（无输出）"));
  } catch (e) {
    const failed = e as { stdout?: unknown; stderr?: unknown };
    const detail = `${String(failed.stdout ?? "")}${String(failed.stderr ?? "")}`.trim() || errText(e);
    throw new Error("强校验未通过（市场同步器 --check）：\n" + detail + "\n  先修 Release 或 approvals 记录，再重跑本脚本");
  }
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
  const { sha256, size, publisher } = await waitForRelease(tag, enr.repository, entryName, !dryRun);
  log(`条目 sha256 ${sha256}（${size} 字节）`);

  syncFork(enr);
  const registryPath = join(WORK, "registry.json");
  const approvalsPath = join(WORK, "approvals.json");
  const registry = fs.readJsonSync(registryPath) as { schemaVersion: number; entries: { kind: string; id: string }[] };
  const approvals = fs.readJsonSync(approvalsPath) as {
    schemaVersion: number;
    approvals: { kind: string; id: string; tag: string; sha256: string }[];
  };

  const existing = findBy(approvals.approvals, enr.id, enr.kind);
  if (existing && existing.tag === tag && existing.sha256 === sha256) {
    log(`该版本已登记（tag ${tag}），无事可做`);
    return;
  }

  const needRegistry = findBy(registry.entries, enr.id, enr.kind) === undefined;
  if (existing) {
    existing.tag = tag;
    existing.sha256 = sha256;
    log(`更新 approvals.json：${enr.id} → ${tag}`);
  } else {
    approvals.approvals.push({ kind: enr.kind, id: enr.id, tag, sha256 });
    log(`新增 approvals.json：${enr.id} → ${tag}`);
  }
  if (needRegistry) {
    registry.entries.push({ kind: enr.kind, id: enr.id, repository: enr.repository, publisher: enr.publisher } as never);
    log(`新增 registry.json：${enr.id} ← ${enr.repository}`);
  }

  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  fs.writeFileSync(approvalsPath, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
  const diff = exec("git", ["diff", "--stat"], WORK);
  log(`改动：\n${diff}`);

  preflightPublished(enr, version, publisher);

  // PR 形状对齐维护者（liliMozi）的更新型 PR：标题 `chore: approve <kind>/<id> <tag>`；正文三段
  // （Release / SHA-256 / Changes）+ 一行本地核对说明。tag 原样用（带 `v` 前缀；skill/recipe 本来就是
  // tag），去 `v` 前缀只用于拼条目名。
  // 提交信息：命令行给了 -m/-F 就用它（同 git commit）；只想补"这次改了什么"那一行就用 --changes；
  // 都不给则按市场形状生成（Changes 留占位）。互斥关系在模块顶层已校验。
  const custom = cliMessage;
  const changes = cliChanges;
  const title = custom ? custom.title : `chore: approve ${enr.kind}/${enr.id} ${tag}`;
  const releaseUrl = `https://github.com/${enr.repository}/releases/tag/${tag.replace(/\+/g, "%2B")}`;
  const body = custom
    ? custom.body
    : [
        `Approve the new ${enr.id} ${enr.kind} release.`,
        "",
        `- Release: ${releaseUrl}`,
        `- SHA-256: \`${sha256}\``,
        `- Changes: ${changes || "（本次变更，人工补）"}`,
        "",
        "Local check: 条目与 Release 资产按 API 核对一致（sha256 digest + 字节数），未下载安装包。",
        "",
        "由 `pnpm run market:pr` 生成。",
      ].join("\n");
  if (custom) log("提交信息取自 -m/-F（不按市场形状生成）");
  else if (changes) log("Changes 行取自 --changes");

  if (dryRun) {
    log(`--dry-run：将提交的 draft PR\n  标题：${title}\n  正文：\n${body}`);
    log("--dry-run：到此为止，未推分支、未开 PR");
    return;
  }

  if (deepCheck) runDeepMarketCheck();

  const branch = `enroll/${tag.replace(/^v/, "").replace(/\+/g, "-")}`;
  exec("git", ["checkout", "-B", branch], WORK);
  exec("git", ["add", "registry.json", "approvals.json"], WORK);
  // 提交签名复用 GitHana 的隔离环（见文件头“署名与 GitHana 同款”），提交信息用同一份标题 + 正文。
  // 推送不注这个 env：隔离 gitconfig 里没有凭据助手，推还是走环境自己的凭据。
  const trailer = `${title}\n${body}`.includes("Co-authored-by: HanaAgent") ? [] : ["-m", AGENT_SIGNATURE];
  exec("git", ["commit", "-m", title, ...(body ? ["-m", body] : []), ...trailer], WORK, signingEnv());
  exec("git", ["push", "--force", "origin", branch], WORK);
  log(`已推 ${enr.fork}:${branch}`);

  // 人工那一位给了（-m/-F 或 --changes）就不再开 draft：材料已齐，别让维护者对着半成品。
  const draft = !(custom || changes);
  const prArgs = [
    "pr", "create",
    "--repo", enr.upstream,
    "--base", enr.defaultBranch || "main",
    "--head", `${enr.fork.split("/")[0]}:${branch}`,
    "--title", title,
    "--body", body,
    ...(draft ? ["--draft"] : []),
  ];
  let prUrl: string;
  try {
    prUrl = exec("gh", prArgs);
    log(`${draft ? "draft PR" : "PR"}：${prUrl}`);
  } catch (e) {
    // 同一版本重跑、或改完提交信息再推：分支上已经有开着的 PR，就地更新即可，别重复开。
    const owner = enr.fork.split("/")[0];
    const existing = exec("gh", ["pr", "list", "--repo", enr.upstream, "--head", `${owner}:${branch}`, "--state", "open", "--json", "url", "--jq", ".[0].url // \"\""]);
    if (!existing) throw e;
    prUrl = existing;
    log(`分支 ${branch} 已有开着的 PR，未重复创建：${prUrl}`);
  }
}

await main();
