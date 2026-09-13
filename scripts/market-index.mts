// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/market-index.mts — 从 releases/ 的产物派生市场条目与市场清单。
//
// 为什么是独立的派生脚本，而不是改 pack.mts：
//   pack.mts 负责「物化依赖 → zip → SHA256」，那些中间态纪律（暂存树、多目标磁盘占用）都压在它
//   身上；市场元数据是**对已出产物的派生**，放这里可以按需重跑、可以只对某个 target 生成，
//   也不必让 pack 知道市场的事（单一职责：产物是产物，市场是市场）。
//
// 流程：读 src/manifest.json + package.json → 扫描 releases/ 里本版本的 zip（配对 .sha256）
//   → 写 <zip>.entry.json（索引构建器的输入）→ 用官方 extension-index-build.mjs 拼 index.v2.json。
//
// ⚠ 索引模型的限制（与 githana 一致）：index.v2.json 的条目只有 `archive.url` 一个地址，
//   **没有平台维度**，构建器按 `kind:id` 分组，多平台 zip 不可能各占一条。故默认只把
//   `universal` 包放进清单，平台包留在 release 资产里按名取用。
//
// 用法：
//   node scripts/market-index.mts                                  # 当前版本 + universal
//   node scripts/market-index.mts --target win32-x64 --base-url https://…/download/v1.0.0
//   node scripts/market-index.mts --publisher Nyasers --out releases/index.v2.json
import fs from "fs-extra";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HANA_HOME = process.env.HANA_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");
const RELEASES = join(ROOT, "releases");

interface Archive {
  url: string;
  sha256: string;
  size: number;
  format: "zip";
}

interface Entry {
  kind: string;
  id: string;
  name: string;
  publisher: string;
  description: string;
  version: string;
  permissions: { capability: string }[];
  compatibility?: { minAppVersion?: string };
  icon?: string;
  archive: Archive;
  /**
   * 自留字段（宿主不读也不拒，未知字段会原样透传）：本版本全量 target → archive 映射。
   * 索引格式没有平台维度（消费侧只按版本文本匹配版本），平台包只能放在 release 资产里按名取用；
   * 这块给“知道目标名”的人与脚本一个稳定入口，将来格式长出平台维度时按它迁移。
   * baseUrl 在此处已是绝对地址（构建器只替换 archive.url 里的占位符，不认这里）。
   */
  "x-dshana-targets"?: Record<string, Archive>;
}

/** --flag value / --flag=value 两种写法。 */
function arg(name: string): string | null {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}

/** 图标 data URI：清单里的 icon 相对包根，源在 src/ 下（也可能已在根）。 */
function iconDataUri(iconRel: string): string | undefined {
  if (!iconRel) return undefined;
  for (const candidate of [join(ROOT, "src", iconRel), join(ROOT, iconRel)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = candidate.toLowerCase();
      const mime = ext.endsWith(".svg") ? "image/svg+xml" : ext.endsWith(".webp") ? "image/webp" : "image/png";
      return `data:${mime};base64,${fs.readFileSync(candidate).toString("base64")}`;
    }
  }
  return undefined;
}

/** 索引构建器：仓库内拷贝优先（只依赖 node 内建），其次 HANA_APP_TOOLS_ROOT，再次本机 Hana（取最新版本）。 */
function findIndexBuilder(): string | null {
  const cands: string[] = [join(ROOT, "scripts", "hana-app-tools", "extension-index-build.mjs")];
  if (process.env.HANA_APP_TOOLS_ROOT) {
    cands.push(join(process.env.HANA_APP_TOOLS_ROOT, "scripts", "extension-index-build.mjs"));
  }
  const serverRoot = join(HANA_HOME, "artifacts", "server");
  if (fs.existsSync(serverRoot)) {
    const versions = fs
      .readdirSync(serverRoot)
      .filter((v) => fs.existsSync(join(serverRoot, v, "scripts", "extension-index-build.mjs")))
      .sort((a, b) => {
        const pa = a.split("-")[0].split(".").map(Number);
        const pb = b.split("-")[0].split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d !== 0) return d;
        }
        return 0;
      });
    for (const v of versions) cands.push(join(serverRoot, v, "scripts", "extension-index-build.mjs"));
  }
  return cands.find((c) => fs.existsSync(c)) ?? null;
}

/** 默认基址：git remote origin（github.com/owner/repo）+ releases/download/v<version>。 */
function defaultBaseUrl(version: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
    if (m) return `https://github.com/${m[1]}/${m[2]}/releases/download/v${version}`;
  } catch {
    /* 交给下面报错 */
  }
  return null;
}

/** 产物事实：字节数 + .sha256（归一成小写）。 */
function zipFacts(zipName: string): { size: number; sha256: string } {
  const size = fs.statSync(join(RELEASES, zipName)).size;
  const sha256 = fs.readFileSync(join(RELEASES, `${zipName}.sha256`), "utf8").trim().split(/\s+/)[0].toLowerCase();
  return { size, sha256 };
}

/** target 名：`<id>-v<version>-<target>.zip` → `<target>`；无后缀（通用包）→ `universal`。 */
function targetOf(zipName: string, prefix: string): string {
  const rest = zipName.slice(prefix.length).replace(/\.zip$/, "");
  return rest.startsWith("-") ? rest.slice(1) : "universal";
}

/** 本版本全量 target → archive（绝对地址）映射，写进自留字段。 */
function buildTargets(zips: string[], version: string, baseUrl: string): Record<string, Archive> {
  const manifest = fs.readJsonSync(join(ROOT, "src", "manifest.json"));
  const prefix = `${manifest.id}-v${version}`;
  const out: Record<string, Archive> = {};
  for (const zipName of zips) {
    if (!fs.existsSync(join(RELEASES, `${zipName}.sha256`))) continue;
    const { size, sha256 } = zipFacts(zipName);
    out[targetOf(zipName, prefix)] = { url: `${baseUrl}/${zipName}`, sha256, size, format: "zip" };
  }
  return out;
}

function buildEntry(zipName: string, sha256File: string, targets: Record<string, Archive>): Entry {
  const manifest = fs.readJsonSync(join(ROOT, "src", "manifest.json"));
  const pkg = fs.readJsonSync(join(ROOT, "package.json"));
  const size = fs.statSync(join(RELEASES, zipName)).size;
  // pack.mts 写的 .sha256 是「纯大写哈希」（不带文件名）——取第一个空白段再归一成小写
  const sha256 = fs.readFileSync(sha256File, "utf8").trim().split(/\s+/)[0].toLowerCase();
  const entry: Entry = {
    kind: "app",
    id: manifest.id,
    name: manifest.name || manifest.id,
    publisher: arg("--publisher") || pkg.publisher || pkg.name || manifest.id,
    description: typeof manifest.description === "string" ? manifest.description : "",
    version: manifest.version,
    permissions: (Array.isArray(manifest.capabilities) ? manifest.capabilities : []).map((capability: string) => ({ capability })),
    archive: { url: `{{BASE_URL}}/${zipName}`, sha256, size, format: "zip" },
  };
  if (Object.keys(targets).length > 0) entry["x-dshana-targets"] = targets;
  if (manifest.minAppVersion) entry.compatibility = { minAppVersion: manifest.minAppVersion };
  const icon = iconDataUri(manifest.icon);
  if (icon) entry.icon = icon;
  return entry;
}

function main(): void {
  const manifest = fs.readJsonSync(join(ROOT, "src", "manifest.json"));
  const version: string = manifest.version;
  const target = arg("--target") || "universal";
  if (target !== "universal") {
    // 索引当前只指 universal：index.v2.json 的 item 只有 archive.url、没有平台维度，
    // 多平台包挤不进同一条；指向某个平台包会让其它平台的机器装到不合身的包。
    console.warn(
      `[market-index] 注意：--target=${target} 不是 universal。` +
        `市场清单按当前格式只应指向 universal（平台包留给 release 资产按名取用）。`,
    );
  }

  const all = fs
    .readdirSync(RELEASES)
    .filter((f: string) => f.startsWith(`${manifest.id}-v${version}`) && f.endsWith(".zip") && !f.endsWith(".sha256"));
  if (all.length === 0) {
    console.error(`[market-index] releases/ 里没有 ${manifest.id}-v${version}-*.zip —— 先出包：pnpm run package --target ${target}`);
    process.exit(1);
  }

  const chosen = all.filter((f: string) => f.includes(`-${target}.zip`) || (target === "universal" && !/-(win32|darwin|linux)-/.test(f)));
  if (chosen.length === 0) {
    console.error(`[market-index] 没有 target=${target} 的包（现有：${all.join(", ")}）`);
    process.exit(1);
  }

  // 基址在写 entry 之前定下来：自留字段里用的是绝对地址（构建器只替换 archive.url 的占位符）
  const baseUrl = arg("--base-url") || defaultBaseUrl(version);
  if (!baseUrl) {
    console.error("[market-index] 拿不到 --base-url（且无法从 git remote 推导）");
    process.exit(1);
  }
  // 自留字段不走构建器的 URL 替换，基址的 https 约束要在这里先立住：
  // 非 https 或相对值一旦写进自留字段，就没有别的步骤会拦它。
  if (!/^https:\/\//.test(baseUrl)) {
    console.error(`[market-index] --base-url 必须是绝对 https 地址（收到 ${JSON.stringify(baseUrl)}）`);
    process.exit(1);
  }
  const targets = buildTargets(all, version, baseUrl);

  // 1) 为所有本版本产物写 entry（多目标各一份，便于以后按平台取用）
  const entries: string[] = [];
  for (const zip of all) {
    const sha256File = join(RELEASES, `${zip}.sha256`);
    if (!fs.existsSync(sha256File)) {
      console.warn(`[market-index] 跳过 ${zip}：缺 ${basename(sha256File)}`);
      continue;
    }
    const entryPath = join(RELEASES, `${zip.replace(/\.zip$/, "")}.entry.json`);
    fs.writeFileSync(entryPath, `${JSON.stringify(buildEntry(zip, sha256File, targets), null, 2)}\n`, "utf8");
    entries.push(entryPath);
  }

  // 2) 拼索引：只喂选中的那些 entry（构建器读目录下所有 *.entry.json）
  const stageDir = join(RELEASES, "_index-input");
  fs.removeSync(stageDir);
  fs.ensureDirSync(stageDir);
  // 按**精确文件名**匹配：universal 包名是各平台包名的前缀（平台包只多一段 `-<os>-<cpu>`），
  // 前缀判定会把五个包一起喂给构建器，构建器再按版本取首（同版本时按输入顺序，即文件名排序）
  // 就会把 darwin-arm64 选成主 archive。
  const chosenEntryNames = new Set(chosen.map((zip: string) => `${zip.replace(/\.zip$/, "")}.entry.json`));
  for (const e of entries) {
    const name = basename(e);
    if (!chosenEntryNames.has(name)) continue;
    fs.copySync(e, join(stageDir, name));
  }

  const builder = findIndexBuilder();
  if (!builder) {
    console.error("[market-index] 找不到 extension-index-build.mjs（仓库内与本机都没有）");
    fs.removeSync(stageDir);
    process.exit(1);
  }

  const out = resolve(arg("--out") || join(RELEASES, "index.v2.json"));
  console.log(`[market-index] 版本 ${version} · target ${target} · 基址 ${baseUrl}`);
  try {
    execFileSync(
      process.execPath,
      [
        builder,
        "--entries", stageDir,
        "--base-url", baseUrl,
        "--source-id", arg("--source-id") || manifest.id,
        "--name", arg("--name") || manifest.name || manifest.id,
        "--out", out,
      ],
      { stdio: "inherit" },
    );
  } finally {
    fs.removeSync(stageDir);
  }
  console.log(`[market-index] 完成 ${out}（entry 见 releases/*.entry.json）`);
}

main();
