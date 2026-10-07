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
// 用法：
//   node scripts/release/market-pr.mts                       # 等 Release 就绪 → 备 draft PR
//   node scripts/release/market-pr.mts --dry-run             # 只打印将要做的改动，不推不改远端
//   node scripts/release/market-pr.mts --tag v1.0.2+dsh-0.2.0-rc.2
//
// 退出码 0 的三种情形：已备好 PR（打印 URL）、该版本已登记（无事可做）、--dry-run 走完。
import fs from "fs-extra";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { ROOT } from "../shared/root.mts";

/** fork 的本地工作副本：在 .cache/ 下，随出包清缓存一起清掉，不留痕。 */
const WORK = join(ROOT, ".cache", "market-fork");
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
const log = (m: string): void => console.log(`[market-pr] ${m}`);

/** 无代理环境下跑 gh / git，并给 git 固定 HTTP/1.1。
 *  宿主环境里的 HTTP(S)_PROXY 可能指向已停的代理，会让 gh 连接失败；而 HTTP/2 过某些代理中转会
 *  Recv failure: Connection was reset。两者都在这里绕开，不依赖跑脚本的人先改好环境。 */
function exec(bin: string, args: string[], cwd = ROOT): string {
  const env = { ...process.env };
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
  assets: { name: string }[];
}

/** 等投稿条目就位（CI 出包），并确认 Release 已可上架；返回条目对象。
 *  市场只收既不是 draft、也不是 prerelease 的正式 Release，而流水线建的是 draft pre-release、publish
 *  只去 draft 而保留 prerelease——标稳定版（--prerelease=false --latest）是「要不要上架」的人工决定，
 *  不属于发版流程，所以这里**不等**它：已经稳定就继续，否则直接报错并给出该跑的命令。
 *  条目本身要等（CI 出包要十几分钟），那是构建在跑、不是人在决策。
 *  `wait=false` 时连条目也只探一次（--dry-run 用）。 */
async function waitForRelease(
  tag: string,
  repo: string,
  entryName: string,
  wait: boolean,
): Promise<{ sha256: string; size: number }> {
  const deadline = Date.now() + (wait ? WAIT_MS : 0);
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
  const entry = fs.readJsonSync(join(dir, entryName)) as { archive: { sha256: string; size: number } };
  fs.removeSync(dir);
  return { sha256: String(entry.archive.sha256).trim().toLowerCase(), size: entry.archive.size };
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

async function main(): Promise<void> {
  const enr = fs.readJsonSync(join(ROOT, "market", "enrollment.json")) as Enrollment;
  const manifest = fs.readJsonSync(join(ROOT, "manifest.json")) as { version: string };
  const tag = arg("--tag") || `v${manifest.version}`;
  // 条目名按**所选 tag** 的版本取，不按本地 manifest：--tag 指旧版本时，拿当前 manifest 去搜那个 Release
  // 只会一直等不到。两者不一致时提示一声（正常发版流程里它们相等）。
  const version = tag.replace(/^v/, "");
  if (version !== manifest.version) {
    log(`注意：--tag ${tag} 与本地 manifest 的 ${manifest.version} 不同，按 tag 的版本找条目`);
  }
  const entryName = `${enr.kind}-${enr.id}-${version}.entry.json`;

  log(`登记 ${enr.kind}/${enr.id} · tag ${tag}`);
  const { sha256, size } = await waitForRelease(tag, enr.repository, entryName, !dryRun);
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

  if (dryRun) {
    log("--dry-run：到此为止，未推分支、未开 PR");
    return;
  }

  const branch = `enroll/${tag.replace(/^v/, "").replace(/\+/g, "-")}`;
  exec("git", ["checkout", "-B", branch], WORK);
  exec("git", ["add", "registry.json", "approvals.json"], WORK);
  exec("git", ["-c", "user.name=HanaAgent", "-c", "user.email=313794804+HanaAgent@users.noreply.github.com", "commit", "-m", `Enroll ${enr.kind}/${enr.id} ${tag}`], WORK);
  exec("git", ["push", "--force", "origin", branch], WORK);
  log(`已推 ${enr.fork}:${branch}`);

  const title = `${enr.id} ${tag}`;
  const body = [
    `Enroll/update \`${enr.kind}/${enr.id}\` at \`${tag}\`.`,
    "",
    `- repository: ${enr.repository}`,
    `- publisher: ${enr.publisher}`,
    `- sha256: \`${sha256}\` (copied from the entry JSON's \`archive.sha256\`)`,
    "",
    "Draft opened automatically by `pnpm run market:pr`; review materials still need filling in.",
  ].join("\n");
  const prUrl = exec("gh", [
    "pr", "create",
    "--repo", enr.upstream,
    "--base", enr.defaultBranch || "main",
    "--head", `${enr.fork.split("/")[0]}:${branch}`,
    "--title", title,
    "--body", body,
    "--draft",
  ]);
  log(`draft PR：${prUrl}`);
}

await main();
