// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/market-entry.mts — 从 releases/ 的产物派生官方市场的投稿条目。
//
// 为什么是独立的派生脚本，而不是并进打包脚本：
//   scripts/release/pack/index.mts 负责「物化依赖 → zip → SHA256」，那些中间态纪律（暂存树、多目标磁盘占用）都压在它
//   身上；投稿条目是**对已出产物的派生**，放这里可以按需重跑，也不必让 pack 知道市场的事
//   （单一职责：产物是产物，市场是市场）。
//
// 流程：读 manifest.json（仓库根）+ package.json → 收目标那个 zip 的事实（字节数 + sha256）→ 写
//   <kind>-<id>-<version>.entry.json，文件名就是官方市场的取件名。
//   事实默认从 releases/ 里那份 zip 现算（读整包取字节数与哈希）；`--facts-dir <目录>` 时改从该目录下所有
//   `package-facts.json` 合并出的表取（CI 里事实由出包作业记好、当 artifact 带过来，zip 不必再落本地一遍）。
//
// 一份对一个版本：官方市场按这个名在 Release 资产里找条目，一份对一个版本，所以只写选中的那个 target。
// archive.url 保留 `{{BASE_URL}}/` 占位符是协议要求：市场同步器按这个前缀取出资产名、再去 Release 资产里
// 找同名 zip，写成绝对地址会被判成非法条目。
//
// 平台包不进条目：官方索引的条目只有 `archive.url` 一个地址槽、**没有平台维度**，多平台 zip 挤不进同一条，
// 所以投稿条目按约定指向 universal；平台包留在 Release 资产里按名取用，装机侧从资产元数据的 `digest` 核验。
//
// 用法：
//   node scripts/release/market-entry.mts                    # 当前版本 + universal
//   node scripts/release/market-entry.mts --target win32-x64
//   node scripts/release/market-entry.mts --publisher Nyasers
//   node scripts/release/market-entry.mts --facts-dir facts  # 事实从目录下的小票合并（CI 场景）
import fs from "fs-extra";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { ROOT } from "../shared/root.mts";
import { mergeFacts, type PackageFacts } from "./facts.mts";
const RELEASES = join(ROOT, "releases");

/** 市场条目里的扩展种类：本仓库只出 App。 */
const KIND = "app";

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
  for (const candidate of [join(ROOT, "packages", "app", "src", iconRel), join(ROOT, iconRel)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = candidate.toLowerCase();
      const mime = ext.endsWith(".svg") ? "image/svg+xml" : ext.endsWith(".webp") ? "image/webp" : "image/png";
      return `data:${mime};base64,${fs.readFileSync(candidate).toString("base64")}`;
    }
  }
  return undefined;
}

/**
 * 产物事实的来源：默认对本地那份 zip 现算（字节数 + sha256）；`--facts-dir <目录>`
 * 时改从该目录下（含子目录）所有 `package-facts.json` 合并出的表取 —— CI 里投稿条目与出包是两个
 * 作业，事实由出包作业记好当 artifact 带过来，zip 不必再落到本地一遍。
 */
const factsDir = arg("--facts-dir");
const injectedFacts: PackageFacts | null = factsDir === null ? null : mergeFacts(factsDir);

/** 该 zip 是否有可用事实（注入表里有，或本地那份 zip 在）。 */
function hasFacts(zipName: string): boolean {
  return injectedFacts !== null ? Object.hasOwn(injectedFacts, zipName) : fs.existsSync(join(RELEASES, zipName));
}

/** 产物事实：字节数 + sha256；注入表优先，否则对本地那份 zip 现算。 */
function zipFacts(zipName: string): { size: number; sha256: string } {
  const injected = injectedFacts?.[zipName];
  if (injected) return { size: injected.size, sha256: String(injected.sha256).trim().toLowerCase() };
  const path = join(RELEASES, zipName);
  return { size: fs.statSync(path).size, sha256: createHash("sha256").update(fs.readFileSync(path)).digest("hex") };
}

function buildEntry(zipName: string): Entry {
  const manifest = fs.readJsonSync(join(ROOT, "manifest.json"));
  const pkg = fs.readJsonSync(join(ROOT, "package.json"));
  const { size, sha256 } = zipFacts(zipName);
  const entry: Entry = {
    kind: KIND,
    id: manifest.id,
    name: manifest.name || manifest.id,
    publisher: arg("--publisher") || pkg.publisher || pkg.name || manifest.id,
    description: typeof manifest.description === "string" ? manifest.description : "",
    version: manifest.version,
    permissions: (Array.isArray(manifest.capabilities) ? manifest.capabilities : []).map((capability: string) => ({ capability })),
    archive: { url: `{{BASE_URL}}/${zipName}`, sha256, size, format: "zip" },
  };
  if (manifest.minAppVersion) entry.compatibility = { minAppVersion: manifest.minAppVersion };
  const icon = iconDataUri(manifest.icon);
  if (icon) entry.icon = icon;
  return entry;
}

function main(): void {
  const manifest = fs.readJsonSync(join(ROOT, "manifest.json"));
  const version: string = manifest.version;
  const target = arg("--target") || "universal";
  if (target !== "universal") {
    // 条目当前只指 universal：官方格式的 item 只有 archive.url、没有平台维度，
    // 多平台包挤不进同一条；指向某个平台包会让其它平台的机器装到不合身的包。
    console.warn(
      `[market-entry] 注意：--target=${target} 不是 universal。` +
        `官方索引的条目只应指向 universal（平台包留在 Release 资产里按名取用）。`,
    );
  }

  // 要哪个包就把名字拼出来、精确匹配：前缀判定会把同前缀的别的版本（1.0.2 之于 1.0.20）一起收进来，
  // 释当的“平台名不匹配”判定也会放行 dshana-v1.0.2-<其它平台>.zip，两者都能把错的包与 hash 写进条目。
  const expected = `${manifest.id}-v${version}${target === "universal" ? "" : `-${target}`}.zip`;
  if (!hasFacts(expected)) {
    const all = injectedFacts !== null
      ? Object.keys(injectedFacts).filter((f: string) => f.startsWith(`${manifest.id}-v`) && f.endsWith(".zip"))
      : fs.readdirSync(RELEASES).filter((f: string) => f.startsWith(`${manifest.id}-v`) && f.endsWith(".zip"));
    console.error(
      `[market-entry] 找不到 ${expected} 的事实来源（releases/ 或 --facts-dir）—— ` +
        (all.length === 0
          ? `先出包：pnpm run package --target ${target}`
          : `现有：${all.join(", ")}`),
    );
    process.exit(1);
  }

  const entry = buildEntry(expected);
  const out = join(RELEASES, `${KIND}-${manifest.id}-${version}.entry.json`);
  fs.writeFileSync(out, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  console.log(`[market-entry] 投稿条目 ${out}（archive 指向 ${expected}，${entry.archive.size} 字节）`);
}

main();
