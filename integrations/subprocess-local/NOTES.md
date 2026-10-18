# subprocess-local

spawn 的工作目录前提：同一个「会话工作目录消失」的前置条件下，终端之外的两个出口——bash / 文件工具
的普通 spawn、模型侧 `terminal_open` 的 PTY spawn。

缝选在这里：本包是 subprocess cap 的本地实现，两个 spawn 出口（普通 `spawn` 与 `spawnTerminal`）都
定义在 `src/index.ts`，这是三平台唯一的共同收口点。判定放在各自落地之前（`validateSubprocessSpec`
之后 / provider 分配之前），失败形态与 node 自己的 `chdir` 报错同形：`code ENOENT/ENOTDIR` + path +
`syscall=chdir`。两条路原先都指错了对象——普通 spawn 那条会把 `CreateProcess` 的
`ERROR_DIRECTORY` 折成「spawn <程序> ENOENT」，PTY 那条则把同一个码漏成裸退出码（win32 侧边栏终端
的「进程已退出（267）」）。

## 为什么只重打 src/index.ts

本包发布的 lib 是多文件 bundle（`index.js` 依赖共享 chunk，另有 `runner.js` 与 `output.js` 两个独立
入口）。共享 chunk 的模块级状态不与 `index.js` 同进程共享：`runner.js` 是被 spawn 出去的子进程
（自带一份模块实例），`output.js` 的消费者是 ssh 侧。因此只重打入口不会造成跨文件的状态分裂
（两条链路本来就不共享进程内实例）。

## 与 terminal-controller 那个集成的分工

那边是「用户侧终端」的显式拒绝（带路径的落点提示），这边是 provider 级的兜底。模型侧
`terminal_open` 不经 terminal-controller，普通 spawn 也完全是另一条路，所以同一前提要在两个出口各挡
一次。
