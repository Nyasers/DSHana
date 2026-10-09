// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/lib/html-relay.test.mjs — 卡内 HTML 绝对引用相对化单测（纯函数，无网络）
// 覆盖：三种属性字形、段运算与 query/fragment、非目标引用原样、原始文本段与注释不被误伤、
// 边界（空文档路径 / 非法参数 / 无引号取值 / 自闭合）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isRootRelativeRef,
  rewriteRootRelativeRefs,
  toDocRelativeRef,
} from "@dshana/shared/html-relay.ts";

const DOC = "/wallpaper-engine/scene-live/index.html";
const PREFIX = "/api/apps/dshana/routes/_runtime/RID/_hana/KEY/";

/** 把改写后的相对引用按文档 URL 解析回来，断言落在中继前缀下的原目标。 */
function resolvesTo(docPath, ref) {
  const docUrl = "http://h" + PREFIX + docPath.replace(/^\//, "");
  return new URL(ref, docUrl).pathname;
}

test("isRootRelativeRef：只认前导斜杠且非协议相对", () => {
  assert.equal(isRootRelativeRef("/a/b"), true);
  assert.equal(isRootRelativeRef("//cdn/x"), false);
  assert.equal(isRootRelativeRef("./a"), false);
  assert.equal(isRootRelativeRef("https://x/a"), false);
  assert.equal(isRootRelativeRef("data:text/plain,x"), false);
  assert.equal(isRootRelativeRef("#frag"), false);
  assert.equal(isRootRelativeRef(""), false);
});

test("toDocRelativeRef：段运算 + 反向解析回到原目标", () => {
  const cases = [
    "/wallpaper-engine/scene-live/index.html",
    "/wallpaper-engine/scene-live/assets/renderer-A.js",
    "/wallpaper-engine/scene-files/tok/x.pkg",
    "/a/b/c.html",
    "/index.html",
  ];
  for (const ref of cases) {
    const rel = toDocRelativeRef(DOC, ref);
    assert.equal(resolvesTo(DOC, rel), PREFIX + ref.replace(/^\//, ""), `${ref} -> ${rel}`);
  }
});

test("toDocRelativeRef：query 与 fragment 原样保留", () => {
  const rel = toDocRelativeRef(DOC, "/wallpaper-engine/scene-files/tok/x.pkg?type=scene#frag");
  assert.ok(rel.endsWith("?type=scene#frag"), rel);
  assert.equal(
    resolvesTo(DOC, rel),
    PREFIX + "wallpaper-engine/scene-files/tok/x.pkg",
  );
});

test("toDocRelativeRef：非根相对与畸形参数原样返回", () => {
  assert.equal(toDocRelativeRef(DOC, "assets/x.js"), "assets/x.js");
  assert.equal(toDocRelativeRef(DOC, "//cdn/x.js"), "//cdn/x.js");
  assert.equal(toDocRelativeRef("relative/doc.html", "/a.js"), "/a.js");
  assert.equal(toDocRelativeRef(DOC, "https://example.com/x.js"), "https://example.com/x.js");
});

test("改写真实形态：模块脚本与 modulepreload 两行", () => {
  const html = [
    '<!doctype html>',
    '<html><head>',
    '<script type="module" crossorigin src="/wallpaper-engine/scene-live/assets/renderer-AJkjEL9i.js"></script>',
    '<link rel="modulepreload" crossorigin href="/wallpaper-engine/scene-live/assets/modulepreload-polyfill-B5Qt9EMX.js">',
    '</head><body></body></html>',
  ].join("\n");
  const out = rewriteRootRelativeRefs(html, DOC);
  assert.ok(!/src="\/wallpaper-engine/.test(out), "模块脚本 src 不应再是根相对:\n" + out);
  assert.ok(!/href="\/wallpaper-engine/.test(out), "modulepreload href 不应再是根相对:\n" + out);
  assert.ok(out.includes("renderer-AJkjEL9i.js"), "文件名应保留");
  // 反验：解析后仍指向原目标（即真的还在卡里那条河道上）
  const srcM = /src="([^"]+)"/.exec(out);
  assert.equal(resolvesTo(DOC, srcM[1]), PREFIX + "wallpaper-engine/scene-live/assets/renderer-AJkjEL9i.js");
});

test("三种属性字形都被改写：双引号 / 单引号 / 无引号", () => {
  const html = `<img src="/a.png"><img src='/b.png'><img src=/c.png>`;
  const out = rewriteRootRelativeRefs(html, "/d/index.html");
  assert.ok(/src="\.\.\/a\.png"/.test(out), out);
  assert.ok(/src='\.\.\/b\.png'/.test(out), out);
  assert.ok(/src=\.\.\/c\.png(?![\w.])/.test(out), out);
});

test("非目标引用原样：协议相对 / 完整 URL / data: / blob: / #frag / 相对路径", () => {
  const html = [
    '<img src="//cdn.example.com/a.png">',
    '<img src="https://example.com/b.png">',
    '<img src="data:image/png;base64,AAA">',
    '<img src="blob:https://hana.local/uuid">',
    '<a href="#section">x</a>',
    '<img src="./rel.png">',
    '<img src="rel2.png">',
  ].join("");
  assert.equal(rewriteRootRelativeRefs(html, DOC), html, "不该动任何一个");
});

test("宿主前缀下的引用不被重复改写（已在 /api/apps/ 下）", () => {
  // 注意：本函数只做「相对化」，不判断宿主前缀；已在 /api/apps/ 下的绝对引用会被相对化，
  // 但解析结果仍落在同一前缀下（幂等，不变量是「解析后指向不变」）。
  const html = '<script src="/api/apps/dshana/ui/app-shell.js"></script>';
  const out = rewriteRootRelativeRefs(html, DOC);
  const m = /src="([^"]+)"/.exec(out);
  assert.equal(resolvesTo(DOC, m[1]), PREFIX + "api/apps/dshana/ui/app-shell.js");
  // 幂等：再跑一次不变
  const again = rewriteRootRelativeRefs(out, DOC);
  assert.equal(again, out);
});

test("原始文本段整体跳过：内联脚本里的 href/src 字符串不被改坏", () => {
  const html = [
    "<head>",
    '<script>var s = \'<img src="/should-not-change.png">\'; window.tpl = "href=\'/x.css\'";</script>',
    "</head>",
    '<body><img src="/real.png"></body>',
  ].join("");
  const out = rewriteRootRelativeRefs(html, "/d/index.html");
  assert.ok(out.includes('"/should-not-change.png"'), "内联脚本里的字符串必须原样:\n" + out);
  assert.ok(out.includes("href='/x.css'"), "内联脚本里的字符串必须原样:\n" + out);
  assert.ok(/src="\.\.\/real\.png"/.test(out), "真实元素应被改写:\n" + out);
});

test("style 原始文本段与注释整体跳过", () => {
  const html = [
    "<style>/* @import url('/x.css') */ body { background: url('/y.png') }</style>",
    '<!-- 示例：<img src="/in-comment.png"> -->',
    '<img src="/real.png">',
  ].join("\n");
  const out = rewriteRootRelativeRefs(html, "/d/index.html");
  assert.ok(out.includes("url('/y.png')"), "<style> 内容必须原样:\n" + out);
  assert.ok(out.includes('src="/in-comment.png"'), "注释内容必须原样:\n" + out);
  assert.ok(/src="\.\.\/real\.png"/.test(out), "真实元素应被改写:\n" + out);
});

test("自闭合与属性顺序：<link/> 也能改；无关属性不被碰", () => {
  const html = '<link rel="stylesheet" href="/a.css" media="screen"/>';
  const out = rewriteRootRelativeRefs(html, "/d/index.html");
  assert.ok(/href="\.\.\/a\.css"/.test(out), out);
  assert.ok(out.includes('rel="stylesheet"') && out.includes('media="screen"'), "无关属性不受影响");
});

test("非法参数原样返回", () => {
  const html = '<img src="/a.png">';
  assert.equal(rewriteRootRelativeRefs(html, ""), html);
  assert.equal(rewriteRootRelativeRefs(html, "no-slash"), html);
  assert.equal(rewriteRootRelativeRefs(null, DOC), null);
  assert.equal(rewriteRootRelativeRefs(html, null), html);
});

test("空字符串与纯文本：不崩、不改", () => {
  assert.equal(rewriteRootRelativeRefs("", DOC), "");
  const text = "纯文本没有标签，/a/b 这样的路径不该被当成引用";
  assert.equal(rewriteRootRelativeRefs(text, DOC), text);
});
