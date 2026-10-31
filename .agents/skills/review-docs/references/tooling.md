# 文档审查工具

该工具为 [review-docs Skill](../SKILL.md) 提供可重复的清单、机械检查和审查记录。内容事实、文档归属、责任与义务仍需按 Skill 审查，独立终审仍由未参与编辑者完成。

## 准备

安装 Node.js 22.13 或更新版本。工具使用独立的精确依赖和锁文件，不依赖架构图工具包。首次在目标 worktree 显式安装依赖：

```powershell
pwsh -NoProfile -File ./.agents/skills/review-docs/scripts/check-docs.ps1 -InstallDependencies
```

依赖、缓存、会话和测试材料位于仓库根目录 `tmp/review-docs/`；安装后正常命令离线运行。脚本按自身所在 worktree 定位，可从其他工作目录通过脚本绝对路径调用。运行工具自身测试：

```powershell
pwsh -NoProfile -File ./.agents/skills/review-docs/scripts/check-docs.ps1 -Test
```

## 工作流

以下示例在 worktree 根目录执行，范围是 `docs/AGENTS.md`。初始化会冻结开始时的基线；当前内容指纹与基线分开，会话文件自身不进入指纹。`--scope` 可重复，显式指定的范围不存在或没有候选文档时初始化失败，退出码为 `2`。`--base` 可指定 Git 基线；省略时冻结初始 HEAD，单纯的空提交不使证据失效。显式基线别名推进后旧证据失效，需创建新会话。

```powershell
$init = pwsh -NoProfile -File ./.agents/skills/review-docs/scripts/check-docs.ps1 init --scope docs/AGENTS.md | ConvertFrom-Json
$session = $init.sessionPath
pwsh -NoProfile -File ./.agents/skills/review-docs/scripts/check-docs.ps1 check --session $session --record
```

检查后由代理阅读目标及依据，处理发现并记录结果。以下示例假定两名代理已经分别完成内容审查与独立终审，且均无发现；只有实际执行并有依据时才能填写这些申报。严格报告还要求记录的机械检查通过，发现问题时先处理并重新检查。输入文件放在根 `tmp/review-docs/`。若只记录内容审查，严格报告会返回未完成。

```powershell
$evidence = @(@{ path = 'docs/AGENTS.md'; reference = '核对文档规范及其归属' })
$scope = @('docs/AGENTS.md')
$records = @(
  @{ schemaVersion = 1; type = 'assignment'; actor = 'reviewer'; scope = $scope; evidence = $evidence; role = 'reviewer'; execution = @{ model = 'gpt-6.1-sol'; effort = 'high'; forkTurns = 'none' } },
  @{ schemaVersion = 1; type = 'content_review'; actor = 'reviewer'; scope = $scope; evidence = $evidence; result = 'no_findings'; findings = @() },
  @{ schemaVersion = 1; type = 'assignment'; actor = 'independent'; scope = $scope; evidence = $evidence; role = 'independent_reviewer'; execution = @{ model = 'gpt-6.1-sol'; effort = 'high'; forkTurns = 'none' } },
  @{ schemaVersion = 1; type = 'independent_review'; actor = 'independent'; scope = $scope; evidence = $evidence; result = 'no_findings'; findings = @() }
)
$inputPath = Join-Path (Get-Location) 'tmp/review-docs/review-input.json'
foreach ($record in $records) {
  [System.IO.File]::WriteAllText($inputPath, ($record | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  pwsh -NoProfile -File ./.agents/skills/review-docs/scripts/check-docs.ps1 record --session $session --input $inputPath
}
pwsh -NoProfile -File ./.agents/skills/review-docs/scripts/check-docs.ps1 report --session $session --require-complete
```

`check --record` 保存检查结果；不带该选项时只检查。`report --require-complete` 对未完成的会话返回非零状态。输入或基点变化使证据过期时，重新核对受影响内容并追加重新确认记录，不改写历史。报告的机械结果、逐文件覆盖状态与内容结论分别判断：机械通过不证明内容正确，清单或申报也不证明完成了阅读。

## 命令与记录

| 命令 | 用途 |
| --- | --- |
| `init [--scope path] [--base ref]` | 创建会话并冻结初始基线；`--scope` 可重复 |
| `check --session id-or-path [--record]` | 检查当前内容，可追加检查记录 |
| `record --session id-or-path --input JSON` | 从 JSON 文件追加审查或分工记录 |
| `report --session id-or-path [--require-complete]` | 汇总机械检查、覆盖和内容结论，可要求完整 |

各命令支持 `--workspace`。四个命令的标准输出为单个 JSON，标准错误输出摘要；成功响应的共同字段包括 `schemaVersion: 1`、`command`、会话 ID `session` 和 `sessionPath`。检查结果的 `discoveredDocuments` 是发现的文档数，`parsedDocuments` 是解析的文档数，`checkedDocuments` 是实际检查的来源文档数，包括范围外入链来源；这些数量不能代替内容审查覆盖。报告包含 `mechanical.status`、`coverage` 中每个文件的 `path` 和 `status`、`content.status`、`content.findings` 及 `complete`。CLI 出错响应包含 `schemaVersion` 和 `error`；启动脚本或依赖出错时查看标准错误。退出码 `0` 表示正常，`1` 表示检查发现问题或严格报告未完成，`2` 表示参数、依赖、会话或输入错误。

`record` 输入为 JSON 对象：

- `schemaVersion` 为 `1`，`type` 为 `assignment`、`content_review`、`independent_review`、`exclusion`、`delegation`、`return` 或 `reconfirmation`；`actor` 为非空字符串，`scope` 为会话范围内具体文档的非空仓库相对路径数组。
- 审查记录使用 `result`：`no_findings`、`findings` 或 `unverified`，并提供 `findings` 数组。每项包含 `severity`（`constraint`、`suggestion` 或 `unverified`）、`message`，可提供 `resolved`。
- `evidence` 是非空数组，每项包含 `path` 和非空 `reference`；`hash` 可省略，由工具采集当前文件指纹。
- `assignment` 和 `delegation` 还需 `role`（`editor`、`reviewer`、`independent_reviewer` 或 `links`）及 `execution`，其中包含 `model`、`effort`、`forkTurns: "none"`，可提供 `availableModels`、`availableEfforts`、`requestedModel` 和 `requestedEffort`。
- 审查记录须先有同一 `actor` 和范围的相应 `reviewer` 或 `independent_reviewer` 分工；`return` 须对应委派并用于回收委派，仅记录 `content_review` 不算回收。工具从委派派生 `return.role`，调用者不必填写：`reviewer` 回收计入内容覆盖，`independent_reviewer` 回收计入独立覆盖，无需重复记录 `independent_review`，`links` 回收只表示委派结束。独立审查者不能是历史编辑者。
- 手工 `exclusion` 须提供 `reason`；每个排除文档须由排除决策者以外的人在最新排除记录之后作当前有效的独立审查或独立回收确认，严格报告才算完整。
- `reconfirmation` 还需 `eventId` 和 `reason`，由原审查者覆盖原事件完整范围并说明重新确认。

会话的 `baseline.json` 冻结初始状态，`events.jsonl` 以哈希链追加事件。代理身份、模型、分工、阅读和结论均为申报，工具不能证明真实调用或阅读；证据指纹只能帮助识别变更。已知生成产物和纯许可正文在发现清单及报告的 `exclusions` 中附规则理由，清单不计算其内容指纹或全量快照，不参与常规内容覆盖，也不要求逐项独立确认。手写的 `SOURCES.md`、`ATTRIBUTION.md` 等来源说明仍在内容范围内，保留事实和链接审查，不作一般措辞清理。明确记录其他排除和待审项，不能将它们算作已完成内容审查。

## 检查边界

工具检查本地 Markdown 链接、GFM 锚点与入链、Skill 结构、差异和记录有效性；具体实现和边界见[源码与测试](../scripts/)。HTTP 外链及其他协议单列为未验证，不联网爬取。工具不修改受控文档，不自动修复链接、执行文档中的命令、启动游戏、更新架构图或提交。检查结果不代表全仓语义审查通过。
