// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/vendor/sdk.mts — 把本机宿主的 App SDK 快照同步进 vendor/hana-app-sdk。
//
// 快照由 4 个 tgz 加 source-manifest.json 构成，是「宿主打包产出」在仓库内的一份副本：
//   · 4 个 tgz 是 package.json / pnpm-workspace.yaml 里 `file:` 依赖的真身，构建期由 rspack 内联；
//   · source-manifest.json 的 packedVersion 是 THIRD_PARTY_NOTICES.md 的版本来源（derive:thirdparty）。
// 宿主升级后这份副本会漂，人肉拷贝既容易漏文件，也说不清同步到了哪个宿主版本，故有此脚本。
//
// 源的位置（按序探测，第一个命中的赢）：
//   1. --source <dir>
//   2. <HANA_HOME>/artifacts/server/<最新版本>/skills2set/hana-app-creator/assets/sdk（随宿主版本分发，权威）
//   3. <HANA_HOME>/skills/hana-app-creator/assets/sdk（已安装 skill 的资产，兜底）
//
// 同步按整文件 sha256 比对，只写变化的那几个；--check 只报漂移并 exit 1。源是本机宿主，
// CI 上没有，所以 CI 门禁（derive --check）不含本脚本。
//
// 同步后 SDK 内容变了，两处衍生要跟着走：
//   · 锁文件与依赖树：pnpm install --no-prefer-frozen-lockfile
//   · THIRD_PARTY_NOTICES.md 的版本号：pnpm run derive thirdparty
//
// 为什么不是裸 pnpm install：pnpm 对 `file:` tarball 的 resolution 按 specifier 文本判定，
// 路径没变就「Lockfile is up to date」，于是 integrity 与 node_modules 里的包都停在旧 tgz 上
// （裸 pnpm install 甚至 --force 都不重算）。--no-prefer-frozen-lockfile 才会重新解析。
// 本脚本同步后自检 lock 里的 integrity：没跟上就把它作为待办打出来。
//
// 用法：
//   pnpm run sync:vendor:sdk                          # 本脚本（sync:vendor 聚合入口会带上它）
//   node scripts/vendor/sdk.mts                  # 同步（源自动探测）
//   node scripts/vendor/sdk.mts --check          # 只校验
//   node scripts/vendor/sdk.mts --source <dir>   # 指定源目录
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT } from "../shared/root.mts";
const DEST = path.join(ROOT, "vendor", "hana-app-sdk");
const HANA_HOME =
  process.env.HANA_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".hanako");

/** 快照的全部构成，缺一即半份——宁可报错，不写进去一个残份。宿主新增包时同步补进本表。 */
const FILES = [
  "hana-app-sdk.tgz",
  "hana-plugin-components-0.0.0.tgz",
  "hana-plugin-protocol-0.0.0.tgz",
  "hana-plugin-sdk-0.0.0.tgz",
  "source-manifest.json",
];

const SKILL_SDK = path.join("skills", "hana-app-creator", "assets", "sdk");
const SERVER_SKILL_SDK = path.join("skills2set", "hana-app-creator", "assets", "sdk");

/** --flag value / --flag=value 两种写法。 */
function arg(name: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const head = (h: string) => h.slice(0, 12);
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, "/") || ".";

/** packedVersion：宿主打包时写入的 SDK 版本，同步的对错以此为准。 */
function packedVersion(dir: string): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "source-manifest.json"), "utf8"));
    return typeof j?.packedVersion === "string" ? j.packedVersion : null;
  } catch {
    return null;
  }
}

/** server 目录名形如 `0.999.2-win32-x64-<hash>`；按语义版本降序（与 market-index 同口径）。 */
function byVersionDesc(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function findSource(): string {
  const explicit = arg("--source");
  if (explicit) return path.resolve(explicit);

  const serverRoot = path.join(HANA_HOME, "artifacts", "server");
  if (fs.existsSync(serverRoot)) {
    const newest = fs
      .readdirSync(serverRoot)
      .filter((v) => fs.existsSync(path.join(serverRoot, v, SERVER_SKILL_SDK)))
      .sort(byVersionDesc)[0];
    if (newest) return path.join(serverRoot, newest, SERVER_SKILL_SDK);
  }
  return path.join(HANA_HOME, SKILL_SDK);
}

/** 锁文件里记的 tgz integrity 是否已跟上（pnpm 不会因本地 tarball 变化而自动重算）。 */
function lockBehind(): string[] {
  const lock = path.join(ROOT, "pnpm-lock.yaml");
  if (!fs.existsSync(lock)) return [];
  const text = fs.readFileSync(lock, "utf8");
  return FILES.filter((name) => name.endsWith(".tgz")).filter((name) => {
    const tgz = path.join(DEST, name);
    if (!fs.existsSync(tgz)) return false;
    const want = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(tgz)).digest("base64");
    return !text.includes(`integrity: ${want}`);
  });
}

/** 同步后的衍生待办：锁文件、第三方声明。 */
function reportFollowUps(): void {
  const behind = lockBehind();
  if (behind.length) {
    console.log(`[sync-vendor-sdk] 锁文件停在旧 tgz（${behind.length} 个 integrity 未更新）：`);
    console.log("  pnpm install --no-prefer-frozen-lockfile && pnpm run derive thirdparty");
    return;
  }
  console.log("[sync-vendor-sdk] 锁文件 integrity 已匹配；THIRD_PARTY_NOTICES 的版本号跑 pnpm run derive thirdparty");
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const src = findSource();

  // 源的完整性：半份快照比没有更坏（写进去就成了"同步过了"的假象）。
  const missing = FILES.filter((f) => !fs.existsSync(path.join(src, f)));
  if (missing.length) {
    console.error(`[sync-vendor-sdk] 源不完整：${rel(src)} 缺 ${missing.join("、")}`);
    console.error("[sync-vendor-sdk] 宿主未安装到预期位置？用 --source <dir> 指定 App SDK 快照目录。");
    process.exit(2);
  }
  const empty = FILES.filter((f) => fs.statSync(path.join(src, f)).size === 0);
  if (empty.length) {
    console.error(`[sync-vendor-sdk] 源文件为空：${empty.join("、")}（在 ${rel(src)}）`);
    process.exit(2);
  }

  const srcVersion = packedVersion(src);
  const destVersion = packedVersion(DEST);
  console.log(`[sync-vendor-sdk] 源 ${rel(src)}（packedVersion ${srcVersion ?? "未知"}）`);
  console.log(`[sync-vendor-sdk] 目标 ${rel(DEST)}（packedVersion ${destVersion ?? "未知"}）`);

  const changed: string[] = [];
  for (const name of FILES) {
    const from = path.join(src, name);
    const to = path.join(DEST, name);
    const same = fs.existsSync(to) && sha256(to) === sha256(from);
    if (same) continue;
    changed.push(name);
    const size = fs.statSync(from).size;
    if (checkOnly) {
      console.log(`  - ${name}  ${fs.existsSync(to) ? head(sha256(to)) : "（缺）"} → ${head(sha256(from))}  ${size} B`);
      continue;
    }
    fs.mkdirSync(DEST, { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`[sync-vendor-sdk] 写回 ${name}（${size} B）`);
  }

  if (checkOnly) {
    if (changed.length) {
      console.error(`[sync-vendor-sdk] 漂移 ${changed.length} 个文件——跑 node scripts/vendor/sdk.mts 写回后提交`);
      process.exit(1);
    }
    console.log("[sync-vendor-sdk] 一致（5 个文件）");
    reportFollowUps();
    return;
  }

  if (!changed.length) {
    console.log(`[sync-vendor-sdk] 无需同步（已是 packedVersion ${destVersion ?? "未知"}）`);
    reportFollowUps();
    return;
  }
  console.log(`[sync-vendor-sdk] 已同步 ${changed.length} 个文件：${changed.join("、")}`);
  reportFollowUps();
}

main();
