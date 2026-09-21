// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/probe/host-surface.mts — 查「宿主给应用的能力面」
//
// 两件事，各用各的事实源：
//   --app-bus（缺省）：应用能调什么、不能用什么。读**随仓 SDK 的已发布契约**
//     （node_modules/@hana/app-sdk/dist/app-bus-contract.js 的 APP_BUS_REQUEST_ALLOWLIST /
//     APP_BUS_EMIT_DENYLIST，直接 import 求值，不解析文本）——它是被承诺的那份，与宿主版本
//     一起走，比从压缩过的宿主 bundle 里猜稳。
//   --look <子串>：这个字面在**装好的宿主 server bundle** 里出现在哪（次数 + 一处上下文）。
//     用来回答「宿主自己有没有发/读这个东西」——例如 models-changed 是不是真的由宿主发射。
//     宿主是压缩单文件，只能按字面找；找不到就是找不到，不做推断。
//
// 用法：node scripts/probe/host-surface.mts [--app-bus] [--look <子串>]... [--context <字符数>]
//        [--home <HANA_HOME>] [--bundle <index.js>] [--sdk <app-bus-contract.js>]
// 退出码：0 = 全部命中；1 = 有 --look 没找到（或 SDK 契约读不到）；2 = 参数/环境问题。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const valuesOf = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};

function fail(code, message) {
  console.error("[host-surface] " + message);
  process.exit(code);
}

const repo = resolve(value("--repo") || process.cwd());
const home = resolve(value("--home") || process.env.HANA_HOME || join(homedir(), ".hanako"));
const context = Number(value("--context") || 220);

/** 最新一份宿主 server bundle（bundle/index.js）。 */
function newestBundle() {
  const root = join(home, "artifacts", "server");
  if (!existsSync(root)) return null;
  const found = [];
  for (const entry of readdirSync(root)) {
    const file = join(root, entry, "bundle", "index.js");
    if (existsSync(file)) found.push({ file, at: statSync(file).mtimeMs });
  }
  found.sort((a, b) => b.at - a.at);
  return found.length > 0 ? found[0].file : null;
}

/** 打印随仓 SDK 里的应用总线契约。 */
async function appBus() {
  const sdk = resolve(value("--sdk") || join(repo, "node_modules", "@hana", "app-sdk", "dist", "app-bus-contract.js"));
  if (!existsSync(sdk)) {
    fail(1, "读不到 SDK 契约：" + sdk + "（先 pnpm install，或用 --sdk 指定）");
  }
  const mod = await import(pathToFileURL(sdk).href);
  const allow = mod.APP_BUS_REQUEST_ALLOWLIST;
  const deny = mod.APP_BUS_EMIT_DENYLIST;
  if (!Array.isArray(allow) || !Array.isArray(deny)) {
    fail(1, "SDK 契约形状变了（app-bus-contract.js 里没有这两个数组）");
  }
  console.log("[host-surface] SDK 契约：" + sdk);
  console.log("\n== 应用可调用的 bus 动词 ctx.bus.request（" + allow.length + " 项）==");
  console.log(allow.join(" "));
  console.log("\n== 应用不许冒用的事件名 ctx.bus.emit（" + deny.length + " 项）==");
  console.log(deny.join(" "));
  console.log("\n（能订阅到什么另说：ctx.bus.subscribe 的 filter.types 不做类型过滤——"
    + "宿主发的事件都能看到，只是只对上面之外的自定义事件名才有 emit 权。）");
}

/** 在宿主 bundle 里找字面。 */
function look(needles) {
  const bundle = value("--bundle") ? resolve(value("--bundle")) : newestBundle();
  if (!bundle || !existsSync(bundle)) {
    fail(2, "找不到宿主 server bundle（用 --bundle 指定，或确认 " + home + " 下有 artifacts/server/*/bundle/index.js）");
  }
  const text = readFileSync(bundle, "utf8");
  console.log("\n[host-surface] 宿主 bundle：" + bundle + "（" + text.length.toLocaleString("en-US") + " 字符）");
  let misses = 0;
  for (const needle of needles) {
    let count = 0;
    let at = 0;
    let first = -1;
    while ((at = text.indexOf(needle, at)) !== -1) {
      if (first < 0) first = at;
      count += 1;
      at += needle.length;
    }
    console.log("\n== " + JSON.stringify(needle) + " 出现 " + count + " 次 ==");
    if (count === 0) { misses += 1; continue; }
    console.log(text.slice(Math.max(0, first - context), first + context).replace(/\s+/g, " "));
  }
  return misses === 0 ? 0 : 1;
}

const needles = valuesOf("--look");
let code = 0;
if (flag("--app-bus") || needles.length === 0) await appBus();
if (needles.length > 0) code = Math.max(code, look(needles));
process.exit(code);
