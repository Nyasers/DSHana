# ui-settings-general

设置跨面：「FP（navigation）点设置、主卡（workspace）打开」。逐字照样例 0.7.0 的
ui-settings-general 补丁，它的 `SettingsRoot.tsx` 是整套机制的读写端。

三处分叉（样例同款）：

- `role` 从宿主桥取（`bridge?.role ?? 'navigation'`），来自 `window.__DSHANA__.role`；
- `role === 'settings'` → `SettingsPanel` embedded（占满整列；panel / embeddedPanel 新 CSS）；
- `role === 'workspace'` → 只渲染 `{panel}{syncFailure}{onboarding}`，**不画触发器**（这就是它不漂顶
  的原因）；
- 其余（`navigation` = FP）→ `triggerRow`（齿轮）+ panel + syncFailure + onboarding。

## 共享状态

`publish()` 把 `{open, section}` 经通用面 `bridge.publishIntent('settings-view', …)` 指名投递过去
（revision 守卫防晚到覆盖）；只有 workspace / standalone 用
`bridge.registerIntentLanding('settings-view', …)` 落地跟随（FP 是发射端）。所以 FP 点齿轮 → 写共享
状态 → 主卡读到就开面板；两边都开着时是主卡出面、FP 只留入口。

## 配套改动（同一批）

- `integrations/ui-layout` 恢复 workspace 的 `settingsShell`（落点）；
- `packages/ui/src/app-shell.ts` 发布 `VIEW_STATE_API`（read / write / onChanged，落在
  `hana.storage.global`，键 `dshana.settings-view`：单 DSH 源、单主卡，不长卡片实例段）；
- `packages/ui/src/dsh-inject.ts` 的 `installTransport` 把 bridge 面合并进 `__DSHANA__`。

样例额外按 `sourceId` 分域；我们单源，注释里留了位。`locales.ts` 加
`view.readError` / `view.writeError` / `view.retry` 三键。
