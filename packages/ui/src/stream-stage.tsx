// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/ui/src/stream-stage.tsx — 会话卡（stream 面）的**重型半**：黑板 / 拆窗态下的完整 DSH 现场
//
// 只在 hana.envelope 说 height 是 fixed（黑板 / 拆窗）时由 packages/ui/src/stream-entry.ts 动态 import()，
// 因此它带着 React、dsh-inject 与 host-theme——聊天流态的卡**永不**解析到这一份。
//
// 为什么这一半用 React：它有一个真的状态机（booting / ready / error 三态 + 轮询 + 注入），
// 而聊天流那一半只有一行静态坐标、没有状态，所以那一半保持零 React 依赖（见 stream-entry.ts）。
// 注入的 DSH UI 钉在 #root 上，自举台（#dsh-stage）在 ready 时由 face-stage.css 收起。
//
// 与主卡 / FP 同一套：轮询 boot-state、跨面共享快照、宿主主题跟随、DSH index 注入。差异只在
// 这一面没有可交互的壳 chrome 与标题栏交互区域，只多一条卡状态行（URL 带 sid 时）。
import { useEffect, useRef, useState, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { hana } from "@hana/plugin-sdk";
import { injectDshIndex, installTransport, type DshTransport } from "./dsh-inject.ts";
import { roleForView } from "./face-role.ts";
import { backdropTokenForView, seedTokensForView, SEED_TOKEN_KEYS, seedsForDshPreference } from "./seed-tokens.ts";
import { followHostTheme } from "./host-theme.ts";
import {
  SURFACE_API,
  dropShared,
  fetchBootState,
  postAction,
  surfaceSession,
  withSurfaceTicket,
} from "./surface-bridge.ts";

// ---- 轮询节拍（与壳页同一口径）----
const POLL_FAST_MS = 1500;   // 非就绪：较快轮询（starting 日志滚动）
const POLL_MID_MS = 3000;    // idle/error：中速
const POLL_SLOW_MS = 6000;   // 错误/缺凭据：慢轮询（等自动链重试）

// ---- 三态（booting / ready / error）----
type View = "idle" | "booting" | "action" | "ready";

interface Snapshot {
  view: View;
  /** boot-state 快照（模板文案与诊断块用）。 */
  state: any;
  /** 台面那行小字（只报状态；报错内容在诊断块里，不重复）。 */
  status: string;
  /** 诊断块正文（空 = 不占版面）。 */
  diag: string;
  /** true = 本页 URL 没带 surface 会话凭据（代理会对无凭据请求一律 403）。 */
  credMissing: boolean;
}

function viewOf(s: any): View {
  if (!s) return "idle";
  if (s.ready) return "ready";
  if (s.phase === "starting") return "booting";
  if (s.phase === "error" || s.phase === "stopped") return "action";
  return "idle";
}

function statusText(view: View, s: any): string {
  if (view === "booting") return "正在启动 DSH…";
  if (view === "idle") return "DSH 未启动";
  if (view === "action") return s && s.phase === "stopped" ? "DSH 已停止" : "启动失败";
  return "";
}

// 台面的诊断块：只报错与运行坐标，不给按钮——自动链会自己重试（换端口 / 崩溃重起），
// 用户插手反而是多余路径。
function diagnosticOf(s: any): string {
  const raw: string[] = [];
  if (s && s.error && s.error.code) raw.push("code: " + s.error.code);
  if (s && s.error && s.error.userText) raw.push("message: " + s.error.userText);
  if (s && s.note) raw.push("note: " + s.note);
  if (s && s.runtimeId) raw.push("runtimeId: " + s.runtimeId);
  if (s && s.service && s.service.port) raw.push("port: " + s.service.port);
  if (s && s.logTail && s.logTail.length) raw.push("最近日志:\n" + s.logTail.slice(-14).join("\n"));
  return raw.length ? raw.join("\n") : "";
}

const CRED_MISSING_DIAG =
  "缺少 App surface 会话凭据：本页 URL 上没有 appSurfaceSession，\n"
  + "DSH 运行时经宿主代理会被直接拒（missing_credential），状态面与内嵌视图都拿不到。\n"
  + "请从 Card Center 重新打开本卡。";

const BACKEND_UNREACHABLE_DIAG =
  "\n请从 Card Center 重新打开本卡以完成 App surface 授权。";

function initialSnapshot(): Snapshot {
  return { view: "idle", state: null, status: "正在读取状态…", diag: "", credMissing: false };
}

// ---- 注入（与 app-shell.ts 的 startInjection 同源，但面固定为 stream）----
// 装配用的中继前缀里含 runtimeId，而宿主按 runtimeId 解析代理目标：运行时代换（宿主重启 /
// 运行体重建）之后这份前缀就是死端点。本台面不自己发现代换——宿主在代换后会重载 App 页面，
// 重载带走新发的 surface 凭据，重新装配一次就干净了。
const injected = {
  started: false,
  transport: null as DshTransport | null,
};

// ---- 主题桥（同文档注入形态）：把宿主主题变量推给 DSH 侧的桥 ----
const THEME_VARS = [
  "--bg", "--bg-card", "--sidebar-bg", "--text", "--text-light", "--text-muted",
  "--accent", "--accent-hover", "--accent-light", "--border", "--green", "--danger",
  "--overlay-strong", "--overlay-medium", "--user-bg",
];
function themeMessage(): any {
  const cs = getComputedStyle(document.documentElement);
  const vars: any = {};
  for (const name of THEME_VARS) vars[name] = cs.getPropertyValue(name).trim();
  try {
    vars.themeId = new URLSearchParams(location.search).get("hana-theme") || "inherit";
  } catch {
    vars.themeId = "inherit";
  }
  return { dshHanaTheme: { vars, preference: dshPreference } };
}
function pushThemeNow(): void {
  try { window.postMessage(themeMessage(), "*"); } catch { /* 忽略 */ }
}
// 为什么必须由壳页主动推：桥发的 dshHanaThemeRequest 走的是 parent.postMessage，而同文档注入后
// 本页的 parent 是**宿主**而不是壳页，那个请求到不了这里，壳也就没机会回。
window.addEventListener("message", (e: MessageEvent) => {
  const data: any = e.data;
  if (!data || typeof data !== "object") return;
  if (data.dshHanaThemeRequest) {
    try { (e.source as any).postMessage(themeMessage(), "*"); } catch { /* 忽略 */ }
  }
});

// DSH index 的 boot-theme 行（ui-theme/src/boot-theme.ts 生成，紧跟 <body> 开标签）：
//   const preference = "system"|"light"|"dark"
// 官方把这行定位成 "the browser's pre-plugin interval"；我们读同一处，把偏好随主题载荷一起
// 交给桥。权威归属不变：桥的 readPreference() 优先 client 半投影的属性，本值只在属性出现前充数。
let dshPreference: string | null = null;
function readIndexThemePreference(html: string): string | null {
  const m = /const\s+preference\s*=\s*"([^"]+)"/.exec(String(html || ""));
  return m && /^(system|light|dark)$/.test(m[1]) ? m[1] : null;
}

// ---- 注入前垫 DSW 底色 token（见 packages/ui/src/seed-tokens.ts）----
// 撤垫片：按 token 名单抹自定义属性，另加 body 自身的 background-color（压住 DSH 首帧样式里
// 那句 body{background-color:#151517}）。
function clearSeedTokens(): void {
  if (!document.body || !document.body.style) return;
  for (const key of SEED_TOKEN_KEYS) {
    try { document.body.style.removeProperty(key); } catch { /* 忽略 */ }
  }
  try { document.body.style.removeProperty("background-color"); } catch { /* 忽略 */ }
}
function seedDshTokens(): void {
  if (!document.body) return;
  // 底座 token：这一面可见底那一格（会话卡是中列面，壳页同源实现见 seed-tokens.ts）。
  // 面名不在这里写：那是页面身份，由 stream-entry.ts 在 boot() 里写在 <html> 上（两个挂载态
  // 都写，因为「本页是 stream 面」与「装不装 DSH」是两件事）。
  try { document.documentElement.setAttribute("data-dshana-backdrop", backdropTokenForView("stream")); } catch { /* 忽略 */ }
  // DSH 自己选了明暗时首帧归它：不但不垫，还要把上一轮垫的抹掉。
  if (!seedsForDshPreference(dshPreference)) { clearSeedTokens(); return; }
  const spec = seedTokensForView("stream");
  const cs = getComputedStyle(document.documentElement);
  for (const [token, hostVar] of spec) {
    const value = cs.getPropertyValue(hostVar).trim();
    if (value) document.body.style.setProperty(token, value);
  }
  // body 自身的背景也要垫：DSH 的首帧样式是 body{background-color:#fff}
  // @media(prefers-color-scheme:dark){...}，跟的是浏览器系统偏好，盖不住自定义属性那一层。
  const backdropVar = spec.find(([token]) => token === "--dsw-alias-bg-base")?.[1];
  if (backdropVar) {
    const value = cs.getPropertyValue(backdropVar).trim();
    if (value) document.body.style.backgroundColor = value;
  }
}

// ---- 装配入口 ----
function startInjection(
  prefix: string,
  onInjected: () => void,
  onError: (msg: string) => void,
): void {
  if (injected.started) return;
  injected.started = true;
  const privatePrefix = withSurfaceTicket(prefix, surfaceSession());
  const base = new URL(privatePrefix, location.origin);
  injected.transport = installTransport(base, {
    // stream 面 → DSH 侧上游角色词 stream（见 packages/ui/src/face-role.ts）。
    role: roleForView("stream"),
    bridge: SURFACE_API,
    // 目录桥要的宿主 SDK：它是本文件头顶那个 import（不在 globalThis 上，DSH 侧自己也拿不到）。
    sdk: hana,
  });
  // 取 index：privatePrefix 已是完整代理路径（含 _surface 票据，宿主路由直认），用原生同源
  // fetch——hana.api.fetch 的入参是「App 路由相对路径」（会再拼 /api/apps/<id>/routes/），
  // 传完整路径会重复前缀 404。
  fetch(privatePrefix + "index.html", { cache: "no-store", credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error("DSH index HTTP " + r.status);
      return r.text();
    })
    .then((html) => {
      // 先取走 boot-theme 行的偏好再注入：桥在 index 解析时就跑，它要立刻知道门开不开。
      dshPreference = readIndexThemePreference(html);
      // 注入前再垫一次：首屏那一帧之前宿主主题多半已到，垫上就不会先画 DSH 的近白底。
      seedDshTokens();
      return injectDshIndex(html, base);
    })
    .then(() => {
      pushThemeNow();
      onInjected();
    })
    .catch((err) => onError((err && err.message) || String(err)));
}

function ensureInjection(
  s: any,
  onInjected: () => void,
  onError: (msg: string) => void,
): void {
  startInjection(s.proxyPrefix, onInjected, onError);
}

// ---- React：三态台面 ----
function Stage({ snap, diagRef }: { snap: Snapshot; diagRef: RefObject<HTMLPreElement | null> }) {
  const showDiag = snap.view === "action" && !!snap.diag;
  return (
    <>
      <div className="loader">
        <span className="wordmark">DSHANA</span>
        <span className="ring" id="dsh-spin" hidden={snap.view !== "booting"} />
        <p id="dsh-status">{snap.status}</p>
      </div>
      <div id="boot-panel">
        {showDiag ? <pre className="diag-progress" data-log-scroll ref={diagRef}>{snap.diag}</pre> : null}
      </div>
    </>
  );
}

function App() {
  const [snap, setSnap] = useState<Snapshot>(initialSnapshot);
  const diagRef = useRef<HTMLPreElement | null>(null);
  const kickedRef = useRef(false);
  const aliveRef = useRef(true);

  // 轮询：取一次快照 → 记录视图。ready 即停表；未就绪（含 error / stopped）继续问。
  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };
    const apply = (next: Snapshot): void => {
      if (aliveRef.current) setSnap(next);
    };
    // 打开页面时补一次启动：轮询不会重试，用户打开页面是最强的一次「我要用它」信号。
    // 只针对 idle / error；stopped 是用户主动停的，不替他复活。每页只踢一次。
    const kickStartIfNeeded = (s: any): void => {
      if (kickedRef.current || !s) return;
      const phase = s.phase || "idle";
      if (phase !== "idle" && phase !== "error") return;
      kickedRef.current = true;
      postAction("start").then(() => tick()).catch(() => { /* 忽略：状态面会显示 */ });
    };
    const tick = (): void => {
      fetchBootState().then((s: any) => {
        if (!aliveRef.current) return;
        const view = viewOf(s);
        if (view === "ready" && !surfaceSession()) {
          // DSH 已就绪但本页 URL 没带 appSurfaceSession（宿主没发）：代理对无凭据请求一律 403。
          // 停在 action 视图，把原因写清。
          apply({ view: "action", state: s, status: "缺少 App surface 会话凭据", diag: CRED_MISSING_DIAG, credMissing: true });
          schedule(POLL_SLOW_MS);
          return;
        }
        apply({
          view,
          state: s,
          status: statusText(view, s),
          diag: view === "action" ? diagnosticOf(s) : "",
          credMissing: false,
        });
        kickStartIfNeeded(s);
        // ready 停表：宿主在运行时代换后会重载本页，台面不需要自己轮询去发现；未就绪才继续问。
        if (view === "ready") return;
        schedule(view === "booting" ? POLL_FAST_MS : POLL_MID_MS);
      }).catch((err: any) => {
        const msg = (err && err.message) || String(err);
        apply({
          view: "action",
          state: null,
          status: "无法连接 App 后端路由",
          diag: msg + BACKEND_UNREACHABLE_DIAG,
          credMissing: /appSurfaceSession/.test(msg),
        });
        schedule(POLL_SLOW_MS);
      });
    };
    tick();
    return () => {
      aliveRef.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  // 视图 → body[data-view]：face-stage.css 靠它收起自举台（ready 时整幅让给注入的 DSH）。
  useEffect(() => {
    document.body.setAttribute("data-view", snap.view);
  }, [snap.view]);

  // 诊断块跟着内容滚到底（旧壳页的同一行为）。
  useEffect(() => {
    const el = diagRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.diag]);

  // ready 才装配：过期的重载，没装过的才装；注入失败退回 action 台面把原因说清。
  useEffect(() => {
    if (snap.view !== "ready" || snap.credMissing) return;
    ensureInjection(snap.state,
      () => { /* 注入完成：此后只有轮询发现运行时代换时才重载 */ },
      (msg) => {
        setSnap((prev) => ({
          ...prev,
          view: "action",
          status: "DSH 前端注入失败",
          diag: "DSH 前端注入失败：" + msg
            + "\nDSH 已就绪，但页面装配失败。重开本卡重试；若反复如此，检查中继前缀与 surface 票据。",
        }));
      });
  }, [snap]);

  // 页面下线：释放注入的 transport（WS 载体等）并删掉本页写过的共享键。
  useEffect(() => () => {
    if (injected.transport) { try { injected.transport.dispose(); } catch { /* 忽略 */ } }
    try { dropShared(); } catch { /* 忽略 */ }
  }, []);

  return <Stage snap={snap} diagRef={diagRef} />;
}

/**
 * 装配重型半（由 stream-entry.ts 在 fixed 态、成功取到本 chunk 之后调用）。
 * @param stageEl tpl-stage 实例化出来的 #dsh-stage 节点（React 接管它的内容）
 */
export function mountStreamStage(stageEl: HTMLElement): void {
  // 首帧那一张样式表由 stream.html <head> 里的内联片段贴（所有静态样式表之后）；这里接的是此后
  // 那一段：首屏快照 + 订阅（事件驱动，不轮询），内联片段已贴过的 URL 会跳过重复 fetch。
  // 应用后垫 DSH 首帧底色，样式表落地后再推一次。
  followHostTheme(hana, {
    onApplied: () => seedDshTokens(),
    onStylesApplied: () => pushThemeNow(),
  });
  // 面名与强制面名单不在这里管：它们由**页面**在 stream-entry.ts 的 boot() 里写（两个挂载态
  // 都写），本重型半只是被它动态 import() 进来的一段。
  createRoot(stageEl).render(<App />);
}
