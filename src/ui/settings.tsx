// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/settings.tsx — DSHana App 自己的设置页脚本（contributes.settings.ui.route = /settings.html）。
//
// 为什么是我们自己的页：宿主设置区里那个「DSHana」标签页直接渲染本页，配置经 App 自己的后端
// 读写（GET/POST /dshana/settings → dataDir/config.json 的 global.*，即运行时优先直读的那份值），
// 不再让宿主按 manifest schema 代画表单，"两处表单两份值"的分叉因此不存在。缺省值由
// src/lib/config.ts 的 APP_SETTING_DEFAULTS 持有（30 / 1800）。
//
// 界面用宿主自己的设置组件（@hana/plugin-components/settings）：形态、间距、字号、保存反馈与
// 就绪态都由宿主口径出，本页只持有状态与读写逻辑。页面本身不加外边距（宿主设置容器已经在管
// 那圈留白），也不自带色彩——颜色全部由宿主主题变量供给。
//
// 本脚本三件事：
//   1) 跟随宿主主题：hana.theme.getSnapshot() 首屏 + hana.theme.subscribe 事件，不轮询。
//      宿主主题 CSS 在 settings.css 之后注入，变量覆盖顺序因此正确。
//   2) 常规两项：读回来的就是运行时生效值，保存后同样以后端返回的生效值为准，不做本地猜测。
//   3) 会话模型：模型候选读 App 后端的 /dshana/models（宿主模型目录 ctx.models.list 的分组视图），
//      不读 DSH 自己的目录，所以本页与 DSH 在不在跑无关。
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { hana } from "@hana/plugin-sdk";
import {
  Button,
  SaveButton,
  Select,
  SettingRow,
  SettingsPage,
  SettingsSection,
  TextInput,
} from "@hana/plugin-components/settings";
import type { SelectOption } from "@hana/plugin-components/settings";
import "@hana/plugin-components/settings.css";

// ---- 主题跟随（与壳页同一姿势）----
const THEME_STYLE_ATTR = "data-hana-theme-style";
let themeCssUrl: string | null = null;

type ThemeSnap = { theme?: string; appearance?: string; cssUrl?: string };

function applyTheme(snap: ThemeSnap | null | undefined) {
  if (!snap || typeof snap !== "object") return;
  const root = document.documentElement;
  if (typeof snap.theme === "string" && snap.theme) root.setAttribute("data-theme", snap.theme);
  if (typeof snap.appearance === "string" && snap.appearance) {
    root.setAttribute("data-appearance", snap.appearance);
    // 原生控件与滚动条跟着宿主明暗，而不是跟着系统（两者不一致时页面会半黑半白）。
    root.style.colorScheme = snap.appearance === "dark" ? "dark" : "light";
  }
  const url = typeof snap.cssUrl === "string" ? snap.cssUrl : "";
  if (!url) return;
  themeCssUrl = url;
  fetch(url, { credentials: "same-origin", cache: "no-store" })
    .then((r) => (r.ok ? r.text() : ""))
    .then((css) => {
      if (themeCssUrl !== url || !css) return; // 期间主题又变了，等新的那次落地
      let el = document.querySelector("style[" + THEME_STYLE_ATTR + "]");
      if (!el) {
        el = document.createElement("style");
        el.setAttribute(THEME_STYLE_ATTR, "");
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) el.textContent = css;
    })
    .catch(() => {
      /* 拿不到主题不致命：交给宿主主题变量与组件库自带的兜底 */
    });
}

// ---- 小工具 ----
const MODEL_KEY_SEP = "\u0000"; // provider 与 model id 之间（见 modelOptions）

function errText(e: unknown) {
  const m = e && (e as { message?: string }).message;
  return m || String(e);
}

/** 常规两项：字段名与提示语（值本身由后端与 config.ts 的缺省值决定）。 */
const FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "approvalTimeoutSec", label: "审批超时", hint: "审批超时自动拒绝，单位秒；填 0 = 禁用自动拒绝。" },
  { key: "defaultTimeoutSec", label: "任务超时", hint: "单次任务超时，单位秒；填 0 按缺省 1800 兜底。" },
];

type CatalogModel = { id?: string; name?: string; efforts?: { id?: string; name?: string }[] };
type CatalogGroup = { id?: string; name?: string; models?: CatalogModel[] };

type ModelOption = SelectOption & { group?: string };

/**
 * 候选拉平成一个列表，用 group 标出 provider。
 *
 * 宿主 Select 的 options 支持 group 字段：运行时（组件库里的 select widget）遇到带 group 的项
 * 就成组渲染，画组标题、组间插分隔线——与宿主自己的模型选择器同一个形状。类型面没声明这个
 * 字段，所以这里显式标注。
 *
 * value = provider + 分隔符 + model：不同 provider 会有同名模型，不能只拿 model id 当值。
 */
function modelOptions(model: any): ModelOption[] {
  const groups: CatalogGroup[] = (model && model.catalog && model.catalog.groups) || [];
  const out: ModelOption[] = [];
  for (const g of groups) {
    const name = String(g.name || g.id || "");
    if (!g.id) continue;
    for (const m of g.models || []) {
      if (!m.id) continue;
      out.push({ value: String(g.id) + MODEL_KEY_SEP + String(m.id), label: String(m.name || m.id), group: name });
    }
  }
  return out;
}

/** 选中值拆成 provider 与 model（value 的写法见 modelOptions）。 */
function splitPicked(picked: string): { provider: string; model: string } {
  const at = picked.indexOf(MODEL_KEY_SEP);
  if (at <= 0) return { provider: "", model: "" };
  return { provider: picked.slice(0, at), model: picked.slice(at + MODEL_KEY_SEP.length) };
}

/** 第三段（推理档位）：选中模型支持的档位，没有就返回空数组，那一行不渲染。 */
function effortsOf(model: any, provider: string, modelId: string): { id?: string; name?: string }[] {
  const groups: CatalogGroup[] = (model && model.catalog && model.catalog.groups) || [];
  for (const g of groups) {
    if (String(g.id) !== provider) continue;
    for (const m of g.models || []) if (String(m.id) === modelId) return m.efforts || [];
  }
  return [];
}

async function readJson(path: string, init?: RequestInit) {
  const res = await hana.api.fetch(path, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    ...(init || {}),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

function stringifySettings(settings: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = settings && settings[f.key];
    out[f.key] = typeof v === "number" ? String(v) : "";
  }
  return out;
}

/** 会话模型模式（App 级）：与后端 global.sessionModelMode 同词汇。 */
const SESSION_MODES: SelectOption[] = [
  { value: "caller", label: "复用调用方" },
  { value: "custom", label: "自定义模型" },
];

/** 会话模型设置读回：模式 + 自定义那条（合成 provider\0model，与 modelOptions 同一写法）。 */
function sessionOf(settings: any): { mode: string; picked: string; effort: string } {
  const provider = typeof settings?.sessionModelProvider === "string" ? settings.sessionModelProvider : "";
  const model = typeof settings?.sessionModelModel === "string" ? settings.sessionModelModel : "";
  return {
    mode: settings?.sessionModelMode === "custom" ? "custom" : "caller",
    picked: provider && model ? provider + MODEL_KEY_SEP + model : "",
    effort: typeof settings?.sessionModelReasoningEffort === "string" ? settings.sessionModelReasoningEffort : "",
  };
}

/** 会话行的显示名：任务 label 优先，缺则按动作给默认前缀 + sessionId 短串。 */
function sessionLabel(s: any): string {
  const label = typeof s?.label === "string" && s.label ? s.label : "";
  if (label) return label;
  const head = s?.action === "send" ? "DSH 续会话" : "DSH 新任务";
  const sid = typeof s?.sessionId === "string" ? s.sessionId.slice(0, 18) : "";
  return head + (sid ? "：" + sid + "…" : "");
}

/** 会话行的副文案：状态 + 工作目录 + 最近活动时间。 */
function sessionRowHint(s: any): string {
  const parts: string[] = [];
  if (typeof s?.status === "string" && s.status) parts.push(s.status);
  if (typeof s?.cwd === "string" && s.cwd) parts.push(s.cwd);
  const at = Number(s?.updatedAt || s?.createdAt || 0);
  if (Number.isFinite(at) && at > 0) parts.push(new Date(at).toLocaleString());
  return parts.join(" · ");
}

function App() {
  const [draft, setDraft] = useState<Record<string, string>>(() => stringifySettings(null));
  const [cfgHint, setCfgHint] = useState("");
  const [cfgWarn, setCfgWarn] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgSaved, setCfgSaved] = useState(false);
  // 自持设置的 revision（乐观并发：写回带上，落后就 409）
  const [cfgRevision, setCfgRevision] = useState<number | null>(null);
  const [sessionMode, setSessionMode] = useState<string>("caller");
  const [customPicked, setCustomPicked] = useState("");
  const [sessionEffort, setSessionEffort] = useState("");
  const [sessionSaving, setSessionSaving] = useState(false);
  const [sessionSaved, setSessionSaved] = useState(false);
  const [sessionHint, setSessionHint] = useState("");
  const [sessionWarn, setSessionWarn] = useState(false);
  const [model, setModel] = useState<any>(null); // 最近一次读回的模型候选（{catalog:{groups}} 或 {error}）
  // 会话清单（「会话」区块）：坐标来自宿主任务记录，列出即可在新窗口里打开。
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsHint, setSessionsHint] = useState("");
  const [sessionsWarn, setSessionsWarn] = useState(false);
  const [openingTask, setOpeningTask] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const { res, data } = await readJson("dshana/settings");
      if (!res.ok) throw new Error("HTTP " + res.status);
      setDraft(stringifySettings(data && data.settings));
      const sess = sessionOf(data && data.settings);
      setSessionMode(sess.mode);
      setCustomPicked(sess.picked);
      setSessionEffort(sess.effort);
      setCfgRevision(data && typeof data.revision === "number" ? data.revision : null);
      setCfgHint("");
      setCfgWarn(false);
    } catch (e) {
      setCfgHint("读取失败：" + errText(e));
      setCfgWarn(true);
    }
  }, []);

  const loadModel = useCallback(async () => {
    try {
      const { res, data } = await readJson("dshana/models");
      if (!data) throw new Error("HTTP " + res.status);
      if (!data.ok) {
        setModel({ error: data.error || "未知原因" });
        return;
      }
      setModel({ catalog: data.catalog || {} });
    } catch (e) {
      setModel({ error: errText(e) });
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsHint("");
    setSessionsWarn(false);
    try {
      const { res, data } = await readJson("dshana/sessions");
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (e) {
      setSessionsWarn(true);
      setSessionsHint("读取失败：" + errText(e));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const openSession = async (s: any) => {
    setOpeningTask(s.taskId);
    setSessionsHint("");
    setSessionsWarn(false);
    try {
      const { res, data } = await readJson("dshana/sessions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sessionId: s.sessionId, taskId: s.taskId, title: sessionLabel(s) }),
      });
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      setSessionsHint("已在新窗口打开：" + sessionLabel(s));
    } catch (e) {
      setSessionsWarn(true);
      setSessionsHint("打开失败：" + errText(e));
    } finally {
      setOpeningTask("");
    }
  };

  useEffect(() => {
    void loadConfig();
    void loadModel();
    void loadSessions();
  }, [loadConfig, loadModel, loadSessions]);

  // 设置变更广播的落地：宿主 App 存储只有 get/set、没有订阅口（已核 SDK 的 d.ts），
  // 所以本页在重新可见时重读一次——另一个窗口改过设置也不会拿着旧值继续操作。
  // 模型目录也是宿主侧的事实（宿主设置里加/改提供商后随之变），一并重读。
  // 切换进行中不重读（免得把页面上的进度显示冲掉）。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void loadConfig();
        void loadModel();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadConfig, loadModel]);

  const saveConfig = async () => {
    const patch: Record<string, number> = {};
    for (const f of FIELDS) {
      const v = draft[f.key];
      if (v !== "") patch[f.key] = Number(v);
    }
    if (Object.keys(patch).length === 0) {
      setCfgHint("请先填一个数值。");
      setCfgWarn(true);
      return;
    }
    setCfgSaving(true);
    setCfgHint("");
    setCfgWarn(false);
    try {
      const { res, data } = await readJson("dshana/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ settings: patch, expectedRevision: cfgRevision ?? undefined }),
      });
      if (res.status === 409) {
        // 别处改过（revision 前进）：不静默覆盖，重读后就着新值重来
        setCfgWarn(true);
        setCfgHint("设置已被别处改过，已刷新。");
        await loadConfig();
        return;
      }
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      setDraft(stringifySettings(data.settings)); // 以后端返回的生效值为准
      if (typeof data.revision === "number") setCfgRevision(data.revision);
      setCfgSaved(true);
    } catch (e) {
      setCfgHint("保存失败：" + errText(e));
      setCfgWarn(true);
    } finally {
      setCfgSaving(false);
    }
  };

  const saveSession = async () => {
    const pick = splitPicked(customPicked);
    const patch: Record<string, unknown> = { sessionModelMode: sessionMode };
    if (sessionMode === "custom") {
      if (!pick.provider || !pick.model) {
        setSessionWarn(true);
        setSessionHint("请先选一个模型。");
        return;
      }
      patch.sessionModelProvider = pick.provider;
      patch.sessionModelModel = pick.model;
      patch.sessionModelReasoningEffort = sessionEffort;
    }
    setSessionSaving(true);
    setSessionHint("");
    setSessionWarn(false);
    try {
      const { res, data } = await readJson("dshana/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ settings: patch, expectedRevision: cfgRevision ?? undefined }),
      });
      if (res.status === 409) {
        setSessionWarn(true);
        setSessionHint("设置已被别处改过，已刷新。");
        await loadConfig();
        return;
      }
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      const sess = sessionOf(data.settings);
      setSessionMode(sess.mode);
      setCustomPicked(sess.picked);
      setSessionEffort(sess.effort);
      if (typeof data.revision === "number") setCfgRevision(data.revision);
      setSessionSaved(true);
    } catch (e) {
      setSessionHint("保存失败：" + errText(e));
      setSessionWarn(true);
    } finally {
      setSessionSaving(false);
    }
  };

  const modelOpts = modelOptions(model);
  const sessionSel = splitPicked(customPicked);
  const sessionEffortOptions: SelectOption[] = effortsOf(model, sessionSel.provider, sessionSel.model).map((e) => ({
    value: String(e.id || ""),
    label: String(e.name || e.id || ""),
  }));
  const catalogHint = !model
    ? ""
    : model.error
      ? "模型候选读取失败：" + model.error
      : modelOpts.length === 0
        ? "宿主目录里没有可选模型（先在宿主设置里配好提供商与凭据）。"
        : "";

  return (
    <SettingsPage>
      <SettingsSection title="常规" description="这里的改动立刻生效，不需要重启 DSH。">
        {FIELDS.map((f) => (
          <SettingRow
            key={f.key}
            label={f.label}
            hint={f.hint}
            layout="stacked"
            control={
              <TextInput
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                aria-label={f.label}
                value={draft[f.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            }
          />
        ))}
        <SettingRow
          label=""
          hint={cfgHint || undefined}
          hintVariant={cfgWarn ? "warn" : "default"}
          control={
            <SaveButton
              status={cfgSaving ? "saving" : cfgSaved ? "saved" : "idle"}
              labels={{ idle: "保存", saving: "保存中", saved: "已保存" }}
              onSavedFeedbackEnd={() => setCfgSaved(false)}
              onClick={() => void saveConfig()}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="会话模型"
        description="工具建的新会话（open）用哪个模型。只影响之后新建的会话，改完立即生效。"
      >
        <SettingRow
          label="模式"
          hint="复用调用方 = 用发起这次调用的那张角色卡配的模型（缺省）；自定义模型 = 固定用下面这一条。"
          layout="stacked"
          control={<Select ariaLabel="会话模型模式" value={sessionMode} options={SESSION_MODES} onChange={setSessionMode} />}
        />
        {sessionMode === "custom" && (
          <>
            <SettingRow
              label="模型"
              hint={sessionHint || catalogHint || undefined}
              hintVariant={sessionWarn ? "warn" : "default"}
              layout="stacked"
              control={
                <Select
                  ariaLabel="自定义会话模型"
                  value={customPicked}
                  options={modelOpts}
                  disabled={modelOpts.length === 0}
                  onChange={(v) => { setCustomPicked(v); setSessionEffort(""); }}
                />
              }
            />
            {sessionEffortOptions.length > 0 && (
              <SettingRow
                label="推理强度"
                hint="该模型支持的档位；留空则沿用 DSH 当前的设置。"
                layout="stacked"
                control={
                  <Select
                    ariaLabel="自定义会话模型推理强度"
                    placeholder="保持当前设置"
                    value={sessionEffort}
                    options={sessionEffortOptions}
                    onChange={setSessionEffort}
                  />
                }
              />
            )}
          </>
        )}
        <SettingRow
          label=""
          hint={sessionMode === "custom" ? undefined : sessionHint || undefined}
          hintVariant={sessionWarn ? "warn" : "default"}
          control={
            <SaveButton
              status={sessionSaving ? "saving" : sessionSaved ? "saved" : "idle"}
              labels={{ idle: "保存", saving: "保存中", saved: "已保存" }}
              onSavedFeedbackEnd={() => setSessionSaved(false)}
              onClick={() => void saveSession()}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="会话"
        description="本 App 提交过的 DSH 会话（坐标取自宿主任务记录）。打开会在一个新窗口里显示那一段会话。"
      >
        {sessions.map((s) => (
          <SettingRow
            key={s.taskId}
            label={sessionLabel(s)}
            hint={sessionRowHint(s)}
            control={
              <button
                type="button"
                disabled={openingTask === s.taskId}
                onClick={() => void openSession(s)}
                style={{
                  font: "inherit",
                  fontSize: 12.5,
                  padding: "4px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border, #D8CFBE)",
                  background: "var(--bg-card, #FBF7EE)",
                  color: "var(--text, #2A2622)",
                  cursor: openingTask === s.taskId ? "default" : "pointer",
                }}
              >
                {openingTask === s.taskId ? "打开中…" : "在新窗口打开"}
              </button>
            }
          />
        ))}
        <SettingRow
          label=""
          hint={sessionsHint || (sessions.length === 0 ? "还没有可打开的会话。" : undefined)}
          hintVariant={sessionsWarn ? "warn" : "default"}
          control={
            <button
              type="button"
              disabled={sessionsLoading}
              onClick={() => void loadSessions()}
              style={{
                font: "inherit",
                fontSize: 12.5,
                padding: "4px 12px",
                borderRadius: 6,
                border: "1px solid var(--border, #D8CFBE)",
                background: "var(--bg-card, #FBF7EE)",
                color: "var(--text, #2A2622)",
                cursor: sessionsLoading ? "default" : "pointer",
              }}
            >
              {sessionsLoading ? "读取中…" : "刷新"}
            </button>
          }
        />
      </SettingsSection>

    </SettingsPage>
  );
}

// ---- 启动 ----
(function boot() {
  try {
    if (hana && typeof hana.ready === "function") hana.ready();
  } catch {
    /* 宿主未提供则忽略 */
  }
  try {
    const snap = hana && hana.theme && typeof hana.theme.getSnapshot === "function" ? hana.theme.getSnapshot() : null;
    if (snap) applyTheme(snap);
  } catch {
    /* 忽略 */
  }
  try {
    if (hana && hana.theme && typeof hana.theme.subscribe === "function") hana.theme.subscribe(applyTheme);
  } catch {
    /* 忽略 */
  }
  const host = document.getElementById("root");
  if (host) createRoot(host).render(<App />);
})();
