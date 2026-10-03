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
import {
  CHANNEL_KINDS, CHANNEL_SCOPE_FALLBACK, isChannelKind, normalizeScope,
  type FaceAddress, type FaceTarget,
} from "@dshana/shared/faces-channel.ts";
import { faceTakesIntent } from "@dshana/shared/shared-state.ts";
import { isFaceView, roleForView } from "./face-role.ts";
import { createFaceChannel, type FaceChannel } from "./face-channel.ts";
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

// ---- 跨面共享状态（通道语义见 @dshana/shared/shared-state.ts）----
// 作用域：本 App 单 DSH 源、单主卡，宿主给主卡与其 FP 同一个 cardInstanceId，按实例分段没有
// 区分度，键就是 `dshana.<kind>`（前缀与 lib/shared-state.ts 同源）。这批键的寿命是一次 App
// 生命周期：加载时由 renewSharedState 清空，页面下线时由 dropShared 删。
export function sharedKey(kind: string): string {
  return SHARED_KEY_PREFIX + kind;
}

// 本页可能写过的共享键：boot 快照 + 意图 kind 里**没搬上直投通道**的那些。
// 已在通道上的 kind（CHANNEL_KINDS）不在这里：它们的权威记录由通道服务端半写（见下方
// faceChannel），页面在 pagehide 里删键就等于抢写者，会把晚到面的快照删掉。
const SHARED_KINDS = [
  "boot-state",
  ...INTENT_KINDS.filter((kind) => !(CHANNEL_KINDS as readonly string[]).includes(kind)),
];

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

// ---- 跨面转发：两台通道 ----
//   ① **共享空间 + 监听**（广播）：一台通道、封闭词表，局部面（FP）发射意图、整幅面落地。
//      跨文档能过的只有意图本身——插件实例与注入的 hook 留在发射端，接收端拿自己的插件实例把那条面
//      重建出来。词表与载荷归一住在 @dshana/shared/shared-state.ts（纯逻辑，单测直接打）；
//      本层只做运输，并把词表外的 kind 挡在门外。
//   ② **直投通道**（指名，`publish`）：发射面给出收件人，中介在 App 进程，回执带回投到几个面。
//      已在通道上的 kind 见 CHANNEL_KINDS（目前是会话选中）；其余 kind 仍在 ① 上，逐个迁移。
//      两台的边界：要在会话选中上工作，读 `readSelection`；写 `writeSelection`（余下同形）。
//   既有三件（设置视图 / 会话选中 / 主面板选中）原本都走 ①，下面保留同名包装使消费方按原样调用。

/**
 * 一条意图的读结果。
 *
 * `pending` 是落地端的判据：这一槽里**有没有待落地的意图**。没写过、以及已被消费过（值被写成
 * null）都是 false——载荷本身为空的 kind（快捷键参考框）光看 value 分不出来，少了这个标志，
 * 面一挂载就会把「空槽」当成一条要打开的指令。
 */
export interface ForwardedIntent<K extends IntentKind> {
  value: IntentPayload<K>;
  at: number;
  pending: boolean;
}

/** 读一条意图（词表外当场拒；载荷先归一，读到的永远是干净形状）。 */
export function readIntent<K extends IntentKind>(kind: K): Promise<ForwardedIntent<K>> {
  if (!isIntentKind(kind)) return Promise.reject(new Error("未知跨面意图：" + String(kind)));
  return readShared(kind).then((raw) => {
    const envelope = raw && typeof raw === "object" ? (raw as { value?: unknown; at?: unknown }) : {};
    return {
      value: normalizeIntent(kind, envelope.value),
      at: typeof envelope.at === "number" ? envelope.at : 0,
      pending: raw !== null && envelope.value !== null,
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

/**
 * 清掉一条 command 意图（落地端消费后调，必须把刚消费的 at 原样带回）。
 *
 * 两个细节都是必需的：
 *   · **带原 at**：清空也是一次写，会广播一次变更。盖新时间戳的话，落地端会被自己的清空
 *     再唤醒一次（读到的 at 更新 → 再应用 → 再清空），就是无限循环；带上原 at，回声被
 *     “at ≤ 已应用” 挡住。
 *   · **值写成 null**：面重开时读到的是「这条已经落地过了」（`pending` 为 false），而不是一条
 *     待应用的空指令——载荷本身为空的 kind（快捷键参考框）光看载荷分不出来。
 */
export function clearIntent(kind: IntentKind, at: number): Promise<unknown> {
  if (!isIntentKind(kind)) return Promise.reject(new Error("未知跨面意图：" + String(kind)));
  return writeShared(kind, { value: null, at: typeof at === "number" && at > 0 ? at : 0 });
}

// 设置视图已搬到直投通道：FP 与主卡的设置入口用 publishIntent('settings-view', …) 指名投递、
// 主卡与整幅面用 registerIntentLanding('settings-view', …) 落地（见 integrations/ui-settings-general）。
// 旧的三件名随迁移删除。

// ---- 跨面直投通道（面 → 面，指名投递）----
// 与上面那台共享空间划清分工：共享空间是**广播**（谁都能读、读侧自己判新旧），直投通道是**指名**
// ——发射面给出收件人（面地址或扇出），只有命中的面收，回执带回投到了几个面。协议住在
// @dshana/shared/faces-channel.ts，中介住在 App 进程（packages/tools/src/faces-hub.ts），
// 本层只是客户端半的接线与懒单例。试点只搬了会话选中：channel kinds 是意图词表的子集，
// 其余 kind 仍走共享空间，逐个迁移。
let faceChan: FaceChannel | null = null;

/** 本页的面（静态声明为准：<meta name="hana-dshana-role"> 或 body[data-dshana-view]）。 */
function declaredRole(): FaceAddress {
  try {
    const meta = document.querySelector('meta[name="hana-dshana-role"]');
    const declared = meta && meta.getAttribute("content");
    if (isFaceView(declared)) return roleForView(declared) as FaceAddress;
    const attr = document.body && document.body.getAttribute("data-dshana-view");
    if (isFaceView(attr)) return roleForView(attr) as FaceAddress;
  } catch { /* 无 DOM：按整幅面（不擅自少一列） */ }
  return "standalone";
}

/** 本页所属的卡片实例（宿主盖章；没有就占位，作用域照样隔离）。 */
function cardScope(): string {
  try {
    const sdk = hana as { surface?: { getContext?: () => { cardInstanceId?: unknown } | null } };
    const ctx = sdk && sdk.surface && typeof sdk.surface.getContext === "function" ? sdk.surface.getContext() : null;
    return normalizeScope(ctx && ctx.cardInstanceId);
  } catch {
    return CHANNEL_SCOPE_FALLBACK;
  }
}

/** 走本 App 路由取一份 JSON（非 2xx 当失败抛，不静默降级）。 */
function jsonOf(path: string, init: RequestInit): Promise<unknown> {
  return apiFetch(path, init).then((res) => {
    if (!res.ok) throw new Error(path + " HTTP " + res.status);
    return res.json() as Promise<unknown>;
  });
}

/** 本页有没有 surface 会话凭据。没有就根本走不了 route（一律拒无凭据请求），也就没有通道可言。 */
function hasSurfaceCredentials(): boolean {
  try {
    return surfaceSession() !== null;
  } catch {
    return false;
  }
}

/** 本页的直投通道（懒建：没用到的面不开循环；没凭据时返回 null，不建一个注定失败的循环）。 */
function faceChannel(): FaceChannel | null {
  if (faceChan) return faceChan;
  if (!hasSurfaceCredentials()) return null;
  faceChan = createFaceChannel({
    role: declaredRole(),
    scope: cardScope(),
    io: {
      get: (path, signal) => jsonOf(path, { method: "GET", cache: "no-store", signal }),
      post: (path, body) => jsonOf(path, {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
    },
    // 首读的种子：直接读一次权威记录。ui-session 的启动握手是「读当前值」，通道就绪与否
    // 不该改变这个语义（也不该让首屏多等一跳）；pending=false 就是「还没有人表过态」。
    seed: (kind) => readIntent(kind as IntentKind).then((r) => (r.pending ? { value: r.value, at: r.at } : null)),
    log: (msg) => console.warn("[dshana/faces] " + msg),
  });
  return faceChan;
}

// ---- 通用落地面（已上通道的 kind 共用一台机器）----
// 落地端不再自己写 applier 循环（读 → 判 at → 判 pending → 落地 → 清空），只登记一件回调；
// 帧到了由这里按“本面是否参与这条 kind”派发。参与面来自意图描述符表（INTENT_SPECS.faces）；
// 未声明的 kind 一律当真。纯逻辑在 intent-landing.ts，本层只接通道与角色。
let chanWired = false;
const landings = createIntentLandings({
  takes: (kind) => faceTakesIntent(kind, declaredRole()),
  onError: (message, error) => console.warn("[dshana/faces] " + message, error),
});

/** 拿到通道并把落地面接上它（只接一次）；没凭据返回 null（退到共享空间那条）。 */
function channelForLandings(): FaceChannel | null {
  const chan = faceChannel();
  if (chan === null) return null;
  if (!chanWired) {
    chanWired = true;
    chan.onFrame((frame) => {
      landings.dispatch(frame.kind, frame.payload, { kind: frame.kind, at: frame.at, from: frame.from });
    });
  }
  chan.start();
  return chan;
}

/**
 * 登记一件跨面意图的落地回调（返回退订）。
 *
 * 还没上通道的 kind 返回一个空退订：那些 kind 仍由广播共享空间那条路（readIntent /
 * onIntentChanged）服务，等它们搬过来时在这里就自动生效了。
 */
export function registerIntentLanding<K extends IntentKind>(
  kind: K,
  handler: (payload: IntentPayload<K>, meta: IntentLandingMeta) => void,
): () => void {
  if (!isChannelKind(kind)) return () => { /* 未上通道：由共享空间那条服务 */ };
  channelForLandings();
  return landings.register(kind, handler as (payload: unknown, meta: IntentLandingMeta) => void);
}

/** 读一条 kind 的当前值（已上通道的读本地缓存/首读懒种子；其余读共享空间记录）。 */
export function readIntentState<K extends IntentKind>(
  kind: K,
): Promise<{ value: IntentPayload<K>; at: number } | null> {
  const chan = isChannelKind(kind) ? channelForLandings() : null;
  if (chan === null) {
    return readIntent(kind).then((r) => (r.pending ? { value: r.value, at: r.at } : null));
  }
  return chan.read(kind).then((hit) => (hit ? { value: hit.value as IntentPayload<K>, at: hit.at } : null));
}

/** 发一条意图（已上通道的指名投递、带回执；其余写共享空间那条）。 */
export function publishIntent<K extends IntentKind>(
  kind: K,
  payload: IntentPayload<K>,
): Promise<{ delivered: number }> {
  const chan = isChannelKind(kind) ? faceChannel() : null;
  if (chan === null) return writeIntent(kind, payload).then(() => ({ delivered: 0 }));
  return chan.publish(kind, payload);
}

/** 会话选中：{ sessionId }。读 = 当前值（首读直接读权威记录），写 = 指名投递给其余面；
 * at 仍是写入时刻，接收端据此只采纳比自己动手更新的意见（ui-session 的判据不变）。
 *
 * 没凭据的页面（本 App 的页面理论上都有，被别的宿主/裸开时没有）由上面三件自动退到广播共享
 * 空间那条：读侧读的是同一张权威记录（通道服务端半写的镜像），所以两台的读不会各说各话。 */
export function readSelection(): Promise<{ sessionId: string | null; at: number }> {
  return readIntentState("selection").then((hit) => {
    const value = hit && hit.value ? (hit.value as { sessionId?: unknown }) : null;
    return {
      sessionId: value && typeof value.sessionId === "string" ? value.sessionId : null,
      at: hit ? hit.at : 0,
    };
  });
}
export function writeSelection(sessionId: string | null): Promise<{ delivered: number }> {
  return publishIntent("selection", { sessionId: sessionId ?? null });
}
export function onSelectionChanged(listener: () => void): () => void {
  return registerIntentLanding("selection", () => { listener(); });
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
  // 通用面（已上通道的 kind 走这三件；逐一迁移时消费方只换调用名）
  publishIntent,
  readIntentState,
  registerIntentLanding,
  readSelection,
  writeSelection,
  onSelectionChanged,
  readPinnedSession,
  clipboardWrite,
};
