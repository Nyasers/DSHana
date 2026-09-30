// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/build/profile-preset.test.mjs — 预设归属我们（spec §6.6）的单测。
//
// 守四件事：
//   1. delta 是**纯加法**：我们插入的每一段删掉之后，逐字节还原上游；
//   2. 我们的 bundle 清单 = 上游 `web` 两层 + **我们自己那层 @dshana/app**（顺序即层序，
//      末层是它才有"用户层能覆盖我们"这条性质——见 integration.json 的 notes）；
//   3. **负向**：`web` 仍在上游那张表里且清单未变——我们没动它，`--profile web` 照旧可用；
//   4. 老安装的 profile 清单（上游 web 两层）能被规范化成我们那份——升级不靠重建 profile 目录。
//
// 为什么值得单测（而不是只靠构建期闸）：上游哈希闸管的是"overlay 还对得上上游吗"，管不到
// "我们期望的语义是什么"。比如有人顺手把 dshana 的 bundles 改成少一层，闸照过、编译照过，
// 只有启动时才炸。这里把语义钉在测试里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, readUpstreamFromMirror } from "../../scripts/integrations/mirror.mts";
import { PROFILE_TEMPLATE_NAME } from "../../scripts/release/package-set.mts";

const TAG = "dsh-v0.2.0-rc.2";
const REL = "packages/boot/app-boot/src/profile.ts";
// `${...}` 形式避开模块级拼接：这里直接写死，改了上游路径本测试就该一起改。
const UPSTREAM = readUpstreamFromMirror(REL, TAG);
const OVERLAY = readFileSync(join(REPO_ROOT, "src-integrations", "app-boot-profile", "files", "src", "profile.ts"), "utf8");

/** 从一张 PROFILE_TEMPLATES 表源码里抽 `<名字>: { bundles: [...] }` 的 bundles 列表。 */
function bundlesOf(source, name) {
  // 只匹配模板表里那种两空格缩进的条目，避免命中别处同名标识符。
  const re = new RegExp("^  " + name + ": \\{\\s*\\n\\s*bundles: \\[([^\\]]*)\\]", "m");
  const m = source.match(re);
  if (m === null) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

/** 我们往上游源码里插入的加法段：注释锚点 → 条目锚点 → 段末（含，跟着条目走）。 */
const DELTAS = [
  // 模板表里的 dshana 条目：注释块 + 条目 + 收尾的 `},`。
  { comment: "  // dshana:", entry: "  dshana: {", end: "\n  },\n" },
  // 规范化表里的 dshana 元组：两行注释 + 一行条目。
  { comment: "  // dshana profile", entry: "  dshana: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],", end: "\n" },
];

test("delta 是纯加法：删掉每一段增量后逐字节还原上游", () => {
  // 这就是"加法 delta"的可判定表述：把锚点围起来的每一段删掉，必须得到原文，没有多余改动。
  let stripped = OVERLAY;
  for (const delta of DELTAS) {
    const start = stripped.indexOf(delta.comment);
    assert.ok(start >= 0, `delta 锚点变了：找不到 ${JSON.stringify(delta.comment)}`);
    const entryStart = stripped.indexOf(delta.entry, start);
    assert.ok(entryStart > start, `注释在但条目不在：${JSON.stringify(delta.entry)}`);
    const entryEnd = stripped.indexOf(delta.end, entryStart);
    assert.ok(entryEnd > entryStart, `条目没有正常收尾：${JSON.stringify(delta.end)}`);
    stripped = stripped.slice(0, start) + stripped.slice(entryEnd + delta.end.length);
  }
  assert.equal(stripped, UPSTREAM.toString("utf8"), "删掉 delta 后不等于上游原文：我们的改动不止这些加法段");
});

test("dshana 模板在：上游 web 两层 + 我们自己那层 @dshana/app（且它在末位）", () => {
  const ours = bundlesOf(OVERLAY, PROFILE_TEMPLATE_NAME);
  const upstreamWeb = bundlesOf(UPSTREAM.toString("utf8"), "web");
  assert.ok(ours, `delta 里没有 ${PROFILE_TEMPLATE_NAME} 模板`);
  assert.deepEqual(upstreamWeb, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "上游 web 模板变了：先看清再决定我们要不要跟");
  assert.deepEqual(
    ours,
    [...upstreamWeb, "@dshana/app"],
    "我们的模板必须是 web 两层后面接我们自己的层",
  );
  // 末位是**契约**而不是风格：层序即数组顺序，用户层排在所有 bundles 之后——我们的层只要不在末尾，
  // 它后面就有别的 bundle 能盖掉我们，而"用户能覆盖我们"这条性质仍成立却多了一层不确定。
  assert.equal(ours[ours.length - 1], "@dshana/app", "我们的层必须在 bundles 末位");
});

test("规范化元组 = 上游 web 两层，且模板 = 元组 + @dshana/app（老安装升上来才落得到我们的层）", () => {
  // 已初始化的 profile 不会被 initProfile 重写，所以"升级后多出我们那层"只能靠规范化元组。
  // 元组必须正好是上游 web 的两层：多一层或少一层都意味着老安装升上来后清单不等于模板。
  const upstreamWeb = bundlesOf(UPSTREAM.toString("utf8"), "web");
  const m = OVERLAY.match(/^  dshana: \[([^\]]*)\],\n/m);
  assert.ok(m, "delta 里没有 dshana 的规范化元组");
  const tuple = m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  assert.deepEqual(tuple, upstreamWeb, "规范化元组必须正是上游 web 那两层");
  assert.deepEqual([...tuple, "@dshana/app"], bundlesOf(OVERLAY, PROFILE_TEMPLATE_NAME));
});

// 负向：我们没动上游那张表里的 web（`--profile web` 仍能正常用）。
test("负向：web 仍在上游模板表里、清单未变（我们只加不改）", () => {
  const upstreamSrc = UPSTREAM.toString("utf8");
  assert.ok(bundlesOf(upstreamSrc, "web"), "上游 web 模板不见了");
  // delta 里 web 的清单必须与上游一致——如果哪天我们顺手改了它，这条会响。
  assert.deepEqual(bundlesOf(OVERLAY, "web"), bundlesOf(upstreamSrc, "web"), "delta 动了 web 模板（应当只加不改）");
  // 上游其余模板也都在（acp/headless/sdk/sdk-minimal），delta 一个都没碰。
  for (const name of ["acp", "headless", "sdk", "sdk-minimal"]) {
    assert.deepEqual(bundlesOf(OVERLAY, name), bundlesOf(upstreamSrc, name), `delta 动了上游模板 ${name}`);
  }
  assert.ok(!bundlesOf(upstreamSrc, PROFILE_TEMPLATE_NAME), "上游本来就有 dshana？那这条 delta 该撤了（别与上游撞名）");
});

test("负向（行为面）：上游 web 模板经 profile 机制能正常初始化与加载", async () => {
  // 源码级"没动它"之外，再走一次真机制：用上游 app-boot 的 web 模板 initProfile，再用同一份
  // app-boot 的 loadProfileDirectory 载回来。这条覆盖 `--profile web` 的初始化 + 层解析两步。
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const appBoot = join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", "@deepseek-ai", "dsh-app-boot");
  const mod = await import(pathToFileURL(join(appBoot, "lib", "index.js")).href);
  const web = mod.PROFILE_TEMPLATES?.web;
  assert.ok(web, "上游 app-boot 里没有 web 模板");
  const home = mkdtempSync(join(tmpdir(), "dshana-web-"));
  try {
    const dir = join(home, "profiles", "web");
    mod.initProfile(dir, web.bundles);
    const loaded = mod.loadProfileDirectory("dsh", dir, join(appBoot, "package.json"), { userLayer: false });
    assert.deepEqual(loaded.layers.map((l) => l.packageName), [...web.bundles], "web 的层没解析全");
    assert.deepEqual(loaded.skippedBundles, [], "web 有层被跳过，说明表或机制坏了");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("integration.json 的哈希指向镜像里那份真源，且只声明一个文件", () => {
  const decl = JSON.parse(readFileSync(join(REPO_ROOT, "src-integrations", "app-boot-profile", "integration.json"), "utf8"));
  assert.equal(decl.package, "@deepseek-ai/dsh-app-boot", "认领的包变了：模板表的宿主就是 app-boot");
  assert.equal(decl.upstreamDir, "packages/boot/app-boot");
  assert.equal(decl.files.length, 1);
  assert.equal(decl.files[0].path, "src/profile.ts");
  assert.match(decl.files[0].upstreamSha256, /^[0-9a-f]{64}$/);
});

test("app-boot-profile 声明为 sourceOnly，且不带编译半（否则会被当 client 半去编）", () => {
  // 这条是真实的坑：集成缺省走 client 半（找 src/client/index.ts 并重打 lib/client.js），而
  // app-boot 的 delta 是**一个上游源文件**，没有自己编的产物。缺了 sourceOnly，build:integrations
  // 会拿 profile.ts 当浏览器入口去 bundle（或直接报找不到原版 lib/client.js）。
  const decl = JSON.parse(readFileSync(join(REPO_ROOT, "src-integrations", "app-boot-profile", "integration.json"), "utf8"));
  assert.equal(decl.sourceOnly, true, "app-boot-profile 必须是 sourceOnly（纯源码 delta）");
  assert.equal(decl.halves, undefined, "sourceOnly 与 halves 互斥：不该再有编译声明");
  // 我们的模板表要生效，bundle 清单里那两层必须在装好的 app-boot 里能解析到；这里只核认领的包名
  // 与 upstreamDir 拼得上（README 的 rebase 指引靠这两个字段）。
  assert.equal(decl.upstreamDir, "packages/boot/app-boot");
  assert.ok(decl.notes.some((n) => n.includes("§6.6")), "notes 应指回 spec §6.6（接手的人要知道这条 delta 的来由）");
});
