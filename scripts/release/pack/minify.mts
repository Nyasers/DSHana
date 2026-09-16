// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/minify.mts — dist 静态件（cordis 插件 JS）的语法级压缩，覆盖写回。
//
// cordis 插件（dist/cordis/*/index.js，由 build 从 src-cordis 组装）被 dsh 运行时 import()
// 加载、client.js 被浏览器 ModuleLoader 按 window.__ModuleLoader__.load 注册；均只做语法级压缩。
import { createRequire } from "node:module";
import fs from "fs-extra";
import { join } from "node:path";

import { errText } from "../../shared/err-text.mts";

const require = createRequire(import.meta.url);

/** 取工具包：RSPACK_ENV 指到构建环境时优先在那边解析，否则回退本仓 node_modules。 */
function resolveTool(pkgName) {
  const envDir = process.env.RSPACK_ENV;
  if (envDir) {
    const envRequire = createRequire(join(envDir, "node_modules", "noop.js"));
    try {
      return envRequire(pkgName);
    } catch {
      console.log(`[pack] RSPACK_ENV 下未找到 ${pkgName}，回退本地 node_modules`);
    }
  }
  return require(pkgName);
}

function collectStaticFiles(dir, recursive = true, ext = ".js") {
  const files: string[] = [];
  if (!fs.pathExistsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const p = join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (recursive) files.push(...collectStaticFiles(p, true, ext));
    } else if (name.endsWith(ext)) {
      files.push(p);
    }
  }
  return files;
}

// module 启发式（JS 专用）：顶层 import/export 语句 → module: true（ESM）
function isEsm(code) {
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return /\b(?:import|export)\s/.test(noComments);
}

/** 压缩 dist/cordis 下的静态 JS（terser 纯语法级），原地覆盖。 */
export async function minifyDistStatics(distDir) {
  const terser = resolveTool("terser");
  const minify = terser.minify ?? terser.default?.minify;
  if (typeof minify !== "function") throw new Error("terser 加载失败：未找到 minify");
  const staticJs = [...collectStaticFiles(join(distDir, "cordis"))];
  console.log(`[pack] minify static js (${staticJs.length} files)...`);
  for (const file of staticJs) {
    const code = fs.readFileSync(file, "utf8");
    const before = Buffer.byteLength(code, "utf8");
    let result;
    try {
      result = await minify(code, {
        compress: true,
        mangle: true,
        module: isEsm(code),
        format: { comments: false },
      });
    } catch (err) { throw new Error(`terser 压缩失败（${file}）：${errText(err)}`); }
    if (!result?.code) throw new Error(`terser 压缩失败（${file}）：无输出`);
    fs.writeFileSync(file, result.code, "utf8");
    console.log(`[pack]   ${file}: ${before} -> ${Buffer.byteLength(result.code, "utf8")} bytes`);
  }
}
