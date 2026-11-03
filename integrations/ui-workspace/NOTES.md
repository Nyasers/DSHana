# ui-workspace

会话行三条面（重命名弹窗 / 归档确认 / 行提示）的跨面转发。

为什么在 ui-workspace：这三条是它 `apply` 闭包自己所有（`shortcutControls.rename`、
`archiveRequest`、`rowToast` / `notify`），而会话列表只住在 FP。FP 是局部面，app 级 overlay 那一层
不归它（ui-layout 的门），于是三条面在 FP 里没有落点。

面间直投通道（surface-bridge 的 `publishIntent` / `readIntentState` /
`registerIntentLanding`；词表与载荷归一在 `@dshana/shared/shared-state.ts`）把 FP 的「发起」指名投
到整幅面，三处发射：

- rename 的两条路径（行菜单 / `session.rename` 快捷键）经包装过的 `controls.rename` 收口；
- 归档确认在 `archiveInjected.archiveSession` 的拒绝分支（带 `displayTitle` 与 `activity`——拒绝事实
  只有发射端有）；
- `notify` 全部提示。

落地只在 workspace / standalone 面订阅；三条都是一次性动作，通道不回放（重开主卡不重放）。

已知代价：归档提示的「筛选已归档」按钮落地在整幅面，而会话列表在 FP。那一格要真的生效，得再有一条
反方向（整幅面 → FP）的列表筛选意图，本批不做。

不做运行时 shim：与「贴上游 + 构建期哈希闸」的路线一致。旧 path 引用的 contract / shortcuts 等由
上游整包提供。

## 贴 navigation.ts

跨面同步要在 main 面落「清空」这一步，而 `UiWorkspace` 的公开面没有清空入口（`clearMain` 是私有
的）。触发场景：FP 在无工作台时新建会话、或归档当前会话时，上游把主视图清掉并把
`dsh.sessions.current` 写成空。做法：`navigation.ts` 整体贴进来，在接口上加 `clearSelection()`，实现
转调同一份 `clearMain`。落点留在覆盖层，不改 vendor。

## 工作区框的落点（0.2.2-alpha.3 起）

0.2.2-alpha.3 把工作区重命名 / 删除的框提到了 apply 层：`requestWorkspaceAction()` 写一份
`workspaceActionRequest`，框组件 `WorkspaceDialogs` 由 `WorkspaceBrowser` 渲染，菜单项来自
`ctx.contextMenus.register({ id: 'workspace.rename' | 'workspace.delete' })`。

我们的 delta 因此只剩一处：`requestWorkspaceAction()` 在 FP（`emitsOnly`）改为发意图
（`workspace-rename` / `workspace-delete`），由整幅面的 `registerIntentLanding` 收回并写进同一份
`workspaceActionRequest`。框仍由那个组件渲染，但 FP 里这份 store 永不为非空，框只出现在整幅面——
这正是原来要修的那条：`Modal` portal 到本文档 body，在 FP 里只会铺满侧栏。

菜单项、框组件与 `rows/WorkspaceBrowser.tsx` 全部走上游原版，那一份 overlay 已从清单移除
（delta 归零）。以后这个文件的上游改动不再需要跟进，除非有人把框逻辑再搬回来。
