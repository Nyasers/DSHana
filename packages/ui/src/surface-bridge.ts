// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/surface-bridge.ts — App surface 的低层宿主管道（凭据 / 取数 / 跨面广播 / 卡实例态 / 剪贴板）
//
// 这一层是「谁在跑」与「页面长什么样」之间的接口：会话卡（stream 面）与壳页（main / default /
// sidebar）都要它，但它是**纯宿主 plumbing**——不碰 DOM 渲染、不引 dsh-inject / React，所以
// 会话卡的聊天流态可以只带这一层（外加 SDK 的 envelope 订阅），把重型那一半留在动态 chunk 里。
//
// 相对资源纪律与凭据形态的来龙去脉见 packages/ui/src/app-shell.ts 顶部注释；这里只保留实现。
import { hana } from "@hana/plugin-sdk";
import { type IntentKind, type IntentPayload, faceTakesIntent } from "@dshana/shared/shared-state.ts";
import { CHANNEL_SCOPE_FALLBACK, normalizeScope, type FaceAddress } from "@dshana/shared/face-addresses.ts";
import { isFaceView, roleForView, type FaceView } from "./face-role.ts";
import { createIntentLandings, type IntentLandingMeta } from "./intent-landing.ts";

// ---- 到 App 后端路由的取数面 ----
// 本页的凭据是 surface 会话票，只从 location 读——查询串（宿主给 App surface iframe 附
// appSurfaceSession）或路径票据（/_surface/<票>/ 段）。不经过 SDK 的 hana.api.fetch：它只读
// 查询串，而凭据形态不止那一种。宿主对 /api/apps/<id>/... 的凭据解析认显式头，所以这里自己
// 拼路由、直接带上票头。
export function appIdFromPath(): string | null {
  try {
    const m = /^\/api\/apps\/([^\/]+)\//.exec(location.pathname || "");
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// 宿主 0.946.2 runtime 代理（bundle ffe/kLt/ELt）认四条：Authorization/query token、
// 头 X-Hana-App-Surface-Session、cookie hana_app_runtime（HttpOnly，Path 锁在
// /api/apps/<id>/routes/_runtime/<rid>/）、以及「路径票据」
//   /api/apps/<id>/routes/_runtime/<rid>/_surface/<appSurfaceSession>/<rest>
// iframe 只认后两条：路径票据让「文档请求自身」就带凭据（不赌 cookie 时序/作用域），
// cookie 兜住 iframe 内丢掉前缀的绝对路径子请求。
export function surfaceSession(): string | null {
  try {
    const q = new URLSearchParams(location.search).get("appSurfaceSession");
    if (q) return q;
    // 宿主 FP / 主卡的 iframe 用的是**路径票据**形态（functionPanel.routeUrl 经
    // /api/apps/iframe-ticket 换回 uiBasePath，票据在路径里），不会带我们的查询参数；
    // 只认查询参数会把这类页面判成「缺少凭据」。这里也认路径形态。
    const m = /\/_surface\/([^\/]+)\//.exec(location.pathname || "");
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const appId = appIdFromPath();
  const ss = surfaceSession();
  if (!appId || !ss) return Promise.reject(new Error("缺少 App surface 会话凭据（appSurfaceSession）"));
  const headers = new Headers((init && init.headers) || {});
  headers.set("X-Hana-App-Surface-Session", ss);
  const opts: RequestInit = { ...(init || {}), credentials: "same-origin", headers };
  return fetch("/api/apps/" + encodeURIComponent(appId) + "/routes/" + path, opts);
}

export function fetchBootState(): Promise<any> {
  return apiFetch("dshana/boot-state", {
    method: "GET", cache: "no-store", headers: { Accept: "application/json" },
  }).then((res) => {
    if (!res.ok) throw new Error("boot-state HTTP " + res.status);
    return res.json();
  }).then((d) => (d && d.state) || null)
    .catch((err) => {
      const msg = err && err.message ? err.message : String(err);
      if (/appSurfaceSession/.test(msg)) throw new Error(SURFACE_MISSING);
      throw err;
    });
}

export function postAction(action: string): Promise<any> {
  return apiFetch("dshana/" + action, { method: "POST", cache: "no-store" })
    .then((res) => res.json().catch(() => ({})));
}

// 代理前缀 → 带路径票据的前缀（已带则不重复插）
export function withSurfaceTicket(prefix: string, ss: string | null): string {
  if (!ss) return prefix;
  const m = /^(\/api\/apps\/[^/]+\/routes\/_runtime\/[^/]+)\/?(.*)$/.exec(prefix);
  if (!m) return prefix;
  if (/^_surface\//.test(m[2])) return prefix;
  return m[1] + "/_surface/" + encodeURIComponent(ss) + "/" + m[2];
}

// 同源预请求一次代理前缀：带上 header，宿主会在响应里种下 hana_app_runtime cookie
// （bundle 109816：`req.query(appSurfaceSession) || req.header(X-Hana-App-Surface-Session)`
// → Set-Cookie Path=代理前缀；HttpOnly，JS 读不到，只当保险丝用）。
export function warmRuntimeCookie(prefix: string): Promise<boolean> {
  const ss = surfaceSession();
  if (!ss) return Promise.resolve(false);
  return fetch(prefix, {
    headers: { "X-Hana-App-Surface-Session": ss },
    cache: "no-store",
    credentials: "same-origin",
  })
    .then((r) => r.text().catch(() => "").then(() => r.ok))
    .catch(() => false);
}

// 本页没拿到 surface 会话时的说明（appSurfaceSession 由宿主开页时附在 surface URL 上）
export const SURFACE_MISSING =
  "状态读取失败：本页缺少 App surface 会话凭据，请从 Card Center 重新打开本卡";
export function credMissingHtml(): string {
  return '<pre class="diag-progress">缺少 App surface 会话凭据：本页 URL 上没有 appSurfaceSession，\n'
    + "DSH 运行时经宿主代理会被直接拒（missing_credential），状态面与内嵌视图都拿不到。\n"
    + "请从 Card Center 重新打开本卡。</pre>";
}

// ---- 跨面共享状态：已退场 ----
// 本层不再落盘任何值。会话选中的真值是 main view 自己的持久化（见 readSelection），跨面通知走
// BroadcastChannel 与 storage 事件。这里只留一个空的下线钩子，给仍在调用它的面留位。
/** 下线钩子：共享键已不存在，无需清理。 */
export function dropShared(): Promise<unknown> {
  return Promise.resolve();
}

// ---- 跨面转发：同源广播一条通道 ----
// 局部面（FP）发射意图、整幅面落地。跨文档能过的只有意图本身——插件实例与注入的 hook 留在发射端，
// 接收端拿自己的插件实例把那条面重建出来。词表与载荷归一住在 @dshana/shared/shared-state.ts
// （纯逻辑，单测直接打）。本层只做运输：同卡的面 join 同一个 BroadcastChannel（频道名按卡片实例
// 分），谁发谁收都到。指名的直投通道与共享存储都已退场，这里不再有第二台通道。

/** 本页静态声明的面（<meta name="hana-dshana-role"> 或 body[data-dshana-view]）；认不出返回 null。 */
export function declaredFaceView(): FaceView | null {
  try {
    const meta = document.querySelector('meta[name="hana-dshana-role"]');
    const declared = meta && meta.getAttribute("content");
    if (isFaceView(declared)) return declared;
    const attr = document.body && document.body.getAttribute("data-dshana-view");
    if (isFaceView(attr)) return attr;
  } catch { /* 无 DOM：当没声明 */ }
  return null;
}

/** 本页的面（静态声明为准）；认不出按整幅面（不擅自少一列）。 */
function declaredRole(): FaceAddress {
  const view = declaredFaceView();
  return view ? (roleForView(view) as FaceAddress) : "standalone";
}

/** 宿主给的卡片实例 id；读不到（绑定握手未完成 / 本页无 context）返回 null。 */
function readHostCard(): string | null {
  try {
    const sdk = hana as { surface?: { getContext?: () => { cardInstanceId?: unknown } | null } };
    const ctx = sdk && sdk.surface && typeof sdk.surface.getContext === "function" ? sdk.surface.getContext() : null;
    const card = normalizeScope(ctx && ctx.cardInstanceId);
    return card === CHANNEL_SCOPE_FALLBACK ? null : card;
  } catch {
    return null;
  }
}

/** 身份重读的间隔与上限：绑定握手正常在几个 tick 内完成，最多等这么多轮就停。 */
const SCOPE_RETRY_MS = 400;
const SCOPE_RETRY_LIMIT = 15;

let scopeCache: string | null = null;let scopeRetry: ReturnType<typeof setTimeout> | null = null;
let scopeTries = 0;

// 可见性监听器随通道一起拆除：没有挂起的东西可隐了。

/** 本页所属的通道作用域（按主卡分段）。
 *
 * 视图身份的绑定握手是异步的：同一张主卡的固定 FP 与悬停展开 FP 是两个 iframe，后者可能在
 * 同步读时还没拿到 cardInstanceId。这时先用共用段上通道（与主卡同段，先能用），并留一个重读：
 * 身份到位就换成卡片段，旧通道的房间是错的，丢掉重建。
 */
function cardScope(): string {
  const host = readHostCard();
  if (host !== null) {
    scopeCache = host;
    return host;
  }
  refreshScopeLater();
  return scopeCache ?? CHANNEL_SCOPE_FALLBACK;
}

/** 身份还没到位时留一个重读（有限次，避免身份永不就绪的页一直重试）；
 * 取到且与当前作用域不同就重建通道。 */
function refreshScopeLater(): void {
  if (scopeRetry !== null) return;
  scopeRetry = setTimeout(() => {
    scopeRetry = null;
    const host = readHostCard();
    if (host === null) {
      if (scopeTries >= SCOPE_RETRY_LIMIT) return;
      scopeTries += 1;
      if (scopeTries === SCOPE_RETRY_LIMIT) {
        console.warn("[dshana/faces] [BroadcastChannel] 视图身份迟迟未就绪，频道留在共用作用域上。");
      }
      refreshScopeLater();
      return;
    }
    const previous = scopeCache;
    scopeTries = 0;
    scopeCache = host;
    // 作用域没变且总线已在：什么都不动，别把已有的监听器拆了。
    if (previous === host && linkBus !== null) return;
    // 作用域换了（或还停在占位段上）：频道名跟着换，丢掉旧总线，按新卡片名重建。
    try { linkBus?.close(); } catch { /* 忽略 */ }
    linkBus = null;
    linkWired = false;
    // 只收不发的面没有发布路径来重建总线，这里替它接上。
    if (landings.kinds().length > 0) wireLink();
  }, SCOPE_RETRY_MS);
}

// ---- 同页直连（同源广播，按卡片分频道）----
// FP 与 main 不一定互为父子（真机上 FP 的父文档不是 main 那一份，“父页可直达”只说明不是顶层），
// 所以不走 parent/child：同卡的面 join 同一个广播频道，谁发谁收都到，不用先认出对端。
// BroadcastChannel 本身同源限制，卡片 id 就是频道名，跨卡自然隔离。
let linkWired = false;
let linkBus: BroadcastChannel | null = null;

function linkBusFor(): BroadcastChannel | null {
  if (linkBus) return linkBus;
  if (typeof BroadcastChannel !== "function") return null;
  // 身份未就绪（cardScope 退成占位符）时不加入：公共频道会把不同卡的面凑到一起。
  // 身份到位后下一次取通道会重新走到这里，那时再建。
  if (cardScope() === CHANNEL_SCOPE_FALLBACK) return null;
  try { linkBus = new BroadcastChannel("dshana.faces." + cardScope()); } catch { return null; }
  linkBus.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { kind?: unknown; payload?: unknown; at?: unknown; from?: unknown } | null;
    if (!data || typeof data !== "object" || typeof data.kind !== "string") return;
    landings.dispatch(data.kind, data.payload, {
      kind: data.kind as IntentKind,
      at: typeof data.at === "number" ? data.at : 0,
      from: typeof data.from === "string" ? (data.from as FaceAddress) : undefined,
    } as IntentLandingMeta);
  });
  return linkBus;
}

function wireLink(): void {
  if (linkWired) return;
  linkWired = true;
  const bus = linkBusFor();
  console.info("[dshana/faces] [BroadcastChannel]", { as: declaredRole(), card: cardScope() });
  if (bus === null) console.warn("[dshana/faces] [BroadcastChannel] 不可用：本页不发也不收跨面帧。");
}

// ---- 通用落地面 ----
// 落地端不再自己写 applier 循环（读 → 判 at → 判 pending → 落地 → 清空），只登记一件回调；
// 帧到了由这里按“本面是否参与这条 kind”派发。参与面来自意图描述符表（INTENT_SPECS.faces）；
// 未声明的 kind 一律当真。纯逻辑在 intent-landing.ts，本层只接广播与角色。
const landings = createIntentLandings({
  takes: (kind) => faceTakesIntent(kind, declaredRole()),
  onError: (message, error) => console.warn("[dshana/faces] " + message, error),
});

/**
 * 登记一件跨面意图的落地回调（返回退订）。
 *
 * 帧只从同页广播来（BroadcastChannel）：登记即生效，没有别的传输可退。
 */
export function registerIntentLanding<K extends IntentKind>(
  kind: K,
  handler: (payload: IntentPayload<K>, meta: IntentLandingMeta) => void,
): () => void {
  // 登记时就把广播总线建起来（收方不一定会发，不建就等于没在听）。
  wireLink();
  return landings.register(kind, handler as (payload: unknown, meta: IntentLandingMeta) => void);
}

/** 把一条意图发给同卡的其他面（同源广播）；返回 1 表示已投出。 */
function linkBroadcast(kind: string, payload: unknown): number {
  const bus = linkBusFor();
  if (bus === null) return 0;
  try {
    bus.postMessage({ kind, payload, at: Date.now(), from: declaredRole() });
    return 1;
  } catch { return 0; }
}

/** 读一条 kind 的当前值：读权威记录（不再经面间通道）。 */
export function readIntentState<K extends IntentKind>(
  kind: K,
): Promise<{ value: IntentPayload<K>; at: number } | null> {
  // 值不存档：同页由广播送，跨页各管各的。这里一律回“没有当前值”。
  void kind;
  return Promise.resolve(null);
}

/** 发一条意图（同页直连 + 写权威记录）；delivered 是同页真正送到的对数。 */
export function publishIntent<K extends IntentKind>(
  kind: K,
  payload: IntentPayload<K>,
): Promise<{ delivered: number }> {
  // 不过存储层：同页两方各在话筒上，值随广播走。记录一写就成了第三个副本，还要防回声。
  return Promise.resolve({ delivered: linkBroadcast(kind, payload) });
}

// ---- 会话选中的真值 ----
// 真值是 main view 自己的持久化：ui-workspace 把目标身份写在 localStorage 的
// `dsh.sessions.current`（`{ sessionId }`，清空时写 `{}`）。两个面同源，这个键本来就是两个
// 文档之间共享的当前值，不必另开一份存储。
const DSH_SELECTION_KEY = "dsh.sessions.current";

/** 读当前选中。读的是**当前值**而不是某一次宣告，所以接收端晚于发射端启动也不会错过。
 * 值本身没有时间戳，而 ui-session 的判据 `at <= localAt` 要一个正数时刻，就用读到的当下时刻：
 * 「这是眼下的真值」正是要表达的意思。没有这个键、值里没有 sessionId、或读不动时回「没有主张」
 * （at = 0，不参与新旧比较）。 */
export function readSelection(): Promise<{ sessionId: string | null; at: number }> {
  let raw: string | null = null;
  try { raw = localStorage.getItem(DSH_SELECTION_KEY); } catch { return Promise.resolve({ sessionId: null, at: 0 }); }
  if (raw === null) return Promise.resolve({ sessionId: null, at: 0 });
  try {
    const parsed = JSON.parse(raw) as { sessionId?: unknown };
    const sid = typeof parsed?.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
    return Promise.resolve({ sessionId: sid, at: Date.now() });
  } catch {
    return Promise.resolve({ sessionId: null, at: 0 });
  }
}
export function writeSelection(sessionId: string | null): Promise<{ delivered: number }> {
  return publishIntent("selection", { sessionId: sessionId ?? null });
}
/** 会话选中变化：两条来源都接。
 *  · 同页广播（别的面调 writeSelection 时投出）：快，但发那一刻不在场的面收不到；
 *  · `storage` 事件（main view 自己写 localStorage 的键）：浏览器原生跨文档通知，接住 DSH 自己
 *    发起的选中变化（侧栏点新建会话就属于这一路），也覆盖「接收端晚于发射端启动」那一段。
 * 两条都只是**触发**，值一律回读 readSelection，所以重复通知不会产生分歧。 */
export function onSelectionChanged(listener: (sessionId: string | null, at: number) => void): () => void {
  const off = registerIntentLanding("selection", (payload, meta) => {
    const value = payload as { sessionId?: unknown } | null;
    const at = meta && typeof meta.at === "number" ? meta.at : 0;
    listener(value && typeof value.sessionId === "string" ? value.sessionId : null, at);
  });
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== DSH_SELECTION_KEY) return;
    void readSelection().then(
      (next) => listener(next.sessionId, next.at),
      () => { /* 读失败保持本地 */ },
    );
  };
  try { window.addEventListener("storage", onStorage); } catch { /* 无 window：只留广播 */ }
  return () => {
    off();
    try { window.removeEventListener("storage", onStorage); } catch { /* 忽略 */ }
  };
}

// 主面板选中已搬到直投通道：FP 侧用 publishIntent('panel-view', …) 指名投递、主卡侧用
// registerIntentLanding('panel-view', …) 落地（见 integrations/ui-sidebar 与 ui-layout）。
// 旧的三件名（readPanelView / writePanelView / onPanelViewChanged）随迁移删除——两条路
// 同时活着就是双投递。

// ---- 会话卡的会话坐标（只认这张卡自己的状态，不读应用态全局）----
// 两个来源，都在卡自身：
//   · route 的 ?sid=（宿主出卡时写进卡面的坐标，工具出卡 / 取出时都跟着过去）；
//   · 卡实例态 hana.state 的 sid（同一张卡在聊天流 / 黑板 / 拆窗之间换挂载时的落点）。
// **不读也不写应用态全局（dshana.selection）**：那是主卡与 FP 的「当前选中」，
// 会话卡属于它钉住的那一段会话，不因别处的选中变化就改绑自己。
export function routeSessionId(): string {
  try {
    const sid = new URLSearchParams(location.search).get("sid");
    return sid && sid.trim() ? sid.trim() : "";
  } catch {
    return "";
  }
}

/** 本卡钉住的会话坐标（route 的 ?sid= / ?tid=）；两者都没有返回 null。 */
export function cardTicket(): { sessionId: string; taskId: string } | null {
  try {
    const q = new URLSearchParams(location.search);
    const sessionId = String(q.get("sid") || "").trim();
    const taskId = String(q.get("tid") || "").trim();
    return sessionId || taskId ? { sessionId, taskId } : null;
  } catch {
    return null;
  }
}

function cardStateApi(): any {
  try {
    return hana && (hana as any).state && typeof (hana as any).state.get === "function" ? (hana as any).state : null;
  } catch {
    return null;
  }
}

export function readCardState(key: string): Promise<string | null> {
  const st = cardStateApi();
  if (!st) return Promise.resolve(null);
  try {
    return Promise.resolve(st.get(key)).then((r: any) => (
      r && typeof r.value === "string" && r.value ? r.value : null
    ), () => null);
  } catch {
    return Promise.resolve(null);
  }
}

export function writeCardState(key: string, value: unknown): Promise<any> {
  const st = cardStateApi();
  if (!st || typeof st.set !== "function") return Promise.resolve();
  try { return Promise.resolve(st.set(key, value)).catch(() => { /* 忽略 */ }); } catch { return Promise.resolve(); }
}

// 本卡钉住的会话：route 优先（工具出卡写进卡面的坐标），没有就取卡实例态。
export function readPinnedSession(): Promise<string | null> {
  const sid = routeSessionId();
  if (sid) return Promise.resolve(sid);
  return readCardState("sid");
}

// 认到就记进卡实例态：同一张卡换挂载（聊天流 / 黑板 / 拆窗）时 route 之外还有一个落点。
export function rememberCardSession(sid: string): Promise<any> {
  if (sid) return writeCardState("sid", sid);
  return Promise.resolve();
}

// ---- 剪贴板 ----
// 宿主 SDK 的 written:false 与异常都 reject 并打印原因，让失败可见（不假装成功）。
export function clipboardWrite(text: string): Promise<boolean> {
  if (!hana || !hana.clipboard || typeof hana.clipboard.writeText !== "function") {
    console.warn("[dshana/clipboard] 宿主 SDK 无 hana.clipboard.writeText（能力 app/ui.clipboard-write 未授予？）");
    return Promise.reject(new Error("host clipboard API unavailable"));
  }
  return Promise.resolve(hana.clipboard.writeText(text)).then(
    (payload: any) => {
      if (payload && payload.written === false) {
        console.warn("[dshana/clipboard] 宿主返回 written:false（复制未发生）：", payload);
        throw new Error("host clipboard write refused");
      }
      return true;
    },
    (error: any) => {
      console.warn("[dshana/clipboard] 宿主能力调用失败：", (error && error.message) || error);
      throw error instanceof Error ? error : new Error(String(error));
    },
  );
}

// ---- 挂到宿主桥（__DSHANA__）上的跨面接口 ----
//   通用面 → 任意词表内 kind（publishIntent / readIntentState / registerIntentLanding）；
//   具名面保留按名的包装，内部坐上面三件：
//     会话选中 → integrations/ui-session；主面板选中 → ui-sidebar（FP 发射）与 ui-layout（主卡落地）；
//   会话坐标 → ui-session 的只读面（readPinnedSession）；
//   剪贴板 → 壳页的 clipboardWrite（宿主能力 clipboard.writeText；DSH 侧那个 client 半已下线）。
export const SURFACE_API = {
  // 通用面（七个 kind 都走这三件：指名投递 / 读当前值 / 登记落地）
  publishIntent,
  readIntentState,
  registerIntentLanding,
  // 具名面（消费方按名调，内部坐上面三件）
  readSelection,
  writeSelection,
  onSelectionChanged,
  readPinnedSession,
  clipboardWrite,
};
