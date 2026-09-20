// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/build.mts — 编译集成进包（摊源 → 覆盖 overlay → 编译 → 装包 + 版本戳）。
//
// 每个集成的产物落在 _tmp/integrations-built/<短名>/：以**原版包为模板**（lib/index.js、
// lib/types、package.json 原样），只把 lib/client.js 换成我们编译的那份，版本戳为
// <上游版本>+dshana-<我们的干净版本>。
//
// 两道闸都在编译末尾：悬空外部引用（loader 模块表答不上）与类名唯一性（多个源文件生成
// 同一个 class，样式互相顶掉）。两者都是运行时才炸、且现场难归因的问题，只能在构建期拦。
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { MIRROR, REPO_ROOT, listMirrorFiles, readUpstreamFromMirror } from "./mirror.mts";

/**
 * 递归收集目录下源码文件里的**非相对导入 specifier**（含 type-only：列出无害）。
 * 用途有二：① 原版产物零 require 时充当 externals；② 收紧产物侧抽取的假阳性。
 * 根因：压缩后工厂参数被改名成单字符（如 e），`e("data-plugin")` 这种同名调用的字符串
 * 字面会被 extractRequires 误认成 require；而真正的外部依赖一定在源码里是 import。
 * @param {string} rootDir 源码根目录
 * @returns {Set<string>} specifier 集合
 */
function sourceSpecifiers(rootDir) {
  const seen = new Set<string>();
  const declRe = /(?:from|import)\s*\(?\s*["']([^"'.][^"']*)["']/g;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) continue;
      let text;
      try { text = readFileSync(p, "utf8") } catch { continue }
      let m;
      while ((m = declRe.exec(text)) !== null) seen.add(m[1]);
    }
  };
  walk(rootDir);
  return seen;
}

/**
 * 从 client bundle 里抽出它使用的外部依赖。
 * 两种姿势都要认：
 *   · 未压缩/官方产物：字面 `require("spec")`；
 *   · 我们自己压缩过的产物：banner 里的 factory 参数被改名（`factory:e=>{… e("spec")`）。
 * externals 的可信来源是**原版** bundle；本函数同样用于事后校验我方产物有无“悬空外部引用”。
 * @param {string} bundleText client bundle 文本
 * @returns {string[]} 去重后的 specifier 列表（保序）
 */
export function extractRequires(bundleText) {
  const text = String(bundleText ?? "");
  const out: string[] = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  const banner = /factory\s*:\s*([A-Za-z_$][\w$]*)\s*=>/.exec(text);
  if (banner) {
    const re = new RegExp(banner[1].replace(/\$/g, "\\$") + "\\(\\s*[\"'`]([^\"'`]+)[\"'`]\\s*\\)", "g");
    for (const m of text.matchAll(re)) push(m[1]);
  }
  const literal = /require\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(literal)) push(m[1]);
  return out;
}

/**
 * 类名唯一性闸：同一次集成构建里，一个 class 名只能由一个源文件生成。
 *
 * 为什么值得一道闸：被重建的包走同一条编译链，类名是「我们的前缀 + local」，没有上游的
 * 哈希；两个包各自把 frame/root 取成同一个全局名时，样式会互相顶掉（整页布局被另一个包
 * 的规则接管）。命名空间已按包身份分段，这里守的是残余情况：同包内两个模块重名，或将来
 * 两个包落进同一命名空间。数据源是编译时记的账（class 名 → 源文件），不扫产物文本，
 * 免掉压缩后的假阳性。
 * @param {Array<{short:string,cssClasses?:Array<{className:string,file:string}>}>} built 各集成的编译结果
 * @returns {string[]} 问题描述（空 = 通过）
 */
export function duplicateCssClasses(built) {
  const byClass = new Map();
  for (const b of Array.isArray(built) ? built : []) {
    for (const c of (b && b.cssClasses) || []) {
      if (!c || !c.className) continue;
      if (!byClass.has(c.className)) byClass.set(c.className, []);
      byClass.get(c.className).push(`${b.short}:${c.file}`);
    }
  }
  const problems = [];
  for (const [className, sources] of byClass) {
    const distinct = [...new Set(sources)];
    if (distinct.length > 1) problems.push(`类名 ${className} 由多个源文件生成：${distinct.join(" / ")}`);
  }
  return problems.sort();
}

/** 包名 → 本机依赖树里的原版包目录（模板与 externals 来源）。 */
export function templatePackageDir(pkgName, repoRoot = REPO_ROOT) {
  return join(repoRoot, "node_modules", ".pnpm", "node_modules", pkgName);
}

/**
 * 把「待内联的非相对 specifier」解析成绝对文件的 alias 表。
 *
 * 为何需要（本质是幽灵依赖）：集成的 stage 树（_tmp/integrations-src/<短名>）只有 src/ 与 lib/，
 * 既没有自己的 package.json 也没有 node_modules——它里面每一条非相对导入都只能向上走到**本仓**
 * 的依赖树去解，也就是在靠 hoisting 碰运气。上游没有这个问题：它的这些包是 monorepo 的
 * workspace 兄弟，打包器直接从工作区解。
 * 所以这里不做“碰巧能解到”，只做“显式声明 + 显式解析”：库由配套的 devDependencies 声明
 * （devDep 会被内联，不进运行时），路径用本脚本已有的同一条约定 .pnpm/node_modules/<name>
 * （templatePackageDir 取原版包走的就是它）。
 * 另一层现实：pnpm 在 Windows 长路径下会把实体放进带哈希的 .pnpm 目录，而根级链接指向一个
 * 不存在的名字（dangling）——本地 <repo>/node_modules/<pkg> 解不开，CI（Linux）上反而正常。
 * 赌链接形态就是赌构建机，故不赌。
 * 只处理 externals 之外的 specifier：React 这类必须保持外部，内联成副本反而错。
 * @param {Iterable<string>} specifiers 待内联的 specifier
 * @param {string} repoRoot 仓库根
 * @returns {Record<string,string>} specifier → 绝对路径
 */
export function resolveInlineAliases(specifiers, repoRoot = REPO_ROOT) {
  const req = createRequire(import.meta.url);
  const alias = {};
  for (const spec of specifiers) {
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    const hoisted = templatePackageDir(pkg, repoRoot);
    if (!existsSync(hoisted)) continue;
    try {
      alias[spec] = req.resolve(spec, { paths: [hoisted] });
    } catch {
      // 解析不到就交给打包器自己试（纯类型导入本就无需解析）
    }
  }
  return alias;
}

/**
 * buildIntegrations 的选项。tag 必填（镜像 tag），其余有默认。
 * 显式给出形状：不注解时 TS 从带默认值的解构参数推断，未带默认值的 tag 反而不进类型，
 * 声明处与调用处都会报「'tag' 不存在」（TS2339/TS2353）。
 */
interface BuildIntegrationsOptions {
  tag: string;
  mirrorDir?: string;
  repoRoot?: string;
  log?: (msg: string) => void;
}

/**
 * 编译一个集成：把上游 src 摊到 _tmp/integrations-src/<短名>/，覆盖 overlay，
 * 用我们的 client preset 编译出 lib/client.js，再以原版包为模板组装成
 * _tmp/integrations-built/<短名>/（版本戳 <上游>+dshana-<干净版本>）。
 */
export async function buildIntegrations(integrations, { tag, mirrorDir = MIRROR, repoRoot = REPO_ROOT, log = (_msg) => {} }: BuildIntegrationsOptions) {
  const { buildClientBundle } = await import("../../src-cordis/build/client-config.mts");
  const { patchVersion } = await import("../shared/version.mts");
  const built: any[] = [];
  for (const it of integrations) {
    const short = it.dir;
    const pkg = String(it.package || "");
    const upstreamDir = String(it.upstreamDir || "");
    const template = templatePackageDir(pkg, repoRoot);
    if (!existsSync(template)) throw new Error(`integration ${short}: 本机依赖树找不到原版包 ${template}`);

    // 1) 摊源（上游 src 全量，保留相对路径——entry 就是上游的 src/client/index.ts）
    const stage = join(repoRoot, "_tmp", "integrations-src", short);
    rmSync(stage, { recursive: true, force: true });
    const files = listMirrorFiles(tag, `${upstreamDir}/src`, mirrorDir);
    if (files.length === 0) throw new Error(`integration ${short}: 镜像 ${tag} 下没有 ${upstreamDir}/src`);
    for (const rel of files) {
      const buf = readUpstreamFromMirror(rel, tag, mirrorDir);
      if (buf === null) throw new Error(`integration ${short}: 读不到 ${rel}`);
      const dst = join(stage, rel.slice(upstreamDir.length + 1));
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, buf);
    }

    // 2) 覆盖我们的 overlay（新文件同样落盘）
    for (const f of Array.isArray(it.files) ? it.files : []) {
      const src = join(it.root, "files", f.path);
      if (!existsSync(src)) throw new Error(`integration ${short}: overlay 文件缺失 ${src}`);
      const dst = join(stage, f.path);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
    }

    // 2.5) 覆盖层类型检查（构建只转译不检查；未定义的名字/不存在的成员在这一步拦）。
    //      跳过口只给本机调试（DSHANA_SKIP_TYPECHECK=1），跳过会大声说一声。
    if (process.env.DSHANA_SKIP_TYPECHECK === "1") {
      log(`[integrations] ${short}: **跳过覆盖层类型检查**（DSHANA_SKIP_TYPECHECK=1）`);
    } else {
      const { typecheckOverlay } = await import("../check/overlay.mts");
      typecheckOverlay({ short, stage, files: it.files, repoRoot, mirrorDir, log: (m) => log(m) });
    }

    // 3) externals = 原版 bundle 自己的 require 集合。
    //    例外：client 半只有类型导入的包（如 dsh-client-hmr）——原版产物里**零 require**。
    //    这不能当「抽取失败」（fail-closed 会误杀整个集成）：改为从缓存的源码取非相对
    //    specifier 作 externals——真正的外部依赖仍保持外部化（不被内联成重复副本），
    //    类型导入列出来无害（会被构建抹掉）。
    const pristineClient = join(template, "lib", "client.js");
    if (!existsSync(pristineClient)) throw new Error(`integration ${short}: 原版缺 lib/client.js（${pristineClient}）`);
    let externals = extractRequires(readFileSync(pristineClient, "utf8"));
    if (externals.length === 0) {
      externals = [...sourceSpecifiers(join(stage, "src"))];
      console.log(`[integrations] ${short}: 原版 bundle 零 require（client 半仅类型导入），externals 取自有源码（${externals.join(", ") || "空"}）`);
    }
    // 源码里的非相对导入（后面判悬空与算别名都用它，只算一次）
    const imported = sourceSpecifiers(join(stage, "src"));

    // 4) 编译 client 半
    const outDir = join(stage, "lib");
    const entryRel = files.includes(`${upstreamDir}/src/client/index.ts`) ? "src/client/index.ts" : "src/client/index.tsx";
    // 待内联的库得先能解到（见 resolveInlineAliases 注释：pnpm 长路径下根级链接是悬空的）。
    const alias = resolveInlineAliases([...imported].filter((s) => !externals.includes(s)), repoRoot);
    if (Object.keys(alias).length) {
      console.log(`[integrations] ${short}: 内联别名 ${Object.keys(alias).join(", ")}`);
    }
    const bundle = await buildClientBundle({ id: pkg, pkgDir: stage, outDir, externals, entry: entryRel, alias });

    // 4b) 悬空外部引用闸：产物里出现 externals 之外的引用 = loader 模块表答不上 → 运行时必炸。
    // 典型成因：上游 bundle 内联的第三方库（如 clsx）在本仓库 node_modules 里缺失，
    // 解析不到就被当成 external。处理：把该库加进 devDependencies（devDep 会被内联，不进运行时）。
    const produced = extractRequires(readFileSync(join(outDir, "client.js"), "utf8"));
    // 产物侧抽取在**压缩后**会出假阳性（minifier 把工厂参数改成单字符，`e("data-plugin")`
    // 这类同名调用的字符串字面会被误认成 require）。判据收紧为「确实是源码里的非相对导入」：
    // 只有这类 specifier 悬空才是真问题（clsx 就属于此类：源码 import 了它、产物 require 了它、
    // 而 externals 里没有它）。
    const dangling = produced.filter((s) => !externals.includes(s) && imported.has(s));
    const noise = produced.filter((s) => !externals.includes(s) && !imported.has(s));
    if (noise.length) console.log(`[integrations] ${short}: 产物抽取忽略 ${noise.length} 个非导入字面（假阳性）：${noise.join(", ")}`);
    if (dangling.length) {
      throw new Error(
        `integration ${short}: 产物含悬空外部引用 ${dangling.join(", ")} —— ` +
          `loader 模块表答不上这些 specifier（上游 bundle 里它们是内联的）。` +
          `请把对应库装进 devDependencies（devDep 会被内联）后重跑，或确认它确实应是外部。`,
      );
    }

    // 5) 以原版包为模板组装（lib/index.js、lib/types、package.json 等原样；client.js 换我们的）
    const out = join(repoRoot, "_tmp", "integrations-built", short);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(template, "lib"), join(out, "lib"), { recursive: true });
    cpSync(join(stage, "lib", "client.js"), join(out, "lib", "client.js"));
    const manifest = JSON.parse(readFileSync(join(template, "package.json"), "utf8"));
    // 版本戳：<上游版本>+dshana-<我们的干净版本>（合成在 scripts/shared/version.mts，与 derive 同一份）。
    // 上游段原样保留：一眼看出改的是哪个上游包。
    manifest.version = patchVersion(manifest.version);
    writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2));

    const size = readFileSync(join(out, "lib", "client.js")).length;
    log(`[integrations] ${short}: ${pkg}@${manifest.version} 编译完成（client.js ${size}B，externals ${externals.length} 个）`);
    built.push({ short, pkg, version: manifest.version, out, externals, bytes: size, cssClasses: bundle.cssClasses });
  }

  // 类名唯一性闸：产物都已落地，重名此刻就能判死。跨包撞名的代价是样式互相顶掉（表现是
  // 整页布局被另一个包的规则接管），而产物里看不出类名归属，只能在构建期拦。
  const clashes = duplicateCssClasses(built);
  if (clashes.length) {
    throw new Error(
      "集成构建的类名唯一性闸未通过（同一个 class 名被多个源文件生成，样式会互相顶掉）：\n" +
        clashes.map((c) => "  - " + c).join("\n") +
        "\n先查 cssScopeOf 的命名空间分段是否让两个包落到了一起，再查同包内是否有两个模块用了同一个 local 名。",
    );
  }
  return built;
}
