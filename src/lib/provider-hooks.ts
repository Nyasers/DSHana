// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/provider-hooks.ts — 受管 runtime 内「provider 目录重载」钩子的键约定
//
// 装钩子的是 @dshana/provider 子插件（cordis 插件 bundle），用钩子的是 dsh-host 入口
// （本 runtime bundle）：两者同进程但不能互相 import（与 lib/model-requests.ts 的
// MODEL_REQUEST_GLOBAL_KEY、__dshanaHana 同款约定），所以键名在两侧字面一致。
//
//   globalThis.__dshanaReloadModels = async () => boolean
//
// 语义：重拉宿主模型目录（hana.models.list），与 DSH 侧当前路由/目录比较；有差异才更新并
// 重注册（DSH 的 registration.replace 会广播 llm/adapters-updated，前端模型目录据此刷新）。
// 返回是否真的变了。钩子不在场（插件未激活/已退场）时调用方按“无变化”处理。

export const PROVIDER_RELOAD_GLOBAL_KEY = "__dshanaReloadModels";
