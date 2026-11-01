# 维护流程与执行记录

实际维护时先读取本参考，再按阶段读取[调度](schedules.md)、[对象模型](object-model.md)、[绘图](rendering.md)、[查看器](viewer.md)及[视觉验收](visual-validation.md)中涉及的规则。局部任务按相关阶段执行；仅修改 Skill 的检查边界见[入口](../SKILL.md#读取与范围)。

## 维护输入与文件归属

[共享分析工具](../../../../tools/rustc-analysis/Cargo.toml)分为独立数据契约、rustc 编译器分析和普通运行层三个 crate。编译器提取事实，运行层连接真实 Schedule 并装配语义图；`docs/diagrams/src/` 只校验分发契约、投影可见图和生成页面，不解析 Rust 源码。

工作区 `tmp/ecs-architecture/compiler/` 保存 `facts.json`、`runtime.json`、`model.json`、`model.calls.ndjson`、`pending-descriptions.json`，以及 `debugdump/` 内的真实清单与 DOT。模型主文件与调用图 NDJSON 是一组必需输入、阶段输出和分发产物；调用图按块读取，逐边校验其身份、注册对象和源码，再核对整体哈希与准确边数，不能为缩小文件而删除调用证据。[中文注释目录](../../../../docs/diagrams/catalog/annotations.json)保存用途和短说明，不承载类型、访问、注册、操作或源码行号。正式文件归属、生成目录及命令见[图的说明](../../../../docs/diagrams/README.md#目录与加载)。

维护执行器在 [scripts/](../scripts/maintenance-cli.mjs)，仍通过 `npm run maintain --prefix docs/diagrams -- <命令>` 调用。使用图包的一份锁文件和依赖环境，不另建 npm 环境；编译器工具产物使用所属检出的根 `tmp/rustc-analysis/`，Cargo 分析缓存与报告使用短目录 `tmp/ra/`。

## 角色与默认模型

主代理按范围选择角色，可顺序复用子代理；下列模型和 reasoning effort 使用当前委派接口支持的值。主代理统筹输入、依赖和用户已授权的结果合并，不将 PR 合并或其他分支变基视为默认维护任务。

| 角色 | 默认模型与 reasoning effort | 职责 |
| --- | --- | --- |
| 架构维护 | `gpt-6.1-sol` / `high` | 维护提取器、语义装配与用途说明；结构事实以编译器和真实快照为准。 |
| 独立复审 | `gpt-6.1-terra` / `high` | 复核事实边界、用途和验收缺口，不复审自己参与的修改。 |
| SVG 目测 | `gpt-6.1-terra` / `medium` | 子代理实际查看分配的 SVG，记录逐图证据。 |
| HTTP／浏览器验收 | `gpt-6.1-sol` / `medium` | 核对冻结后的页面、资源、交互及访问边界。 |
| 检查执行 | `gpt-6.1-terra` / `low` | 执行确定的检查并收集退出结果和日志，不补猜结构事实。 |

仅在具体歧义仍无法消除或同一原因的修复再次失败时，将相关角色的 reasoning effort 提高到 `xhigh`，并记录原因。复杂修改可拆分互不覆盖的任务。

## 委派、单写者与恢复

委派时给出工作区、输入提交及未提交变更指纹、文件范围、依赖和交付证据。同一工作区的分析契约、生成入口及共享索引各指定单写者；Cargo 由单一 owner 串行安排，其他代理读取结果。工作区执行锁不代替跨 worktree 的 Cargo 排队。

确定性的计划、执行、恢复、计时和 SVG 证据管理统一使用[维护入口](../../../../docs/diagrams/README.md#生成与校验命令)。阶段记录在所属工作区 `tmp/ecs-architecture/maintenance/`；恢复时核对内容、进程、输出和退出，不凭 session 标识或 mtime 判定成功。已完成代理用会触发执行的接口唤醒，不只发送普通消息。

## 事实提取与预检

先运行 `npm run maintain --prefix docs/diagrams -- plan`。`run` 按必要性准备依赖、提取编译器事实与真实 Schedule、装配模型，再执行预检、生成、校验和完整 Node 回归。没有有效事实或必要绑定时停止下游，不启动 Chromium 补造对象。

编译器源码位置随提取结果生成，不维护人工行号修复命令。新的声明、类型实例、实体模板和注册使用自身身份，不保留旧扫描器双跑、旧 ID 迁移映射或新旧模型等价验收。

## 中文用途补写

模型缺少用途时，CLI 返回退出码 `3`；执行器记录 `needs-descriptions`，在编译器输出目录保留 `pending-descriptions.json`。按待补项的 `key`、`evidenceHash` 和 `sourceEntries` 阅读精确源码、函数体及必要 helper，在 `annotations.json` 的 `items` 中填写 `description`、`summary` 和对应证据哈希。已有有效用途或源码中的中文文档可复用。

系统用途应说明主要输入输出、条件和清理职责，类型用途应说明承载的数据，Local 应区分函数与参数槽。不要翻译名称、罗列参数或用通用 API 模板代替职责。源码事实有歧义时修正提取器或保留具体缺口，不让模型在注释文件添加结构覆盖。

补写后执行 `run --resume <run-id>`，重跑模型及受影响下游；事实、工具和配置未变时不重复提取。未补齐必要中文用途前不发布正式产物。

## 结果复用与执行

编译器报告绑定工具实现、编译器提交、Cargo 编译单元、target、features、锁文件和源码内容。Cargo 复用依赖产物时仍须有有效分析报告；缺失或源码哈希不符时，仅在专用缓存使相关包失效重编。真实 Schedule、类型关联和 DOT 必须属于匹配的构建上下文，不能混用不同编译的运行时类型哈希。

依赖与锁文件匹配时不重复安装；渲染输入、配置和工具匹配时复用合法缓存，仍保留文字、身份及几何检查。仅用途或呈现变化时重跑对应阶段，不重做输入未变且已通过的编译器提取。

```text
npm run maintain --prefix docs/diagrams -- run
npm run maintain --prefix docs/diagrams -- run --resume <run-id>
npm run maintain --prefix docs/diagrams -- report --format markdown
```

失败、中断和未知退出均不作为成功。自动检查稳定后进入[冻结与视觉验收](visual-validation.md)，交付时分别报告编译器事实、真实导出／导入、用途、模型与图形检查，以及实际 SVG、浏览器和协议观察。
