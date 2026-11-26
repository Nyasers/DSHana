// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/runtime/src/data-source.ts — DSH 数据目录与自持设置存储
//
// 数据目录固定为 <dataDir>/.dsh（命名与 DSH 自身默认 ~/.dsh 统一）：不读 <dataDir>/dsh-home，
// 不做迁移，也没有运行中换源的通道——DSH_HOME 在子进程启动之前就已定下，一个 App 只有一份。
//
// 为什么自持一份设置文件而不是用宿主 contributes.settings / ctx.storage：
//   · DSH_HOME 必须在子进程启动**之前**定下，而子进程读不到 App ctx.storage（跨进程），
//     故两进程共享可读处只有 dataDir 下的文件；
//   · DSH 未运行时（设置页仍可达）也要能读写这份设置。
//   形态：{version, revision, settings}；0600 + 原子写（.pending → rename）；
//   revision 供乐观并发（冲突回 409）。
//
// 本模块是叶子（只依赖 app-runtime 取值助手），不做 runtime 启停。
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppRuntime } from "./app-runtime.ts";
import { APP_SETTING_DEFAULTS, resolveApprovalTimeoutSec, resolveDefaultTimeoutSec } from "./config.ts";
import {
  FORCE_FOLLOW_FACES,
  normalizeForceFollowFaces as normalizeFacesStrict,
} from "@dshana/shared/face-theme.ts";

export const SETTINGS_VERSION = 1;
/** 数据目录名：与 DSH 自身默认目录 ~/.dsh 命名统一。 */
export const PRIVATE_HOME_NAME = ".dsh";
/** 固定 profile：runtime 只启动壳自有的这一个（目录由壳建并维护，层列钉在
 * packages/host/src/main.ts 的 PROFILE_BUNDLES）。名字要与那里的 PROFILE_NAME 一致。 */
export const PRIVATE_PROFILE = "dshana";
export const SETTINGS_KEYS = Object.freeze([
  "approvalTimeoutSec",
  "defaultTimeoutSec",
  "sessionModelMode",
  "sessionModelProvider",
  "sessionModelModel",
  "sessionModelReasoningEffort",
  "forceFollowFaces",
]);
export const DEFAULT_SETTINGS = Object.freeze({
  approvalTimeoutSec: APP_SETTING_DEFAULTS.approvalTimeoutSec,
  defaultTimeoutSec: APP_SETTING_DEFAULTS.defaultTimeoutSec,
  sessionModelMode: APP_SETTING_DEFAULTS.sessionModelMode,
  sessionModelProvider: APP_SETTING_DEFAULTS.sessionModelProvider,
  sessionModelModel: APP_SETTING_DEFAULTS.sessionModelModel,
  sessionModelReasoningEffort: APP_SETTING_DEFAULTS.sessionModelReasoningEffort,
  // 强制跟随宿主主题的面：声明与缺省都住在 shared（见该模块头注），这里只引不复制。
  // 之所以不落进 config.ts 的 APP_SETTING_DEFAULTS：那份缺省是给**不经过本存储**的消费者用的
  // （cancel-chain 直读 config.json 的 global.*），这张表没有那样的消费者——设置页与壳页都走
  // GET /dshana/settings。本表的完整缺省单点就是这里。
  forceFollowFaces: [...FORCE_FOLLOW_FACES],
});
/** 会话模型模式：caller = 跟随调用方会话当前在用的那条（缺省），custom = 用固定的一条。 */
export const SESSION_MODEL_MODES = Object.freeze(["caller", "custom"]);

/** 数据目录（dataDir 为 App ctx.dataDir）。 */
export const privateHomeOf = (dataDir) => join(dataDir, PRIVATE_HOME_NAME);

/** 数据源身份：home 给子进程当 DSH_HOME，profileName 给 runProfile，sourceId 给页面回显。 */
export function privateSource(dataDir) {
  return { sourceId: "private", home: privateHomeOf(dataDir), profileName: PRIVATE_PROFILE };
}

/**
 * 两个超时（秒）：整数 ≥ 0（0 = 显式禁用自动拒绝 / 交给调用方默认）；缺省填默认值。
 * 与其余设置同栈：一份设置、一个 revision（想改就带 expectedRevision，冲突就得 409）。
 */
function normalizeTimeouts(input): { approvalTimeoutSec: number; defaultTimeoutSec: number } {
  // 初值即默认（APP_SETTING_DEFAULTS 是常量）；循环只处理显式传入的值，避免 `out = {}`
  // 把返回类型推成 `{}`（spread 进 validateSettings 后两键在调用侧就消失了）。
  const out = {
    approvalTimeoutSec: APP_SETTING_DEFAULTS.approvalTimeoutSec,
    defaultTimeoutSec: APP_SETTING_DEFAULTS.defaultTimeoutSec,
  };
  for (const key of ["approvalTimeoutSec", "defaultTimeoutSec"] as const) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    // 只接受 number 类型：不当成字符串解析（Number([]) 是 0、Number("") 是 0，宽松转换会让脏值混进来）
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      throw new Error(key + " 必须是不小于 0 的整数秒（收到 " + JSON.stringify(raw) + "）");
    }
    out[key] = raw;
  }
  return out;
}

/**
 * 会话模型设置（工具建的会话用哪个模型）：模式限定两种；custom 时 provider/model 都要有。
 * caller 模式下那两个值原样保留（来回切不丢用户选过的那条）。
 */
function normalizeSessionModel(input) {
  const mode = input.sessionModelMode === undefined || input.sessionModelMode === null
    ? APP_SETTING_DEFAULTS.sessionModelMode
    : input.sessionModelMode;
  if (!SESSION_MODEL_MODES.includes(mode)) {
    throw new Error("会话模型模式只能是 caller 或 custom（收到 " + JSON.stringify(mode) + "）");
  }
  const out: {
    sessionModelMode: string;
    sessionModelProvider: string;
    sessionModelModel: string;
    sessionModelReasoningEffort: string;
  } = {
    sessionModelMode: mode,
    sessionModelProvider: "",
    sessionModelModel: "",
    sessionModelReasoningEffort: "",
  };
  for (const key of ["sessionModelProvider", "sessionModelModel", "sessionModelReasoningEffort"] as const) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string") throw new Error(key + " 必须是字符串（收到 " + JSON.stringify(raw) + "）");
    out[key] = raw.trim();
  }
  if (mode === "custom" && (!out.sessionModelProvider || !out.sessionModelModel)) {
    throw new Error("会话模型选「自定义模型」时需要 provider 与 model 都填");
  }
  return out;
}

/**
 * 强制跟随宿主主题的面（存储侧的口）：严格口径与词表都在 shared 的 normalizeForceFollowFaces
 * 里（声明单点），这里只包一层、把缺键当缺省，**不复制规则**。
 *
 * 与 normalizeTimeouts / normalizeSessionModel 同一形制：返回一个只含本组键的对象，供
 * validateSettings 铺进结果。空数组是合法值（显式「一个都不强制」），不得被当成缺省。
 */
function normalizeForceFollowFaces(input) {
  const raw = input.forceFollowFaces;
  return { forceFollowFaces: normalizeFacesStrict(raw === undefined || raw === null ? [...FORCE_FOLLOW_FACES] : raw) };
}

/**
 * 设置校验（纯函数）：未知键拒绝；两个超时必须是非负整数秒；会话模型模式与自定义选择；
 * 强制跟随宿主主题的面必须是候选面（词表外的值/重复项一律拒，见 shared/face-theme.ts）。
 */
export function validateSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("DSH 设置必须是对象");
  }
  const unknown = Object.keys(input).filter((k) => !SETTINGS_KEYS.includes(k));
  if (unknown.length) throw new Error("DSH 设置含未知键：" + unknown.join("、"));
  return {
    ...normalizeTimeouts(input),
    ...normalizeSessionModel(input),
    ...normalizeForceFollowFaces(input),
  };
}

/**
 * 读侧兼容：settings.json 缺两个超时键时，从 <dataDir>/config.json 的 global.* 读一次当初始值
 * （只在读路径生效，不当场落盘）；写设置时它们落进 settings.json，这条路只在缺键时用到。
 * 另丢弃退役键（会话流卡的展示档位；换源时代的 mode/path/profile）：它们没有对应行为了，留着
 * 只会撞上 validateSettings 的未知键拒绝、把整份设置读成失败。
 */
function withReadCompat(raw, dataDir) {
  const out = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  if (!("approvalTimeoutSec" in out)) out.approvalTimeoutSec = resolveApprovalTimeoutSec({ dataDir });
  if (!("defaultTimeoutSec" in out)) out.defaultTimeoutSec = resolveDefaultTimeoutSec({ dataDir });
  delete out.sessionCardDisplay;
  delete out.mode;
  delete out.path;
  delete out.profile;
  // forceFollowFaces 是后加的键：存量 settings.json 里没有它，读回来必须补缺省（不抛错）。
  // 它不需要在这里先占位——最后铺默认时自然落位，而先占位会让 DEFAULT_SETTINGS 的缺省永远读不到。
  // 显式写了空数组的存档要原样留着（"in" 判定为真，缺省不覆盖它）。
  // 其余键同样缺省落位；顺序要紧：先补完那两个旧位置的超时，缺哪个补哪个，
  // 然后才铺默认，否则默认会先把键占住、那份兼容值就永远读不到了。
  return { ...DEFAULT_SETTINGS, ...out };
}

function clone(v) {
  return structuredClone(v);
}

/**
 * 自持设置存储（ctx.dataDir/settings.json，0600，原子写）。
 * 读失败（文件损坏/版本不符）抛错——设置是 DSH 启动与超时判定的依据，静默回退会让行为不可预期；
 * 文件不存在 = 未设置过，回落默认。
 */
export function createDataSourceStore(ctx) {
  if (!ctx || typeof ctx.dataDir !== "string" || !ctx.dataDir) {
    throw new Error("data-source: 需要 App ctx（ctx.dataDir）");
  }
  const filename = join(ctx.dataDir, "settings.json");
  let cached: SettingsSnapshot | null = null;

  const store = {
    async read() {
      if (cached) return clone(cached);
      let stored;
      try {
        stored = JSON.parse(await readFile(filename, "utf8"));
      } catch (e) {
        if ((e as any)?.code === "ENOENT") {
          cached = {
            version: SETTINGS_VERSION,
            revision: 0,
            settings: validateSettings(withReadCompat({}, ctx.dataDir)),
          };
          return clone(cached);
        }
        if (e instanceof SyntaxError) throw new Error("DSH 设置文件不是合法 JSON：" + e.message);
        throw e;
      }
      if (!stored || typeof stored !== "object" || stored.version !== SETTINGS_VERSION) {
        throw new Error("DSH 设置文件版本不受支持（version=" + JSON.stringify(stored && stored.version) + "，本版 " + SETTINGS_VERSION + "）");
      }
      if (!Number.isSafeInteger(stored.revision) || stored.revision < 0) {
        throw new Error("DSH 设置文件 revision 非法（" + JSON.stringify(stored.revision) + "）");
      }
      cached = {
        version: SETTINGS_VERSION,
        revision: stored.revision,
        settings: validateSettings(withReadCompat(stored.settings, ctx.dataDir)),
      };
      return clone(cached);
    },

    /** 写入（原子）：revision +1；只写设置，不触碰数据目录内容。 */
    async write(input) {
      const previous = await store.read();
      const settings = validateSettings(input);
      const next = {
        version: SETTINGS_VERSION,
        revision: previous.revision + 1,
        settings,
      };
      await mkdir(ctx.dataDir, { recursive: true }); // 目录归宿主建，这里只保证写原子文件时它在
      const pending = filename + ".pending";
      await writeFile(pending, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await rename(pending, filename);
      cached = next;
      return clone(next);
    },
  };
  return store;
}

/** 设置快照（settings.json 的内存形态；settings 的形状由 validateSettings 把关）。 */
interface SettingsSnapshot {
  version: number;
  revision: number;
  settings: any;
}

/** 自持设置存储的接口面（createDataSourceStore 的产物）。 */
export interface DataSourceStore {
  read(): Promise<SettingsSnapshot>;
  write(input: unknown): Promise<SettingsSnapshot>;
}

let storeRef: DataSourceStore | null = null;

/** 单例存储（同一 App 进程一份）。测试可用 resetDataSourceStore 复位。 */
export function dataSources(ctx = null): DataSourceStore {
  if (storeRef) return storeRef;
  const c = ctx || (getAppRuntime() || {}).ctx;
  storeRef = createDataSourceStore(c);
  return storeRef;
}

export function resetDataSourceStore() {
  storeRef = null;
}

/**
 * 同步读设置：只给同步调用面用（cancel-chain 的超时解析是同步的，异步化会往外扩散）。
 * 不走 store 的内存缓存：这份文件只有几行，"改完即时生效"比省一次读更重要。
 * 读失败（损坏/版本不符）抛错，与 store 同口径；文件不存在则回落默认。
 */
export function readSettingsSync(dataDir) {
  const filename = join(dataDir, "settings.json");
  let stored;
  try {
    stored = JSON.parse(readFileSync(filename, "utf8"));
  } catch (e) {
    if ((e as any)?.code === "ENOENT") return validateSettings(withReadCompat({}, dataDir));
    if (e instanceof SyntaxError) throw new Error("DSH 设置文件不是合法 JSON：" + e.message);
    throw e;
  }
  if (!stored || typeof stored !== "object" || stored.version !== SETTINGS_VERSION) {
    throw new Error(
      "DSH 设置文件版本不受支持（version=" + JSON.stringify(stored && stored.version) + "，本版 " + SETTINGS_VERSION + "）",
    );
  }
  return validateSettings(withReadCompat(stored.settings, dataDir));
}
