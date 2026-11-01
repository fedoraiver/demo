---
name: update-ecs-architecture
description: 更新、核对或修复本项目的 ECS 架构图，包括 rustc 事实提取、真实 Schedule 导出、对象关系、Graphviz／Mermaid 产物、源码快照和视觉检查。
---

# 更新 ECS 架构图

在当前工作区维护 `docs/diagrams/`。rustc 提取声明、类型、访问、操作和源码证据，真实应用导出 Schedule 与 DOT，Rust 装配语义模型，Node 负责呈现。用户明确的维护范围优先，不据本 Skill 增设审批。

## 读取与范围

- 从仓库根读取 [AGENTS.md](../../../AGENTS.md)、[开发规范](../../../docs/development.md)、[当前架构](../../../docs/architecture.md)、[验证参考](../../../docs/testing/README.md)及[图的说明](../../../docs/diagrams/README.md)。
- 按[变更类型](../../../docs/testing/README.md#按变更类型选择检查)确定执行范围。仅修改本 Skill 的 Markdown 说明时，检查入口、步骤、事实、相对链接及工作区与修改保护规则，不递归执行提取、构建、Node 测试或图形验收；修改执行脚本或 Rust 分析工具时运行对应回归。
- 检查 `git status --short`、暂存与未暂存 diff，保留用户修改。按当前模型契约、编译器证据和真实运行时快照验收，不要求与旧扫描器或旧对象 ID 双跑对照。
- 原图、diff、日志及截图放根 `tmp/ecs-architecture/` 下的任务目录；正式产物留在 `docs/diagrams/`。只在用户要求时暂存或提交。

## 按阶段读取并执行

完整维护依次完成以下阶段；局部任务只读取涉及的参考及必要前置，不默认加载全部参考。

1. 计划与组织：读取[维护流程](references/workflow.md)，确定工作区、输入、单写者、Cargo 排队和检查范围；使用统一入口计划、执行、恢复和报告。
2. 取得事实：涉及 Schedule 时读取[调度快照与筛选模型](references/schedules.md)；涉及对象身份、类型、关系、源码或用途时读取[对象模型与源码](references/object-model.md)。取得同次构建的编译器事实与真实运行时快照；语义模型须同时保留 `model.json` 与其完整 `model.calls.ndjson`，校验全部调用边、哈希和边数。不用名称、正则或大模型补猜结构事实。
3. 补全中文用途：模型返回待补说明时，读取 `pending-descriptions.json` 中的确切声明、冻结源码和必要 helper，由大模型在 `catalog/annotations.json` 补写中文用途与短说明，再恢复模型阶段。不得修改提取事实来消除说明缺项。
4. 生成与交互：涉及对象投影、Mermaid 几何、样式或图例时读取[绘图规则](references/rendering.md)；涉及详情、搜索、筛选、选择、历史、焦点或资源加载时读取[查看器规则](references/viewer.md)。
5. 验收与交付：读取[视觉证据与验收](references/visual-validation.md)，冻结输入、复用有效证据并记录完成范围和缺项。实际 SVG 逐图目测及用户限定的抽样目测必须委派子代理，主代理统筹并复核证据。

## 关键边界

修改事实提取、语义装配或呈现入口并重新生成产物，不手改生成文件。编译器负责可确定的源码事实；大模型负责中文用途和业务解释；无法静态确认的行为保留具体缺口，不能由模型选取结构候选。几何检查不能代替实际观察。

不启动或操作游戏；允许的专用 Schedule 导出及其设备初始化边界见[调度输入](references/schedules.md#导出有效性与导入失败)。文档浏览器访问拒绝后的停止规则见[视觉验收](references/visual-validation.md#http协议拒绝与离线分发)，不得使用编译浏览器绕过限制。
