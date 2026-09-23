// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/build/server-config.mts — 集成层的 server 半共享 preset（rspack + swc）
//
// 上游的 api 包发布的是**单个 ESM bundle**（lib/index.js：只 import node 内建与 dsh-* 兄弟包，
// 未压缩），我们的 overlay 是那份包的 TS 源码。要既带上 delta、又不把兄弟包内联成重复副本，
// 就得用同一姿势重打一遍：非相对导入保持外部，相对导入合并进同一个文件。
//
// 为什么是 rspack（而不是 client 半用的 tsdown）：上游源码带 **标准装饰器**（`@Remote('list')`
// 挂在类方法上，实现在 dsh-typert-protocol 的 remoteDecorator，按 (value, context) 取值）。
// rolldown/oxc 现在只降 legacy：标准装饰器会被原样放出去（`@(void 0)` 之类仍是语法错误，
// node 一 import 就 Invalid or unexpected token）。swc 要 `legacyDecorator: false` +
// `decoratorVersion: "2022-03"` 才按标准提案降级，语义与上游产物一致。
//
// 与上游产物对齐的三处：format esm（不是 closure-factory 的 cjs）、platform node、不压缩。
// dts 不从源码生成：上游的 lib/types/** 与 lib/*.d.ts 原样沿用模板（覆盖层只加可选字段，
// 方法签名没变，声明面不用重打）。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

/** 判断 specifier 是否该保持外部：非相对、非绝对路径的一律外部（node 内建由 externalsPresets 管）。 */
function isBare(spec) {
  const s = String(spec || "");
  if (!s) return false;
  if (s.startsWith(".") || s.startsWith("file:") || s.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return false; // win32 绝对路径
  return true;
}

/** 解析 rspack（RSPACK_ENV 或本地 node_modules；与 src-cordis/build.ts 同一口径）。 */
async function loadRspack() {
  const envDir = process.env.RSPACK_ENV;
  if (envDir) {
    const coreDir = join(envDir, "node_modules", "@rspack", "core");
    const pkg = JSON.parse(fs.readFileSync(join(coreDir, "package.json"), "utf8"));
    const dot = pkg.exports?.["."];
    let entry: string | null = null;
    if (typeof dot === "string") entry = dot;
    else if (dot && typeof dot === "object") entry = dot.default ?? dot.import ?? dot.require ?? null;
    const mod = await import(pathToFileURL(join(coreDir, entry || pkg.main || "dist/index.js")).href);
    return mod.rspack ?? mod.default?.rspack;
  }
  const mod = await import("@rspack/core");
  return mod.rspack ?? mod.default?.rspack;
}

/**
 * 产物闸：让 node 自己 parse 一遍这份 ESM，parse 不过即拒。
 *
 * 为什么非得在构建期查：标准装饰器是转译器上的静默陷阱——配置差一格，装饰器会被原样放
 * 出去，构建照旧「成功」，产物直到 import 那一刻才 SyntaxError（DSH 插件树加载失败、宿主
 * runtime 永远停在「启动中」）。上游产物是同一姿势打出来的，所以判据只能是「node 读不读
 * 得进去」，而不是「我们配对了没有」。
 *
 * 复制成 .mjs 再查：产物同目录的 package.json 未必声明 type:module，而这里的判据是
 * 「这份 ESM 能不能被 node 解析」，不吃目录里的声明。
 * @param file - 产物路径
 * @param label - 报错里指代它的名字
 */
export function assertParseableModule(file, label = basename(file)) {
  const tmp = join(dirname(file), `.syntax-check-${randomBytes(6).toString("hex")}.mjs`);
  fs.writeFileSync(tmp, fs.readFileSync(file));
  try {
    const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`产物语法不合法（${label}）：` + String(res.stderr || res.stdout || "").trim());
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 产物闸：服务半产物里不得出现构建机的源码路径（暂存树路径）。
 *
 * 为什么非得在构建期拦：路径元数据（import.meta.url 一类）被静态求值后，产物会把构建机的
 * 暂存树路径冻进去，运行期从那里解析依赖；这个错误只在真机、只在走到那条引用路径时才现形，
 * 构建期不拦就等于赌「用户机器上恰好没有这棵树」。
 * @param file - 产物路径
 * @param pkgDir - 该包的源码树根（暂存树），泄漏点必然是它
 * @param label - 报错里指代它的名字
 */
export function assertNoSourcePathLeak(file, pkgDir, label = basename(file)) {
  const text = fs.readFileSync(file, "utf8");
  const normalized = String(pkgDir).replace(/\\/g, "/");
  // 三种形态都查：URL 形态（file:///…）、正斜杠、本机分隔符。产物里的路径字面通常前两种。
  for (const probe of [...new Set([pathToFileURL(pkgDir).href, normalized, String(pkgDir)])]) {
    const at = text.indexOf(probe);
    if (at < 0) continue;
    const snippet = text.slice(Math.max(0, at - 60), at + probe.length + 60).replace(/\s+/g, " ").trim();
    throw new Error(
      `产物含构建机源码路径（${label}）：${probe}\n  现场：…${snippet}…\n` +
        "  路径元数据（import.meta.url 等）应保留给运行时求值（见本文件 module.parser.javascript.importMeta）。",
    );
  }
}

/**
 * 打一个包的 server 半（单文件 ESM bundle）。
 * @param opts - { id, pkgDir, outDir, entry, outFile }：id = 包名；pkgDir = 源码树根
 *   （stage 树，entry 相对它）；outDir = lib 目标目录；entry 缺省 src/index.ts；
 *   outFile 缺省 index.js。
 * @returns { id, out }：产物路径
 */
export async function buildServerBundle({ id, pkgDir, outDir, entry = "src/index.ts", outFile = "index.js" }) {
  const rspack = await loadRspack();
  const out = join(outDir, outFile);
  const compiler = rspack({
    name: id + "/server",
    mode: "production",
    target: "node",
    entry: join(pkgDir, entry),
    output: {
      path: outDir,
      filename: outFile,
      module: true,
      library: { type: "module" },
      clean: false, // 同目录还有模板拷来的 package.json / lib/types（clean 会误删）
    },
    experiments: { outputModule: true },
    externalsPresets: { node: true },
    externalsType: "module",
    externals: [(ctx, cb) => (isBare(ctx.request) ? cb(null, ctx.request) : cb())],
    module: {
      parser: {
        javascript: {
          // import.meta 的元数据一律留给运行时求值。静态求值的代价在服务半是真金白银的故障：
          //   · `import.meta.url` 按「模块自身的源码路径」求值 → 构建机路径被冻进产物，运行期从
          //     那里解析依赖（本机恰好还有那棵暂存树时是 MODULE_NOT_FOUND，别的机器上锚点不存在）；
          //   · 静态处理 `import.meta.resolve` → 包内子入口（如 …/runner）被换成模块 id，运行期解析落空。
          // 上游发布产物三处元数据都保留运行时形态（import.meta.url / import.meta.resolve /
          // new URL(…, import.meta.url)），这里对齐。
          importMeta: false,
          // `new URL(字面量, import.meta.url)` 不当作构建期资源引用：node 服务半没有资源图，上游这处
          // 指的是包外的 tsconfig——构建期解析必然失败。见 module-parser 的 javascript.url。
          url: false,
        },
      },
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: "builtin:swc-loader",
            options: {
              jsc: {
                parser: { syntax: "typescript", decorators: true },
                transform: { legacyDecorator: false, decoratorVersion: "2022-03" },
                target: "es2022",
              },
            },
          },
        },
      ],
    },
    // minimize false：对齐上游产物（lib/index.js 未压缩）。
    // usedExports/sideEffects false：不许摇树丢掉「只为副作用存在」的模块（装饰器注册、prototype 写入）。
    optimization: { minimize: false, usedExports: false, sideEffects: false, concatenateModules: true },
    node: false,
    devtool: false,
    stats: "errors-warnings",
  });
  await new Promise<void>((resolve, reject) => {
    compiler.run((err, stats) => {
      if (err) return reject(err);
      if (!stats || stats.hasErrors()) {
        return reject(new Error("server 半编译失败（" + id + "）：\n" + String(stats ? stats.toString({ errors: true }) : err)));
      }
      const warnings = stats.toString({ warnings: true });
      if (warnings && warnings.trim()) console.log("[integrations] " + id + " server 半告警：\n" + warnings);
      resolve();
    });
  });
  assertParseableModule(out, `${id} 的 server 半（${outFile}）`);
  assertNoSourcePathLeak(out, pkgDir, `${id} 的 server 半（${outFile}）`);
  return { id, out };
}
