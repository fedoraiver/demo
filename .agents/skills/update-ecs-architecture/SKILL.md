---
name: update-ecs-architecture
description: 更新、核对或修复本项目的 ECS 架构图，包括真实 Schedule 导出、逐对象关系、Graphviz／Mermaid 产物、源码快照和视觉检查。用于架构图维护请求。
---

# 更新 ECS 架构图

在当前工作区维护 `docs/diagrams/`。Schedule 图使用真实应用的 debugdump 导出与 Graphviz；对象图使用已核对清单与 Mermaid。用户明确的维护范围优先，不据本 Skill 增设审批。

## 读取与范围

- 从仓库根读取 [AGENTS.md](../../../AGENTS.md)、[开发规范](../../../docs/development.md)、[当前架构](../../../docs/architecture.md)、[验证参考](../../../docs/testing/README.md)及[图的说明](../../../docs/diagrams/README.md)。
- 按[变更类型](../../../docs/testing/README.md#按变更类型选择检查)确定执行范围。仅修改本 Skill 或其说明时，只检查入口、步骤、事实、相对链接及工作区与修改保护规则，不递归执行本 Skill 的导出、构建、Node 测试或图形验收。
- 检查 `git status --short`、暂存与未暂存 diff。使用用户指定基线；未指定时对照原产物、清单和当前源码，保留用户修改。
- 原图、diff、日志及截图放根 `tmp/ecs-architecture/` 下的任务目录；正式产物留在 `docs/diagrams/`。只在用户要求时暂存或提交。

## 按阶段读取并执行

完整维护依次完成以下阶段，在进入阶段前读取对应参考；局部任务只读取涉及的参考及其必要前置，不默认加载全部参考。

1. 计划与组织：读取[维护流程](references/workflow.md)，确定输入、角色、单写者、执行记录及检查范围；使用统一入口计划、预检、执行、恢复和报告。
2. 核对真实输入：涉及 Schedule 时读取[调度快照与筛选模型](references/schedules.md)；涉及对象清单、身份、关系、源码或用途时读取[对象模型与源码](references/object-model.md)。完整维护在核对阶段读取二者。
3. 生成与交互：涉及对象投影、Mermaid 几何、样式或图例时读取[绘图规则](references/rendering.md)；涉及详情、搜索、筛选控件、选择、历史、焦点或资源加载时读取[查看器规则](references/viewer.md)。完整维护在对应检查阶段读取二者。
4. 验收与交付：读取[视觉证据与验收](references/visual-validation.md)，冻结输入，复用有效证据并记录完成范围和缺项。实际 SVG 逐图目测及用户限定的抽样目测必须委派子代理，主代理统筹并复核证据。

## 关键边界

修改维护入口并重新生成产物，不手改生成文件；自动审计不能代替源码核对，几何检查不能代替实际观察。详细执行、失败与复用条件由各参考负责。

不启动或操作游戏；允许的专用 Schedule 导出及其设备初始化边界见[调度输入](references/schedules.md#导出有效性与导入失败)。文档浏览器访问拒绝后的停止规则见[视觉验收](references/visual-validation.md#http协议拒绝与离线分发)，不得使用编译浏览器绕过限制。
