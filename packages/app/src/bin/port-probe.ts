// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// packages/app/src/bin/port-probe.ts — 向系统要一个「此刻确实可绑」的回环端口号，打到 stdout。
//
// 为什么单独成一个入口（rspack 的第三个 entry，产物 bin/port-probe.mjs）：这段逻辑必须跑在
// 一个**带 --allow-net** 的进程里。App 主进程被 Hana 的权限模型管着，不能 listen；而它 spawn
// 出去的子进程只要显式带 --allow-net 就能 listen（权限不继承，实测父进程无 --allow-net 时
// 子进程带 --allow-net 仍 bind 成功）。
//
// 为什么要探针而不是区间盲抽：中继端口要注册给宿主的 service.port，必须是确定整数
// （SDK 契约：never a port a child printed and the host guessed，所以不能传 0）。而盲抽会撞上
// Windows 的保留段（Hyper-V / WSL 占的），落进去就是 EACCES。bind(0) 拿到的号由系统保证可用。
//
// 输出协议：成功时 stdout 恰好一行端口号；失败时 stderr 一行原因、退出码 1。
// 不输出别的东西——调用方按整行解析，多余日志会污染结果。

import { createServer } from "node:net";

const server = createServer();
server.once("error", (error: { code?: string }) => {
  process.stderr.write(String(error?.code ?? error) + "\n");
  process.exit(1);
});
// 只绑回环：这个号要交给宿主当中继端口，不该对外可达。
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  server.close(() => {
    if (port > 0) {
      process.stdout.write(port + "\n");
      process.exit(0);
    }
    process.stderr.write("bind(0) 未返回端口\n");
    process.exit(1);
  });
});
