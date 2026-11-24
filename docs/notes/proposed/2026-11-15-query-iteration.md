# Agent Note: Bevy 可变查询遍历

Status: proposed — 已完成调研，建议当前场景沿用串行遍历

## Problem

[Issue #35 第 1 项](https://github.com/fedoraiver/demo/issues/35)提出比较 `for … in &mut query` 和 `query.par_iter_mut()`。当前灰盒的候选查询通常只匹配一个实体。用这个规模测得并行调度成本高于循环本身，建议等实际工作负载出现瓶颈时再评估。

## Proposal

以当前灰盒的匹配数量为基线，盘点共享写入和顺序要求。用 Bevy 0.20.1 运行无窗口配对基准，对照实际数量和放大数量，在真实规模有可复现收益且业务语义一致时再替换局部循环。[开发规范](../../development.md#代码组织与性能) · [依赖锁定](../../../Cargo.lock)

## Alternatives considered

沿用串行遍历。它直接表达条件分支及循环内共享状态，且无需将实体批次交给工作线程。小场景中优先保留各系统已有的运行条件、变更过滤与调度器对独立系统的并发。

使用默认批大小进行并行遍历。Bevy 按存储布局与线程数切分查询，每个匹配项恰好访问一次，闭包执行顺序和线程分配无保证。串行查询的实体枚举顺序同样无契约，但每次循环完成后才会开始下一次。并行闭包要求 `Fn + Send + Sync + Clone`，多个工作线程时还要分批并等待完成。只有一个匹配项时也要经过任务池，调整批大小无法增加可并行项。关闭 `multi_threaded`、在 wasm32 或只有一个 ComputeTaskPool 线程时退回普通迭代。[Query 接口](https://github.com/bevyengine/bevy/blob/a0577b5c6a7b208719dd761c5c6a7a539e472a97/crates/bevy_ecs/src/system/query.rs) · [并行迭代实现](https://github.com/bevyengine/bevy/blob/a0577b5c6a7b208719dd761c5c6a7a539e472a97/crates/bevy_ecs/src/query/par_iter.rs)

更大的负载可单独比较默认和自定义 `BatchingStrategy`。多个表或 archetype、实体工作量不均以及任务池争用都会改变合适的粒度。[Bevy 批处理策略](https://github.com/bevyengine/bevy/blob/a0577b5c6a7b208719dd761c5c6a7a539e472a97/crates/bevy_ecs/src/batching.rs) · [官方示例](https://github.com/bevyengine/bevy/blob/v0.20.1/examples/ecs/parallel_query.rs)

## Acceptance criteria

在实际规模和放大规模运行同一组件更新，检查两种遍历的结果一致并记录边界。替换生产循环需要在实际工作负载中证实净收益，同时保留已有关系约束和系统间顺序。

## Risks

独立基准在相同实体布局与输入下重复运行，范围仅覆盖系统调用、组件访问及写入。游戏内渲染、物理求解和系统间并行调度会改变任务池负载。此次计时期间同机在后台构建覆盖率测试，因此大规模结果只说明量级，不用作性能门槛。接地查询和 Avian 力积分的真实开销留待未来场景测量。

## Changes

按 [灰盒装配](../../../src/scene_assembly/mod.rs)，常规会话有 1 个角色、1 个控制者、1 台第一人称相机和 3 个可拾取方块，同一角色的正常操作至多持 1 件。场景没有创建带 `CharacterVisual` 的子实体，因此角色显隐匹配 0 项。原生窗口查询匹配主窗口。菜单一次只装配一个页面，主菜单与暂停菜单各 4 个按钮，音频页 2 个音量控件，控制页 1 个灵敏度输入框。数字来源为源码装配。[菜单装配](../../../src/ui/pages.rs) · [物品交互约束](../../architecture/item_interaction.md#持有关系与生命周期)

| 查询路径 | 与并行相关的约束 |
| --- | --- |
| [意图清空](../../../src/character/lifecycle.rs)、[相机跟随和角色显隐](../../../src/first_person/camera.rs)、[持物呈现](../../../src/item_interaction/pose.rs) | 对当前匹配项独立写入。意图清空只在进入暂停或主菜单时运行。相机跟随和持物呈现每帧读相关目标的变换。显隐另有转换日志。 |
| [接地、运动与跳跃](../../../src/character/motion.rs) | 接地每个角色执行独立的空间查询和结果归约。Avian `Forces` 写当前刚体的力、速度或休眠计时器。接地与跳跃含状态日志，角色更多时应按真实形状查询与物理负载测量。 |
| [鼠标捕获](../../../src/first_person/capture.rs)、[暂停恢复](../../../src/first_person/mod.rs)和[角色朝向](../../../src/first_person/facing.rs) | 暂停恢复的逐项赋值可独立执行。常规捕获汇总 `any_active` 后更新单个光标并决定控制者状态。朝向通过其他可变查询更新关联相机和角色，并可能提交碰撞释放命令。 |
| [拿放](../../../src/item_interaction/interaction.rs)、[持物挂接](../../../src/item_interaction/attachment.rs)、[物理同步](../../../src/item_interaction/pose.rs) 与 [关系恢复](../../../src/item_interaction/lifecycle.rs) | 拿放共享同批候选预留。挂接与恢复提交影响持有者和碰撞代理的延迟命令。物理同步还通过另一可变查询写代理。直接换遍历方式无法维持现有借用及共享更新。 |
| [按钮样式](../../../src/ui/style.rs)、[滑条](../../../src/ui/slider.rs)、[音量文字](../../../src/ui/volume.rs)、[文字输入](../../../src/ui/sensitivity.rs) 和 [滚动轨道](../../../src/ui/scroll.rs) | 多数样式逐项独立，且值变化时才刷新部分查询。输入编辑共享布局、剪贴板、草稿或菜单状态，滚动轨道另写目标区域与滑块。 |
| [原生窗口](../../../src/window_policy/mod.rs) | 依赖窗口线程的本地后端和 `NonSendMut` 守卫。 |

现有 [PR #34](https://github.com/fedoraiver/demo/pull/34) 修改了角色运动、第一人称和持物查询的声明。后续若确有并行收益，以整合后的实际查询复验。涉及相机及持物时保留固定步与帧末呈现的原有顺序与零固定步回归。[调度顺序](../../architecture/game_flow.md#调度与模拟边界) · [事故记录](../../postmortem/2026-10-01-held-crate-frame-mismatch.md)

基准使用 Windows 上的 i5-13400、项目固定的 `nightly-2026-10-31` 和 Bevy 0.20.1 发布构建。串行意图清空直接调用生产系统，相机跟随复用了生产查询形状和变换计算。每种负载用独立 ECS 世界对照串行和并行计算，先运行一次并断言输出一致，再预热并交替计时 9 组。相机压测加入一个缺角色的目标以覆盖跳过分支。发布构建、三轮运行的样本范围和复现入口保存在本 worktree 的 `tmp/query-iteration-bench/`。

8 个 ComputeTaskPool 线程下，两次运行的单实体串行系统中位数均为数十纳秒以内，并行版本约为 1 微秒。放大后，相机跟随从约千项样本起出现收益，简单的意图清空在测试的十万项样本才出现收益，说明适合并行的规模取决于每项工作。单线程对照的两种写法耗时同量级。基准的全部规模通过结果对照。
