# api-terminal-controller

终端的会话工作目录前提：终端的 cwd 取会话头里的记录值，而那个目录可能在会话建立之后消失。

缝选在这里：terminal-controller 是「会话 → 终端工作目录」的唯一出口，Web 侧边栏终端的 cwd 就是
`environment()` 交出去的那个值。判定放在 `spawn()` 里、`workingDirectory.ensure()` 之后，只挡真正要
落地的那一刻；`list` / `retain` / `read` 这类对既有终端的操作不受影响。

## 为什么是显式失败而不是回落到一个活目录

终端的存在意义就是在会话工作区里跑命令，工作区不在时换一个目录开壳是静默的错误答案。而且 DSH 里
没有可回落的活目录：`sandboxPolicy.workspaceRoot` 本身等于 `session.header.cwd`（sandbox-policy 按
会话头解析根），两条路指向同一个已消失的路径。

报错带上绝对路径，用户能直接去修；错误码 `terminal/cwd-unavailable` 由本包在
`RemoteErrorDetailsMap` 上局部声明。

## 跨平台

这条前提三平台同源，只是失败的样子不同：win32 上 ConPTY 把 `CreateProcess` 的
`ERROR_DIRECTORY(267)` 收成一个子进程退出码（客户端显示成「进程已退出（267）」），POSIX 上 fork
出来的子进程 `chdir` 失败后立刻退出。两次都是没有指向的退出，所以在 provider 之前把前提点破。

客户端不映射这个码到 issue：`model.ts` 的 `fail()` 对未映射的码直接显示 message，因此不需要动
client 半。

## 0.2.1 起 cwd 的权威值来自 dsh-working-directory

`ensure()` 本身带恢复：当前目录消失时它会恢复到会话头记的原始项目并返回恢复后的路径。所以检查必须
排在 `ensure()` 之后。排在前面会抢在恢复动作之前抛出，把本来能救回来的那一次变成硬失败。此时检查的
也不再是环境读数，而是真要交给 `spawnTerminal` 的那个 cwd。

改序之后两处前提谁先谁后：`ensure()` 是主闸（当前目录与原始项目都不在时它自己抛），
`requireSessionWorkspace()` 退成 spawn 前的 TOCTOU 兜底，因为 ensure 到 spawn 之间那一小段里目录仍
可能被删。所以它留着，但它不再是「唯一的拒绝点」；报错码以 working-directory 的为主，
`terminal/cwd-unavailable` 只在那种窄窗里出现。
