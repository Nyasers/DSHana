# tests/ —— 单测布局

## 约定

**路径镜像被测源**：一个测试文件放在它覆盖的那块源对应的组里，文件名 = 被测模块名（`<模块>.test.mjs`）。
跨域的按主语归位：`stream-gate` 测 `src/runtime/bridge.ts` 的闸门，进 `runtime/`；`tool-ctx` 测
`src/lib/app-runtime.ts` 的执行上下文，进 `lib/`。

| 组 | 覆盖 |
|---|---|
| `lib/` | `src/lib/**`：纯函数与状态机（模型选择、数据源、会话串行化、流帧、任务归属…） |
| `routes/` | `src/routes/**`：App 路由的挂载与响应 |
| `runtime/` | `src/runtime/**`：桥、中继、任务桥、子进程参数（部分真起 http/socket） |
| `tools/` | `src/tools/**`：dshana 工具的取数与出卡字面量 |
| `ui/` | `src/ui/**`：壳页注入的桥、剪贴板影子、流载体 |
| `cordis/` | `src-cordis/**`：主题适配层（规则表 + 桥）与 provider 插件 |
| `build/` | 构建与交付面约束：集成层漂移闸、依赖版本、产物语法、打包清单 |
| `e2e/` | 真机探针与 smoke（`.probe.mjs` / `.smoke.mjs`），**不进** `pnpm test` |
| `fixtures/` | 测试夹具（`cordis-user-plugin` 是给真机验收用的 dsh 插件，不是自动测试） |

## 运行

- `pnpm test` = `node --test tests/`：递归收集 `tests/**/*.test.mjs`，其余文件不参与；
- 只跑一组：`node --test tests/runtime/`；
- 打包产物的启动 smoke：`pnpm run smoke:packed`。

## 写测试时注意

- 从 `import.meta.url` 推本仓根时按层数写：`tests/<组>/x.test.mjs` 的仓根是 `"..", ".."`，
  被测源是 `"../../src/…"`。组内**不再往下分层**——层数一变，这些相对路径全要跟着改。
- 夹具与 e2e 各自在 `fixtures/`、`e2e/`，别在组目录里另建同级资源目录。
