// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/dsh-session 自持构建描述（学官方 dsh 组织：配置随源码走）。
// 消费方：packages/app/src/cordis.ts（package.json build:cordis）扫描本文件 → preset →
// .cache/cordis/dsh-session/index.js。
// 约定：本文件存在 = 该包有 service 半（入口 packages/dsh/session/index.ts，rspack 打包为
// index.js，cordis loader 按包 main 原生 import）；本包无 client 半（浏览器端没有它的事）。
export default {};
