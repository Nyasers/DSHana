// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/entry.ts — 会话入口卡的脚本：把坐标变成黑板上那张会话卡，并报结果。
//
// 这一页的职责只有一件：把工具回执里那对坐标（sid = 钉住的 DSH 会话，tid = 对应的宿主任务）
// 交给宿主，让那段会话出现在黑板上（lib/chalkboard.ts 的 placeSessionOnChalkboard）。
// 卡的位置、外框、关闭按钮与 surface 凭据都归宿主，本页不碰。
// 自己不注入 DSH、不连中继，所以没有票据与冻结的负担——那张黑板卡才是 DSH 现场。
import { hana } from "@hana/plugin-sdk";
import { placeSessionOnChalkboard } from "#/lib/chalkboard.ts";
import { followHostTheme } from "#/ui/host-theme.ts";

// 宿主握手（与壳页、设置页同一纪律）：页面挂载即 hana.ready()，宿主据此把本 surface 标成
// 可信。没有这一步，稍后 hana.cards.open 会被宿主以 APP_CARD_SURFACE_NOT_READY 拒掉。
try {
  if (hana && typeof hana.ready === "function") hana.ready();
} catch {
  /* 宿主未提供则忽略 */
}

// 跟随宿主主题：首帧自己贴一次样式表，此后事件驱动。SDK 只在收到 hana.theme.changed 时才
// 应用 cssUrl，页面不自己贴首帧就会一路吃 entry.html 里写死的纸张 fallback（见 host-theme.ts）。
followHostTheme(hana);

const params = new URLSearchParams(location.search);
const sid = (params.get("sid") || "").trim();
const tid = (params.get("tid") || "").trim();
const cwd = (params.get("cwd") || "").trim();

const root = document.querySelector<HTMLElement>("[data-dsh-entry]");
const labelEl = document.querySelector<HTMLElement>("[data-dsh-entry-label]");
const metaEl = document.querySelector<HTMLElement>("[data-dsh-entry-meta]");
const openBtn = document.querySelector<HTMLButtonElement>("[data-dsh-entry-open]");

/** 卡面标题：会话 id 全串（够辨认）；版面不够时由 .label 的 CSS 省略，不在这里硬截断。 */
const title = sid ? "DSH 会话 " + sid : "DSH 会话";

/** 副行：工作目录 + 任务 id 短串；两者都缺就说明这张卡没带坐标。 */
function metaText(): string {
  const parts: string[] = [];
  if (cwd) parts.push(cwd);
  if (tid) parts.push("task " + tid.slice(0, 12));
  return parts.length ? parts.join(" · ") : "这张卡没有带会话坐标";
}

function setPhase(phase: string, note: string): void {
  if (root) root.dataset.phase = phase;
  if (metaEl) metaEl.textContent = note || metaText();
}

if (labelEl) labelEl.textContent = title;
setPhase(sid ? "idle" : "error", "");
// 没有会话坐标就没有可放置的对象：黑板卡跟随的是共用选中，而这里正是它的写入方。
if (!sid && openBtn) openBtn.disabled = true;

let placing = false;
openBtn?.addEventListener("click", () => {
  void (async () => {
    if (placing) return;
    placing = true;
    openBtn.disabled = true;
    openBtn.textContent = "放置中…";
    try {
      await placeSessionOnChalkboard(hana, sid);
      setPhase("placed", "已放到黑板（那张卡跟随当前选中的会话）");
      // 留住按钮：宿主已有这张卡时再点一次只是把它揭示出来，不会开出第二份。
      openBtn.disabled = false;
      openBtn.textContent = "再放到黑板";
    } catch (e) {
      setPhase("error", "放到黑板失败：" + ((e as Error)?.message || String(e)));
      openBtn.disabled = false;
      openBtn.textContent = "重试";
    } finally {
      placing = false;
    }
  })();
});
