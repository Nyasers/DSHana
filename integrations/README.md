# integrations/ — hana 对官方 DSH 包的集成层（样例路线）

本目录承载「hana 对 DSH 的改动」，形态与官方样例 hana-dsh 一致：**薄集成贴上游版本**，
不是自研插件接管上游角色。

## 为什么要有这一层

改动贴着上游当前版本的源码走，不 vendor 冻结一份拷贝。vendor 的拷贝在落盘那一刻就冻结：
上游把 root 子槽从 `conversation/details` 改成 `sidebar + main(keyed)` 时，那份 frame 跟不上
→ 官方 occupant 挂不上、根钩子无人提供 → **真机全页黑屏**。

结论：hana 的改动必须**贴着上游当前版本的源码**，并且**有版本戳、有构建期闸**。

## 形态

```
integrations/<短名>/
  integration.json          # 清单：对应官方包、上游目录、overlay 文件与其「基于的上游哈希」
  files/<上游相对路径>       # overlay：整文件拷贝 = 上游该文件 + 我们的 delta
```

`integration.json`：

```json
{
  "package": "@deepseek-ai/dsh-client-ui-layout",
  "upstreamDir": "packages/client/ui-layout",
  "files": [
    {
      "path": "src/client/index.ts",
      "upstreamSha256": "<写入时上游同名文件的 sha256>",
      "deltaSha256": "<这份 overlay 相对上游改了什么的指纹>"
    }
  ]
}
```

两个哈希各管一件事，`upstreamSha256` 证明「贴的是这一版上游」，`deltaSha256` 证明「我们的
delta 还在」。后者由**改动的行内容**算出、不含行号（上游其他行小改不会让它变，delta 被冲掉
或改错必变）。行号每天都随上游漂，所以不写进清单：要看「我们改了哪几行」现场跑
`node scripts/integrations/index.mts delta [短名]`。

## 闸怎么响

`node scripts/integrations/index.mts verify`（已接进 `pnpm run build`，在最前）：

1. **镜像版本一致**：`vendor/deepseek-harness` 必须含 tag `dsh-v<版本>`，版本取自
   `packages/host/package.json` 的 `dependencies[@deepseek-ai/dsh]`（仓库根那份 devDependencies 里的
   同名声明的版本必须与它一致，闸会当场比）；
2. **overlay 未过期**：对每个 `files[].path`，重算**当前镜像该 tag 下同名文件**的 sha256，
   与清单里记录的比对。不一致 = 上游动过 → **构建失败**，并指出该 rebase 哪个文件、更新哪个哈希。
3. **delta 未丢**：重算 overlay 的 delta 指纹，与清单的 `deltaSha256` 比。上游哈希对得上但指纹
   不对 = rebase 时整份覆盖或三方合并把我们的改动弄丢了（哈希闸对这种情况完全不响）。

于是"拷贝即冻结"在流程上不可能：上游一变，构建就停，rebase 是显式动作。
若上游新增了符号而我们用不上，不会报错；**我们引用了不存在的符号**则由该包的编译/类型检查拦下（第二道闸）。

## 加一个集成

1. `integrations/<短名>/integration.json` 写好包名、上游目录；
2. 把「上游该文件 + 我们的 delta」整文件拷进 `files/<相对路径>`；
3. 记录上游同名文件的 sha256（`node scripts/integrations/index.mts hash packages/client/ui-layout/src/client/index.ts` 打印）；
4. `node scripts/integrations/index.mts delta <短名>` 取这份 overlay 的 `deltaSha256`，一并写进清单；
5. `pnpm run build` —— 闸会替你验证镜像、哈希与 delta 指纹。

## 边界

- **只写 delta**：overlay 文件里除必要改动外不留私货，便于上游升级时人工比对。
- **不改上游未涉及的包**。
- 产物版本号带 `<上游版本>+dshana-<我们的干净版本>`（例 `0.1.7-alpha.1+dshana-1.0.0-rc.18`）：
  安装树里一眼可见“这包被改过”、被哪个 dshana 版本改的。版本段只有一个来源——主
  `package.json`（合成在 `scripts/shared/version.mts`，与 derive/version 同一份）；
  清单里不写任何手写版本字段。
- 不做运行时 shim：与"贴上游 + 构建期有闸"的路线相悖。
