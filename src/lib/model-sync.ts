// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/model-sync.ts — 宿主模型/提供商变更 → 受管 runtime 重拉目录
//
// 为什么要有这一层：DSH 侧的 provider 路由与模型目录是**启动快照**——@dshana/provider 在
// 插件激活时读一次 hana.models.list()。宿主改了提供商（设置页加/改凭据、models.json、
// 模型信息目录刷新）之后，DSH 里那份目录不会跟着变，得等 runtime 重启。宿主自己有变更广播：
// 它在 app_event 通道上发 { type: "app_event", event: { type: "models-changed", payload } }
// （设置写入、凭据/OAuth、目录刷新三条路都发）。本模块订阅它，再经既有控制面（/_control）
// 通知 runtime 重拉；runtime 侧重新注册 provider 路由后，DSH 广播 llm/adapters-updated，
// 前端模型目录据此自己刷新——不重启 runtime，也不重载插件。
//
// 订阅面按 APPS.md 的承诺用：ctx.bus.subscribe(callback, filter) 的 filter.types 不做额外
// 类型过滤（app_event 也在可观察范围内），回调拿到的是只读投影、至少隔一个异步回合才到。
// runtime 未就绪时不动：它启动时本来就要重新拉一次目录。
import { bridgeAccess } from "#/lib/managed-runtime.ts";
import { invokeControl } from "#/lib/controller.ts";
import { errText } from "#/lib/err-text.ts";

/** 宿主 app 事件里本模块关心的类型。 */
export const MODELS_CHANGED_EVENT = "models-changed";
/** runtime 控制面上重拉目录的动作名（处理见 src/runtime/main.ts）。 */
export const MODELS_REFRESH_ACTION = "models-refresh";

/**
 * 这条事件是不是「宿主模型目录已变更」。
 * @param event - ctx.bus.subscribe 回调收到的事件投影。
 * @returns 是则 true。
 */
export function isModelsChangedEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.type !== "app_event") return false;
  const inner = event.event;
  return !!inner && typeof inner === "object" && inner.type === MODELS_CHANGED_EVENT;
}

/**
 * 安装宿主模型变更订阅；变更时让受管 runtime 重拉一次目录。
 * @param ctx - 宿主 App ctx（要 ctx.bus 与 ctx.runtime）。
 * @param log - (level, ...args) 日志出口。
 * @returns 退订函数；宿主没有订阅面时是 no-op。
 */
export function installHostModelSync(ctx, log) {
  const bus = ctx && ctx.bus;
  if (!bus || typeof bus.subscribe !== "function") {
    log("info", "宿主无 ctx.bus.subscribe：模型变更不做实时同步（改宿主提供商需重启 runtime 生效）");
    return () => {};
  }
  const refresh = () => {
    const access = bridgeAccess();
    if (!access || !access.runtimeId) {
      log("info", "宿主模型目录已变更：受管 runtime 未就绪，跳过（它启动时会重新拉目录）");
      return;
    }
    invokeControl(ctx, MODELS_REFRESH_ACTION, {})
      .then((res) => {
        const changed = !!res && res.changed === true;
        log("info", changed
          ? "宿主模型目录已变更：runtime 重注册了 provider 路由（DSH 会广播 llm/adapters-updated）"
          : "宿主模型目录变更信号：runtime 侧无差异，未重注册");
      })
      .catch((e) => {
        log("warn", "宿主模型目录变更同步失败（下次变更或重启 runtime 后再试）：" + errText(e));
      });
  };
  try {
    const off = bus.subscribe((event) => {
      if (isModelsChangedEvent(event)) refresh();
    }, { types: ["app_event"] });
    log("info", "宿主模型变更订阅已安装（app_event/models-changed → 控制面 " + MODELS_REFRESH_ACTION + "）");
    return typeof off === "function" ? off : () => {};
  } catch (e) {
    log("warn", "宿主模型变更订阅安装失败（改宿主提供商需重启 runtime 生效）：" + errText(e));
    return () => {};
  }
}
