// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packaging/README.md — 交付树里的静态件
//
// 这个目录放「装出来的包根上要有、但仓库自己的构建入口又不能是它」的东西：
//
//   package.json   包根那份。仓库根那份 package.json 是**构建入口**（scripts / devDependencies /
//                  packageManager / imports 别名），装机侧一个都不消费（依赖已物化进包，安装不跑
//                  pnpm；别名在 build 期就解析掉了），整份复制过去只会让人读出错觉。交付树要的只有
//                  name / version / type 三件——三件里 version 是派生的（scripts/derive 的
//                  product-package 任务按仓库版本重写），name / type 是手写的实体。
//                  `type: module` 不能少：包根 index.js 是 ESM，Node 按「最近一份 package.json 的
//                  type」判定模块类型，缺了它宿主 import entry 会按 CommonJS 解析。
//                  pack 把它复制到包根，出包前 assertProductPackage 校验字段白名单与版本一致。
