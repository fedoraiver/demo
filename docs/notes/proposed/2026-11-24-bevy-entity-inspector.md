# Agent Note: Bevy 官方 Entity Inspector

Status: proposed

## Problem

决定何时评估用 Bevy 官方检查器接替 `demo-inspector` 的 Egui 检查器。当前独立入口提供实体组件、资源和资产检查，F3 在面板保持显示时切换游戏与检查器的输入归属。[项目检查器架构](../../architecture/inspector.md) · [项目 Issue #35](https://github.com/fedoraiver/demo/issues/35)

## Proposal

等项目可升级的 Bevy 稳定版发布 `bevy_inspector` 后，按现有检查器验收场景核对能力。要求稳定版同时兼容项目的玩法插件和无窗验收工具，检查器继续由独立入口启用。[Bevy 官方追踪 #23013](https://github.com/bevyengine/bevy/issues/23013) · [项目依赖](../../../Cargo.toml)

## Alternatives considered

现阶段继续使用 `bevy-inspector-egui`。上游 `inspector` feature 会把原生覆盖层装入 `DefaultPlugins`，默认 F12 切换可见性。`bevy_inspector` feature 也可提供用于自定义装配的面板，适合在替换时评估现有运行状态和输入归属。[上游 feature 定义](https://github.com/bevyengine/bevy/blob/1c4460b102a6a4380319455051c0e4c6051708a6/Cargo.toml#L441-L453) · [独立面板示例](https://github.com/bevyengine/bevy/blob/1c4460b102a6a4380319455051c0e4c6051708a6/examples/inspector/local_inspector.rs)

## Acceptance criteria

- 稳定版提供可用检查器，三个入口按锁文件编译，普通游戏和无窗验收保留各自的插件边界。
- `demo-inspector` 能查看人物和方块组件、编辑反射字段、查看和编辑 `PrototypeConfig`，并检查现有资产面板中的网格和材质。
- 面板随运行状态显示或隐藏。F3 在检查器操作和玩法输入之间切换，覆盖 W、空格、E、鼠标位移、焦点丢失和恢复时的相机状态。[检查器验收](../../testing/inspector.md#世界检查器验收)

## Risks

主线 `Edit`／`Preview` 管理指针拾取和交互。项目 F3 还管理鼠标捕获、移动意图和玩法键盘输入。切换原生界面时需要核对这些输入边界以及主菜单和暂停时的面板门控。[上游输入](https://github.com/bevyengine/bevy/blob/1c4460b102a6a4380319455051c0e4c6051708a6/crates/bevy_inspector/src/lib.rs#L12-L26) · [项目鼠标捕获](../../architecture/first_person.md#鼠标捕获与输入归属)

## Changes

项目锁定的 Bevy 0.20.1 未提供官方检查器的 feature。上游主线已有本地实体树、反射组件及资源字段编辑。其面板包含 `Entities` 和 `Resources`，资产句柄显示为只读标签。资产检查和项目 F3 门控仍是替换前的核对项。[锁定版本 feature 定义](https://github.com/bevyengine/bevy/blob/v0.20.1/Cargo.toml#L135-L175) · [上游面板](https://github.com/bevyengine/bevy/blob/1c4460b102a6a4380319455051c0e4c6051708a6/crates/bevy_inspector/src/world_tabs.rs#L20-L86) · [资产句柄测试](https://github.com/bevyengine/bevy/blob/1c4460b102a6a4380319455051c0e4c6051708a6/crates/bevy_inspector/src/details_panel.rs#L3757-L3795)
