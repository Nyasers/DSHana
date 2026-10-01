// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/build/minify-assets.mts — 资源压缩共享逻辑（单一事实源）
// 三个消费方，压缩参数只维护一份：
//   build/minify-loader.mts（rspack asset/source 内联前压缩 src/assets 前端资源）
//   build/common.mts 的 extraMinify（rspack 产物二次压缩：JS 与静态壳页 HTML）
//   （前两个之外还有测试直接调）
import { minify } from "terser";
import CleanCSS from "clean-css";
import { minify as minifyHtmlSource } from "html-minifier-terser";
import { parse } from "parse5";

/** JS 压缩：terser，module 语义（保留 ESM 语法，普通脚本同样适用） */
export async function minifyJs(content) {
  const r = await minify(content, { module: true });
  return r.code;
}

/** CSS 压缩：clean-css level 2，出错即抛（fail-closed）。
 * level 2 默认已开合并/去重/重构；另显式打开三项非默认的深度去重。
 * 不用 removeUnusedAtRules：它在含未知 at-rule 的样式上会自己抛回（clean-css 5.3 的 bug）。 */
export function minifyCss(content) {
  const r = new CleanCSS({
    level: {
      1: {},
      2: {
        mergeSemantically: true,
        removeDuplicateMediaBlocks: true,
        removeDuplicateFontRules: true,
      },
    },
  }).minify(content);
  if (r.errors.length) throw new Error(`clean-css: ${r.errors.join("; ")}`);
  return r.styles;
}

/**
 * 文档的标签名序列（用于压缩前后结构比对）。用 parse5（规范级 HTML 解析器）解析后遍历取
 * 标签名：<script>/<style> 的内容由解析器当**文本**，不会被误认成标签。
 * 手写正则做不到这点——JS 里的比较符、字符串里的 HTML 片段会冒充标签名，
 * 一压行内块就误判成「改了结构」。
 */
function tagsOf(html) {
  const out: string[] = [];
  const walk = (node) => {
    if (typeof node.tagName === "string") out.push(node.tagName);
    if (node.content) walk(node.content); // <template> 的内容挂在 content 上
    for (const child of node.childNodes || []) walk(child);
  };
  walk(parse(html));
  return out.join(",");
}

/**
 * HTML 压缩：去注释、收空白、压缩行内 <style>/<script>。
 *
 * 行内块不能交给别人：静态壳页里的 <style>/<script> 是手写文本，不经任何打包器，
 * 本器内嵌的 clean-css / terser 就在这里把它们压了（minifyCSS / minifyJS），
 * 否则它们会原样落进产物。空白整体收掉（不留标签间的多余空格）；属性引号、标签顺序都不动。
 * 压缩前后标签名序列必须一致，变了就是动了结构，当场失败（壳页里跑的是 DSH 的 UI，
 * 少一个标签就是另一个页面）。
 */
export async function minifyHtml(content) {
  const out = await minifyHtmlSource(content, {
    removeComments: true,
    collapseWhitespace: true,
    minifyCSS: { level: 2 },
    minifyJS: true,
    // 属性引号能省则省、doctype 用短形（html-minifier 只在安全时才去引号）。
    // 结构守护靠 parse5 看标签名，与属性引号/顺序无关。
    removeAttributeQuotes: true,
    useShortDoctype: true,
    sortAttributes: false,
    sortClassName: false,
  });
  const before = tagsOf(content);
  const after = tagsOf(out);
  if (before !== after) throw new Error("html-minifier 改了标签结构（压缩前后标签序列不一致），拒绝写出");
  return out;
}
