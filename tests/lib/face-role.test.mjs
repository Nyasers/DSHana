// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/face-role.test.mjs — 页面的「面」与 DSH 侧角色词（packages/ui/src/face-role.ts）。
//
// 面的事实源是页面自己的静态声明（meta / body[data-dshana-view]），映射表在可单测的模块里。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FACE_ROLE, FACE_VIEWS, isFaceView, roleForView } from "@dshana/ui/face-role.ts";
import { manifestPath } from "../../scripts/shared/contract-assets.mts";

test("会话流面：未钉住时跟随共用选中，不把会话清空", () => {
  const src = readFileSync(join(here, "..", "..", "integrations", "ui-session", "files", "src", "client", "index.ts"), "utf8");
  // 不带 sid 直接开页 = 跟随跨面共用的当前会话（见 ui/stream.html 的注释）。
  // 若这一支也报 MAX_SAFE_INTEGER，applyRemote 就会把它当成「最新的意思：没有会话」而 clear()。
  assert.match(src, /if \(sid === null\) return sharedSelection\(\)/, "未钉住要回落到共用选中");
  assert.ok(!/id: sid \?\? null/.test(src), "不再把「没钉住」当成「就是没有会话」");
});

const here = dirname(fileURLToPath(import.meta.url));
const APP_FRAME = join(here, "..", "..", "integrations", "ui-layout", "files", "src", "client", "AppFrame.tsx");

test("认面：词表内的值才算声明", () => {
  for (const view of FACE_VIEWS) assert.equal(isFaceView(view), true);
  for (const bad of ["", "MAIN", "sidebar ", "unknown", null, undefined, 1, {}]) {
    assert.equal(isFaceView(bad), false, "不属于词表的值一律当没声明：" + String(bad));
  }
});

test("映射：每个面都有角色词，认不出面时回到上游整幅 UI", () => {
  for (const view of FACE_VIEWS) {
    assert.equal(typeof FACE_ROLE[view], "string");
    assert.ok(FACE_ROLE[view].length > 0);
    assert.equal(roleForView(view), FACE_ROLE[view]);
  }
  assert.equal(roleForView(null), "standalone", "认不出面按上游本来的行为画整幅，不擅自少一列");
  assert.equal(roleForView("nope"), "standalone");
});

test("会话流面：角色词是 stream，且不与别的面共用", () => {
  assert.equal(roleForView("stream"), "stream");
  const others = FACE_VIEWS.filter((v) => v !== "stream").map((v) => FACE_ROLE[v]);
  assert.ok(!others.includes("stream"), "stream 是这一面专属的角色词");
});

test("ui-layout 覆盖层：每个角色词都有对应 surface 分支", () => {
  const source = readFileSync(APP_FRAME, "utf8");
  const block = /const ROLE_SURFACES[^=]*=\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(block, "AppFrame.tsx 里应有 ROLE_SURFACES 表");
  const words = new Set([...block[1].matchAll(/([A-Za-z][\w-]*)\s*:/g)].map((m) => m[1]));
  for (const role of new Set(Object.values(FACE_ROLE))) {
    assert.ok(words.has(role), "覆盖层缺角色词：" + role);
  }
});

test("清单与页面：会话卡由 ui/stream.html 承担（聊天卡就是这一页，不注册 manifest 卡）", () => {
  const html = readFileSync(join(here, "..", "..", "packages", "ui", "src", "stream.html"), "utf8");
  assert.match(html, /<meta name="hana-dshana-role" content="stream">/);
  assert.match(html, /data-dshana-view="stream"/);
  const manifest = JSON.parse(readFileSync(manifestPath(join(here, "..", "..")), "utf8"));
  const ids = manifest.contributes.cards.map((c) => c.id);
  assert.ok(!ids.includes("stream"), "会话卡走工具的聊天流卡（details.card 指这一页），不占卡片中心一格");
  assert.ok(!ids.includes("session"), "取出由宿主手势完成，不再声明一张黑板的会话卡");
});
