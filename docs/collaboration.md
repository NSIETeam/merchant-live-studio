# GitHub 协作者迁移

核验日期：2026-09-11（Asia/Shanghai）。

- 源：`NSIETeam/otto-new`，公开个人仓库。
- 目标：`NSIETeam/merchant-live-studio`，私有仓库。
- 源协作者通过 REST `affiliation=all` / `direct` 全量分页以及 GraphQL DIRECT 交叉核对，共 4 人；没有待接受源邀请或关联团队。

| 账号           | 源权限        | 新仓库 API 实际返回权限 | 初始结果             |
| -------------- | ------------- | ----------------------- | -------------------- |
| NSIETeam       | admin / owner | owner                   | 仓库所有者，无须邀请 |
| Imd11          | write         | write                   | 已发出邀请，待接受   |
| Jeremy-Curry30 | write         | write                   | 已发出邀请，待接受   |
| krx521920      | admin         | admin                   | 已发出邀请，待接受   |

这是一份创建时快照，接受情况以 GitHub 实时状态为准。没有把“邀请已发出”视为对方已经加入。权限按目标邀请 API 的实际返回记录，没有使用推测权限。
