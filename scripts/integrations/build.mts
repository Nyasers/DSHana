// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations/build.mts — 编译集成进包（摊源 → 覆盖 overlay → 编译 → 装包 + 版本戳）。
//
// 每个集成的产物落在 .cache/integrations/<短名>/：以**原版包为模板**（lib/index.js、
// lib/types、package.json 原样），只把 lib/client.js 换成我们编译的那份，版本戳为
// <上游版本>+dshana-<我们的干净版本>。摊源树（上游 src 全量 + 我们的 overlay）挂在
// .cache/integrations-src/<短名>/，每轮重摊，留着重在方便看摊出来的东西。
//
// 两道闸都在编译末尾：悬空外部引用（loader 模块表答不上）与类名唯一性（多个源文件生成
// 同一个 class，样式互相顶掉）。两者都是运行时才炸、且现场难归因的问题，只能在构建期拦。
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { MIRROR, REPO_ROOT, listMirrorFiles, readUpstreamFromMirror } from "./mirror.mts";
import { integrationsDirOf, integrationsSrcDirOf } from "../shared/paths.mts";

/**
 * 递归收集目录下源码文件里的非相对导入 specifier。
 * 用途有二：① 原版产物零 require 时充当 externals（只取其中的值导入）；② 收紧产物侧抽取的假阳性。
 * 根因：压缩后工厂参数被改名成单字符（如 e），`e("data-plugin")` 这种同名调用的字符串
 * 字面会被 extractRequires 误认成 require；而真正的外部依赖一定在源码里是 import。
 *
 * 两种导入分开记：`import type` 在构建期被抹掉，**不产生 require**，绝不能当 external——
 * 列进去就等于宣称「loader 会答这个词」，而它连调用都不会有（client-hmr 的 cordis 就是这种）。
 *
 * 分类的粒度是**语句**而非文件：同一个文件里完全可以既有 `import type { A } from "react"`
 * 又有 `import { b } from "react"`，按文件归会把后者一起当成类型（react 从此不在 values 里，
 * externals 与两道闸全部失明）。所以先逐条认出声明、再看这一条带没带 `type`。
 * @param {string} rootDir 源码根目录
 * @returns {{values: Set<string>, types: Set<string>}} 值导入与类型导入
 */
export function sourceSpecifiers(rootDir) {
  const values = new Set<string>();
  const types = new Set<string>();
  // 一条声明 = 关键字 + 可选的 `type` + 中间那段（绑定了什么）+ from "spec"；
  // 或裸 `import "spec"`。
  // 中间段用 [^;'"`\n] 把住三件事：不跨过字符串（否则会掳到上一个声明的引号）、
  // 不跨过分号、**不跨行**。不卡换行时会跨过前一行注释：`… merges.\nimport type { X } from`
  // 里 `import` 会从注释末尾那个单词起匹配，`type` 关键字被吃进中间段，
  // 于是类型导入被误判成值导入，凭空给 externals 加一个模块表答不上的词。
  const declRe = /\b(import|export)\s*(type\s+)?([^;'"`\n]*?)\bfrom\s*(["'])([^"']+)\4|\bimport\s*(["'])([^"']+)\6/g;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) continue;
      let text;
      try { text = readFileSync(p, "utf8") } catch { continue }
      declRe.lastIndex = 0;
      let m;
      while ((m = declRe.exec(text)) !== null) {
        // 裸 import "spec"（无绑定）永远是值导入
        const spec = m[5] ?? m[7];
        // 相对路径 / 绝对路径 / 子路径别名不是包，不进外部表（相对导入由打包器自己拼）
        if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) continue;
        const bound = (m[3] ?? "");
        // `type` 关键字之后必须跟 `{...}` 或 `*` 才算仅类型；`import type from "x"`（默认导入
        // 恰好叫 type）是值导入，不能误伤。
        const typeOnly = Boolean(m[2]) && /[\{*]/.test(bound);
        if (typeOnly) types.add(spec);
        else values.add(spec);
      }
    }
  };
  walk(rootDir);
  // 同一个词既当值又当类型用时就以值为准（真会发 require）
  for (const t of types) if (values.has(t)) types.delete(t);
  return { values, types };
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
  const problems: string[] = [];
  for (const [className, sources] of byClass) {
    const distinct = [...new Set(sources)];
    if (distinct.length > 1) problems.push(`类名 ${className} 由多个源文件生成：${distinct.join(" / ")}`);
  }
  return problems.sort();
}

/**
 * 我们从源码加进会话请求的那个可选字段，在生成物里要补成的形状。
 * 与 src/types.ts 的 ModelSelection 一致：provider/model 必填，reasoningEffort 可选。
 * 缩进照生成物的习惯（对象属性一律两格，嵌套对象不额外缩）。
 */
const SESSION_MODEL_SCHEMA = [
  "  'model': z.object({",
  "  'provider': z.string().readonly(),",
  "  'model': z.string().readonly(),",
  "  'reasoningEffort': z.string().readonly().optional(),",
  "}).readonly().optional(),",
].join("\n") + "\n";

/**
 * 把我们从源码声明的请求字段补进生成的 RPC 校验表（纯函数）。
 *
 * 为何得有这一手：`lib/typert.host.js` 是上游**发布时**由 dsh-typert-generator 从 FaceModel
 * 生成的（不在上游 git 里，生成器也不在运行时依赖里），它对每个远端方法按 request 类型逐字段
 * 列 zod 校验；而 zod 的 `z.object` 对未见过的键默认是**剥离**。于是只在 src/types.ts 里加的
 * 字段在 RPC 边界被拿走，服务端读到的永远是 undefined——现场只剩「模型没生效」这种无从归因的
 * 样子（服务端反而报它自己的默认路由不可服务）。
 * 定位靠锚点：schema 常量名 + `z.object({` 换行。上游换了生成器/改名/换形状就抛，不静默放过；
 * 若上游哪天把字段做进协议（schema 里已有 model），也抛——那是这里的补丁该撤的信号。
 * @param text - 生成物文本（lib/typert.host.js）
 * @param schemaNames - 要补的 schema 常量名（如 session_prompt_parameter_0）
 * @param label - 报错里指代它的名字（包名）
 * @returns 补好的文本
 */
export function patchGeneratedRequestModel(text, schemaNames, label = "生成物") {
  let out = String(text ?? "");
  for (const name of schemaNames) {
    const re = new RegExp(`const \\w*${name}\\$schema = \\(\\) => \\([\\s\\S]*?z\\.object\\(\\{\\n`);
    const m = re.exec(out);
    if (!m) {
      throw new Error(
        `${label}: 生成物里找不到 ${name} 的 schema 锚点——` +
          "上游换了生成物形状，补丁要重新对账（lib/typert.host.js 是生成的，只能靠锚点定位）",
      );
    }
    const at = m.index + m[0].length;
    const end = out.indexOf("\n}))", at);
    const body = out.slice(at, end >= 0 ? end : out.length);
    if (/'model':/.test(body)) {
      throw new Error(`${label}: ${name} 的 schema 里已经有 model 字段——上游把它做进协议了，这里的补丁该撤`);
    }
    out = out.slice(0, at) + SESSION_MODEL_SCHEMA + out.slice(at);
  }
  return out;
}

/**
 * 包名 → 本机依赖树里的原版包目录（模板与 externals 来源）。
 *
 * 先看 .pnpm/node_modules：pnpm 把**非直接依赖**提升进那里；直接依赖留在顶层 node_modules/，
 * 而覆盖层的包往往正是直接依赖（要有它的类型与产物就得自己声明）。顶层链接在 Windows 长
 * 路径下可能是 dangling，所以不拼路径，交给 Node 的解析拿实际位置。解不到时返回原路径，
 * 让调用方报出与从前一致的缺失信息。
 */
export function templatePackageDir(pkgName, repoRoot = REPO_ROOT) {
  const hoisted = join(repoRoot, "node_modules", ".pnpm", "node_modules", pkgName);
  if (existsSync(hoisted)) return hoisted;
  try {
    return dirname(createRequire(join(repoRoot, "package.json")).resolve(`${pkgName}/package.json`));
  } catch {
    return hoisted;
  }
}

/**
 * 从镜像读上游的平台模块词表（`packages/client/web/src/platform.ts` 的 PLATFORM_MODULES
 * 与 PRELOADED_CLIENT_EXTERNALS）。
 *
 * 为何不本地手抄一份：这两个数组是上游交付口径的一部分，抄一份就是第二事实源，上游一变
 * 我们就静默落后。读不到就返回 null，调用方退成旧行为并说一声（不静默假装知道）。
 * @param {string} tag 镜像 tag
 * @param {string} mirrorDir 镜像目录
 * @returns {{platform: Set<string>, preloaded: Set<string>} | null}
 */
export function readPlatformWords(tag, mirrorDir) {
  const rel = "packages/client/web/src/platform.ts";
  let text;
  try {
    const buf = readUpstreamFromMirror(rel, tag, mirrorDir);
    if (buf === null) return null;
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  /** 取一处 `const NAME = [ ... ]` 里的字符串字面（容忍换行与注释）。 */
  const listOf = (name) => {
    const start = text.indexOf(`const ${name}`);
    if (start < 0) return null;
    const open = text.indexOf("[", start);
    if (open < 0) return null;
    const close = text.indexOf("]", open);
    if (close < 0) return null;
    const body = text.slice(open, close);
    return new Set([...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]));
  };
  const platform = listOf("PLATFORM_MODULES");
  const preloaded = listOf("PRELOADED_CLIENT_EXTERNALS");
  if (platform === null) return null;
  return { platform, preloaded: preloaded ?? new Set() };
}

/**
 * 把「待内联的非相对 specifier」解析成绝对文件的 alias 表。
 *
 * 为何需要（本质是幽灵依赖）：集成的摊源树（.cache/integrations-src/<短名>）只有 src/ 与 lib/，
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
 * 编译一个集成：把上游 src 摊到 .cache/integrations-src/<短名>/，覆盖 overlay，
 * 用我们的 client preset 编译出 lib/client.js，再以原版包为模板组装成
 * .cache/integrations/<短名>/（版本戳 <上游>+dshana-<干净版本>）。
 */
export async function buildIntegrations(integrations, { tag, mirrorDir = MIRROR, repoRoot = REPO_ROOT, log = (_msg) => {} }: BuildIntegrationsOptions) {
  const { buildClientBundle } = await import("../../packages/app/src/cordis/client-config.mts");
  const { patchVersion } = await import("../shared/version.mts");
  const built: any[] = [];
  for (const it of integrations) {
    const short = it.dir;
    const pkg = String(it.package || "");
    const upstreamDir = String(it.upstreamDir || "");
    const template = templatePackageDir(pkg, repoRoot);
    if (!existsSync(template)) throw new Error(`integration ${short}: 本机依赖树找不到原版包 ${template}`);

    // 1) 摊源（上游 src 全量，保留相对路径——entry 就是上游的 src/client/index.ts）
    const stage = join(integrationsSrcDirOf(repoRoot), short);
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

    // 3) 分派两半：integrations/<短名>/integration.json 的 halves。没写 halves = 只有 client 半
    //    （既有八个集成都是这样）；server 半是上游 api 包那一类（发布单文件 ESM bundle）。
    const halves = it.halves && typeof it.halves === "object" ? it.halves : {};
    const serverDecl = halves.server && typeof halves.server === "object" ? halves.server : null;
    const wantClient = halves.client !== false;
    if (!wantClient && !serverDecl) {
      throw new Error(`integration ${short}: halves 既没 client 也没 server（没东西可编译）`);
    }

    /** client 半的编译结果（集成只声明 server 半时是 null）。 */
    let clientArtifact: {
      bytes: number;
      externals: string[];
      cssClasses: Array<{ className: string; local: string; scope: string; file: string }>;
    } | null = null;
    if (wantClient) {
      // 3a) externals = 原版 bundle 自己的 require 集合。
      //    例外：client 半只有类型导入的包（如 dsh-client-hmr）——原版产物里**零 require**，
      //    因为上游 preset 把「不在模块表里的一切」都内联了（eventsource-parser 就内联在产物里）。
      //    这时不能从源码把所有非相对 import 都当 external：那会把本该内联的第三方库（甚至
      //    `import type` 这种根本不发 require 的）一并宣告成外部，而 loader 模块表答不上它们，
      //    运行时就是 require(...) missed the module table。
      //    正确口径 = 上游自己的口径：只有模块表能答的词才保持外部，其余一律内联。
      //    模块表能答的词 = PLATFORM_MODULES ∪ PRELOADED_CLIENT_EXTERNALS ∪ 本包 dsh.client.external，
      //    前两者直接从镜像的上游 platform.ts 读（不本地手抄）。
      const pristineClient = join(template, "lib", "client.js");
      if (!existsSync(pristineClient)) throw new Error(`integration ${short}: 原版缺 lib/client.js（${pristineClient}）`);
      let externals = extractRequires(readFileSync(pristineClient, "utf8"));
      if (externals.length === 0) {
        const specs = sourceSpecifiers(join(stage, "src"));
        const words = readPlatformWords(tag, mirrorDir);
        if (words === null) {
          // 读不到上游词表就不能猜：退成旧行为会让第三方库变外部引用并在运行时炸。
          throw new Error(
            `integration ${short}: 原版 bundle 零 require，且读不到镜像 ${tag} 的 ` +
              `packages/client/web/src/platform.ts 来判定模块表词表；无法可靠推出 externals`,
          );
        }
        const manifestDsh = JSON.parse(readFileSync(join(template, "package.json"), "utf8"));
        const declared = Array.isArray(manifestDsh?.dsh?.client?.external) ? manifestDsh.dsh.client.external : [];
        const tableWords = new Set([...words.platform, ...words.preloaded, ...declared]);
        externals = [...specs.values].filter((s) => tableWords.has(s));
        const inlined = [...specs.values].filter((s) => !tableWords.has(s));
        console.log(
          `[integrations] ${short}: 原版 bundle 零 require，externals 按模块表取 ${externals.join(", ") || "空"}` +
            (inlined.length ? `（其余内联：${inlined.join(", ")}）` : "") +
            (specs.types.size ? `；类型导入不计：${[...specs.types].join(", ")}` : ""),
        );
      }
      // 源码里的非相对值导入（后面判悬空与算别名都用它，只算一次）
      const imported = sourceSpecifiers(join(stage, "src")).values;

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
      // 4b-bis) 模块表闸：产物里每一个 require 的 specifier 都必须能被 loader 模块表答上。
      // 上面的 dangling 闸只看「externals 之外且源码里有的」——当 externals 本身算错时它会失效：
      // client-hmr 那次 fallback 把 eventsource-parser/stream 当成了 external，于是
      // `!externals.includes(s)` 恒假，闸一言不发，装到真机上才在 web boot 时报
      // require(...) missed the module table。所以这里不再拿 externals 做参照，而是直接问
      // 「模块表能不能答这个词」：答不上就是错，少了一个外部声明也罢、多了一个也罢。
      const tableWords = (() => {
        const words = readPlatformWords(tag, mirrorDir);
        if (words === null) return null;
        const manifestDsh = JSON.parse(readFileSync(join(template, "package.json"), "utf8"));
        const declared = Array.isArray(manifestDsh?.dsh?.client?.external) ? manifestDsh.dsh.client.external : [];
        return new Set([...words.platform, ...words.preloaded, ...declared]);
      })();
      if (tableWords !== null) {
        // 只拿「确实是源码里导入过的词」来问：压缩后 `e("hidden")` / `e("copied")` 这类
        // 同名调用的字符串字面会被 extractRequires 误认成 require（上游 lint 文案就是这么进
        // 产物的），拿它们去问模块表只会得到假阳。代价是：若某个真外部词同时不是源码导入，
        // 这里看不见它（那种情况下上面的 dangling 闸也看不见，而两闸合起来覆盖已足够）。
        const unanswerable = produced.filter((s) => imported.has(s) && !tableWords.has(s));
        if (unanswerable.length) {
          throw new Error(
            `integration ${short}: 产物 require 了模块表答不上的词 ${unanswerable.join(", ")} —— ` +
              `装到真机上会在 web boot 报 "require(...) missed the module table"。` +
              `本该把它们内联（它们不在 PLATFORM_MODULES / PRELOADED_CLIENT_EXTERNALS / ` +
              `本包 dsh.client.external 里）`,
          );
        }
      } else {
        log(`[integrations] ${short}: 读不到上游 platform.ts，跳过模块表闸`);
      }
      if (noise.length) console.log(`[integrations] ${short}: 产物抽取忽略 ${noise.length} 个非导入字面（假阳性）：${noise.join(", ")}`);
      if (dangling.length) {
        throw new Error(
          `integration ${short}: 产物含悬空外部引用 ${dangling.join(", ")} —— ` +
            `loader 模块表答不上这些 specifier（上游 bundle 里它们是内联的）。` +
            `请把对应库装进 devDependencies（devDep 会被内联）后重跑，或确认它确实应是外部。`,
        );
      }
      clientArtifact = { bytes: readFileSync(join(outDir, "client.js")).length, externals, cssClasses: bundle.cssClasses };
    }

    // 4c) 编译 server 半（可选）：上游 api 包发布的是单文件 ESM bundle，重打姿势见 server-config.mts。
    let serverArtifact: { file: string; bytes: number } | null = null;
    if (serverDecl) {
      const entry = String(serverDecl.entry || "src/index.ts");
      if (!existsSync(join(stage, entry))) throw new Error(`integration ${short}: server 入口不存在（${entry}）`);
      const outFile = String(serverDecl.out || "lib/index.js").replace(/^lib[\\/]/, "");
      const { buildServerBundle } = await import("../../packages/app/src/cordis/server-config.mts");
      const res = await buildServerBundle({ id: pkg, pkgDir: stage, outDir: join(stage, "lib"), entry, outFile });
      serverArtifact = { file: outFile, bytes: readFileSync(res.out).length };
      log(`[integrations] ${short}: ${pkg} server 半编译完成（${outFile} ${serverArtifact.bytes}B，非相对导入全部外部）`);
    }

    // 5) 以原版包为模板组装（lib/index.js、lib/types、package.json 等原样；被我们重打的那半替换）
    const out = join(integrationsDirOf(repoRoot), short);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(template, "lib"), join(out, "lib"), { recursive: true });
    if (clientArtifact) cpSync(join(stage, "lib", "client.js"), join(out, "lib", "client.js"));
    if (serverArtifact) {
      mkdirSync(dirname(join(out, "lib", serverArtifact.file)), { recursive: true });
      cpSync(join(stage, "lib", serverArtifact.file), join(out, "lib", serverArtifact.file));
    }

    // 5b) 生成物补丁：模板里那份 RPC 校验表不认识我们从源码加进请求的字段，不改它就等于没加
    //     （zod 在边界把未声明的键剥掉，服务端逻辑收到 undefined）。详见
    //     patchGeneratedRequestModel：它按锚点定位、找不到就抛。
    for (const g of Array.isArray(it.generatedPatches) ? it.generatedPatches : []) {
      const target = join(out, String(g.path || ""));
      if (!existsSync(target)) throw new Error(`integration ${short}: 生成物补丁目标不存在（${g.path}）`);
      const schemas = Array.isArray(g.requestSchemas) ? g.requestSchemas : [];
      if (schemas.length === 0) throw new Error(`integration ${short}: 生成物补丁没声明 requestSchemas（${g.path}）`);
      writeFileSync(target, patchGeneratedRequestModel(readFileSync(target, "utf8"), schemas, pkg));
      log(`[integrations] ${short}: ${g.path} 补上请求级模型字段（${schemas.join(", ")}）`);
    }
    const manifest = JSON.parse(readFileSync(join(template, "package.json"), "utf8"));
    // 版本戳：<上游版本>+dshana-<我们的干净版本>（合成在 scripts/shared/version.mts，与 derive 同一份）。
    // 上游段原样保留：一眼看出改的是哪个上游包。
    manifest.version = patchVersion(manifest.version);
    writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2));

    const parts: string[] = [];
    if (clientArtifact) parts.push(`client.js ${clientArtifact.bytes}B，externals ${clientArtifact.externals.length} 个`);
    if (serverArtifact) parts.push(`${serverArtifact.file} ${serverArtifact.bytes}B`);
    log(`[integrations] ${short}: ${pkg}@${manifest.version} 编译完成（${parts.join("；")}）`);
    built.push({
      short, pkg, version: manifest.version, out,
      externals: clientArtifact ? clientArtifact.externals : [],
      bytes: clientArtifact ? clientArtifact.bytes : 0,
      cssClasses: clientArtifact ? clientArtifact.cssClasses : [],
      server: serverArtifact ? serverArtifact.file : null,
    });
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
