// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/session-run.ts — dshana open/reply 提交链（内部 action 词汇沿用 create/send）
//
// 职责：execute（工具执行，App 主进程）内完成：
//   ① ctx.tasks.create({ callToken, label, metadata }) —— callToken 只在这里消费，
//      不落盘、不落日志；
//   ② ensureManagedRuntime（未起则启动到 ready；单例，一个 runtime 服务多会话）；
//   ③ 经 loopback HTTP Unary RPC（同一信封协议，见 lib/rpc-envelope.js）把
//      session.create / prompt 提交给受管 runtime 内的 DSH web 服务（模型选择随这两个请求
//      一起下传，见集成 api-session-controller）；
//   ④ 把 DSH 坐标（metadata.dsh：action/cwd/sessionId/rpcId/timeoutSec/approvalTimeoutMs）
//      回写宿主任务记录（ctx.tasks.update）——绑定事实源就是这份记录，受管 runtime 的
//      task-bridge / approval-bridge（src/runtime/*）与 provider 身份判定直接读它
//      （见 lib/task-binding.ts），没有私有映射文件；
//   ⑤ 同 DSH session 串行化（lib/session-serialize.js）：锁持有到任务终态，不同 session
//      互不干扰——否则同一 session 的两个任务会互相消费对方的终态事件。
//
// 提交是 fire-and-forget：submitDshTask 返回 { promise, ready }——ready 在 prompt 被 DSH
// 接受（{ accepted:true }）后 resolve 定位键，execute 随即返回；promise 在后台继续等到
// Hana task 终态（child task-bridge complete/fail 后，宿主投递到来源会话）并释放串行化锁。
// 本模块不把 DSH turn 的最终文本带回 execute——内容读取统一走 dshana action=get。
//
// 词汇映射：工具面动作是 open/reply（见 tools/actions/open.ts、tools/actions/reply.ts），本模块内部沿用
// create/send 描述「新建会话 / 续已有会话」这两个动作，映射在 tools/actions/open.ts 与
// tools/actions/reply.ts 的 submit 调用处完成。
import { isAbsolute, join } from "node:path";
import { appCtx, appDataDir } from "#/lib/app-runtime.ts";
import { currentDshHome } from "#/lib/data-source.ts";
import { ensureManagedRuntime } from "#/lib/managed-runtime.ts";
import { nextRpcId } from "#/lib/rpc-envelope.ts";
import { isValidSessionId, dshMetadataFor } from "#/lib/task-binding.ts";
import { withSessionTurn, enterSessionTurn } from "#/lib/session-serialize.ts";
import { readDshDefaultModel } from "#/lib/config.ts";
import { callerPlanDeps, resolveCallerPlan } from "#/lib/caller-model.ts";
import { serviceBase } from "#/lib/service-base.ts";
import { rpcViaControl, invokeControl } from "#/lib/controller.ts";
import { resolveTaskTimeoutSec, resolveApprovalTimeoutMs, cancelSessionWork } from "#/lib/cancel-chain.ts";

/** 取错误的可读文本。catch 到的值类型未知，字段访问一律经这里。 */
const errText = (e: unknown): string => ((e as any)?.message as string) || String(e);

// ---- 归一/校验（纯函数面，便于单测）----
export function normalizeCreateSend({ action, input }: { action?: unknown; input?: any } = {}) {
  const act = action === "send" ? "send" : action === "create" ? "create" : "";
  if (!act) throw new Error("session-run: action 必须是 create / send");
  const taskText = String((input && input.task) || "").trim();
  if (!taskText) {
    throw new Error((act === "create" ? "open" : "reply") + " 必须传 task（任务描述/消息文本）");
  }
  const cwd = String((input && input.cwd) || "").trim();
  const sessionId = String((input && input.sessionId) || "").trim();
  const label = String((input && input.label) || "").trim() || null;
  if (act === "create") {
    if (sessionId) throw new Error("open 不允许传 sessionId（新建；续会话用 reply）");
    if (!cwd) throw new Error("open 必须传 cwd（沙箱工作目录，无 defaultCwd 回退）");
  } else {
    if (!sessionId) throw new Error("reply 缺少目标会话（应给 taskId 句柄或 sessionId 凭证）");
    if (!isValidSessionId(sessionId)) throw new Error("sessionId 格式非法（应为 session-<UUID>）：" + sessionId);
  }
  // agent 预设：code → ptc；空值不传（DSH 默认）
  let preset = String((input && input.agentPreset) || "").trim() || null;
  if (preset === "code") preset = "ptc";
  // 推理强度/模型：只取工具显式值（off/high/max 词汇不变）；空值不传（DSH 默认处理）
  const effort = String((input && input.reasoningEffort) || "").trim() || null;
  const provider = String((input && input.provider) || "").trim() || null;
  const model = String((input && input.model) || "").trim() || null;
  return {
    action: act,
    taskText,
    cwd,
    sessionId,
    label,
    agentPreset: preset,
    reasoningEffort: effort,
    provider,
    model,
    timeoutSec: Number(input && input.timeout) > 0 ? Number(input.timeout) : null,
  };
}

/** 会话模型选择：provider/model 必填，推理强度可选（不传 = 由 DSH 决定）。 */
type ModelSelection = { provider: string; model: string; reasoningEffort?: string };

/**
 * selectModel 载荷组装（纯函数）：显式传了 provider/model/effort 任一时需要；
 * 只传其一/只传 effort 时另一侧从 DSH 默认模型（settings.yaml agent-default-model）补齐；
 * 补不出且确需选择时报错（沿用 v1 文案语义）。全不传返回 null（不随请求带模型）。
 */
export function resolveModelSelection(parsed, dshHome): ModelSelection | null {
  const { provider: p, model: m, reasoningEffort: e } = parsed || {};
  if (!p && !m && !e) return null;
  let provider = p;
  let model = m;
  if (!provider || !model) {
    const dm = readDshDefaultModel(dshHome);
    provider = provider || (dm && dm.provider) || "";
    model = model || (dm && dm.model) || "";
  }
  if (!provider || !model) {
    throw new Error(
      "需要 provider/model：请显式传 provider/model，或在 DSH 自己的模型选择器里选一条（本 App 不再提供默认模型的设置入口）",
    );
  }
  return { provider, model, ...(e ? { reasoningEffort: e } : {}) };
}

// ---- DSH 一元 RPC（经 runtime 控制面转发；App 侧不直连 DSH HTTP）----
// 载体 = lib/controller.js rpcViaControl（controller.invoke → /_control → runtime 带 cookie 转发）。
// 保留 DSHana 特色编排（ctx.tasks.create / 串行化 / 宿主任务记录回投）不变——只换 DSH 访问通道。
async function rpcCall(ctx, _base, opts) {
  return rpcViaControl(ctx, opts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function failTask(ctx, taskId, message) {
  try {
    if (ctx && ctx.tasks && typeof ctx.tasks.fail === "function") {
      await ctx.tasks.fail(taskId, String(message || "dsh 任务失败").slice(0, 3000));
    }
  } catch {
    /* fail 失败不阻断（终态尽力而为） */
  }
}

/** 后台等到 Hana task 终态（complete/failed/canceled/aborted；轮询 get，无 SSE 复杂度）。 */
async function waitTaskTerminal(ctx, taskId, log, pollMs = 1200) {
  for (;;) {
    let rec: any = null;
    try {
      rec = await ctx.tasks.get(taskId);
    } catch (e) {
      log?.warn?.("[dsh-session] tasks.get 查询失败：" + errText(e));
    }
    const st = rec && rec.status;
    if (st && ["completed", "failed", "canceled", "aborted"].includes(String(st))) {
      return rec;
    }
    await sleep(pollMs);
  }
}

/**
 * 带执行超时的终态等待：timeoutSec（秒）内未终态 → 走 cancel 链（
 * 执行超时 = 取消，不是只标失败）；超时后仍继续等到任务终态（cancel 已确认/升级后宿主
 * 终态到达）。timeoutSec <= 0 时等价 waitTaskTerminal（无限等）。超时计时 unref（不阻断
 * App 进程退出）。
 */
async function waitTaskTerminalWithTimeout(ctx, taskId, sessionId, timeoutSec, log, pollMs = 1200) {
  const ms = Number(timeoutSec) > 0 ? Math.round(Number(timeoutSec)) * 1000 : 0;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = async () => {
    if (fired) return;
    fired = true;
    logLine(log, "[dsh-session] 任务执行超时（" + Math.round(ms / 1000) + "s）——走 cancel 链（session=" + sessionId + "）");
    try {
      await cancelSessionWork({ sessionId, reason: "timeout", log });
    } catch (e) {
      log?.warn?.("[dsh-session] 超时 cancel 链失败：" + errText(e));
    }
  };
  if (ms > 0) {
    timer = setTimeout(() => { void fire(); }, ms);
    if (typeof timer.unref === "function") timer.unref();
  }
  try {
    return await waitTaskTerminal(ctx, taskId, log, pollMs);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- 会话建立/续用 ----
// create：session.create { cwd, agentPreset? } → { sessionId }
// send：目标会话可能 (a) 持久非活跃（runtime 重启后）→ session.list 有它（带 cwd），走
// session.create resume（{ sessionId, cwd }）；(b) 活跃/空闲在 DSH agent Map（list 不含）
// → 直接 prompt（无 session.create）；list 也不含 = 会话不存在（prompt admission 会以
// session/not-found 报错）。
async function establishSession(ctx, base, parsed, log, modelSelection: ModelSelection | null = null) {
  const withModel = modelSelection ? { model: modelSelection } : {};
  if (parsed.action === "create") {
    const createPayload = {
      cwd: parsed.cwd,
      ...(parsed.agentPreset ? { agentPreset: parsed.agentPreset } : {}),
      ...withModel,
    };
    const value = await rpcCall(ctx, base, { method: "session/create", payload: createPayload });
    const sessionId = value && value.sessionId;
    if (!sessionId) throw new Error("session.create 未返回 sessionId：" + JSON.stringify(value || null));
    return { sessionId, resumed: false, effectiveCwd: parsed.cwd };
  }
  let listed: { sessionId?: string; cwd?: string } | null = null;
  try {
    const listValue = await rpcCall(ctx, base, { method: "session/list", payload: {} });
    const items = (listValue && Array.isArray(listValue.items) && listValue.items) || [];
    listed = items.find((it) => it && it.sessionId === parsed.sessionId) || null;
  } catch (e) {
    // list 失败不阻断（活跃 Map 会话路径照常）；回落直接 prompt
    log?.warn?.("[dsh-session] session.list 查询失败，回落直接 prompt：" + errText(e));
  }
  if (listed && typeof listed.cwd === "string" && listed.cwd) {
    await rpcCall(ctx, base, {
      method: "session/create",
      payload: {
        sessionId: parsed.sessionId,
        cwd: listed.cwd,
        ...(parsed.agentPreset ? { agentPreset: parsed.agentPreset } : {}),
        ...withModel,
      },
    });
    return { sessionId: parsed.sessionId, resumed: true, effectiveCwd: listed.cwd };
  }
  return { sessionId: parsed.sessionId, resumed: false, effectiveCwd: parsed.cwd || null };
}

function logLine(log, msg) {
  try {
    if (log && typeof log.info === "function") log.info(msg);
  } catch {
    /* 日志失败不阻断 */
  }
}

/**
 * create/send 提交入口（tools/actions/open.ts / tools/actions/reply.ts 调用）。返回 { promise, ready }：
 *   ready  —— prompt 被 DSH 接受后 resolve loc { action, sessionId, rpcId, taskId, cwd }；
 *             提交阶段失败（runtime 起不来 / cwd 不可用 / 会话建立失败 / 模型不可用 / prompt 拒绝）
 *             时 reject（任务已 fail 标记，错误直接抛给 execute）。
 *   promise —— 后台继续等到 Hana task 终态并释放同会话串行化锁（fire-and-forget；
 *             终态结果由宿主投递到来源会话）。调用方 catch 记录即可，不 await。
 */
/**
 * 后台结果的投递档位：宿主任务字段，只在 create 时定死（update 改不了）。
 * 宿主不替作者默选档位——要哪一种必须显式声明；两档与 session:send 的 deliverAs 是同一套语义：
 *   · `next-step`（本 App 选用）＝ 结果在下一个输入收集点贴回来源会话，即 `steer`：
 *     不打断在途模型请求，也不要求模型为等结果而结束回合；会话空闲时才另起一轮；
 *   · `next-turn` ＝ 本回合结束后另起一轮，即 `followUp`。
 * create 入参、工具回执的 `delivery`、结果通知的措辞都读这一处，改它即改全 App 的投递语义。
 */
export const TASK_DELIVERY = "next-step";

/** 提交定位键：prompt 被 DSH 接受后可得的坐标。 */
export interface DshSubmitLoc {
  action: string;
  sessionId: string;
  rpcId: string;
  taskId: string;
  delivery: string;
  cwd?: string | null;
}

/** 提交句柄：ready 在 prompt 被接受后 resolve 定位键；promise 是后台生命周期（等终态、释放锁）。 */
export interface DshSubmitHandle {
  ready: Promise<DshSubmitLoc>;
  promise: Promise<unknown>;
}

/** submitDshTask 的入参。 */
export interface DshSubmitInput {
  /** 内部动作词汇（工具面 open/reply 映射为 create/send）。 */
  action: "create" | "send";
  input: any;
  callToken?: string;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
}
/**
 * open 的 cwd 契约：绝对路径 + 已存在的目录。
 *
 * 为什么拆成两段：
 *   · 「绝对」在这里判就行，纯字符串判断，两条进程（App / 受管 runtime）的解析基准不同，先说清楚
 *     要求绝对就不存在这个歧义；
 *   · 「存在 / 是目录」**不能**在这里判——宿主半的 node:fs 只覆盖应用自己的目录（应用包 + dataDir），
 *     用户侧路径 stat 不到，而那个失败与「目录不存在」在 errno 上分不开，于是每个合法 cwd 都会被
 *     判成不存在。它改由受管 runtime 判（控制面 cwd-check），那是真正 spawn 命令、也真正用这个
 *     cwd 的进程。
 *
 * 在提交前拒掉，比生出一条「每个命令都死」的会话便宜：会话一旦建立，cwd 就是记录值。
 */
export function assertAbsoluteSessionCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw new Error("open 的 cwd 必须是绝对路径（相对路径在 App 与受管 runtime 两侧解析基准不同）：" + cwd);
  }
}

/** runtime 的 cwd-check 回执 → 拒绝理由；可用时返回 null。纯函数，错误文案在这里定稿。 */
export function sessionCwdRejection(check: unknown, cwd: string): Error | null {
  const r = (check || {}) as { ok?: unknown; isDirectory?: unknown; code?: unknown; message?: unknown };
  if (r.ok === true) {
    return r.isDirectory === false ? new Error("open 的 cwd 不是目录：" + cwd) : null;
  }
  const code = typeof r.code === "string" ? r.code : "";
  if (code === "ENOENT") {
    return new Error("open 的 cwd 不存在（会话的每次 spawn 都从它出发，先建好目录再开）：" + cwd);
  }
  if (code === "ENOTDIR") return new Error("open 的 cwd 不是目录：" + cwd);
  // 「有但用不了」不许伪装成「不存在」：errno 与原始原因都要带出来，否则排查只能靠猜。
  const reason = code
    ? code + (typeof r.message === "string" && r.message ? "：" + r.message : "")
    : String(r.message || "未知原因");
  return new Error("open 的 cwd 不可用（" + reason + "）：" + cwd);
}

export function submitDshTask({ action, input, callToken, log }: DshSubmitInput): DshSubmitHandle {
  const parsed = normalizeCreateSend({ action, input });
  // 只验 create：send 的 cwd 沿用会话已有值，而那一刻的目录在建立会话时已经验过
  if (parsed.action === "create") assertAbsoluteSessionCwd(parsed.cwd);
  const ctx = appCtx();
  const dataDir = appDataDir();
  if (!ctx || !dataDir) {
    throw new Error("App 运行包未初始化（apply 未注入宿主 ctx/dataDir）");
  }
  if (!ctx.tasks || typeof ctx.tasks.create !== "function") {
    throw new Error("宿主 ctx.tasks 不可用（缺 app/tasks.manage 能力授予）");
  }
  const token = String(callToken || "").trim();
  if (!token) {
    throw new Error(
      "create/send 需要宿主工具调用 callToken（任务绑定来源会话）；请在模型工具调用路径下执行本工具（context.callToken 缺失）",
    );
  }

  let resolveReady!: (loc: DshSubmitLoc) => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<DshSubmitLoc>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let releaseNewSessionTurn: (() => void) | null = null; // create：会话槽位（占用到终态）
  // 显示名：显式 label 优先，否则按动作给默认前缀（宿主任务列表与结果通知里可见）
  const taskLabel =
    parsed.label || ((parsed.action === "send" ? "DSH 续会话" : "DSH 新任务") + "：" + parsed.taskText.slice(0, 30));

  const runTask = async () => {
    let taskId: string | null = null;
    let sessionId: string | null = null;
    try {
      // ① Hana task 创建（callToken 专用一次；taskId 是稳定句柄）
      let task;
      try {
        task = await ctx.tasks.create({
          callToken: token,
          label: taskLabel,
          // 档位显式声明：宿主默认就是这两个（有令牌 ⇒ session；delivery 默认 next-turn），
          // 写出来是为了不吃隐式默认——改默认值不会静默改变本 App 的形状（APPS.md
          // “后台任务与审批”节：档位只在创建时确定，update 改不了）。
          // 我们要 next-step：结果贴回下一个输入点，不必让模型为等结果结束回合。
          // create 时 DSH 会话尚未诞生，sessionId 由建会话后的 update 回写。
          scope: "session",
          delivery: TASK_DELIVERY,
          metadata: {
            dsh: {
              action: parsed.action,
              cwd: parsed.cwd || undefined,
              sessionId: parsed.sessionId || undefined,
              // 提示词摘要**不进**宿主记录：那是用户内容，宿主任务记录是共享面。
              timeoutSec: parsed.timeoutSec || undefined,
            },
          },
        });
      } catch (e) {
        throw new Error("Hana task 创建失败：" + errText(e));
      }
      taskId = task && task.taskId;
      if (!taskId) throw new Error("ctx.tasks.create 未返回 taskId（宿主契约异常）");

      // ② 受管 runtime 就绪（单例；首启含 DSH boot）
      try {
        const rt = await ensureManagedRuntime({ taskId });
        logLine(log, "[dsh-session] runtime 就绪 runtimeId=" + (rt && rt.runtimeId) + "（task=" + taskId + "）");
      } catch (e) {
        await failTask(ctx, taskId, "DSH 受管运行时启动失败：" + errText(e));
        throw e;
      }
      const base = serviceBase();

      // ②′ cwd 可用性：runtime 起来了才问得到（create 才需要；send 沿用会话已有值）。
      // 查得失败不拦——控制面犯浑不该把合法 cwd 一起拒掉，真有问题由 provider 级守卫（spawn
      // 时的工作目录检查）与命令自身的报错兜住。
      if (parsed.action === "create") {
        let check: unknown = null;
        try {
          check = await invokeControl(ctx, "cwd-check", { cwd: parsed.cwd }, { timeoutMs: 10000 });
        } catch (e) {
          logLine(log, "[dsh-session][warn] cwd 可用性查询失败（继续）：" + errText(e));
        }
        const rejected = check === null ? null : sessionCwdRejection(check, parsed.cwd);
        if (rejected) throw rejected;
      }

      // ③ 会话模型：显式入参 > 用户设的默认（DSH 自己生效，不用我们动手）> 调用方角色卡（create 才补）
      // 它随 create / prompt 的请求一起下传（集成层给这两个请求加了可选 model）：会话就地装上，
      // 不碰 DSH 的全局默认——settings.yaml 那格只在用户手设过时才有值。
      // dshHome = 当前数据源：默认模型/预设从当前源的 settings.yaml 解析
      const dshHome = await currentDshHome(dataDir);
      let modelSelection = resolveModelSelection(parsed, dshHome);
      if (!modelSelection && parsed.action === "create") {
        const plan = await resolveCallerPlan(parsed, callerPlanDeps(ctx, dshHome, dataDir), (m) =>
          logLine(log, "[dsh-session] 会话模型：" + m),
        );
        if (plan.kind === "select") {
          modelSelection = {
            provider: plan.provider,
            model: plan.model,
            ...(plan.reasoningEffort ? { reasoningEffort: plan.reasoningEffort } : {}),
          };
          logLine(
            log,
            "[dsh-session] 会话模型随请求带上：" + plan.provider + "/" + plan.model +
              (plan.reasoningEffort ? "（推理强度 " + plan.reasoningEffort + "）" : ""),
          );
        } else {
          logLine(log, "[dsh-session] 会话模型不随请求带（" + plan.reason + "）：交给 DSH 的选择");
        }
      }

      // ④ 会话建立（create 新建 / send 沿用）：模型选择随 create 的请求一起下传
      let established: { sessionId: string; effectiveCwd?: string | null } | null = null;
      try {
        established = await establishSession(ctx, base, parsed, log, modelSelection);
      } catch (e) {
        await failTask(ctx, taskId, "DSH 会话建立失败：" + errText(e));
        throw e;
      }
      sessionId = established.sessionId;
      // create：会话已知后立即占住队列槽位（到任务终态释放；防 create 后立即 send 重叠）
      if (parsed.action === "create") releaseNewSessionTurn = enterSessionTurn(sessionId);
      // ⑤ 绑定回写宿主任务记录（先于 prompt；rpcId = prompt requestId = jsonl
      //    data.source.rpcId 关联键）。这份 metadata.dsh 就是全部下游的绑定事实源：
      //      · 受管 runtime 的 task-bridge / approval-bridge 按 sessionId 找 taskId；
      //      · provider 身份判定按 sessionId 决定带不带 taskId；
      //      · 句柄路径（taskId/approvalId）按它解析会话。
      //    执行超时与审批超时也随它下传（受管 runtime 读不到 App settings；0 = 宿主不自动拒绝）。
      //    写全量 dsh 对象：tasks.update 的 metadata 是整体替换还是浅合并，宿主契约没写死，
      //    给全量在两种语义下都正确。写失败抛错——绑定没落地 = 任务拿不到结果，不能当没事。
      const rpcId = nextRpcId();
      const timeoutSec = resolveTaskTimeoutSec(parsed.timeoutSec);
      const approvalTimeoutMs = resolveApprovalTimeoutMs();
      const back = await ctx.tasks.update(taskId, {
        metadata: dshMetadataFor(task || {}, {
          action: parsed.action,
          cwd: parsed.cwd || undefined,
          sessionId,
          rpcId,
          timeoutSec,
          approvalTimeoutMs,
        }),
      });
      if (!back || !back.taskId) {
        logLine(log, "[dsh-session][warn] 宿主任务绑定回写未确认（task=" + taskId + "）");
      }
      // ⑥ prompt（fire：{ accepted:true } 立即返回）：模型选择随这次 prompt 下传（send 路径）
      await rpcCall(ctx, base, {
        method: "session/prompt",
        rpcId,
        payload: {
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: parsed.taskText }],
          ...(modelSelection ? { model: modelSelection } : {}),
        },
      });
      logLine(log, "[dsh-session] prompt 已提交（" + parsed.action + "）session=" + sessionId + " rpcId=" + rpcId);
      // ready 后 execute 可返回；本后台继续等 task 终态（释放串行化锁）
      const loc = {
        action: parsed.action,
        sessionId,
        rpcId,
        taskId,
        delivery: TASK_DELIVERY,
        cwd: established.effectiveCwd || parsed.cwd || null,
      };
      resolveReady(loc);
      // 后台等到终态（child task-bridge complete/fail/canceled → 宿主投递来源会话）。
      // 执行超时：超时走 cancel 链（不是只 fail task——超时/撤销不默认
      // 批准、不给假成功）；超时确认也复用取消确认窗口（DSH 未确认时升级宿主 cancel）。
      const rec = await waitTaskTerminalWithTimeout(ctx, taskId, sessionId, timeoutSec, log);
      logLine(log, "[dsh-session] task 终态 " + ((rec && rec.status) || "?") + "（session=" + sessionId + "）");
      return loc;
    } catch (e) {
      // 提交阶段失败：任务 fail（已建时）+ ready reject。绑定记录的终态由宿主状态承担
      // （fail 之后宿主记录 status=failed，读侧即按“已终结”处理），不另写一份结束标记。
      if (taskId) {
        const msg = "DSH 任务提交失败（" + parsed.action + "）：" + errText(e);
        await failTask(ctx, taskId, msg);
        const err = new Error(msg) as Error & { sessionId?: string };
        if (sessionId) err.sessionId = sessionId;
        rejectReady(err);
      } else {
        rejectReady(e);
      }
      throw e;
    } finally {
      if (releaseNewSessionTurn) {
        try { releaseNewSessionTurn(); } catch { /* 忽略 */ }
        releaseNewSessionTurn = null;
      }
    }
  };

  const promise =
    parsed.action === "send"
      ? withSessionTurn(parsed.sessionId, runTask) // 同会话 send 串行
      : runTask();
  // 后台 promise 兜底：ready reject 已同步抛给调用方；promise 自身拒绝只记日志
  promise.catch((e) => {
    try {
      logLine(log, "[dsh-session] 后台任务异常：" + errText(e));
    } catch { /* 忽略 */ }
  });
  return { promise, ready };
}
