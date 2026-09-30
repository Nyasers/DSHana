// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/integrations.test.mjs — 集成层漂移闸（scripts/integrations/index.mts）单测
// 重点：闸必须在「上游变了」时响，且报错要指名该 rebase 哪个文件、哈希改成什么。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dshVersionOf,
  sha256,
  tagForVersion,
  verifyIntegrations,
} from "../../scripts/integrations/verify.mts";
import {
  CACHE_INTEGRATIONS,
  REPO_ROOT,
  loadIntegrations,
  stageIntegrations,
} from "../../scripts/integrations/mirror.mts";
import { extractRequires, duplicateCssClasses, patchGeneratedRequestModel } from "../../scripts/integrations/build.mts";
import { cssScopeOf, scopedClassName } from "../../src-cordis/build/client-config.mts";
import { MIN_FREE_BYTES, buildCacheKey, memoryGuardError } from "../../scripts/vendor/build.mts";
import { deltaContentHash } from "../../scripts/integrations/delta.mts";
import { integrationBakeError, versionEquationError } from "../../scripts/release/pack/assert.mts";
import { patchVersionOf } from "../../scripts/shared/version.mts";

const upstreamFile = "packages/client/ui-layout/src/client/index.ts";

test("CLI: 未知子命令 exit 2（不再落进默认分支白跑一次 verify）", () => {
  const r = spawnSync(process.execPath, ["scripts/integrations/index.mts", "buid"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(`${r.stdout}${r.stderr}`, /未知子命令/);
});

test("tagForVersion: pin 的版本 → 上游 tag", () => {
  assert.equal(tagForVersion("0.1.5-rc.2"), "dsh-v0.1.5-rc.2");
  assert.equal(tagForVersion(" 0.1.2-rc.1 "), "dsh-v0.1.2-rc.1");
});

test("dshVersionOf: 取 pin 版本，缺失返回 null", () => {
  assert.equal(dshVersionOf({ dependencies: { "@deepseek-ai/dsh": "0.1.5-rc.2" } }), "0.1.5-rc.2");
  assert.equal(dshVersionOf({ dependencies: {} }), null);
  assert.equal(dshVersionOf(null), null);
});

test("sha256: 缓冲与字符串一致、可复现", () => {
  assert.equal(sha256("abc"), sha256(Buffer.from("abc", "utf8")));
  assert.equal(sha256("abc").length, 64);
});

test("闸通过：哈希与上游一致时计数正确", () => {
  const content = "export const inject = ['slots']\n";
  const integrations = [
    {
      dir: "ui-layout",
      package: "@deepseek-ai/dsh-client-ui-layout",
      upstreamDir: "packages/client/ui-layout",
      files: [{ path: "src/client/index.ts", upstreamSha256: sha256(content) }],
    },
  ];
  const r = verifyIntegrations(integrations, (rel) => (rel === upstreamFile ? Buffer.from(content) : null));
  assert.equal(r.packages, 1);
  assert.equal(r.files, 1);
  assert.deepEqual(r.empty, []);
});

test("闸会响：上游变了 → 抛错并指名 rebase 的文件与新哈希", () => {
  const recorded = sha256("旧的上游内容");
  const integrations = [
    {
      dir: "ui-layout",
      package: "@deepseek-ai/dsh-client-ui-layout",
      upstreamDir: "packages/client/ui-layout",
      files: [{ path: "src/client/index.ts", upstreamSha256: recorded }],
    },
  ];
  const now = "上游改过了";
  assert.throws(
    () => verifyIntegrations(integrations, () => Buffer.from(now)),
    (e) => {
      assert.match(e.message, /已过期/);
      assert.match(e.message, /src-integrations\/ui-layout\/files\/src\/client\/index\.ts/);
      assert.ok(e.message.includes(sha256(now)), "报错里要给出新哈希，便于直接更新清单");
      assert.equal(e.problems.length, 1);
      return true;
    },
  );
});

test("闸会响：上游文件不存在（路径被移动）", () => {
  const integrations = [
    {
      dir: "ui-sidebar",
      package: "@deepseek-ai/dsh-client-ui-sidebar",
      upstreamDir: "packages/client/ui-sidebar",
      files: [{ path: "src/client/index.ts", upstreamSha256: sha256("x") }],
    },
  ];
  assert.throws(() => verifyIntegrations(integrations, () => null), /上游不存在/);
});

test("闸会响：清单自身不合法（缺 upstreamSha256 / 缺 path / 缺 upstreamDir）", () => {
  const bad = [
    { dir: "a", package: "p", upstreamDir: "d", files: [{ path: "f.ts" }] },
    { dir: "b", package: "p", upstreamDir: "d", files: [{ upstreamSha256: sha256("x") }] },
    { dir: "c", package: "p", files: [] },
  ];
  assert.throws(() => verifyIntegrations(bad, () => Buffer.from("x")), (e) => {
    assert.match(e.message, /未记录合法的 upstreamSha256/);
    assert.match(e.message, /缺少 path/);
    assert.match(e.message, /缺少 upstreamDir/);
    return true;
  });
});

test("尚无 overlay 的集成被记为 empty（允许，但会被提示）", () => {
  const integrations = [
    { dir: "ui-layout", package: "p", upstreamDir: "d", files: [] },
    { dir: "ui-sidebar", package: "p", upstreamDir: "d", files: [] },
  ];
  const r = verifyIntegrations(integrations, () => null);
  assert.equal(r.files, 0);
  assert.deepEqual(r.empty, ["ui-layout", "ui-sidebar"]);
});

test("仓库真实清单：能解析、字段齐（当前为批次①两枚、尚无 overlay）", () => {
  const list = loadIntegrations(REPO_ROOT);
  assert.ok(list.length >= 2, "至少登记 ui-layout / ui-sidebar");
  for (const it of list) {
    assert.ok(it.package && it.upstreamDir && Array.isArray(it.files), `${it.dir} 字段应齐`);
    // 版本戳段不写在清单里：它只从主 package.json 派生（手写字段会被 loadIntegrations 拒）。
    assert.equal(it.hana, undefined);
    assert.equal(it.revision, undefined);
    assert.ok(Array.isArray(it.files));
  }
  const names = list.map((x) => x.dir);
  assert.ok(names.includes("ui-layout") && names.includes("ui-sidebar"));
});

test("patchVersion：补丁包版本戳只从主 package.json 派生（无手写修订号）", async () => {
  const { patchVersion, readPkg } = await import("../../scripts/shared/version.mts");
  const clean = String(readPkg("package.json").version).split("+")[0];
  assert.equal(patchVersion("0.1.5-rc.2"), `0.1.5-rc.2+dshana-${clean}`);
  assert.equal(patchVersion("0.1.5-rc.2+whatever"), `0.1.5-rc.2+dshana-${clean}`);
});

test("extractRequires：认未压缩产物的字面 require()", () => {
  const bundle = 'window.__ModuleLoader__.load({ id: "pkg", factory: (require) => { const a = require("react"); const b = require("react/jsx-runtime"); const c = require("react"); return module.exports; } });';
  assert.deepEqual(extractRequires(bundle), ["react", "react/jsx-runtime"]);
});

test("extractRequires：也认我们压缩过的产物（factory 参数被改名、引号含反引号）", () => {
  const bundle = "window.__ModuleLoader__.load({id:`@deepseek-ai/dsh-client-ui-layout`,factory:e=>{var t={exports:{}};let r=e(\"react\"),i=e(`react/jsx-runtime`),a=e('@deepseek-ai/dsh-client-store');return t.exports}});";
  assert.deepEqual(extractRequires(bundle), ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-store"]);
});

test("extractRequires：无 factory banner 时不炸、空输入得空表", () => {
  assert.deepEqual(extractRequires('const x = require("zustand")'), ["zustand"]);
  assert.deepEqual(extractRequires(""), []);
  assert.deepEqual(extractRequires(null), []);
});

test("stage：把 overlay 落进 .cache/integrations/<短名>/ 并保内容", () => {
  const root = mkdtempSync(join(tmpdir(), "hana-int-"));
  try {
    const itRoot = join(root, "integrations", "demo");
    mkdirSync(join(itRoot, "files", "src"), { recursive: true });
    writeFileSync(join(itRoot, "files", "src", "x.ts"), "delta\n");
    const integrations = [{ dir: "demo", package: "p", upstreamDir: "d", root: itRoot, files: [{ path: "src/x.ts", upstreamSha256: sha256("d") }] }];
    const staged = stageIntegrations(integrations, root);
    // 落点用实现导出的常量而不是字面量：它住在 .cache（B 节：stage 树由 delta 内容决定、可复用），
    // 哪天再挪一次，这条断言跟着走而不是又红一次。
    assert.deepEqual(staged, [join(CACHE_INTEGRATIONS, "demo", "src", "x.ts")]);
    const dst = join(root, CACHE_INTEGRATIONS, "demo", "src", "x.ts");
    assert.ok(existsSync(dst));
    assert.equal(readFileSync(dst, "utf8"), "delta\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage：overlay 文件缺失时明确报错", () => {
  const root = mkdtempSync(join(tmpdir(), "hana-int-"));
  try {
    const itRoot = join(root, "integrations", "demo");
    mkdirSync(itRoot, { recursive: true });
    const integrations = [{ dir: "demo", package: "p", upstreamDir: "d", root: itRoot, files: [{ path: "src/missing.ts", upstreamSha256: sha256("d") }] }];
    assert.throws(() => stageIntegrations(integrations, root), /overlay 文件缺失/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cssScopeOf：包身份进命名空间，且现有集成两两不同", () => {
  assert.equal(cssScopeOf("@deepseek-ai/dsh-client-ui-chat"), "chat");
  assert.equal(cssScopeOf("@deepseek-ai/dsh-client-ui-settings-general"), "settings_general");
  assert.equal(cssScopeOf("@deepseek-ai/dsh-client-hmr"), "hmr");
  assert.equal(cssScopeOf("@dshana/view"), "view");
  assert.equal(cssScopeOf("@dshana/"), "pkg");
  // 命名空间本身撞车就等于类名前缀失效（同名前缀下 local 重名会重新变成同一个 class）
  const scopes = loadIntegrations().map((it) => cssScopeOf(it.package));
  assert.equal(new Set(scopes).size, scopes.length, `命名空间重复：${scopes.join(", ")}`);
});

test("scopedClassName：同包内两个模块的同一个 local 名不撞，且与构建机路径无关", () => {
  const id = "@deepseek-ai/dsh-client-ui-chat";
  // 这两个前缀是**故意不同**的：本测试要证的正是"名字不吃构建机路径"。用 stage 树的现行形状
  //（.cache/integrations-src/<短名>/）只是让读的人不以为集成还落在 .tmp。
  const a = scopedClassName(id, "/m1/repo/.cache/integrations-src/ui-chat/src/client/chat/ChatView.module.css", "root");
  const b = scopedClassName(id, "/m1/repo/.cache/integrations-src/ui-chat/src/client/chat/StatsPills.module.css", "root");
  assert.notEqual(a, b);
  // 同一个模块在另一台机器（前缀不同）上仍得到同一个名字
  const aElsewhere = scopedClassName(id, "D:/build/.cache/integrations-src/ui-chat/src/client/chat/ChatView.module.css", "root");
  assert.equal(a, aElsewhere);
  assert.match(a, /^dv_chat_[0-9a-f]{6}_root$/);
  // 跨包同一模块相对路径也不撞
  assert.notEqual(a, scopedClassName("@deepseek-ai/dsh-client-ui-layout", "/m1/repo/.cache/integrations-src/ui-layout/src/client/chat/ChatView.module.css", "root"));
});

test("scopedClassName：无 /src/ 时按 pkgDir 取相对路径，不同子树的同名模块不共享身份", () => {
  const id = "@dshana/view";
  const pkgDir = "E:/repo/src-cordis/packages/view";
  const a = scopedClassName(id, "E:/repo/src-cordis/packages/view/views/a/shared.module.css", "root", pkgDir);
  const b = scopedClassName(id, "E:/repo/src-cordis/packages/view/widgets/a/shared.module.css", "root", pkgDir);
  assert.notEqual(a, b);
  // 同一 pkgDir 相对路径在不同机器上（盘符与 pkgDir 前缀都变）仍是同一个名字
  assert.equal(
    a,
    scopedClassName(id, "D:/elsewhere/src-cordis/packages/view/views/a/shared.module.css", "root", "D:/elsewhere/src-cordis/packages/view"),
  );
});

test("duplicateCssClasses：跨包重名报错、唯一时静默", () => {
  const one = (short, file, ...names) => ({ short, cssClasses: names.map((className) => ({ className, file })) });
  assert.deepEqual(
    duplicateCssClasses([
      one("ui-chat", "ChatView.module.css", "dv_chat_frame"),
      one("ui-layout", "AppFrame.module.css", "dv_layout_frame"),
    ]),
    [],
  );
  const clash = duplicateCssClasses([
    one("ui-chat", "ChatView.module.css", "dv_frame"),
    one("ui-layout", "AppFrame.module.css", "dv_frame"),
  ]);
  assert.equal(clash.length, 1);
  assert.match(clash[0], /dv_frame/);
  assert.match(clash[0], /ui-chat/);
  assert.match(clash[0], /ui-layout/);
});

test("duplicateCssClasses：同包内两个模块重名同样报错", () => {
  const clash = duplicateCssClasses([
    {
      short: "ui-chat",
      cssClasses: [
        { className: "dv_chat_root", file: "ChatView.module.css" },
        { className: "dv_chat_root", file: "TurnNavigator.module.css" },
      ],
    },
  ]);
  assert.equal(clash.length, 1);
  assert.match(clash[0], /ChatView\.module\.css/);
  assert.match(clash[0], /TurnNavigator\.module\.css/);
});

// ---- 生成物补丁：RPC 校验表（lib/typert.host.js）里的请求级字段 ----

/** 生成物的缩小版：两个 schema，形状与 dsh-typert-generator 的产出一致。 */
const TYPERT_FIXTURE = [
  "/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */",
  "let _pkg_session_create_parameter_0$schema$value",
  "const _pkg_session_create_parameter_0$schema = () => (_pkg_session_create_parameter_0$schema$value ??= z.object({",
  "  'workspaceId': z.string().readonly().optional(),",
  "  'cwd': z.string().readonly().optional(),",
  "}))",
  "let _pkg_session_prompt_parameter_0$schema$value",
  "const _pkg_session_prompt_parameter_0$schema = () => (_pkg_session_prompt_parameter_0$schema$value ??= z.object({",
  "  'sessionId': z.string().readonly(),",
  "  'mode': z.union([z.literal('queue'), z.literal('steer')]).readonly(),",
  "}))",
].join("\n") + "\n";

/** 取某个 schema 的对象体（从 z.object({ 到它的 }))）。 */
function schemaBodyOf(text, name) {
  const start = text.indexOf(`const _pkg_${name}$schema = `);
  const open = text.indexOf("z.object({", start);
  return text.slice(open, text.indexOf("\n}))", open));
}

test("patchGeneratedRequestModel：两份 schema 各被补上 model，别的字逐字不动", () => {
  const patched = patchGeneratedRequestModel(TYPERT_FIXTURE, [
    "session_create_parameter_0",
    "session_prompt_parameter_0",
  ]);
  // 各补一次，且补在各自的 schema 里（不是全堆到第一份上）
  assert.equal(patched.split("'model': z.object({").length - 1, 2);
  for (const name of ["session_create_parameter_0", "session_prompt_parameter_0"]) {
    const body = schemaBodyOf(patched, name);
    assert.match(body, /'model': z\.object\(\{/);
    assert.match(body, /'reasoningEffort': z\.string\(\)\.readonly\(\)\.optional\(\),/);
  }
  // 原有字段与另一份 schema 的顺序不受影响
  assert.match(schemaBodyOf(patched, "session_create_parameter_0"), /'cwd': z\.string\(\)\.readonly\(\)\.optional\(\),/);
  assert.ok(patched.includes("  'sessionId': z.string().readonly(),"));
  // 补完的行数 = 原行数 + 每个 schema 五行
  assert.equal(patched.split("\n").length, TYPERT_FIXTURE.split("\n").length + 10);
});

test("patchGeneratedRequestModel：锚点找不到就抛（上游换了生成物形状）", () => {
  assert.throws(
    () => patchGeneratedRequestModel("const foo = 1;\n", ["session_prompt_parameter_0"]),
    /找不到 session_prompt_parameter_0 的 schema 锚点/,
  );
});

test("patchGeneratedRequestModel：生成器已推出我们那份规范形状时，什么都不做（T5 的最好情形）", () => {
  // delta 前移到构建期后，生成器会从烤进检出的 src/types.ts 自己推出 model 字段；
  // 那时补丁不该再插一遍（会变成重复字段），也不该报错——那是"生成物不再打补丁"的正常态。
  // 这里用规范形状本身构造"已含"的生成物：把它插进 prompt schema，补丁应当原样返回。
  const canonical = [
    "  'model': z.object({",
    "  'provider': z.string().readonly(),",
    "  'model': z.string().readonly(),",
    "  'reasoningEffort': z.string().readonly().optional(),",
    "}).readonly().optional(),",
  ].join("\n") + "\n";
  const fixture = TYPERT_FIXTURE.replace(
    "  'sessionId': z.string().readonly(),",
    "  'sessionId': z.string().readonly(),\n" + canonical,
  );
  const out = patchGeneratedRequestModel(fixture, ["session_prompt_parameter_0"]);
  assert.equal(out, fixture, "生成器已给出规范形状时应当逐字不动（不重复插入）");
  // 该 schema 里 model 只出现一次（= 生成器给的那份，没被补丁再插一遍）。
  assert.equal(schemaBodyOf(out, "session_prompt_parameter_0").split("'model': z.object({").length - 1, 1);
});

test("patchGeneratedRequestModel：schema 里已有 model 但形状不对就抛（上游把字段做进协议了，补丁该撤）", () => {
  const already = TYPERT_FIXTURE.replace(
    "  'sessionId': z.string().readonly(),",
    "  'sessionId': z.string().readonly(),\n  'model': z.string().readonly().optional(),",
  );
  assert.throws(
    () => patchGeneratedRequestModel(already, ["session_prompt_parameter_0"]),
    /形状与我们的 delta 不一致/,
  );
});

// ---- T5：内存护栏与缓存键（delta 进键、跨 dshana 版本可复用） ----

test("memoryGuardError：够用时放行、不够时点名步骤并如实报数（纯函数，不必真压内存）", () => {
  const GiB = 1024 * 1024 * 1024;
  // 够用：安静放行（上限与下限各取一次，边界算够用）。
  assert.equal(memoryGuardError(16 * GiB, "host: tsdown"), null);
  assert.equal(memoryGuardError(MIN_FREE_BYTES, "host: tsdown"), null);
  // 不够：报出步骤名、实际值、阈值，并说清"不自动重试"。
  const msg = memoryGuardError(1.37 * GiB, "client: tsc -b tsconfig.client.json");
  assert.ok(msg, "低于阈值必须给出说明");
  assert.match(msg, /client: tsc -b tsconfig\.client\.json/);
  assert.match(msg, /1\.37 GiB/);
  assert.match(msg, new RegExp(String(MIN_FREE_BYTES / GiB) + " GiB"));
  assert.match(msg, /不自动重试/);
});

test("buildCacheKey：delta 内容进键（改了 delta 就换键）", () => {
  const base = {
    tag: "dsh-v0.2.0-rc.2",
    recipeVersion: "2",
    nodeVersion: "26.8.1",
    pnpmVersion: "11.7.0",
    lockSha256: "deadbeef",
  };
  const a = buildCacheKey({ ...base, deltaHash: "a".repeat(64) });
  const b = buildCacheKey({ ...base, deltaHash: "b".repeat(64) });
  assert.notEqual(a, b, "delta 内容不同必须落不同键（否则会命中一份没有这次改动的包集）");
  assert.equal(buildCacheKey({ ...base, deltaHash: "a".repeat(64) }), a, "同输入必须同键");
});

test("deltaContentHash：只随 delta 内容变，不随 dshana 版本变（缓存跨版本复用）", () => {
  const h = deltaContentHash();
  assert.match(h, /^[0-9a-f]{64}$/);
  // 同一次调用两次必须一致（读的是仓库里的声明与 overlay 字节）。
  assert.equal(deltaContentHash(), h);
  // 键材料里不含任何版本号：把主版本换掉，deltaHash 与用它算出的键都必须原地不动。
  const pkgPath = join(REPO_ROOT, "package.json");
  const original = readFileSync(pkgPath, "utf8");
  try {
    for (const v of ["1.0.0-rc.30+dsh-0.2.0-rc.2", "9.9.9+dsh-0.2.0-rc.2"]) {
      writeFileSync(pkgPath, JSON.stringify({ ...JSON.parse(original), version: v }, null, 2) + "\n");
      assert.equal(deltaContentHash(), h, "deltaHash 不得随 dshana 版本变");
    }
  } finally {
    writeFileSync(pkgPath, original);
  }
});

// ---- T5 pack 侧：交付树版本式子 + 集成烘焙对账（都是纯函数，两个分支各覆盖一次） ----

const APP = "1.0.0-rc.29+dsh-0.2.0-rc.2";
const APP_CLEAN = "1.0.0-rc.29";

test("patchVersionOf：戳 = <清单版本>+dshana-<干净版本>（剥掉 +dsh- 段）", () => {
  assert.equal(patchVersionOf("0.2.0-rc.2", APP), "0.2.0-rc.2+dshana-" + APP_CLEAN);
  // 上游版本本身若带 build 段，也要剥掉（版本串里不能出现两个 +）。
  assert.equal(patchVersionOf("0.2.0-rc.2+build", APP), "0.2.0-rc.2+dshana-" + APP_CLEAN);
});

test("versionEquationError：式子成立时静默（集成目标带戳、其余逐字等于清单）", () => {
  const manifest = new Map([
    ["@deepseek-ai/dsh-client-ui-layout", "0.2.0-rc.2"],
    ["@deepseek-ai/dsh-session", "0.2.0-rc.2"],
  ]);
  const targets = new Set(["@deepseek-ai/dsh-client-ui-layout"]);
  const installed = [
    { name: "@deepseek-ai/dsh-client-ui-layout", version: "0.2.0-rc.2+dshana-" + APP_CLEAN },
    { name: "@deepseek-ai/dsh-session", version: "0.2.0-rc.2" },
  ];
  assert.deepEqual(versionEquationError(installed, manifest, targets, APP), []);
});

test("versionEquationError：集成目标没带戳 → 报（漏盖/盖错）", () => {
  const manifest = new Map([["@deepseek-ai/dsh-client-ui-layout", "0.2.0-rc.2"]]);
  const targets = new Set(["@deepseek-ai/dsh-client-ui-layout"]);
  // 仍是清单版本 = 戳没盖上（正是旧 applyIntegrations 退场后最容易出的错）。
  const problems = versionEquationError(
    [{ name: "@deepseek-ai/dsh-client-ui-layout", version: "0.2.0-rc.2" }],
    manifest, targets, APP,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@deepseek-ai\/dsh-client-ui-layout@0\.2\.0-rc\.2/);
  assert.match(problems[0], /集成目标/);
});

test("versionEquationError：非目标包版本被带偏 → 也报（式子两侧都要判）", () => {
  const manifest = new Map([["@deepseek-ai/dsh-session", "0.2.0-rc.2"]]);
  const problems = versionEquationError(
    [{ name: "@deepseek-ai/dsh-session", version: "0.2.0-rc.1" }],
    manifest, new Set(), APP,
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /非目标/);
});

test("versionEquationError：清单外的包不属本式子作用域（registry 三方包不误报）", () => {
  const manifest = new Map([["@deepseek-ai/dsh-session", "0.2.0-rc.2"]]);
  const installed = [
    { name: "@deepseek-ai/dsh-session", version: "0.2.0-rc.2" },
    { name: "@deepseek-ai/cordis", version: "4.0.4" }, // 清单外，随便什么版本都不该报
  ];
  assert.deepEqual(versionEquationError(installed, manifest, new Set(), APP), []);
});

test("integrationBakeError：档案与当前声明一致时静默", () => {
  const declared = [
    { dir: "ui-layout", packageName: "@deepseek-ai/dsh-client-ui-layout", files: 2 },
    { dir: "ui-theme", packageName: "@deepseek-ai/dsh-client-ui-theme", files: 1 },
  ];
  const baked = {
    deltaHash: "a".repeat(64),
    stagedFiles: 3,
    packages: [
      { dir: "ui-layout", package: "@deepseek-ai/dsh-client-ui-layout", files: 2 },
      { dir: "ui-theme", package: "@deepseek-ai/dsh-client-ui-theme", files: 1 },
    ],
  };
  assert.deepEqual(integrationBakeError(declared, baked, "a".repeat(64)), []);
});

test("integrationBakeError：改了 overlay 而包集没重编（deltaHash 不符）→ 报", () => {
  const declared = [{ dir: "ui-layout", packageName: "@deepseek-ai/dsh-client-ui-layout", files: 2 }];
  const baked = { deltaHash: "a".repeat(64), stagedFiles: 2, packages: [{ dir: "ui-layout", package: "@deepseek-ai/dsh-client-ui-layout", files: 2 }] };
  const problems = integrationBakeError(declared, baked, "b".repeat(64));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /与当前工作树不一致/);
  assert.match(problems[0], /没重编包集/);
});

test("integrationBakeError：新增声明但档案里没有 → 报；档案多出已删声明 → 也报", () => {
  const declared = [
    { dir: "ui-layout", packageName: "@deepseek-ai/dsh-client-ui-layout", files: 2 },
    { dir: "ui-new", packageName: "@deepseek-ai/dsh-client-ui-new", files: 1 },
  ];
  const baked = { deltaHash: "a".repeat(64), stagedFiles: 2, packages: [{ dir: "ui-layout", package: "@deepseek-ai/dsh-client-ui-layout", files: 2 }] };
  const problems = integrationBakeError(declared, baked, "a".repeat(64));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ui-new/);
  assert.match(problems[0], /没含这次声明/);

  const declared2 = [{ dir: "ui-layout", packageName: "@deepseek-ai/dsh-client-ui-layout", files: 2 }];
  const baked2 = { deltaHash: "a".repeat(64), stagedFiles: 2, packages: [
    { dir: "ui-layout", package: "@deepseek-ai/dsh-client-ui-layout", files: 2 },
    { dir: "ui-gone", package: "@deepseek-ai/dsh-client-ui-gone", files: 1 },
  ] };
  const problems2 = integrationBakeError(declared2, baked2, "a".repeat(64));
  assert.equal(problems2.length, 1);
  assert.match(problems2[0], /ui-gone/);
  assert.match(problems2[0], /已不在 src-integrations/);
});

test("integrationBakeError：旧配方没有 integrations 记录 → 报（不能默认成已烤过）", () => {
  const problems = integrationBakeError([{ dir: "x", packageName: "p", files: 1 }], undefined, "a".repeat(64));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /没有 integrations 记录/);
});

test("integrationBakeError：overlay 数为 0 的声明不算缺口（与 stageDelta 同口径）", () => {
  const declared = [{ dir: "empty", packageName: "@deepseek-ai/dsh-empty", files: 0 }];
  const baked = { deltaHash: "a".repeat(64), stagedFiles: 0, packages: [] };
  assert.deepEqual(integrationBakeError(declared, baked, "a".repeat(64)), []);
});
