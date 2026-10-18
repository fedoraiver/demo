---
name: update-ecs-architecture
description: 更新、核对或修复本项目的 ECS 架构图，包括源码语义、清单、四视图布局、源码快照、生成校验与视觉检查。用于架构图维护请求；
---

# 更新 ECS 架构图

在当前工作区维护 `docs/diagrams/` 的架构图。

## 读取与范围

- 从仓库根目录执行命令，先读取 [AGENTS.md](../../../AGENTS.md)、[开发规范](../../../docs/development.md)、[当前架构](../../../docs/architecture.md) 与 [验证指南](../../../docs/testing/README.md)。
- 阅读 [图的说明与维护入口](../../../docs/diagrams/README.md)，核对 `ecs-data.json`、`build-ecs.mjs` 和相关 Rust 源码。布局与部分说明在生成器中，不能只修改 JSON。
- 检查 `git status --short`、暂存与未暂存 diff；使用用户指定的比较基线。未指定时，以原图和清单定位差异，再核对当前源码；不要只看最近一次提交而遗漏工作区变化或既有过期内容。
- 保留用户已有修改。需保存原图、diff、检查日志或截图时，使用根 `tmp/ecs-architecture/` 下独立的任务目录；正式产物保留在 `docs/diagrams/`。

## 对照源码维护

以源码的实际注册和访问为准，按请求范围核对以下内容：

- 插件装配、系统与 Observer 注册、Schedule/SystemSet、运行条件、显式顺序及延迟命令可见时机。
- Entity 身份、组件与资源字段、系统私有状态、查询读写和过滤条件；区分 `QueryData`、`SystemParam`、普通辅助值和 ECS 组件。
- `ChildOf` 等 Bevy 关系与普通 `Entity` 引用、生成和销毁、消息与事件、动作上下文及 Observer 触发条件。
- App 总览、调度与读写、实体关系、事件与 Observer 四视图，以及对应说明、源码路径和行号。没有显式顺序的系统或 Observer 不得画成全序流水线。

更新 `ecs-data.json` 和必要的生成器布局、说明，沿用现有图形及交互约定。源码行号应指向类型声明或实际注册／使用位置；删除失效节点、关系和入口。受影响的长期架构说明按文档维护规则同步更新。

生成器只渲染输入，校验器不分析 Rust 架构语义，也无法发现所有遗漏系统；必须完成上述人工源码核对。

## 生成与自动校验

在仓库根依次执行，每条成功后再继续；失败时修复原因并重试，不将失败产物报告为完成：

```text
node docs/diagrams/build-ecs.mjs
node docs/diagrams/check-ecs.mjs
node --test docs/diagrams/check-ecs.test.mjs docs/diagrams/source-editor.test.mjs docs/diagrams/source-viewer.test.mjs
```

若 PATH 中没有 Node.js，使用当前环境已安装的 Node.js（例如 Codex 工作区依赖工具返回的运行时）执行同样命令，不把个人绝对路径写进仓库。

生成会读取当前工作区源码与清单，覆盖 `ecs-architecture.html`、`ecs-source.html`、`ecs-overview.svg`、`ecs-schedules.svg`、`ecs-relationships.svg`、`ecs-events.svg` 六份产物。检查最终 diff，确认只出现预期变更；保留现有编辑器入口、离线快照与四视图覆盖。只有用户另行要求时才暂存或提交；部分暂存的源码不代表这些产物只反映索引版本。

## 最终视觉检查与交付

架构图有变更时，按 [架构图视觉检查](../../../docs/testing/README.md#架构图视觉检查) 实际查看最终 HTML 与四份 SVG：先看四视图概览，再放大修改区域，重点追踪箭头起止、方向、分叉汇合，以及线条连续性、重叠和裁切。按 [箭头锚点与走线](../../../docs/diagrams/README.md#箭头锚点与走线) 核对节点边上的锚点和末段；修复并重新生成后检查最终版本。修改编辑器入口时，另按验证指南完成源码定位验证。

只打开静态架构文档或查看其渲染截图，禁止启动或操作游戏。截图和渲染临时文件仍放在根 `tmp/`。自动校验通过不能代替视觉检查；工具不可用时明确记录原因及未检查范围，不声称验收通过。

交付说明列出源码核对范围、具体图变化、自动校验结果、实际视觉检查结果和未完成事项。有关联 Issue 或 PR 时将本次执行记录放在那里，长期文档只保留可复用方法。
