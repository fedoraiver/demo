# Agent Notes（决策记录）

Agent Note 记录值得长期保留的决策或提案：为什么需要它、考虑过哪些替代方案，以及选择它付出的代价。当前行为由对应的归属文档维护。

这类记录遵循本 README 的独立约定，不受 `docs/AGENTS.md` 约束。下文的记录格式适用于具体笔记，不适用于本 README。

## 目录与生命周期

路径使用 `{lifecycle}/{class}/YYYY-MM-DD-topic.md`。文件名日期为主题首次提出的日期，移动笔记时保持不变。

| 生命周期 | 用途 |
| --- | --- |
| `proposed/` | 等待决策或实施的提案 |
| `implemented/` | 已实施且决策依据仍能指导维护的记录 |
| `rejected/` | 已否决但否决理由仍有参考价值的提案 |
| `archived/` | 已实施、仅作为历史依据保留的决策 |

类别为 `feature`（新能力）、`bug-fix`（缺陷修复）、`simplification`（简化）、`architecture`（架构）、`process`（流程）和 `testing`（测试）。只有实际笔记需要时才创建目录。

直接通过活跃记录的生命周期目录查找笔记，不额外维护重复的中央索引。笔记之间使用相对 Markdown 链接。

## 何时编写

当代码、测试或现有文档无法充分承载长期决策依据时，新增或更新笔记，例如有意义的替代方案、归属边界、行为承诺或不明显的约束。

机械性修改和局部展示调整无需新增笔记。已有记录负责该决策时，更新原记录，避免重复。只记录实际考虑过的替代方案和真实依据，不为填满模板而虚构。

一次事故可能同时产生事故复盘和 Agent Note。事故复盘解释故障，Agent Note 维护为应对故障而作出的长期决策。

## 记录格式

每份活跃笔记以标题和状态开头：

```text
# Agent Note: <title>

Status: proposed | implemented | rejected — <reason>
```

按状态使用以下章节：

- `proposed`：`Problem`（问题）、`Proposal`（提案）、`Alternatives considered`（考虑过的替代方案）、`Acceptance criteria`（验收标准）、`Risks`（风险）。
- `implemented`：`Problem`（问题）、`Decision`（决策）、`Alternatives considered`（考虑过的替代方案）、`Consequences`（影响与代价）、`Verification`（验证）。
- `rejected`：保留提案内容，在状态行中记录否决理由。

验证章节记录持续适用的检查、覆盖范围和已知缺口。每次具体执行的结果仍放在关联 Issue 或 PR 中。

## 维护

提案实施后，移入 `implemented/`，更新状态，并用实际决策及其影响替换原计划。

路径、名称或相关契约变化时，同步更新仍活跃的已实施笔记。决策本身改变时，新建笔记并链接被取代的记录，不把原决策改写成相反结论。

已实施笔记的决策依据不再指导当前工作、但仍有历史价值时，将其归档。保留 `implemented` 状态，并增加 `Archived: YYYY-MM-DD`。归档记录仅作为历史依据，不随当前代码继续更新。

删除已无决策参考价值的记录，并修复指向它们的链接。尚未实施的提案不能归档；不再推进时应标记为否决。
