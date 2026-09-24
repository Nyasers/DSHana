// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/entry.ts — 会话入口卡的脚本：读坐标、开窗口、报结果。
//
// 这一页的职责只有一件：把工具回执里那对坐标（sid = 钉住的 DSH 会话，tid = 对应的宿主任务）
// 交给 App 后端，让它在原生窗口里打开那段会话（POST /dshana/sessions/open）。
// 自己不注入 DSH、不连中继，所以没有票据与冻结的负担。
// 到 App 后端一律 hana.api.fetch（宿主在 App surface iframe URL 附 appSurfaceSession，
// SDK 注入 X-Hana-App-Surface-Session 头；裸 fetch 会被网关 403）。
import { hana } from "@hana/plugin-sdk";

const params = new URLSearchParams(location.search);
const sid = (params.get("sid") || "").trim();
const tid = (params.get("tid") || "").trim();
const cwd = (params.get("cwd") || "").trim();

const root = document.querySelector<HTMLElement>("[data-dsh-entry]");
const labelEl = document.querySelector<HTMLElement>("[data-dsh-entry-label]");
const metaEl = document.querySelector<HTMLElement>("[data-dsh-entry-meta]");
const openBtn = document.querySelector<HTMLButtonElement>("[data-dsh-entry-open]");

/** 卡面标题：会话 id 的短串（够辨认，不占版面）。 */
const title = sid ? "DSH 会话 " + sid.slice(0, 18) + "…" : "DSH 会话";

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
setPhase(sid || tid ? "idle" : "error", "");
if (!sid && !tid && openBtn) {
  openBtn.disabled = true;
}

let opening = false;
openBtn?.addEventListener("click", () => {
  void (async () => {
    if (opening) return;
    opening = true;
    openBtn.disabled = true;
    openBtn.textContent = "打开中…";
    try {
      const res = await hana.api.fetch("dshana/sessions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sessionId: sid, taskId: tid, title }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data || data.ok !== true) throw new Error(data?.error || "HTTP " + res.status);
      setPhase("opened", "已在新窗口打开");
      openBtn.textContent = "已打开";
      // 留住按钮：再点一次是"再开一个窗口"，宿主负责去重与聚焦。
      openBtn.disabled = false;
      openBtn.textContent = "再开一个窗口";
    } catch (e) {
      setPhase("error", "打开失败：" + ((e as Error)?.message || String(e)));
      openBtn.disabled = false;
      openBtn.textContent = "重试";
    } finally {
      opening = false;
    }
  })();
});
