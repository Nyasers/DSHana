// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive/thirdparty.mts — THIRD_PARTY_NOTICES.md 生成（derive 的 thirdparty 任务）
//
// 为什么单独成模块：这份通知的"人工部分"（每个包为什么在包里、以什么形态进来）是一张
// 事实表，改它要动数据而不是改逻辑；许可全文又是一份独立文本。分开放，derive/index.mts 只负责调度。
//
// 语言：**产物是英文**——它与 NOTICE、Apache 全文同族，读者是拿到分发件的人（含要查证的
// 第三方）。本文件的注释仍是中文（给维护者看）。
//
// 边界（很重要）：
//   · 只列**内联进产物**的组件——它们的原始包与 LICENSE 都不在 zip 里，必须由我们代为声明。
//   · 随包 node_modules/ 的物化依赖树**不列**：那批各自带着 LICENSE 进包（scripts/release/pack/index.mts 的
//     复制不排除它们），合规靠保留原件，本文件只给一句指引。
//   · 版本：随包 SDK 那一批取 vendor/hana-app-sdk/source-manifest.json 的 packedVersion（宿主打包时
//     写死的那份），不手抄、不猜；不走 SDK 的组件（zod）取装出来的包版本。
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "../shared/root.mts";

import type { FileTask } from "./index.mts";

const join = (...p: string[]) => path.join(ROOT, ...p);

/** 随包 SDK 的来源与版本（宿主打包产出；仓库内一份快照）。 */
const SDK_MANIFEST = "vendor/hana-app-sdk/source-manifest.json";
/** 随包 SDK 的持包目录（形态描述里点名用）。 */
const SDK_DIR = "vendor/hana-app-sdk";
const SOURCE_LINE = `Hana App Creator SDK shipped with the host (snapshot under \`${SDK_DIR}\`; see \`source-manifest.json\` in the same directory)`;

/** 内联组件的元信息（人工知识：为什么在包里、以什么形态进来的）。 */
interface InlinedComponent {
  name: string;
  purpose: string;
  form: string;
  copyright?: string;
  /** 许可全文区块：缺省 Apache-2.0（随包 SDK 那一批），zod 是 MIT。 */
  license?: "Apache-2.0" | "MIT";
  /** 版本取法：缺省取随包 SDK 的 packedVersion；`installed` 取 node_modules 里装出来的版本。 */
  versionFrom?: "sdk" | "installed";
}

/**
 * 只列**内联**的组件。判定依据是 src/ 里的实际 import 链：
 *   · plugin-sdk：app.ts / settings.tsx 直接 import，经 rspack 内联进 ui/*
 *   · plugin-components：settings.tsx 直接 import（连 settings.css）
 *   · app-sdk：runtime/main.ts import connectAppRuntime，内联进 bin/dsh.mjs
 *   · plugin-protocol：plugin-sdk 的 dependency，随它一起被打进产物
 *   · zod：tools 域 import（工具参数 schema 与校验），rspack 按裸说明符打进 bin/app.mjs
 *     （构建配置只把 node 内置件留成外部，没有 externals 名单）；它同时是 DSH 树的传递依赖，
 *     因此 node_modules/ 下另有一份原包（那一份靠保留 LICENSE 合规，见下节）
 * 顺序按依赖方向（底 → 上），与产物里的层次一致。
 */
const COMPONENTS: InlinedComponent[] = [
  {
    name: "@hana/plugin-protocol",
    purpose:
      "Message-protocol constants and types exchanged between the host and plugins (for example the theme-change notification `THEME_CHANGED`).",
    form: `devDependency (\`file:${SDK_DIR}/hana-plugin-protocol-0.0.0.tgz\`); inlined together with @hana/plugin-sdk — it has no entry point of its own in the distribution.`,
  },
  {
    name: "@hana/plugin-sdk",
    purpose:
      "Browser-side App shell surface: `hana.api.fetch` and `hana.api.url` (App-surface session credential injection and runtime proxy path tickets), plus the surface / theme / clipboard / storage faces.",
    form: `devDependency (\`file:${SDK_DIR}/hana-plugin-sdk-0.0.0.tgz\`), inlined at build time by rspack into \`ui/app.js\` and \`ui/settings.js\`; no vendored copy is shipped separately.`,
  },
  {
    name: "@hana/plugin-components",
    purpose:
      "Host settings components (`@hana/plugin-components/settings` and its `settings.css`), so the settings surface matches the host.",
    form: `devDependency (\`file:${SDK_DIR}/hana-plugin-components-0.0.0.tgz\`), inlined by rspack into \`ui/settings.js\`.`,
  },
  {
    name: "@hana/app-sdk",
    purpose:
      "The `connectAppRuntime()` client runtime for the managed runtime's private IPC (tasks / models / network.fetch / close).",
    form: `devDependency (\`file:${SDK_DIR}/hana-app-sdk.tgz\`), statically inlined by rspack into \`bin/dsh.mjs\`.`,
    copyright: "Copyright (c) 2026 Hana App SDK authors (SPDX headers in the source files)",
  },
  {
    name: "zod",
    purpose:
      "Runtime schemas for the tool argument surface: one definition generates the model-facing JSON Schema and validates incoming arguments before dispatch.",
    form: "devDependency (`zod`), statically inlined by rspack into `bin/app.mjs` for the tool argument surface. A separate copy also ships under `node_modules/` as part of the DSH dependency tree, carrying its own LICENSE.",
    license: "MIT",
    versionFrom: "installed",
    copyright: "Copyright (c) 2025 Colin McDonnell",
  },
];

/** 许可全文（从既有通知一次性提取的原文副本；不重打法律文本）。 */
function licenseText(file: string): string {
  const p = join("scripts", "derive", "licenses", file);
  if (!fs.existsSync(p)) throw new Error(`missing license text: ${path.relative(ROOT, p)} (should be carried by the repo)`);
  return fs.readFileSync(p, "utf8");
}

/** 组件引用的许可全文文件（区块顺序与正文里 `full text below` 的指涉一致）。 */
const LICENSE_FILES: Record<string, string> = {
  "Apache-2.0": "apache-2.0.txt",
  MIT: "zod-mit.txt",
};

/** 许可的显示名（`- License:` 一行）。 */
const LICENSE_LABELS: Record<string, string> = {
  "Apache-2.0": "Apache License 2.0",
  MIT: "MIT License",
};

/**
 * 装出来的包版本：构建期内联进产物的就是这一版（安装走 `--frozen-lockfile`，与锁一致）。
 * 供不走随包 SDK 的组件使用。
 */
function installedVersion(name: string): string {
  const p = join("node_modules", name, "package.json");
  if (!fs.existsSync(p)) throw new Error(`missing installed ${name}: ${path.relative(ROOT, p)}（先 pnpm install）`);
  const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
  if (typeof v !== "string" || !v) throw new Error(`${p} has no version`);
  return v;
}

/** 读随包 SDK 的 packedVersion（宿主打包时写入，仓库内快照）。 */
export function packedVersion(): string {
  const j = JSON.parse(fs.readFileSync(join(SDK_MANIFEST), "utf8"));
  const v = j && j.packedVersion;
  if (typeof v !== "string" || !v) throw new Error(`${SDK_MANIFEST} has no packedVersion`);
  return v;
}

/** 生成整份 THIRD_PARTY_NOTICES.md。 */
function render(): string {
  const sdkVersion = packedVersion();
  const lines: string[] = [
    "# Third-Party Notices",
    "",
    "Third-party components distributed with dshana, and their license notices.",
    "The project's own license is in NOTICE (MPL-2.0).",
    "",
    "Generated by `node scripts/derive/index.mts thirdparty` — do not edit by hand. Versions are read",
    `from \`packedVersion\` in \`${SDK_MANIFEST}\` (the packaged SDK) or from the installed package (zod).`,
    "",
    "## Components inlined into the distribution",
    "",
    "These are inlined into the built App at build time, so their notices are reproduced here. For",
    "entries whose original package is **not shipped** (the Hana SDK group below), the package and its",
    "LICENSE are absent from the distribution and this file is the only notice; where a package also",
    "ships under `node_modules/` as a dependency of more than one tree (zod), that copy carries its own",
    "LICENSE and the entry is reproduced here for the inlined build-time use.",
    "",
  ];
  for (const c of COMPONENTS) {
    const license = c.license ?? "Apache-2.0";
    const version = c.versionFrom === "installed" ? installedVersion(c.name) : sdkVersion;
    lines.push(`### ${c.name}`, "");
    lines.push(`- Version: ${version}`);
    lines.push(`- Purpose: ${c.purpose}`);
    lines.push(`- Form: ${c.form}`);
    // 随包 SDK 那一批的来源是 SDK 快照；其余（zod）来自各自的包，没有 SDK 这一层。
    if (c.versionFrom !== "installed") lines.push(`- Source: ${SOURCE_LINE}`);
    lines.push(`- License: ${LICENSE_LABELS[license]} (full text below)`);
    if (c.copyright) lines.push(`- Copyright: ${c.copyright}`);
    lines.push("");
  }
  lines.push(
    "## Components under the shipped `node_modules/`",
    "",
    "The materialized production dependency tree (`node_modules/`) ships with its own LICENSE and",
    "NOTICE files. Licenses and copyrights live in each package's directory; this file does not",
    "duplicate them.",
    "",
    "--------------------------------------------------------------------------------",
    "",
  );
  // 只附真正被引用到的许可全文（按上表顺序），不把没用的法律文本塞进分发件。
  const used = [...new Set(COMPONENTS.map((c) => c.license ?? "Apache-2.0"))];
  for (const [i, key] of used.entries()) {
    if (i > 0) lines.push("", "--------------------------------------------------------------------------------", "");
    lines.push(licenseText(LICENSE_FILES[key]).trimEnd(), "");
  }
  return lines.join("\n");
}

/** 任务：thirdparty —— 随包 SDK manifest → THIRD_PARTY_NOTICES.md。 */
export const thirdpartyTask: FileTask = {
  kind: "file",
  name: "thirdparty",
  about: "随包 SDK 快照 + 装出来的第三方包 → THIRD_PARTY_NOTICES.md",
  plan: () => [{ rel: "THIRD_PARTY_NOTICES.md", content: render() }],
};
