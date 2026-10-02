// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/surface-bridge.ts — App surface 的低层宿主管道（凭据 / 取数 / 跨面共享 / 卡实例态 / 剪贴板）
//
// 这一层是「谁在跑」与「页面长什么样」之间的接口：会话卡（stream 面）与壳页（main / default /
// sidebar）都要它，但它是**纯宿主 plumbing**——不碰 DOM 渲染、不引 dsh-inject / React，所以
// 会话卡的聊天流态可以只带这一层（外加 SDK 的 envelope 订阅），把重型那一半留在动态 chunk 里。
//
// 相对资源纪律与凭据形态的来龙去脉见 packages/ui/src/app-shell.ts 顶部注释；这里只保留实现。
import { hana } from "@hana/plugin-sdk";
import {
  SHARED_KEY_PREFIX, INTENT_KINDS, intentSharedValue, isIntentKind, normalizeIntent,
  type IntentKind, type IntentPayload,
} from "@dshana/shared/shared-state.ts";

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

// ---- 跨面共享状态（通道语义见 @dshana/shared/shared-state.ts）----
// 作用域：本 App 单 DSH 源、单主卡，宿主给主卡与其 FP 同一个 cardInstanceId，按实例分段没有
// 区分度，键就是 `dshana.<kind>`（前缀与 lib/shared-state.ts 同源）。这批键的寿命是一次 App
// 生命周期：加载时由 renewSharedState 清空，页面下线时由 dropShared 删。
export function sharedKey(kind: string): string {
  return SHARED_KEY_PREFIX + kind;
}

// 本页可能写过的共享键：boot 快照 + 全部意图 kind（同名即同一个键）。
const SHARED_KINDS = ["boot-state", ...INTENT_KINDS];

/** 删掉本页写过的共享键（下线时调用；过期留着没有消费方）。 */
export function dropShared(): Promise<unknown> {
  const st = sharedStore();
  if (!st || typeof st.delete !== "function") return Promise.resolve();
  return Promise.all(SHARED_KINDS.map((kind) => {
    try { return Promise.resolve(st.delete(sharedKey(kind))); } catch { return Promise.resolve(); }
  }));
}

// storage.global 在 SDK 里即可调用对象、也可能是工厂（两边兼容地取）。
function sharedStore(): any {
  try {
    const g: any = hana && hana.storage ? hana.storage.global : null;
    if (typeof g === "function") { const s = g(); if (s && typeof s.get === "function") return s; }
    if (g && typeof g.get === "function") return g;
  } catch { /* 忽略 */ }
  return null;
}

export function readShared(kind: string): Promise<any> {
  const st = sharedStore();
  if (!st) return Promise.resolve(null);
  return Promise.resolve(st.get(sharedKey(kind))).then((entry: any) => {
    const v = entry && typeof entry === "object" ? entry.value : null;
    return v && typeof v === "object" ? v : null;
  }, () => null);
}

export function writeShared(kind: string, value: unknown): Promise<any> {
  const st = sharedStore();
  if (!st) return Promise.reject(new Error("hana.storage.global 不可用"));
  return Promise.resolve(st.set(sharedKey(kind), value));
}

export function onSharedChanged(kind: string, listener: () => void): () => void {
  const st = sharedStore();
  if (!st || typeof st.onChanged !== "function") return () => { /* 无通知面则只靠读时刷新 */ };
  const key = sharedKey(kind);
  const off = st.onChanged((keys: unknown) => {
    if (Array.isArray(keys) && keys.indexOf(key) >= 0) { try { listener(); } catch { /* 忽略 */ } }
  });
  return typeof off === "function" ? off : () => { /* 无取消句柄 */ };
}

// ---- 跨面转发：一台通道 ----
// 局部面（FP）发射意图，整幅面落地。跨文档能过的只有意图本身——插件实例与注入的 hook 留在发射端，
// 接收端拿自己的插件实例把那条面重建出来。词表与载荷归一住在 @dshana/shared/shared-state.ts
// （纯逻辑，单测直接打）；本层只做运输，并把词表外的 kind 挡在门外。
// 既有三件（设置视图 / 会话选中 / 主面板选中）就是这条通道上的三个 kind，下面保留同名包装，
// 消费方按原样调用；新增的跨面面走 readIntent / writeIntent / onIntentChanged。

/** 一条意图的读结果：归一后的载荷 + 通道盖的写入时刻。 */
export interface ForwardedIntent<K extends IntentKind> {
  value: IntentPayload<K>;
  at: number;
}

/** 读一条意图（词表外当场拒；载荷先归一，读到的永远是干净形状）。 */
export function readIntent<K extends IntentKind>(kind: K): Promise<ForwardedIntent<K>> {
  if (!isIntentKind(kind)) return Promise.reject(new Error("未知跨面意图：" + String(kind)));
  return readShared(kind).then((raw) => {
    const envelope = raw && typeof raw === "object" ? (raw as { value?: unknown; at?: unknown }) : {};
    return {
      value: normalizeIntent(kind, envelope.value),
      at: typeof envelope.at === "number" ? envelope.at : 0,
    };
  });
}

/** 写一条意图（落盘前先归一，at 由通道盖章）。 */
export function writeIntent<K extends IntentKind>(kind: K, value: IntentPayload<K>): Promise<unknown> {
  if (!isIntentKind(kind)) return Promise.reject(new Error("未知跨面意图：" + String(kind)));
  return writeShared(kind, intentSharedValue(normalizeIntent(kind, value)));
}

/** 订阅一条意图的变化（词表外不订阅，静默给一个空 disposer）。 */
export function onIntentChanged(kind: IntentKind, listener: () => void): () => void {
  if (!isIntentKind(kind)) return () => { /* 词表外不订阅 */ };
  return onSharedChanged(kind, listener);
}

/** 清掉一条 command 意图（落地端消费后调；state 类不要用，那会把要镜像的值抹掉）。 */
export function clearIntent(kind: IntentKind): Promise<unknown> {
  if (!isIntentKind(kind)) return Promise.reject(new Error("未知跨面意图：" + String(kind)));
  return writeShared(kind, intentSharedValue(normalizeIntent(kind, null)));
}

// 设置视图：{ open, section }。
export function readSettingsView(): Promise<IntentPayload<"settings-view">> {
  return readIntent("settings-view").then((r) => r.value);
}
export function writeSettingsView(next: { open?: boolean; section?: string | null }): Promise<unknown> {
  return writeIntent("settings-view", {
    open: !!(next && next.open === true),
    section: next && typeof next.section === "string" && next.section ? next.section : null,
  });
}

// 会话选中：{ sessionId }；at 是通道盖的写入时刻，接收端据此判断这条意见是否比自己的动手新
// （主卡自己切工作区/新建会话也会改本地选中，旧意见不得把它压回去）。
export function readSelection(): Promise<{ sessionId: string | null; at: number }> {
  return readIntent("selection").then((r) => ({ sessionId: r.value.sessionId, at: r.at }));
}
export function writeSelection(sessionId: string | null): Promise<unknown> {
  return writeIntent("selection", { sessionId: sessionId ?? null });
}

// 主面板选中：{ panelId }。DSH 侧栏的面板行在 FP 上没有中列可放，那一页归主卡。
export function readPanelView(): Promise<IntentPayload<"panel-view">> {
  return readIntent("panel-view").then((r) => r.value);
}
export function writePanelView(panelId: string | null): Promise<unknown> {
  return writeIntent("panel-view", { panelId: panelId ?? null });
}

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
//   通用转发 → 任意词表内 kind（readIntent / writeIntent / onIntentChanged，新增面走这条）；
//   三个既有消费者保留同名包装，与上一条同一条通道：
//     设置视图 → integrations/ui-settings-general；会话选中 → integrations/ui-session；
//     主面板选中 → ui-sidebar（FP 发射）与 ui-layout（主卡落地）；
//   会话坐标 → ui-session 的只读面（readPinnedSession）；
//   剪贴板 → @dshana/clipboard 的 client 半（同文档，直接调，无消息协议）。
export const SURFACE_API = {
  readIntent,
  writeIntent,
  onIntentChanged,
  clearIntent,
  readSettingsView,
  writeSettingsView,
  onSettingsViewChanged: (listener: () => void) => onIntentChanged("settings-view", listener),
  readSelection,
  writeSelection,
  onSelectionChanged: (listener: () => void) => onIntentChanged("selection", listener),
  readPanelView,
  writePanelView,
  onPanelViewChanged: (listener: () => void) => onIntentChanged("panel-view", listener),
  readPinnedSession,
  clipboardWrite,
};
