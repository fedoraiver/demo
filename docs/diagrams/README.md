# ECS 架构图第一版

打开 [交互式 HTML](ecs-architecture.html) 查看四个视图。文件内嵌图形与数据，可离线使用；滚轮缩放、拖动平移，点击卡片展开字段、读写声明和源码入口。详情中的组件与资源还可继续点击。

详情中的“源码位置”是链接，点击后在新页面打开 [源码查看页](ecs-source.html)，显示对应完整文件并定位、高亮指定行。源码页可切换文件，点击行号更新定位链接；两份 HTML 放在同一目录即可离线使用，无需启动服务。源码文本是生成时的快照，不会自动跟随工作区文件变化。

| 视图 | 独立 SVG | 阅读重点 |
| --- | --- | --- |
| App 总览 | [总览](ecs-overview.svg) | 插件装配、启动、逐帧阶段和主要数据流。 |
| 调度与读写 | [调度](ecs-schedules.svg) | 固定步与逐帧同步、命令应用点、输入与检查器阶段。 |
| 实体关系 | [实体与组件](ecs-relationships.svg) | 组件归属、普通实体引用、Bevy 关系与生命周期。 |
| 事件与 Observer | [通信](ecs-events.svg) | 七个 Observer、意图消费、视角请求、窗口缓冲消息。 |

粗实线表示执行先后；蓝虚线表示读取，绿实线表示写入，橙虚线表示事件触发。紫虚线表示普通 `Entity` 引用，紫实线表示 Bevy 关系。框的类型标签和颜色用于区分实体、组件、系统、Observer、共享资源、系统私有状态及引擎概览。

图按当前单角色原型的源码整理，包含第一／第三人称切换和世界检查器。实体框按角色汇总组件，可选组件并非始终同时存在；省略地面、光照等背景实体。引擎集合、检查器与渲染子应用只展示相关流程，不代表引擎全部系统的精确全序。源码入口对项目类型指向声明，对框架类型指向项目内的使用或注册位置。

固定模拟为 60 Hz，每个渲染帧可能执行 0～N 次。默认渲染上限为 60 FPS，允许配置的最低上限为 60；实际帧率仍取决于运行性能。Observer 按匹配事件触发，不由注册顺序组成流水线；Enhanced Input 的 `Apply` 与 ECS 命令应用是两个步骤。

[ecs-data.json](ecs-data.json) 保存经过源码核对的清单，[build-ecs.mjs](build-ecs.mjs) 生成交付文件，[source-viewer.mjs](source-viewer.mjs) 将清单引用文件的完整文本内嵌到源码查看页。架构图的清单、布局、关系、源码入口及生成校验统一归下面的 Agent Hook 维护职责；普通代码开发任务不逐次手动维护或刷新。分享时保留 `ecs-architecture.html` 和 `ecs-source.html` 的相对位置。

## Agent Hook 自动维护

架构图维护由专门的 Agent Hook 承担。该职责包含对照原图和本次源码变化，更新系统与 Observer 清单、插件装配、调度顺序、读写与过滤条件、组件和资源字段、实体关系、事件与消息、延迟命令可见时机，以及四视图布局、说明和源码路径、行号；随后生成 HTML、SVG 与源码快照并执行校验。布局及部分文字位于生成器中，维护范围不能只限于 JSON。

普通代码任务不承担上述手动维护、手动刷新或架构图专项验收。维护或生成失败由 Hook 记录原因、日志位置和未完成状态，并在 Hook 流程中处理与重试；失败不能报告为完成，也不将逐次人工维护重新作为普通开发任务的前置条件。Hook 不启动或操作游戏，临时文件统一保存在根 `tmp/`。

本生成器不分析 Rust 架构语义，校验器也不能识别所有新系统；Agent Hook 需负责语义输入。以上职责约定不代替实际 Hook 配置与实现，不能仅凭生成或校验成功认定语义维护已经完成。

### Git Hook 自动维护

Git [pre-commit](../../.githooks/pre-commit) 完成生成与校验，随后 [post-commit](../../.githooks/post-commit) 仅对齐提交后的索引。两者调用 [architecture-hook.mjs](../../.codex/hooks/architecture-hook.mjs)；Windows 通过 [PowerShell 入口](../../.codex/hooks/architecture-hook.ps1) 调用 Node.js，优先复用 Codex 桌面应用随附的运行时，其他环境需在 PATH 中提供 Node.js。实际生效状态以入口脚本与仓库配置为准。此流程不依赖 Codex 对话事件；`git commit --no-verify` 跳过提交前生成，提交后没有本次生成记录时也不修改索引。

首次克隆后，在仓库根启用项目本地 Hook。执行前检查当前 `core.hooksPath` 和生效 Hook 目录中的非 sample 文件；存在既有 Hook 时须先保留并整合，不能直接切换目录将其遮蔽。配置只影响本仓库：

```text
git config --local core.hooksPath .githooks
```

首次安装前，若本次候选索引不包含 `docs/diagrams/` 下的任何文件，且当前 HEAD 也没有 `ecs-data.json`，Hook 返回 `architecture_not_installed`，不运行生成或校验、不修改索引及正式产物。工作区未暂存的架构图文件不会参与判断，因此可先独立提交既有源码，再完整引入架构图工具。候选索引已包含任意图文件，或 HEAD 已包含模型时，缺少 `ecs-data.json` 仍会阻止提交；这项兼容行为不能用于绕过首次不完整安装或删除已安装模型的检查。

每次 `git commit`（包括 `--amend`、`-a` 和指定部分路径）写入提交前，Hook 通过 `git write-tree` 读取 Git 为本次提交提供的活动索引，将候选树导出到根 `tmp/git-hooks/architecture/<索引树ID>-<运行标识>/` 的独立快照中。在快照内生成两份 HTML、四份 SVG，并运行 [check-ecs.mjs](check-ecs.mjs) 校验清单一致性、系统图内覆盖、节点及 Observer 引用、函数入口、源码快照与 SVG 一致性。保留原图、本次 diff、生成与校验日志；`run.json` 记录状态及错误。临时文件不提交，Hook 不启动或操作游戏。纯问答和没有提交的工作区修改不触发生成。

候选树必须包含清单、生成器及其依赖（源码查看页生成器、校验器和引用源码）；首次引入时须暂存项目 Hook、清单、生成器、校验器及源码。Hook 只读取候选树中的输入，不使用工作区未暂存的修改补齐快照，也不自动暂存源码、清单、生成器或其他文件。校验通过后，仅将 `ecs-architecture.html`、`ecs-source.html` 和四份 SVG 的生成内容精确写入活动索引，随本次提交一起保存，不另行提交或 amend。部分暂存时，图和源码页表示本次提交选中的版本，工作区剩余修改不参与生成。校验不判断 Rust 架构语义，也不能识别所有新系统；语义输入由 Agent Hook 负责。

提交后的 `post-commit` 只将本次提交中六份已生成产物的 blob 对齐到 Git 提供的真实索引，不生成产物、不再次提交。同步要求本次 Git 进程的生成记录存在，且其中的候选树与当前 HEAD 树一致；其他运行留下的记录不能用于同步。普通索引及自定义 `GIT_INDEX_FILE` 的指定路径提交均支持此流程，避免提交后出现六份产物的反向暂存差异，其他已暂存文件保持原状。

工作区产物原本与索引或 HEAD 一致时，Hook 同步写回新产物；存在手工修改或生成期间的并发编辑时，保留该文件并在结果中列出。保留工作区文件不影响索引中的生成版本，因此提交内的产物仍来自已校验的候选快照；不要将保留的工作区产物重新暂存而覆盖 Hook 的生成结果。

生成或校验失败时，`pre-commit` 返回失败并阻止本次提交，原索引和正式产物保持不变。对应临时目录的 `run.json` 及生成、校验日志记录失败；不能报告生成成功。提交后的索引同步失败时，提交已经存在，不会回滚，也不重新生成；Hook 报告同步错误和待处理记录，按下面的命令重试对齐。原因处理及重试属于 Hook 维护流程。

### Hook 维护与排查命令

以下命令供维护或排查 Hook 时使用，不是普通代码任务的常规验收要求。手动重试读取当前索引，生成并暂存六份产物，但不执行提交：

```powershell
powershell -NoProfile -File .codex/hooks/architecture-hook.ps1 pre-commit
```

提交后的索引同步失败时，使用错误报告中的完整 Git 调用标识（进程 ID 与创建时间组合）重试。此命令只对齐六份已提交产物，不生成或提交；标识错误、记录缺失或候选树与 HEAD 不一致时不会修改索引：

```text
powershell -NoProfile -File .codex/hooks/architecture-hook.ps1 synchronize-index <Git调用标识>
```

排查工作区生成或校验问题时，可直接生成当前工作区产物并运行相关无窗口回归：

```text
node docs/diagrams/build-ecs.mjs
node docs/diagrams/check-ecs.mjs
node --test .codex/hooks/architecture-hook.test.mjs docs/diagrams/check-ecs.test.mjs
```

工作区生成读取当前源码与清单，覆盖六份产物但不自动暂存；它只进行渲染，不能代替 Agent Hook 的语义维护职责。`pre-commit` 重试只读取索引，排查工作区修改时使用上述生成命令。独立校验可能报告未刷新产物的源码入口或快照不符；校验仅允许 CRLF/LF 换行差异，不忽略其他源码内容变化。本次提交以 `pre-commit` 索引快照内的校验结果为准。Hook 回归在根 `tmp/` 的独立 Git 仓库执行真实提交、amend、`-a` 和普通、自定义索引的部分路径提交，检查暂存边界、生成失败保护、提交后索引对齐及重试，不修改主仓库历史。临时文件遵循 [临时文件管理](../development.md#临时文件管理)。

图描述代码结构与调度约束，不替代游戏运行或视觉验收。
