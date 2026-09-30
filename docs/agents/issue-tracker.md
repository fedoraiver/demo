# Issue tracker: GitHub

本仓库的需求、缺陷和 PRD 记录在 [fedoraiver/demo 的 GitHub Issues](https://github.com/fedoraiver/demo/issues)。

使用已连接的 GitHub 工具或已登录的 `gh` CLI 操作。使用 CLI 时显式指定 `--repo fedoraiver/demo`，并通过 `git remote -v` 核对目标仓库。

## 常用操作

- 创建：`gh issue create --repo fedoraiver/demo --title "标题" --body-file <正文文件>`。
- 读取：`gh issue view <编号> --repo fedoraiver/demo --comments`；需要结构化内容时使用 `--json number,title,body,labels,comments,state,url`。
- 列表：`gh issue list --repo fedoraiver/demo --state open --json number,title,body,labels,url`；按需添加 `--label` 或调整 `--state`。
- 评论：`gh issue comment <编号> --repo fedoraiver/demo --body-file <正文文件>`。
- 添加或移除标签：`gh issue edit <编号> --repo fedoraiver/demo --add-label <标签>` 或 `--remove-label <标签>`。
- 关闭：`gh issue close <编号> --repo fedoraiver/demo`；需要说明时先添加评论。

多行正文先保存到 UTF-8 文件，再用 `--body-file` 传入，保留真实换行。
分诊标签名称见 [triage-labels.md](triage-labels.md)。

## 技能指令的含义

- “发布到任务跟踪器”：在上述仓库创建 GitHub Issue。
- “获取相关工单”：读取对应 Issue 的正文、标签和评论。

连接不可用时，明确说明限制，保留草稿；不要静默改用本地任务文件。
