// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/shared/src/html-relay.ts — 卡内 HTML 的绝对引用相对化（中继改写用）
//
// 为什么需要它：注入形态下，卡里的文档是从**中继前缀**取的
// （`/api/apps/<id>/routes/_runtime/<rid>/…/_hana/<key>/…`），而文档内部的前导斜杠引用
// （`<script src="/wallpaper-engine/…">`）按 origin 解析 —— 即落到**宿主源**根上，被凭据闸挡。
// 这类引用是浏览器解析器直接落的：`setAttribute` 与属性访问器都拦不到（`innerHTML`、
// `createContextualFragment` 同理），`<base href>` 也管不了（`/` 开头只继承 origin、
// 不继承 base 的路径）—— 三件事都在真 Chromium 上核过。所以只能在**产出 HTML 的那一层**
// 改写，而卡里所有东西都经中继出去，中继就是那一层。
//
// 为什么改成**相对引用**而不是拼上中继前缀：中继在授权那步已把 `/_hana/<key>/` 剥掉，
// 手上只有上游相对路径（`/wallpaper-engine/scene-live/index.html`），前缀里那几个可变段
// （runtimeId / key）它并不持有；而文档 URL 与引用本来都挂在同一个前缀下，把那一段约掉
// 即可 —— 相对化不依赖前缀的内容，前缀换了也不必跟着改。
//
// 为什么用扫描器而非一条正则：属性字形之外还有 `<script>` / `<style>` 的**原始文本段**与
// 注释，内联脚本里出现 `' href="/x"'` 这样的字符串时，整段替换会把脚本内容改坏。原始文本段
// 与注释必须原样跳过 —— 那些位置上的引用要么本就该由客户端接管处理，要么根本不是引用。
//
// 只处理「前导斜杠且非协议相对」的引用。`//host/x`（协议相对）、`#frag`、`?query`、
// 完整 URL、`data:` / `blob:` 一律原样：它们要么本来就不受宿主源约束，要么不该被重写。
// 本模块零依赖，中继（Node）与页面（浏览器）可共用同一份判定。

/** 「前导斜杠、且不是协议相对」才算要处理的绝对路径。 */
export function isRootRelativeRef(value: string): boolean {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

/**
 * 把一个「根相对引用」相对化，使其按**文档自身 URL** 解析后仍指向同一目标。
 *
 * 做法：文档路径去掉末段（文件名）得到目录段，与引用取公共前缀，回退 `../` 之后接剩余段。
 * 同层时用 `./` 开头（比裸 `assets/x.js` 更能表明「这是相对引用」）。
 *
 * @param docPath 文档在上游的路径（前导斜杠，如 `/wallpaper-engine/scene-live/index.html`）
 * @param ref 根相对引用（可带 query/fragment，如 `/a/b.js?x=1#h`）
 * @returns 相对引用；`ref` 不是根相对、或参数畸形时原样返回
 */
export function toDocRelativeRef(docPath: string, ref: string): string {
  if (!isRootRelativeRef(ref)) return ref;
  if (typeof docPath !== "string" || !docPath.startsWith("/")) return ref;

  // 拆出引用自身的 query/fragment，只对路径部分做段运算
  const cut = ref.search(/[?#]/);
  const refPath = cut === -1 ? ref : ref.slice(0, cut);
  const refTail = cut === -1 ? "" : ref.slice(cut);

  const docSegs = docPath.replace(/^\/+/, "").split("/");
  docSegs.pop(); // 末段是文件名，目录段到此为止
  const refSegs = refPath.replace(/^\/+/, "").split("/");

  let same = 0;
  while (same < docSegs.length && same < refSegs.length && docSegs[same] === refSegs[same]) same += 1;
  const up = docSegs.length - same;
  const rest = refSegs.slice(same).join("/");
  return (up > 0 ? "../".repeat(up) : "./") + rest + refTail;
}

/** 属性值字形：双引号 / 单引号 / 无引号（HTML 规范允许三种）。 */
const ATTR_RE = /(\s(?:src|href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/** 在一段标签文本（`<...>`，含尖括号）内重写资源属性；非标签文本原样返回。 */
function rewriteTagAttributes(tag: string, docPath: string): string {
  return tag.replace(ATTR_RE, (whole, prefix, dq, sq, uq) => {
    const value = dq !== undefined ? dq : sq !== undefined ? sq : uq;
    if (!isRootRelativeRef(value)) return whole;
    const next = toDocRelativeRef(docPath, value);
    if (next === value) return whole;
    if (dq !== undefined) return prefix + '"' + next + '"';
    if (sq !== undefined) return prefix + "'" + next + "'";
    return prefix + next;
  });
}

/** 从 `<` 处找到与之配对的 `>`（跳过引号内的尖括号）；找不到返回 -1。 */
function findTagEnd(html: string, start: number): number {
  let quote = "";
  for (let i = start + 1; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") return i;
  }
  return -1;
}

/** 原始文本段标签：其内容不按标签解析（HTML 的 raw text elements）。 */
const RAW_TEXT_RE = /^<(script|style|textarea|title)\b/i;

/**
 * 改写一段 HTML 里所有根相对的资源引用。
 *
 * 只认 `src` / `href` 两个属性的取值。`<script>` / `<style>` 等原始文本段与注释**整体跳过**
 * （内容原样保留），文本节点也原样保留。只改属性值字面量，不动结构。
 *
 * 有意不处理：`srcset`（一个值里多条 URL，要按各自语法切分）、CSS `url()` / `@import`
 * （在 `<style>` 与 style 属性里），以及 SVG 的 `xlink:href`（命名空间属性，属性名不只
 * `href` 一段）。它们是各自语法的多值或限定名，不是单值属性重写能覆盖的。
 *
 * @param html 上游 HTML 原文
 * @param docPath 该文档在上游的路径（前导斜杠）
 * @returns 改写后的 HTML；`docPath` 非法时原样返回
 */
export function rewriteRootRelativeRefs(html: string, docPath: string): string {
  if (typeof html !== "string" || typeof docPath !== "string" || !docPath.startsWith("/")) return html;
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    // 注释：整段原样（其中的示例引用不该被改）
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      const stop = end === -1 ? html.length : end + 3;
      out.push(html.slice(i, stop));
      i = stop;
      continue;
    }
    if (html[i] === "<") {
      const tagEnd = findTagEnd(html, i);
      if (tagEnd === -1) { out.push(html.slice(i)); break; }
      const tag = html.slice(i, tagEnd + 1);
      out.push(rewriteTagAttributes(tag, docPath));
      i = tagEnd + 1;
      // 原始文本段：开标签已改写，内容到配对闭合标签为止整体原样搬过去
      const m = RAW_TEXT_RE.exec(tag);
      if (m && !/\/>\s*$/.test(tag)) {
        const closeRe = new RegExp("</" + m[1] + "\\s*>", "i");
        const rest = html.slice(i);
        const close = closeRe.exec(rest);
        if (!close) { out.push(rest); break; }
        out.push(rest.slice(0, close.index));
        out.push(close[0]);
        i += close.index + close[0].length;
      }
      continue;
    }
    // 文本节点：搬到下一个 '<'
    const next = html.indexOf("<", i);
    if (next === -1) { out.push(html.slice(i)); break; }
    out.push(html.slice(i, next));
    i = next;
  }
  return out.join("");
}
