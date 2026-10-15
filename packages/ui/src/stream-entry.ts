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
import { apiFetch, fetchCardCoords, declaredFaceView, readCardState, rememberCardSession } from "./surface-bridge.ts";
import { followHostTheme } from "./host-theme.ts";
import { FACE_ATTR } from "@dshana/shared/face-theme.ts";
import { publishForceFollow, watchForceFollowChanges } from "./force-follow.ts";

// 等 envelope 首帧的封顶时间。宿主在 iframe ready 之后立刻推第一帧，通常远快于此；这一条只为
// 从不发信号的旧宿主兜底。
const MOUNT_WAIT_MS = 2000;
const ENTRY_ID = "dsh-entry";

/**
 * 动作 → 卡内第一行的状态字样。
 *
 * 文案住在这里（不是投递载荷里的字段），所以改文案对已经发出的卡也生效：卡页每次都从安装树现取。
 * 载荷只带动作词（open / reply），词到文案的映射是卡页的事。
 */
const ACT_TEXT: Record<string, string> = { open: "新会话", reply: "续会话", create: "新会话", send: "续会话" };

/** 入口行是不是已经用来说失败原因了（置位后坐标反查不再改写它，失败原因必须留下）。 */
let entryFailed = false;

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

// 入口行的高度由内容定（一行抬头 + 三行单行文本，宽度变窄也不会换行）：量一次报给宿主。
//
// 量的是入口行自己的边框盒——stream.html 里它不铺满 iframe（不写 height:100%），所以量到的是
// 内容高度；若它铺满，量到的会是宿主给的容器高度（视口高），报回去等于把错误高度又确认一遍。
//
// 这条路是这张卡高度的唯一来源：`contributes.messageRenderers` 那条路的映射不带 aspectRatio，
// 卡也没有声明位。宿主收到后在客户端把值夹进 `[100, innerHeight - 48]`（非 card 槽位分支，
// 常量见 ChatTranscript 的 A9/mT），所以内容高（本页约 100）落在地板附近——这就是卡的高度下限。
const ENTRY_MIN_HEIGHT_PX = 96;

/** 上一次报上去的高度：同值不重报——宿主改框会带动本页重排，无条件重报会来回弹成回环。 */
let reportedHeight = 0;

/** 把入口行的真实高度报给宿主（运行时高度报告；旧宿主没这道门就按宿主缺省走）。 */
function reportEntryHeight(): void {
  const el = document.getElementById(ENTRY_ID);
  const ui = hana && (hana as any).ui;
  if (!el || !ui || typeof ui.resize !== "function") return;
  // 1px 容差：亚像素级的来回报不出真变化，却足以把宿主拖进改框循环。
  const height = Math.max(Math.ceil(el.getBoundingClientRect().height), ENTRY_MIN_HEIGHT_PX);
  if (Math.abs(height - reportedHeight) <= 1) return;
  reportedHeight = height;
  try {
    ui.resize({ height });
  } catch { /* 宿主拒绝就按宿主缺省走 */ }
}

/**
 * 跟着入口行的内容变高变矮。
 *
 * 谁会让它变：坐标反查回来改写坐标行、跟踪态片段落进来（两者都在首次上报之后）。
 * 为什么不会回环：观察的是入口行自己，而它的高度由内容定（不铺满 iframe）——宿主改框只改
 * 本页 iframe，不会改这一行的高度，所以改框不触发重报，重报只由内容真的变了触发。
 */
let entrySizeObserver: ResizeObserver | null = null;
function watchEntryHeight(): void {
  const el = document.getElementById(ENTRY_ID);
  if (!el || typeof ResizeObserver !== "function" || entrySizeObserver) return;
  try {
    entrySizeObserver = new ResizeObserver(() => reportEntryHeight());
    entrySizeObserver.observe(el);
  } catch { entrySizeObserver = null; /* 旧宿主没这 API：靠各内容改写点自己调 reportEntryHeight */ }
}

/** 卡状态行右侧的跟踪态：非终态（tracked / cancelling）期间慢轮询，终态即停手。 */
const CARD_POLL_MS = 4000;
function mountEntryStatus(sessionId: string): void {
  const sid = sessionId;
  const slot = document.querySelector("[data-dsh-entry-status]");
  if (!sid || !slot) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const loop = (): void => {
    // 状态面走原生同源 fetch（与坐标反查同一条路由面）：这里只需要一次 GET + 一段 HTML。
    void cardStateFetch(sid).then((html) => {
      if (html === null) { stop(); slot.textContent = ""; return; }
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

/** 取一次卡状态行片段；拿不到（无凭据 / HTTP 失败）回 null。 */
function cardStateFetch(sessionId: string): Promise<string | null> {
  return apiFetch("dshana/card-state?sessionId=" + encodeURIComponent(sessionId), {
    method: "GET", cache: "no-store", headers: { Accept: "text/html" },
  }).then((res) => {
    if (!res.ok) throw new Error("card-state HTTP " + res.status);
    return res.text();
  }).then((html) => (html && html.trim() ? html : null));
}

/** 写一格坐标值；空值把整行收起来（不留下悬空的标签）。 */
function setEntryRow(selector: string, value: string): void {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  el.textContent = value;
  const row = el.closest(".entry-row") as HTMLElement | null;
  if (row) row.style.display = value ? "" : "none";
}

/**
 * 聊天流态：露出入口行，并把它自己的坐标填上。
 *
 * 坐标来自 App 后端按 cardInstanceId 的反查（见 surface-bridge.ts 的 fetchCardCoords）——坐标住在
 * 宿主任务记录的 metadata.dsh 里，卡读不到那份记录，只能这样报自己的身份让后端去认领。
 *
 * **认不到时如实标注未钉住**（不空着，也不假装钉住了）：卡 id 由 App 按 taskId 派生，反查要在
 * 任务记录里找到那次提交；记录已被宿主回收、或这张卡出自更早一版投递时都认不到，所以这条回落路
 * 是设计的一部分，不是异常。
 */
function showEntry(): void {
  document.body.setAttribute("data-stream-view", "entry");
  reportEntryHeight();
  watchEntryHeight();
  fetchCardCoords().then((coords) => {
    // 装载失败已经把原因写在入口行上了（见 showLoadFailure）：坐标反查晚于它回来时不许把它盖掉，
    // 那一行此刻是这一页唯一的失败可见面。
    if (entryFailed) return;
    if (coords) {
      setEntryRow("[data-dsh-entry-state]", ACT_TEXT[coords.action] || "DSHana 会话");
      setEntryRow("[data-dsh-entry-sid]", coords.sessionId);
      setEntryRow("[data-dsh-entry-cwd]", coords.cwd);
      setEntryRow("[data-dsh-entry-tid]", coords.taskId);
      mountEntryStatus(coords.sessionId);
      void rememberCardSession(coords.sessionId);
      return;
    }
    // 未钉住：说清这张卡没有坐标，并标明它跟随的是「当前选中」那一档。
    setEntryRow("[data-dsh-entry-state]", "DSHana 会话（未钉住）");
    setEntryRow("[data-dsh-entry-sid]", "");
    setEntryRow("[data-dsh-entry-cwd]", "");
    setEntryRow("[data-dsh-entry-tid]", "");
    const hint = document.querySelector("[data-dsh-entry-hint]") as HTMLElement | null;
    if (hint) hint.textContent = "未取到本卡坐标，跟随当前选中的会话";
    // 兜底：卡实例态里记过的那段会话（换挂载后后端暂时答不上来时先不空着）。
    readCardState("sid").then((sid) => {
      if (!entryFailed && sid) setEntryRow("[data-dsh-entry-sid]", sid + "（未钉住，按上次记录显示）");
    }, () => { /* 忽略 */ });
  });
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
  entryFailed = true;
  document.body.setAttribute("data-stream-view", "entry");
  setEntryRow("[data-dsh-entry-state]", "DSH 现场装载失败");
  setEntryRow("[data-dsh-entry-sid]", msg);
  setEntryRow("[data-dsh-entry-cwd]", "");
  setEntryRow("[data-dsh-entry-tid]", "");
  reportEntryHeight();
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

/** 把本页的面写在 <html> 上（面的单一事实源仍是页面的静态声明；写前比现值，同值不重写）。 */
function publishFace(): void {
  const view = declaredFaceView();
  if (!view) return; // 认不出面就不写：桥读回 null 会按非强制面走，与静态声明缺失时的行为一致
  try {
    const root = document.documentElement;
    if (root.getAttribute(FACE_ATTR) !== view) root.setAttribute(FACE_ATTR, view);
  } catch { /* 忽略 */ }
}

/** 认到挂载态后分派：聊天流 = 保持入口行；黑板 / 拆窗 = 装载重型半。 */
function boot(): void {
  // 脚本已经接管本页：stream.html 的兜底计时器看这个标记（它找不到就不代我们露出入口行）。
  document.documentElement.setAttribute("data-dshana-stream", "claimed");
  // 宿主握手（对齐官方样例 hana-dsh 的 bootstrap：页面挂载即 hana.ready()）。它也是 envelope
  // 首帧的触发条件——不 ready，宿主不会推信号，这一页就只能走聊天流兜底。
  try { if (hana && typeof (hana as any).ready === "function") (hana as any).ready(); } catch { /* 宿主未提供则忽略 */ }
  // 首帧主题由页面 <head> 的内联片段贴（早于第一次绘制，与壳页同一片段）；这里接的是此后
  // 那一段：首屏快照 + 订阅，内联片段已贴过的 URL 会跳过重复 fetch。
  followHostTheme(hana);
  // 本页的面写在 <html> 上（面的单一事实源是页面静态声明，这里只是把它投影出去）：主题桥在
  // DSH 文档里读它判「这一面是不是强制面」，它读不到外层的 <meta>。**两个挂载态都写**——
  // 「本页是 stream 面」与「装不装 DSH」是两件事，聊天流态的卡也是这一面。
  publishFace();
  // 「哪些面强制跟随宿主主题」那张表也搬上 <html>（拉不到就不写，桥按缺省兜底）：
  // 聊天流态的卡不装 DSH、桥不在，但取出到黑板时会装；设置变化也得听得见。
  void publishForceFollow();
  watchForceFollowChanges();
  // 坐标记忆不在这里做：它是后端反查回来之后才有的值（见 showEntry），两个挂载态都走同一条路。

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
