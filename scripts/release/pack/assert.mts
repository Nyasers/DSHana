// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/release/pack/assert.mts — 出包前的四处断言（产物不完整就拒包）。
//
// 都在 fail-closed 一侧：宁可不出包，也不出一个装了起不来的包。
import fs from "fs-extra";
import { join } from "node:path";

import { cordisPkgDirs, cordisPkgName } from "../../shared/version.mts";
import { DECLARATION_TEXTS } from "../../shared/paths.mts";

/**
 * 交付树不得出现 package.json（fail-closed）。
 * App 入口是 bin/app.mjs，Node 按扩展名就判 ESM，安装树不需要「最近一份 package.json 的 type」，
 * 也就没有留在包根的理由；出现它只可能是构建面字段（scripts / devDependencies / packageManager /
 * imports / 内核声明）被混进安装包。
 * @param outDir - 交付目录（dist 或组装树）
 */
export function assertNoProductPackage(outDir) {
  const p = join(outDir, "package.json");
  if (fs.pathExistsSync(p)) {
    throw new Error(
      "交付树出现了 package.json（" + p + "）：入口是 bin/app.mjs，安装树不带包清单；出现即构建面字段混进包，拒绝出包",
    );
  }
}

/**
 * cordis 子插件的产物断言（防回归，与 manifest 校验对称）：子插件清单派生自包现场
 * version 与主 package.json 同批由 derive/version（pnpm version 发版流程）同步，pack 时读产物校验
 * 一致——手改/漏同步即出包版本漂移。
 * @param cordisDir 子插件产物目录（.cache/cordis）
 * @param version 本次出包的版本
 */
export function assertCordisArtifacts(cordisDir, version) {
  // cordis 未组装 = 构建未跑/被清：fail-closed（校验放行空产物会让缺插件的包过包）
  if (!fs.pathExistsSync(cordisDir)) {
    throw new Error(`cordis 产物缺失（${cordisDir} 不存在）：先跑 pnpm run build 再打包`);
  }
  // 完整性：子插件全部存在且 package.json 版本一致——缺失/部分产物（含 count=0）
  // 一律拒包，防 build 失败后残留部分产物被误打包。
  // 名单派生自包现场（packages/dsh/*/cordis.config.mjs），不在这里再写一份：加一个子插件就自动
  // 纳入，下线一个也不会留一条永远失败的断言。
  const required = cordisPkgDirs().map((rel) => cordisPkgName(rel));
  let count = 0;
  for (const name of required) {
    const pj = join(cordisDir, name, "package.json");
    if (!fs.pathExistsSync(pj)) {
      throw new Error(
        `cordis 产物不完整：缺少 ${name}/package.json（${cordisDir} 下）——先跑 pnpm run build 再打包`,
      );
    }
    const j = fs.readJsonSync(pj);
    if (j.version !== version) {
      throw new Error(
        `版本不一致：cordis 包 ${join(name, "package.json")} version ${j.version} ≠ package.json ${version}（跑 node scripts/derive/index.mts 同步后再打包）`,
      );
    }
    count += 1;
  }
  console.log(`[pack] cordis 子插件版本一致（${count} 个 = ${version}）`);
  return count;
}

/**
 * 组合层包（@dshana/dsh-app）的产物断言：两个入口与六份组合文档都得在，版本与主 package.json 同批
 * 由 derive/version 同步（pnpm version 发版流程）。它是 profile 层列里被选中的那一层——缺一件
 * 就 boot 不起来或少一半行，所以 fail-closed。
 * @param bundleDir 组合层包产物目录（.cache/bundle/dsh-app）
 * @param version 本次出包的版本
 */
export function assertBundleArtifacts(bundleDir, version) {
  const required = [
    "package.json",
    "cordis.patch.yml",
    "presets/standard.patch.yml",
    "presets/ptc.patch.yml",
    "presets/minimal.patch.yml",
    "presets/cordis.patch.yml",
    "presets/dshana.patch.yml",
    "presets/dshana-ptc.patch.yml",
    "lib/index.js",
    "lib/startup.js",
  ];
  if (!fs.pathExistsSync(bundleDir)) {
    throw new Error(`组合层包产物缺失（${bundleDir} 不存在）：先跑 pnpm run build 再打包`);
  }
  for (const rel of required) {
    if (!fs.pathExistsSync(join(bundleDir, rel))) {
      throw new Error(`组合层包产物不完整：缺少 ${rel}（${bundleDir} 下）——先跑 pnpm run build 再打包`);
    }
  }
  const j = fs.readJsonSync(join(bundleDir, "package.json"));
  if (j.version !== version) {
    throw new Error(
      `版本不一致：组合层包 package.json version ${j.version} ≠ package.json ${version}（跑 node scripts/derive/index.mts 同步后再打包）`,
    );
  }
  if (j.name !== "@dshana/dsh-app") {
    throw new Error(`组合层包名字不对：${j.name}（层列钉住的是 @dshana/dsh-app）`);
  }
  console.log(`[pack] 组合层包在位（@dshana/dsh-app = ${version}，2 入口 + 7 份组合文档）`);
}

/**
 * 随包声明文本（NOTICE / THIRD_PARTY_NOTICES.md）断言：缺件拒包。
 *
 * 交付目录由 build:app 一次组装完整（与 skills/ 同批直出），pack 不再向它写任何东西；这里只
 * 核实真的落位。靠 pack 事后补会把 pack 变成 dist 的写者，源改了而产物没跟时两边不同步。
 */
export function assertDeclarationTexts(outDir) {
  for (const item of DECLARATION_TEXTS) {
    if (!fs.pathExistsSync(join(outDir, item))) {
      throw new Error(
        "交付目录缺声明文本：" + item + "（dist 应由 build:app 一次组装完整；拒绝出少合规件的包）",
      );
    }
  }
  console.log("[pack] 声明文本在位（" + DECLARATION_TEXTS.join(" / ") + "）");
}

/**
 * 技能参照断言：SKILL.md 指到的每一份 references/ 文件都必须在包里。
 *
 * 它缺失时同样不响：SKILL.md 里那句指针会指向一片空白，模型读不到内容，而报错面不会出现
 * （技能照旧加载，只是少了那个文件）。参照分两类——`parameters.md` 由 derive 的 skill-params
 * 任务生成，其余为手写——两类都随 skills/ 整树进包。
 *
 * 名单从 SKILL.md 正文里的 `references/<名>.md` 提，不另立一份：指到了一定要存在，这一条
 * 对两边都成立；各写一份名录就会出现「写了指针但没建文件」。
 */
export function assertSkillReferences(outDir) {
  const skillDir = join(outDir, "skills", "dshana");
  const skillFile = join(skillDir, "SKILL.md");
  if (!fs.pathExistsSync(skillFile)) throw new Error("交付目录缺技能主体：skills/dshana/SKILL.md");
  const text = fs.readFileSync(skillFile, "utf8");
  const named = [...new Set([...text.matchAll(/references\/([\w.-]+\.md)/g)].map((m) => m[1]))];
  if (named.length === 0) {
    throw new Error("SKILL.md 未指向任何 references/ 文件：技能主体丢掉了按需阅读的参照面");
  }
  for (const name of named) {
    const rel = join("skills", "dshana", "references", name);
    if (!fs.pathExistsSync(join(outDir, rel))) {
      throw new Error(
        "交付目录缺技能参照：" + rel + "（SKILL.md 指到了它但包里没有；parameters.md 由 derive 的 skill-params 任务生成）",
      );
    }
  }
  // 反向：references/ 里除了 parameters.md 之外的文件都该被 SKILL.md 指到，否则模型找不到它。
  const onDisk = fs.pathExistsSync(join(skillDir, "references"))
    ? fs.readdirSync(join(skillDir, "references")).filter((f) => f.endsWith(".md"))
    : [];
  const unlisted = onDisk.filter((f) => !named.includes(f));
  if (unlisted.length > 0) {
    throw new Error("references/ 下有 SKILL.md 没指到的文件（模型找不到它）：" + unlisted.join(", "));
  }
  console.log("[pack] 技能参照在位（SKILL.md 指向 " + named.length + " 份：" + named.join(" / ") + "）");
}

/**
 * 启动页花瓣断言：改写过的前端产物里必须真的有花瓣标记与样式。
 * 缺了就说明 applyBootBloom 没跑或锚点静默失效（上游换了产物），那种包装到真机上启动页会退回
 * 转圈环、且现场很难归因，所以在打包这一步拒包。
 * @param {string} nodeModulesDir 交付树的 node_modules
 */
export function assertBootBloom(nodeModulesDir) {
  const pkgDir = join(nodeModulesDir, "@deepseek-ai/dsh-web-frontend");
  if (!fs.pathExistsSync(pkgDir)) return;
  const assets = join(pkgDir, "dist", "assets");
  const jsName = fs.readdirSync(assets).find((n) => n.startsWith("index-") && n.endsWith(".js"));
  const cssName = fs.readdirSync(assets).find((n) => n.startsWith("index-") && n.endsWith(".css"));
  if (!jsName || !cssName) {
    throw new Error("启动页花瓣：前端 dist 里找不到 index-*.js / index-*.css");
  }
  const js = fs.readFileSync(join(assets, jsName), "utf8");
  const css = fs.readFileSync(join(assets, cssName), "utf8");
  if (!js.includes("_bloomPetal_boot")) {
    throw new Error("启动页花瓣：JS 里没有花瓣标记（applyBootBloom 未生效；上游产物变了就该重做改写）");
  }
  if (!css.includes("_bloomLife_boot")) {
    throw new Error("启动页花瓣：CSS 里没有花瓣动画（applyBootBloom 未生效或替换锚点失效）");
  }
  if (js.includes("_spin_u7vgf_45") || css.includes("_spin_u7vgf_45")) {
    throw new Error("启动页花瓣：仍有转圈环残留（旧动画没被完全替换）");
  }
  // 选择器必须真的以点开头。曾经把 "._spinner_u7vgf_45{…}" 写成 "_spinner_u7vgf_45{…}"，
  // 字符串里仍有类名、上面几条都过得去，但选择器成了元素选择器，整条规则作废：
  // spinner 容器失去尺寸与定位，整个 WebUI 只剩底下一团。所以这里要看**规则形式**而非关键字。
  const straySelectors = css.match(/(?:^|[};])\s*(_spinner_u7vgf_45[^{]*\{)/g);
  if (straySelectors !== null) {
    throw new Error(
      `启动页花瓣：有选择器丢了前导点，整条规则作废：${straySelectors.slice(0, 3).join(" ")}`,
    );
  }
  // 花瓣容器自身的规则必须在（尺寸/定位），否则即使动画在，布局也会塌。
  if (!/(?:^|[};])\._spinner_u7vgf_45\{[^}]*width:20px/.test(css)) {
    throw new Error("启动页花瓣：._spinner_u7vgf_45 自身规则缺失或没带尺寸");
  }
  console.log("[pack] 启动页花瓣在位（四花标记 + 绽放动画，无转圈环残留，选择器合法）");
}

/** App ui/ 静态树断言（cards route 资源面；相对资源契约）：缺失 = 卡片 404，拒包。 */
export function assertUiTree(outDir) {
  const uiDir = join(outDir, "ui");
  if (!fs.pathExistsSync(uiDir)) {
    throw new Error("App ui/ 静态树缺失（dist/ui 不存在）：@dshana/ui 的产物未拷进交付目录——先跑 pnpm run build 再打包");
  }
  for (const rel of ["main.html", "sidebar.html", "app.js"]) {
    if (!fs.pathExistsSync(join(uiDir, rel))) {
      throw new Error("App ui/ 缺 cards route 资源：" + rel + "（packages/ui/src/" + rel + " 缺失或构建未跑）");
    }
  }
  console.log("[pack] ui/ 静态树完整（main/sidebar 壳页 + app.js bundle）");
}

/** 集成覆盖的声明（每个 integration.json 的 package 字段与 overlay 数）。 */
function integrationDecls(integrationsDir) {
  if (!fs.pathExistsSync(integrationsDir)) {
    throw new Error(`集成目录不存在：${integrationsDir}（预期 integrations/；拒绝产出未打补丁的包）`);
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
