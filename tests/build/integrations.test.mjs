// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/integrations.test.mjs — 集成层漂移闸（scripts/integrations/index.mts）单测
// 重点：闸必须在「上游变了」时响，且报错要指名该 rebase 哪个文件、哈希改成什么。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import postcss from "postcss";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dshVersionOf,
  sha256,
  tagForVersion,
  verifyIntegrations,
} from "../../scripts/integrations/verify.mts";
import {
  REPO_ROOT,
  loadIntegrations,
  stageIntegrations,
} from "../../scripts/integrations/mirror.mts";
import { extractRequires, duplicateCssClasses, patchGeneratedRequestModel } from "../../scripts/integrations/build.mts";
import { cssScopeOf, scopedClassName, scopeSelector } from "../../packages/app/src/cordis/client-config.mts";

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
      assert.match(e.message, /integrations\/ui-layout\/files\/src\/client\/index\.ts/);
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

test("stage：把 overlay 落进 .tmp/integrations/<短名>/ 并保内容", () => {
  const root = mkdtempSync(join(tmpdir(), "hana-int-"));
  try {
    const itRoot = join(root, "integrations", "demo");
    mkdirSync(join(itRoot, "files", "src"), { recursive: true });
    writeFileSync(join(itRoot, "files", "src", "x.ts"), "delta\n");
    const integrations = [{ dir: "demo", package: "p", upstreamDir: "d", root: itRoot, files: [{ path: "src/x.ts", upstreamSha256: sha256("d") }] }];
    const staged = stageIntegrations(integrations, root);
    assert.deepEqual(staged, [join(".tmp", "integrations", "demo", "src", "x.ts")]);
    const dst = join(root, ".tmp", "integrations", "demo", "src", "x.ts");
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
  const pkgDir = "E:/repo/packages/view";
  const a = scopedClassName(id, "E:/repo/packages/view/views/a/shared.module.css", "root", pkgDir);
  const b = scopedClassName(id, "E:/repo/packages/view/widgets/a/shared.module.css", "root", pkgDir);
  assert.notEqual(a, b);
  // 同一 pkgDir 相对路径在不同机器上（盘符与 pkgDir 前缀都变）仍是同一个名字
  assert.equal(
    a,
    scopedClassName(id, "D:/elsewhere/packages/view/views/a/shared.module.css", "root", "D:/elsewhere/packages/view"),
  );
});

// ---- CSS Modules 穿透语法：:global(...) / :local(...) ----

const scopeAs = (local) => `dv_x_${local}`;

test("scopeSelector：:global(...) 剥掉括号，括号外的 local 照常作用域化", () => {
  // 真实选择器形状取自被重建的 ui-chat（宿主滚动容器的滚动归属就写在这里）
  assert.equal(
    scopeSelector(":global([data-conversation-scroll]) .toBottomSlot", scopeAs),
    "[data-conversation-scroll] .dv_x_toBottomSlot",
  );
  assert.equal(
    scopeSelector(":global([data-conversation-scroll]):has(.root[data-chat-following-tail])", scopeAs),
    "[data-conversation-scroll]:has(.dv_x_root[data-chat-following-tail])",
  );
  assert.equal(
    scopeSelector(":global(html[data-platform='darwin'][data-fullscreen]) .frame[data-sidebar-collapsed]", scopeAs),
    "html[data-platform='darwin'][data-fullscreen] .dv_x_frame[data-sidebar-collapsed]",
  );
  assert.equal(
    scopeSelector(":global([data-windows-titlebar]) .frame::before", scopeAs),
    "[data-windows-titlebar] .dv_x_frame::before",
  );
});

test("scopeSelector：:global(...) 里的类名是宿主的，不换名", () => {
  assert.equal(
    scopeSelector(".body :global(.md-table-wide) > table", scopeAs),
    ".dv_x_body .md-table-wide > table",
  );
  assert.equal(
    scopeSelector(":global([data-platform='darwin']) :global([data-ds-dark-theme]) .sidebarCol", scopeAs),
    "[data-platform='darwin'] [data-ds-dark-theme] .dv_x_sidebarCol",
  );
});

test("scopeSelector：:local(...) 剥括号且内容照常作用域化，裸伪类当场抛", () => {
  assert.equal(scopeSelector(":local(.root)", scopeAs), ".dv_x_root");
  // 裸伪类（无括号）的作用范围要按 CSS Modules 语义单独对账：不静默当成没看见
  assert.throws(() => scopeSelector(":global .root", scopeAs), /没有括号/);
  assert.throws(() => scopeSelector(":local .root", scopeAs), /没有括号/);
});

test("仓库自有 overlay 样式：全部只走括号形态，转换后不留 :global/:local", () => {
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith(".module.css")) files.push(p);
    }
  };
  walk(join(REPO_ROOT, "integrations"));
  assert.ok(files.length >= 2, "至少 ui-layout 与 ui-sidebar 各一份样式");
  for (const file of files) {
    const root = postcss.parse(readFileSync(file, "utf8"), { from: file });
    root.walkRules((rule) => {
      const next = scopeSelector(rule.selector, scopeAs);
      assert.ok(!/:(?:global|local)\b/.test(next), `${file}: ${rule.selector} → ${next}`);
    });
  }
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

test("patchGeneratedRequestModel：schema 里已有 model 就抛（上游把字段做进协议了，补丁该撤）", () => {
  const already = TYPERT_FIXTURE.replace(
    "  'sessionId': z.string().readonly(),",
    "  'sessionId': z.string().readonly(),\n  'model': z.string().readonly().optional(),",
  );
  assert.throws(
    () => patchGeneratedRequestModel(already, ["session_prompt_parameter_0"]),
    /已经有 model 字段/,
  );
});
