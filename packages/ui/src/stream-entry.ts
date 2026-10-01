// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/stream-entry.ts — 会话卡（stream 面）的**轻半**：认挂载态 + 只画一行入口坐标
//
// 这一半的硬约束：**零 React、不碰 DSH 注入**。聊天流里每一张会话卡都要跑一遍这里，所以它只
// 能带低层宿主管道（packages/ui/src/surface-bridge.ts）与 SDK 的 envelope / state 两个读面。
//
// 两个挂载态（判据 = hana.envelope 的 height.mode，宿主契约见 APPS_EN.md「Mount-mode table」与
// 「Size envelope」）：
//   · chat   —— height flexible/unbounded：聊天流。入口行已经是最终内容，这里什么都不装。
//   · canvas —— height fixed：黑板 / 拆窗。**这时才**动态 import() 重型半
//                packages/ui/src/stream-stage.tsx（React + dsh-inject + host-theme + 卡状态条）。
//
// 坐标由 stream.html 的**内联脚本**在求值时就写进 DOM（不依赖 SDK、不依赖任何宿主握手），
// 而**露不露出**这一行由本模块决定：认到聊天流态才露（取出的卡首帧不许出现坐标行）。
// 首帧主题也由那段内联脚本贴（早于第一次绘制）；本模块接上「此后跟宿主事件走」那一段——
// 聊天流卡不装配重型半，所以主题跟随不能只留在那边。
// 认不出态就等 envelope 首帧，等到封顶仍没有信号时按聊天流收尾——宁可少画（一行坐标），
// 也不能把整幅 DSH 现场灌进聊天转录。
import { hana } from "@hana/plugin-sdk";
import { apiFetch, cardTicket, readCardState, rememberCardSession, routeSessionId } from "./surface-bridge.ts";
import { followHostTheme } from "./host-theme.ts";

// 等 envelope 首帧的封顶时间。宿主在 iframe ready 之后立刻推第一帧，通常远快于此；这一条只为
// 从不发信号的旧宿主兜底。
const MOUNT_WAIT_MS = 2000;
const ENTRY_ID = "dsh-entry";

/** 挂载态（只信 hana.envelope）：chat = 聊天流，canvas = 黑板 / 拆窗，null = 信号还没到。 */
function classifyMount(): "chat" | "canvas" | null {
  let env: any = null;
  try {
    env = hana && (hana as any).envelope && typeof (hana as any).envelope.getSnapshot === "function"
      ? (hana as any).envelope.getSnapshot() : null;
  } catch {
    env = null;
  }
  const mode = env && env.height ? env.height.mode : null;
  if (mode === "fixed") return "canvas";
  if (mode === "flexible" || mode === "unbounded") return "chat";
  return null; // 还没收到信号（宿主在 iframe ready 之后才推第一帧）
}

// 入口行的高度由内容定（四行单行文本，宽度变窄也不会换行）：量一次报给宿主，宿主就不会按
// aspectRatio 把高度跟着宽度一起压扁。这是下限，内容更高时按内容走。
const ENTRY_MIN_HEIGHT_PX = 96;

/** 把入口行的真实高度报给宿主（运行时高度报告；旧宿主没这道门就按 aspectRatio 走）。 */
function reportEntryHeight(): void {
  const el = document.getElementById(ENTRY_ID);
  const ui = hana && (hana as any).ui;
  if (!el || !ui || typeof ui.resize !== "function") return;
  try {
    ui.resize({ height: Math.max(Math.ceil(el.scrollHeight), ENTRY_MIN_HEIGHT_PX) });
  } catch { /* 宿主拒绝就按比例走 */ }
}

/** 卡状态行右侧的跟踪态：非终态（tracked / cancelling）期间慢轮询，终态即停手。 */
const CARD_POLL_MS = 4000;
function mountEntryStatus(): void {
  const ticket = cardTicket();
  const sid = ticket ? ticket.sessionId : "";
  const slot = document.querySelector("[data-dsh-entry-status]");
  if (!sid || !slot) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const loop = (): void => {
    apiFetch("dshana/card-state?sessionId=" + encodeURIComponent(sid), {
      method: "GET", cache: "no-store", headers: { Accept: "text/html" },
    }).then((res) => {
      if (!res.ok) throw new Error("card-state HTTP " + res.status);
      return res.text();
    }).then((html) => {
      if (!html || !html.trim()) { stop(); slot.textContent = ""; return; }
      slot.innerHTML = html;
      const stateEl = slot.querySelector("[data-state]");
      // detail（终态 / 时刻这类）不占版面：挪到悬停提示上，行里只留 label。
      const detailEl = slot.querySelector(".detail");
      if (stateEl && detailEl) {
        const detail = (detailEl.textContent || "").trim();
        if (detail) stateEl.setAttribute("title", detail);
        detailEl.remove();
      }
      const state = stateEl ? String(stateEl.getAttribute("data-state") || "") : "";
      // 只在 tracked / cancelling 期间继续问；其余（ended / unknown / 无状态）停手：卡成快照。
      if (state !== "tracked" && state !== "cancelling") { stop(); return; }
      timer = setTimeout(loop, CARD_POLL_MS);
    }).catch(() => { stop(); });
  };
  loop();
}

/** 写一格坐标值；空值把整行收起来（不留下悬空的标签）。 */
function setEntryRow(selector: string, value: string): void {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  el.textContent = value;
  const row = el.closest(".entry-row") as HTMLElement | null;
  if (row) row.style.display = value ? "" : "none";
}

/** 聊天流态：露出入口行（坐标已由页面内联脚本写好），route 没带 sid 时再从卡实例态补一次。 */
function showEntry(): void {
  document.body.setAttribute("data-stream-view", "entry");
  reportEntryHeight();
  mountEntryStatus();
  if (routeSessionId()) return;
  readCardState("sid").then((sid) => {
    if (sid) setEntryRow("[data-dsh-entry-sid]", sid);
  }, () => { /* 忽略 */ });
}

/** 移除聊天流的入口行（黑板 / 拆窗态装配前调用）。 */
function dropEntry(): void {
  const node = document.getElementById(ENTRY_ID);
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

/** 重型半装载失败时把原因说在入口行上（此时页面只剩这一行）。 */
function showLoadFailure(error: unknown): void {
  const msg = error && (error as { message?: string }).message ? (error as { message: string }).message : String(error);
  console.error("[dshana/stream] 重型半装载失败：", msg);
  setEntryRow("[data-dsh-entry-sid]", "DSH 现场装载失败");
  setEntryRow("[data-dsh-entry-cwd]", msg);
  showEntry();
}

/**
 * 黑板 / 拆窗：先取重型 chunk，认到才把自举台实例化进 DOM。
 * 取 chunk 放在拆入口行**之前**：chunk 取不到（相对路径/部署形态出错）时页面还留着入口行，
 * 失败因此可见，而不是白屏。
 */
function mountStage(): void {
  import("./stream-stage.tsx").then((mod) => {
    const tpl = document.getElementById("tpl-stage") as HTMLTemplateElement | null;
    const stage = tpl && tpl.content && tpl.content.firstElementChild
      ? (tpl.content.firstElementChild.cloneNode(true) as HTMLElement)
      : null;
    if (!stage) throw new Error("stream.html 缺 tpl-stage 模板");
    dropEntry();
    document.body.appendChild(stage);
    mod.mountStreamStage(stage);
  }).catch(showLoadFailure);
}

/** 认到挂载态后分派：聊天流 = 保持入口行；黑板 / 拆窗 = 装载重型半。 */
function boot(): void {
  // 脚本已经接管本页：stream.html 的兜底计时器看这个标记（它找不到就不代我们露出入口行）。
  document.documentElement.setAttribute("data-dshana-stream", "claimed");
  // 宿主握手（对齐官方样例 hana-dsh 的 bootstrap：页面挂载即 hana.ready()）。它也是 envelope
  // 首帧的触发条件——不 ready，宿主不会推信号，这一页就只能走聊天流兜底。
  try { if (hana && typeof (hana as any).ready === "function") (hana as any).ready(); } catch { /* 宿主未提供则忽略 */ }
  // 首帧主题由页面内联脚本贴（早于第一次绘制）；这里接上订阅，此后事件驱动。
  followHostTheme(hana);
  // 认到 sid 就记进卡实例态（两个挂载态都记）：同一张卡换挂载时 route 之外还有落点。
  rememberCardSession(routeSessionId());

  let decided = false;
  const decide = (mode: "chat" | "canvas"): void => {
    if (decided) return;
    decided = true;
    if (mode === "chat") { showEntry(); return; }
    mountStage();
  };

  const mode = classifyMount();
  if (mode !== null) { decide(mode); return; }

  // envelope 还没到。hana.envelope.subscribe() 注册时会立刻用当前快照叫一次回调（可能仍是
  // null），所以这里必须自己判空、不能一叫就定——否则等于没等，通道一旦是 null 就落进兜底。
  const timer = setTimeout(() => {
    // 始终没等到信号（旧宿主不发这道事件）：按聊天流收尾。整幅 DSH 现场（拉中继、打后端、
    // 注入一整个前端）灌进聊天转录是更重也更意外的结果，入口行至少是无副作用的安全面。
    decide("chat");
  }, MOUNT_WAIT_MS);
  try {
    if (hana && (hana as any).envelope && typeof (hana as any).envelope.subscribe === "function") {
      const off = (hana as any).envelope.subscribe(() => {
        const next = classifyMount();
        if (next === null) return; // 还没信号，继续等
        try { if (typeof off === "function") off(); } catch { /* 忽略 */ }
        clearTimeout(timer);
        decide(next);
      });
    }
  } catch { /* SDK 未提供则只走兜底 */ }
}

// 认态本身出错（不该发生）也要把入口行露出来：宁可少画，不能空着。
try { boot(); } catch (error) { showLoadFailure(error); }
