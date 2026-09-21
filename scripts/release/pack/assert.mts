// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/assert.mts — 出包前的四处断言（产物不完整就拒包）。
//
// 都在 fail-closed 一侧：宁可不出包，也不出一个装了起不来的包。
import fs from "fs-extra";
import { join } from "node:path";

/** 交付树 package.json 允许出现的键（构建输入一律不进安装包）。 */
export const PRODUCT_PACKAGE_KEYS = ["name", "type", "version"];

/**
 * 交付树 package.json 校验：字段白名单 + 版本一致 + type: module。
 * 那份文件是 packaging/package.json（手写实体，version 由 derive 的 product-package 任务同步），
 * pack 复制成包根的 package.json。它被改坏/抄了旧版就直接拒包。
 * @param outDir - 交付目录（dist 或组装树）
 * @param version - 本次出包的版本
 */
export function assertProductPackage(outDir, version) {
  const p = join(outDir, "package.json");
  if (!fs.pathExistsSync(p)) {
    throw new Error("交付树的 package.json 缺失（packaging/package.json 没复制进来）：拒绝出包");
  }
  const j = fs.readJsonSync(p);
  const keys = Object.keys(j).sort();
  const allowed = [...PRODUCT_PACKAGE_KEYS].sort();
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length || keys.length !== allowed.length) {
    throw new Error(
      "交付树 package.json 字段不对：只允许 " + allowed.join("/") + "（多出 " + extra.join("/") + "）——构建入口字段不进安装包",
    );
  }
  if (j.version !== version) {
    throw new Error(
      `交付树 package.json version ${j.version} ≠ 本次出包版本 ${version}（跑 node scripts/derive/index.mts 同步后再打包）`,
    );
  }
  if (j.type !== "module") {
    throw new Error('交付树 package.json 必须 type: "module"（包根 index.js 是 ESM，缺了它宿主按 CommonJS 解析）');
  }
}

/**
 * cordis 子插件包 version 一致性校验（防回归，与 manifest 校验对称）：子插件（provider /
theme / clipboard）version 与主 package.json 同批由 derive/version（pnpm version 发版流程）
同步，pack 时读 dist 产物校验一致——手改/漏同步即出包版本漂移。
 * roster patch（dist/cordis.patch.yml）不是包，只校验在位。
 */
export function assertCordisDistVersions(outDir, version) {
  const cordisRoot = join(outDir, "cordis");
  // cordis 未组装 = 构建未跑/被清：fail-closed（校验放行空产物会让缺插件的包过包）
  if (!fs.pathExistsSync(cordisRoot)) {
    throw new Error("cordis 产物缺失（dist/cordis 不存在）：先跑 pnpm run build 再打包");
  }
  if (!fs.pathExistsSync(join(outDir, "cordis.patch.yml"))) {
    throw new Error("roster patch 缺失（dist/cordis.patch.yml 不存在）：先跑 pnpm run build 再打包");
  }
  // 完整性：子插件全部存在且 package.json 版本一致——缺失/部分产物（含 count=0）
  // 一律拒包，防 build 失败后残留部分 dist 被误打包。
  const required = [
    "clipboard", "provider", "theme",
  ];
  let count = 0;
  for (const name of required) {
    const pj = join(cordisRoot, name, "package.json");
    if (!fs.pathExistsSync(pj)) {
      throw new Error(
        `cordis 产物不完整：缺少 ${name}/package.json（dist/cordis 下）——先跑 pnpm run build 再打包`,
      );
    }
    const j = fs.readJsonSync(pj);
    if (j.version !== version) {
      throw new Error(
        `版本不一致：cordis 包 ${join("cordis", name, "package.json")} version ${j.version} ≠ package.json ${version}（跑 node scripts/derive/index.mts 同步后再打包）`,
      );
    }
    count += 1;
  }
  console.log(`[pack] cordis 子插件版本一致（${count} 个 = ${version}）+ roster patch 在位`);
}

/** App ui/ 静态树断言（cards route 资源面；相对资源契约）：缺失 = 卡片 404，拒包。 */
export function assertUiTree(outDir) {
  const uiDir = join(outDir, "ui");
  if (!fs.pathExistsSync(uiDir)) {
    throw new Error("App ui/ 静态树缺失（dist/ui 不存在）：src/ui 未随 build 拷贝——先跑 pnpm run build 再打包");
  }
  for (const rel of ["main.html", "sidebar.html", "app-shell.js"]) {
    if (!fs.pathExistsSync(join(uiDir, rel))) {
      throw new Error("App ui/ 缺 cards route 资源：" + rel + "（src/ui/" + rel + " 缺失或构建未跑）");
    }
  }
  console.log("[pack] ui/ 静态树完整（main/sidebar 壳页 + app-shell.js bundle）");
}

/** 集成覆盖的声明（每个 integration.json 的 package 字段与 overlay 数）。 */
function integrationDecls(integrationsDir) {
  if (!fs.pathExistsSync(integrationsDir)) {
    throw new Error(`集成目录不存在：${integrationsDir}（预期 src-integrations/；拒绝产出未打补丁的包）`);
  }
  const out: any[] = [];
  for (const e of fs.readdirSync(integrationsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(integrationsDir, e.name, "integration.json");
    if (!fs.pathExistsSync(p)) continue;
    const decl = JSON.parse(fs.readFileSync(p, "utf8"));
    out.push({
      name: e.name,
      package: decl.package,
      files: Array.isArray(decl.files) ? decl.files.length : 0,
    });
  }
  if (out.length === 0) {
    throw new Error(`没有有效的集成声明（${integrationsDir}）：拒绝产出未打补丁的包`);
  }
  return out;
}

/** 同步睡一会（打包脚本内部的顺序流程，不用事件循环）。 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * 物化完成后先确认集成目标包齐备，再进组装。物化是外部进程（pnpm），它退出与文件完全落盘
 * 之间有时差；没有这道闸时，残树会一路跑到覆盖阶段才报“物化树里没有 px”，看起来像是集成层的问题。
 * 有界等待（≤30s）只是给那个时差留窗口，等了还是缺就是真的缺，当场失败并点名。
 */
export function assertIntegrationTargets(modules, integrationsDir) {
  const targets = integrationDecls(integrationsDir);
  const missingOf = () => targets.filter((t) => !fs.pathExistsSync(join(modules, t.package, "package.json")));
  let missing = missingOf();
  if (missing.length > 0) {
    console.log(`[pack] 等物化落盘（缺 ${missing.length} 个集成目标包，最多等 30s）…`);
    const deadline = Date.now() + 30000;
    while (missing.length > 0 && Date.now() < deadline) {
      sleepSync(1000);
      missing = missingOf();
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `物化树缺少集成目标包（${missing.length}/${targets.length} 个，拒绝打包）：\n  - `
      + missing.map((t) => t.package).join("\n  - "),
    );
  }
  return targets.length;
}
