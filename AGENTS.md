# Agent 开发指南

本文件适用于整个仓库。所有新增或修改的游戏逻辑必须遵循 ECS（Entity Component System，实体、组件、系统）架构，并使用本项目的 Bevy 实现。

## 项目背景

- 技术栈：Rust edition 2024、Bevy 0.19.1；具体依赖以 `Cargo.toml` 和 `Cargo.lock` 为准。
- ECS 是架构模式，并无适用于所有引擎的统一强制规范。下文是本项目的开发约定；API 行为以对应版本的 Bevy 官方文档为准。
- 使用与项目版本匹配的示例。不要直接套用旧版 Bevy、Unity DOTS 或其他 ECS 框架的接口及限制。

## ECS 的职责划分

### Entity：实体只表示身份

- 使用 Bevy 的 `Entity` 标识实体，通过组件组合表达其能力和状态。
- 实体之间的引用使用 `Entity` 或 Bevy 关系组件，不持有其他实体组件的长期引用。
- 不建立包含全部状态与行为的 `GameObject` / `Actor` 对象层，不自行维护一套与 Bevy 重复的实体管理器。
- 实体可能被销毁；读取保存的实体引用时，按业务需要处理实体不存在或组件缺失的情况。
- 存档、网络协议等需要稳定标识时，使用独立的业务 ID，不把运行时 `Entity` 当作跨会话永久 ID。

### Component：组件承载实体数据

- 实体自身的状态定义为 `#[derive(Component)]` 的结构体或枚举；无数据的身份或能力标签使用标记组件。
- 按数据职责、访问模式和生命周期拆分组件，保持内聚。避免把位置、生命值、输入、渲染和 AI 等无关状态堆进一个巨型组件，也不要机械地将每个字段拆成组件。
- 组件可以提供构造、校验和只操作自身数据的辅助方法。每帧更新、跨实体交互、访问世界或外部服务等行为应由系统执行。
- 通过组件组合复用能力，避免用继承式层级或大型对象类型分支模拟实体种类。
- 同一业务状态应有明确的数据来源；优先复用 Bevy 已有组件，例如 `Transform`，避免无必要地维护重复数据。

### Resource / Local：明确共享范围

- 全局唯一、由多个系统共享的数据使用 `#[derive(Resource)]`，通过 `Res<T>` / `ResMut<T>` 访问，例如配置或全局统计。
- 属于某个实体的数据放在组件中，不用巨型全局资源中的实体列表替代 ECS 存储。确有需要的索引或缓存应明确维护与失效规则。
- 仅供单个系统保存的临时状态可使用 `Local<T>`。
- 不用可变静态变量或自建全局单例绕过 Bevy 的数据访问与调度机制。

### System：系统实现行为

- 系统使用职责明确的 Rust 函数，通过 `Query`、`Res`、`ResMut`、`Commands` 等参数声明所需数据。
- 使用组件组合和 `With<T>` / `Without<T>` 等过滤条件选择实体，避免依赖实体名称、固定 ID 或无关的类型判断。
- 查询仅请求所需数据；只读访问使用 `&T` / `Res<T>`，确需修改时才使用 `&mut T` / `ResMut<T>`，保留调度器并行执行的空间。
- 一个系统负责一个清晰的数据变换或流程步骤。复杂计算可提取为纯函数，由系统负责数据访问和结果写回。
- 查询访问冲突应通过拆分系统、明确互斥过滤条件或必要的 `ParamSet` 解决，不用 `unsafe` 或随意添加锁掩盖问题。
- 常规业务优先使用普通系统。确需独占 `&mut World` 的系统时，说明原因并限制其范围。

## 调度、通信与生命周期

- 使用 `add_systems` 注册系统。启动初始化使用 `Startup`，逐帧逻辑使用 `Update`；需要固定时间步的模拟逻辑使用 `FixedUpdate`，并使用相应时间步数据。
- 同一 Schedule 内有先后依赖的系统必须通过 `.before()`、`.after()`、`.chain()` 或 `configure_sets` 配置系统集之间的依赖。仅 `.in_set()` 不建立顺序；注册顺序、元组顺序和数据访问冲突也不能代替顺序约束。
- 顺序约束不会自动注册被引用的系统，也不能建立跨 Schedule 的顺序；核对相关系统是否注册，并按实际调度阶段设计数据流。
- 实体生成、销毁及组件增删等结构变更优先使用 `Commands`。它们是延迟操作，不要假设调用后立即能被当前系统的 `Query` 看到。
- 后续系统需要观察结构变更时，确保在两者之间应用延迟命令。常规调度配置中的 `.before()`、`.after()` 和 `.chain()` 支持自动插入同步点；自定义调度需核对实际配置，必要时使用 `ApplyDeferred`。
- 系统间的缓冲通信使用 `Message`、`MessageWriter`、`MessageReader`，并在 `App` 中注册消息；需要触发式响应时使用 `Event` / `EntityEvent` 与 Observer。两者语义不同，使用 Bevy 0.19.1 对应接口。
- `World::trigger` 在调用中触发 Observer；`Commands::trigger` 要等命令应用时才触发，不能假设立即生效。
- 跨系统协作通过组件、资源、消息或显式调度表达，不直接调用另一系统来隐式驱动流程。
- 初始化、退出和实体清理要与实际生命周期对应。默认消息缓冲不会永久保留，条件停用的读取系统可能漏读；必须跨停用期保留的业务状态应存入组件、资源或明确管理的持久队列。

## 代码组织与性能

- 功能成长后按领域划分模块，并用 `Plugin` 封装系统注册、资源初始化和消息注册。`main.rs` 保持应用组装与启动职责。
- 小功能无需预建完整目录树；组件和系统可先放在同一功能模块中，复杂后再拆分。
- 优先批量查询处理实体，避免每帧全世界扫描、无必要的分配与克隆，以及频繁增删组件。
- 在适合的场景使用 `Added<T>`、`Changed<T>`、条件执行或消息驱动减少重复工作；不能因此遗漏必要的连续更新。
- 默认使用 Bevy 的存储与调度方式。只有测量表明确有需要时，才调整组件存储、并行迭代或缓存策略。

## Agent 完成代码变更前的检查

- 确认实体身份、实体数据、共享数据和行为分别放在正确位置。
- 确认系统读写声明、执行依赖和延迟命令的可见时机正确。
- 确认功能插件注册了所需的系统、资源和消息，实体销毁后不会留下错误引用或失效缓存。
- 修改 Rust 代码后运行 `cargo fmt --all -- --check` 和 `cargo check --locked`。
- 行为变更增加或运行有针对性的测试；可使用最小 `App` / `World` 验证组件变化、查询过滤和调度结果，无需为纯逻辑测试启动完整窗口。
- 仅修改文档时，检查内容和链接即可。交付时说明实际完成的验证及未验证事项。
- 如需偏离本约定，在代码注释或交付说明中解释具体理由和影响，保持偏离范围最小。

## 官方参考资料

以下资料用于核对概念与 API；上述工程约定是结合本项目整理的要求。

- [Bevy ECS 0.19.1：实体、组件、系统、资源与查询概览](https://docs.rs/bevy_ecs/0.19.1/bevy_ecs/)
- [Bevy ECS 0.19.1：Resource](https://docs.rs/bevy_ecs/0.19.1/bevy_ecs/resource/trait.Resource.html)
- [Bevy ECS 0.19.1：Commands 与延迟结构变更](https://docs.rs/bevy_ecs/0.19.1/bevy_ecs/system/struct.Commands.html)
- [Bevy 0.19.1：系统顺序与调度配置](https://docs.rs/bevy/0.19.1/bevy/ecs/schedule/trait.IntoScheduleConfigs.html)
- [Bevy 0.19.1：Plugin](https://docs.rs/bevy/0.19.1/bevy/app/trait.Plugin.html)
- [Flecs：实体与组件概念（仅作跨框架概念参考）](https://www.flecs.dev/flecs/EntitiesComponents.html)

## Agent skills

### Issue tracker

需求、缺陷和 PRD 使用 GitHub Issues，仓库为 `fedoraiver/demo`。参见 [任务跟踪约定](docs/agents/issue-tracker.md)。

### Triage labels

使用五个默认分诊标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。参见 [标签映射](docs/agents/triage-labels.md)。

### Domain docs

采用多上下文布局：根目录 `CONTEXT-MAP.md` 索引子项目，各子项目分别记录术语和架构决策。参见 [领域文档约定](docs/agents/domain.md)。
