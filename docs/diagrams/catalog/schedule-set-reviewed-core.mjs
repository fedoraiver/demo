// 基于完整集合或枚举项身份、原始文档和实际配置核对的职责。
export const CORE_SCHEDULE_SET_PURPOSES = Object.freeze({
  "avian3d::collider_tree::ColliderTreeSystems::BeginOptimize": {
    "summary": "启动碰撞体树的后台优化。",
    "description": "在模拟可继续推进时异步优化碰撞体加速结构，减少树退化对空间查询的影响；结果由 EndOptimize 阶段接收。"
  },
  "avian3d::collider_tree::ColliderTreeSystems::EndOptimize": {
    "summary": "接收并合并碰撞体树优化结果。",
    "description": "在模拟步收尾完成 BeginOptimize 发起的加速结构优化，把后台结果合并回当前碰撞体树。"
  },
  "avian3d::collider_tree::ColliderTreeSystems::UpdateAabbs": {
    "summary": "刷新移动碰撞体的包围盒。",
    "description": "在碰撞对搜集前更新碰撞体树中的轴对齐包围范围，使广相查询使用当前运动后的空间范围。"
  },
  "avian3d::collision::broad_phase::BroadPhaseSystems::CollectCollisions": {
    "summary": "搜集包围盒重叠的潜在碰撞对。",
    "description": "以 ColliderAabb 的重叠筛选可能接触的实体，建立或维护接触图中的候选对；精确接触由随后窄相处理。"
  },
  "avian3d::collision::broad_phase::BroadPhaseSystems::First": {
    "summary": "提供广相开始前的扩展边界。",
    "description": "标记广相碰撞流程的起点，供自定义准备逻辑排在候选碰撞对搜集之前；该集合自身没有执行函数。"
  },
  "avian3d::collision::broad_phase::BroadPhaseSystems::Last": {
    "summary": "提供广相结束后的收尾边界。",
    "description": "标记广相候选搜集完成的扩展位置，本快照在该范围安排碰撞体树优化等收尾成员；集合标签本身不运行算法。"
  },
  "avian3d::collision::narrow_phase::CollisionEventSystems": {
    "summary": "在求解完成后触发碰撞开始与结束事件。",
    "description": "把 CollisionStart 和 CollisionEnd 的派发安排在物理步 Finalize，使事件发生在约束求解及接触冲量计算之后。"
  },
  "avian3d::collision::narrow_phase::NarrowPhaseSystems::First": {
    "summary": "提供窄相开始前的扩展位置。",
    "description": "在接触几何更新之前预留窄相准备边界，原生默认无成员，可供额外窄相逻辑排序。"
  },
  "avian3d::collision::narrow_phase::NarrowPhaseSystems::Last": {
    "summary": "提供窄相完成后的扩展位置。",
    "description": "在本轮接触几何和状态更新结束后预留窄相收尾边界，原生默认无成员。"
  },
  "avian3d::collision::narrow_phase::NarrowPhaseSystems::Update": {
    "summary": "更新精确接触并处理接触状态变化。",
    "description": "把窄相接触检测与 ContactGraph 维护放在同一阶段，更新候选对的精确接触及开始、结束等状态。"
  },
  "avian3d::diagnostics::PhysicsDiagnosticsSystems::Reset": {
    "summary": "开始新物理步前重置诊断采样。",
    "description": "清零各物理诊断实现的计数与耗时字段，使本轮碰撞树、碰撞检测、求解器和空间查询采样不混入上一轮值。"
  },
  "avian3d::dynamics::integrator::IntegrationSystems::ClearVelocityIncrements": {
    "summary": "在子步循环后清除速度增量。",
    "description": "把逐步累积的刚体速度增量清理安排在 SolverSystems::PostSubstep，避免它们被下一物理步重复使用。"
  },
  "avian3d::dynamics::integrator::IntegrationSystems::Position": {
    "summary": "按子步速度推进求解器姿态。",
    "description": "在子步积分中根据当前线速度、角速度和物理时间增量更新位置及旋转变化，并协调该阶段需要的惯量数据。"
  },
  "avian3d::dynamics::integrator::IntegrationSystems::UpdateVelocityIncrements": {
    "summary": "为子步积分准备外力和重力增量。",
    "description": "在子步循环前把恒定作用、重力及锁轴约束汇总到速度增量，并按子步时间缩放，交给各子步的速度积分使用。"
  },
  "avian3d::dynamics::integrator::IntegrationSystems::Velocity": {
    "summary": "把速度增量应用到刚体速度。",
    "description": "在子步内施加本轮速度增量、局部作用及阻尼，并处理速度上限，为位置积分和约束求解提供当前速度。"
  },
  "avian3d::dynamics::joints::JointSystems::PrepareLocalFrames": {
    "summary": "把关节锚点和坐标架转换到局部空间。",
    "description": "在关节约束使用前准备各关节两端的局部 JointFrame 或局部锚点，使世界空间配置能随连接刚体运动。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::ForceSystems::ApplyConstantForces": {
    "summary": "把恒定作用累加为世界或局部速度增量。",
    "description": "把恒定力、力矩及线性、角加速度加入 VelocityIntegrationData；局部空间的恒定作用保留到 AccumulatedLocalAcceleration，供子步按当前旋转施加。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::ForceSystems::ApplyLocalAcceleration": {
    "summary": "按当前姿态应用局部空间加速度。",
    "description": "在每个子步把 AccumulatedLocalAcceleration 的局部作用转换并累加到刚体线速度和角速度，以反映子步内旋转的变化。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::ForceSystems::Clear": {
    "summary": "清空本物理步的局部作用累计。",
    "description": "在子步循环完成后清除 AccumulatedLocalAcceleration，为下一轮恒定力及局部加速度累积准备空状态。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::MassPropertySystems::QueueRecomputation": {
    "summary": "标记需要重新计算质量属性的实体。",
    "description": "检测刚体显式质量或碰撞体质量数据的变化，排入 RecomputeMassProperties 标记，让后续阶段统一重算。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::MassPropertySystems::UpdateColliderMassProperties": {
    "summary": "从碰撞体几何和密度更新质量属性。",
    "description": "刷新各碰撞体的 ColliderMassProperties，提供刚体组合质量、质心和转动惯量重算所需的几何贡献。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::MassPropertySystems::UpdateComputedMassProperties": {
    "summary": "重新计算刚体有效质量、质心和惯量。",
    "description": "处理带 RecomputeMassProperties 的实体，更新 ComputedMass、ComputedCenterOfMass 和 ComputedAngularInertia，并在处理后移除重算标记。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::ContinuousCollision": {
    "summary": "处理快速动态刚体的连续碰撞。",
    "description": "把连续碰撞检测安排在普通离散求解流程中，处理高速运动可能跨过碰撞体的情况。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::Finalize": {
    "summary": "把求解器内部状态写回刚体。",
    "description": "在子步循环后提交 SolverBody 的运动结果，并完成与该收尾阶段关联的树优化合并或岛拆分，供后续物理步骤使用。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::PostSubstep": {
    "summary": "在子步循环后清理积分累计。",
    "description": "提供子步循环刚结束的处理阶段，本快照在这里清除局部加速度和速度增量，使每个物理步的累计只使用一次。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::PrepareContactConstraints": {
    "summary": "为子步求解准备接触约束。",
    "description": "把窄相接触数据转换为子步循环可使用的接触约束，准备约束点、质量和缓存信息。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::PrepareJoints": {
    "summary": "为子步求解预留关节约束准备阶段。",
    "description": "在子步循环开始前提供关节约束构建的固定排序位置；本快照未关联具体成员时不表示执行了关节准备算法。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::PrepareSolverBodies": {
    "summary": "建立子步循环使用的求解器刚体。",
    "description": "把活跃刚体的质量、姿态和速度等数据准备为 SolverBody，供约束和积分阶段使用统一内部表示。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::PreSubstep": {
    "summary": "在子步循环前汇总速度积分输入。",
    "description": "把恒定力、重力及速度增量预处理安排在重复子步之前，使同一物理步的准备与每个子步的应用分开。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::Restitution": {
    "summary": "在重叠求解后施加恢复冲量。",
    "description": "依据碰撞材质的恢复系数处理接触反弹，使恢复响应与位置重叠修正分开进行。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::StoreContactImpulses": {
    "summary": "保存接触冲量供下一次热启动。",
    "description": "把本轮 ContactConstraints 的冲量复制回 ContactGraph 中的接触记录，供下一帧或子步 WarmStart 复用。"
  },
  "avian3d::dynamics::solver::schedule::SolverSystems::Substep": {
    "summary": "重复运行物理子步调度。",
    "description": "安排 SubstepSchedule 循环，把一个物理步拆成配置数量的子步，协调积分与约束求解的重复执行。"
  },
  "avian3d::dynamics::solver::schedule::SubstepSolverSystems::Damping": {
    "summary": "对约束施加基于相对速度的阻尼。",
    "description": "在子步中处理 JointDamping 等速度阻尼，减弱连接刚体的相对线性或角向运动。"
  },
  "avian3d::dynamics::solver::schedule::SubstepSolverSystems::Relax": {
    "summary": "用无偏置约束求解放松过强响应。",
    "description": "再次求解速度约束但不加入位置偏置，缓解热启动及带偏置求解造成的速度与冲量过冲。"
  },
  "avian3d::dynamics::solver::schedule::SubstepSolverSystems::SolveConstraints": {
    "summary": "用位置偏置求解速度约束。",
    "description": "在子步中按约束误差加入位置偏置，迭代接触和其他速度约束以修正重叠。"
  },
  "avian3d::dynamics::solver::schedule::SubstepSolverSystems::WarmStart": {
    "summary": "以历史接触冲量热启动求解器。",
    "description": "把上一帧或子步保存的冲量施加到当前求解器刚体，提高约束迭代收敛速度；可能产生的过强响应由 Relax 阶段放松。"
  },
  "avian3d::physics_transform::PhysicsTransformSystems::PositionToTransform": {
    "summary": "把物理位置和旋转同步到显示变换。",
    "description": "在物理模拟之后依据 Position 和 Rotation 更新 Transform，连接物理世界状态与实体的呈现变换。"
  },
  "avian3d::physics_transform::PhysicsTransformSystems::TransformToPosition": {
    "summary": "把外部变换变化同步到物理姿态。",
    "description": "在物理模拟前读取 Transform 的变化，更新 Position 和 Rotation，使外部移动、旋转或层级变换进入本轮模拟。"
  },
  "avian3d::schedule::PhysicsStepSystems::BroadPhase": {
    "summary": "用包围范围建立潜在接触集合。",
    "description": "承担物理步的广相阶段，更新空间包围范围并筛选重叠碰撞体对，为窄相建立 ContactGraph 候选。"
  },
  "avian3d::schedule::PhysicsStepSystems::Finalize": {
    "summary": "在核心物理步后派发事件并收尾。",
    "description": "提供本轮核心模拟结束后的处理阶段，安排碰撞开始、结束等最终通知，并为下一物理步准备状态。"
  },
  "avian3d::schedule::PhysicsStepSystems::First": {
    "summary": "在物理调度开头处理状态与关系变化。",
    "description": "标记 PhysicsSchedule 的开始边界，本快照在此同步子碰撞体位置、应用接触状态变更及维护关节关系，交给广相和求解使用。"
  },
  "avian3d::schedule::PhysicsStepSystems::Last": {
    "summary": "提供物理调度最终的扩展边界。",
    "description": "标记 PhysicsSchedule 中核心步骤均结束后的收尾位置，允许外部逻辑排在最后；空集合不表示额外执行。"
  },
  "avian3d::schedule::PhysicsStepSystems::NarrowPhase": {
    "summary": "刷新接触几何与接触图状态。",
    "description": "承担物理步的窄相阶段，对广相候选计算精确接触并处理 ContactGraph 中接触状态的变化。"
  },
  "avian3d::schedule::PhysicsStepSystems::Sleeping": {
    "summary": "决定物理岛的休眠与唤醒。",
    "description": "根据运动稳定性、外部组件变化和禁用休眠配置维护岛的活跃状态，最终让符合条件的刚体休眠或重新激活。"
  },
  "avian3d::schedule::PhysicsStepSystems::Solver": {
    "summary": "运行约束求解器及子步循环。",
    "description": "承担物理步内的求解阶段，准备求解器刚体、约束和积分输入，重复子步并提交求解后的刚体结果。"
  },
  "avian3d::schedule::PhysicsSystems::First": {
    "summary": "在所有 Avian 物理系统之前提供准备边界。",
    "description": "允许项目或扩展逻辑排在物理功能之前，本快照关联数值断言与修改后刚体唤醒；原生该边界默认不放置成员。"
  },
  "avian3d::schedule::PhysicsSystems::Last": {
    "summary": "在所有 Avian 物理系统之后提供收尾边界。",
    "description": "为物理功能全部完成后的外部逻辑提供排序接口，原生默认无成员；具体执行项由当前应用注册决定。"
  },
  "avian3d::schedule::PhysicsSystems::Prepare": {
    "summary": "在模拟前准备物理姿态、质量和查询数据。",
    "description": "同步外部变换，处理碰撞体及质量属性变化，准备本轮模拟需要的刚体和碰撞查询输入。"
  },
  "avian3d::schedule::PhysicsSystems::StepSimulation": {
    "summary": "推进包含碰撞与求解的完整物理步。",
    "description": "通过 PhysicsSchedule 运行 PhysicsStepSystems 定义的模拟步骤，连接物理时钟推进、碰撞检测、约束求解和休眠处理。"
  },
  "avian3d::schedule::PhysicsSystems::Writeback": {
    "summary": "把模拟结果同步回其他实体数据。",
    "description": "在模拟后将 Position 和 Rotation 等物理结果写回 Transform 等呈现数据，使后续插值与显示看到本轮物理状态。"
  },
  "avian3d::spatial_query::SpatialQuerySystems": {
    "summary": "刷新空间投射器并执行射线和形状查询。",
    "description": "更新 RayCaster、ShapeCaster 等组件的世界空间起点与方向，再执行射线或形状投射并保存命中结果。"
  },
  "bevy_a11y::AccessibilitySystems::Update": {
    "summary": "同步原生可访问性树和窗口节点。",
    "description": "安排可访问性消息接收、节点更新和窗口关闭清理，使平台适配器跟随 UI 语义、焦点与窗口生命周期。"
  },
  "bevy_app::app::OnAppExitSystems": {
    "summary": "在退出消息发出后执行应用收尾。",
    "description": "为 AppExit 已发布但应用尚未真正退出的清理逻辑提供阶段；例如关闭尚未执行延迟队列的丢弃警告，不把此集合当作独立退出请求。"
  },
  "bevy_app::hierarchy::ValidateParentHasComponentSystems": {
    "summary": "复核父子层级是否满足组件要求。",
    "description": "安排 ValidateParentHasComponentPlugin 的延后检查，报告带指定组件的子实体仍连接到缺少同类组件的父实体的情况。"
  },
  "bevy_app::main_schedule::AnimationSystems": {
    "summary": "更新动画图、播放时间和目标姿态。",
    "description": "在 PostUpdate 中协调动画图加速结构、播放推进、过渡、目标求值及动画事件，使它们组成同一动画更新阶段。"
  },
  "bevy_app::main_schedule::RunFixedMainLoopSystems::AfterFixedMainLoop": {
    "summary": "在固定循环之后执行插值与呈现。",
    "description": "在本帧零次或多次固定更新完成后运行变动帧率的后处理，适合把上一与当前固定状态插值为本帧呈现。"
  },
  "bevy_app::main_schedule::RunFixedMainLoopSystems::BeforeFixedMainLoop": {
    "summary": "在固定循环之前采集或准备本帧输入。",
    "description": "把需要以显示帧率更新、又必须在本轮固定模拟读取之前完成的逻辑放在此处；例如镜头或调试绘制上下文的前置准备。"
  },
  "bevy_app::main_schedule::RunFixedMainLoopSystems::FixedMainLoop": {
    "summary": "根据虚拟时间推进零次或多次固定更新。",
    "description": "以 Time<Virtual> 的累计时间和 overstep 控制 FixedMain 循环；业务系统通常注册到 FixedUpdate 等子调度，此集合主要提供相对固定循环的排序边界。"
  },
  "bevy_app::main_schedule::SceneSpawnerSystems::SceneSpawn": {
    "summary": "解析并实例化新一代场景补丁。",
    "description": "协调 ScenePatch 和 SceneListPatch 的依赖解析与等待实体装配，形成 Bevy 新场景系统的生成阶段。"
  },
  "bevy_app::main_schedule::SceneSpawnerSystems::WorldInstanceSpawn": {
    "summary": "生成或更新世界资产实例。",
    "description": "协调 WorldAssetRoot、DynamicWorldRoot 与世界实例生成器，处理原场景系统对应的世界资产生成、替换及排队实例。"
  },
  "bevy_app::main_schedule::TransformGizmoRenderStep": {
    "summary": "准备变换操纵器的网格和显示变换。",
    "description": "把变换操纵器及相似调试覆盖层需要的渲染网格更新和变换传播放在可被其他渲染功能引用的公共排序阶段。"
  },
  "bevy_app::propagate::PropagateSet": {
    "summary": "沿关系层级传播指定组件值。",
    "description": "协调传播源变化、移除限制、继承中间状态与输出组件更新，让指定组件值沿配置的关系传播；具体组件与限制由该传播插件实例决定。"
  },
  "bevy_ecs::message::update::MessageUpdateSystems": {
    "summary": "统一轮换已登记的消息缓冲。",
    "description": "安排 message_update_system 更新 World 中已登记的 Messages，维护消息批次的保留窗口，供独立读者消费。"
  },
  "bevy_egui::EguiInputSet::FocusContext": {
    "summary": "按指针顺序选择 Egui 输入焦点。",
    "description": "处理有顺序的光标移动、鼠标按钮和触摸消息，依据悬停非窗口上下文设置或清除聚焦上下文，先于其他输入路由。"
  },
  "bevy_egui::EguiInputSet::InitReading": {
    "summary": "准备 Egui 修饰键、缩放和悬停信息。",
    "description": "读取修饰键状态与 Egui 缩放因子，并提供更新 HoveredNonWindowEguiContext 的约定位置，为本轮消息路由准备上下文。"
  },
  "bevy_egui::EguiInputSet::ReadBevyMessages": {
    "summary": "把其余设备消息路由到 Egui 上下文。",
    "description": "处理窗口及非窗口上下文的键盘、滚轮、捏合、触摸和输入法等消息，生成带明确接收上下文的 Egui 输入事件。"
  },
  "bevy_egui::EguiInputSet::WriteEguiEvents": {
    "summary": "将路由后的事件写入 Egui 原始输入。",
    "description": "把 Egui 输入事件和文件拖放记录写入 EguiInput，在启用输入吸收时同步屏蔽已被 Egui 使用的 Bevy 输入。"
  },
  "bevy_egui::EguiPostUpdateSet::EndPass": {
    "summary": "完成 Egui 上下文的界面帧。",
    "description": "运行上下文专属 UI 调度并结束自动 pass，保存完整输出，交给输出处理阶段拆分平台命令和绘制数据。"
  },
  "bevy_egui::EguiPostUpdateSet::PostProcessOutput": {
    "summary": "应用 Egui 输出产生的后续资源变化。",
    "description": "在主输出拆分之后处理 Egui 纹理增量及其他平台后处理，使托管图像资源与本帧界面输出一致。"
  },
  "bevy_egui::EguiPostUpdateSet::ProcessOutput": {
    "summary": "拆分 Egui 输出并更新平台输入需求。",
    "description": "把完整输出整理为绘制任务和平台输出，汇总界面输入占用，并同步输入法状态，连接 UI 计算与渲染准备。"
  },
  "bevy_egui::EguiPreUpdateSet::BeginPass": {
    "summary": "在输入准备完成后开始 Egui 界面帧。",
    "description": "将本轮整理的 EguiInput 交给自动上下文并开始 pass，为随后执行的界面逻辑建立当前输入状态。"
  },
  "bevy_egui::EguiPreUpdateSet::InitContexts": {
    "summary": "维护新渲染目标的 Egui 上下文。",
    "description": "为新相机初始化主上下文，更新窗口与上下文的映射，应用延迟装配并根据相机视口更新界面屏幕区域。"
  },
  "bevy_egui::EguiPreUpdateSet::ProcessInput": {
    "summary": "在 Egui 帧开始前转换窗口与设备输入。",
    "description": "将键盘、指针、触摸等 Bevy 消息整理为各上下文的 EguiInput；外部输入修正应排在此阶段之后、BeginPass 之前。"
  },
  "bevy_egui::EguiStartupSet::InitContexts": {
    "summary": "在启动时初始化主 Egui 上下文。",
    "description": "创建启动相机上的主上下文并完成其所需组件和屏幕区域初始化，避免第一轮 UI pass 缺少目标状态。"
  },
  "bevy_enhanced_input::EnhancedInputSystems::Apply": {
    "summary": "把通用动作值写回强类型动作组件。",
    "description": "在输入评估之后将 ActionValue 转换为具体 Action 的值表示，执行于注册了对应上下文的各调度。"
  },
  "bevy_enhanced_input::EnhancedInputSystems::Prepare": {
    "summary": "清理等待释放和已消费的动作输入。",
    "description": "在 PreUpdate 中刷新需要忽略或等待重置的绑定，准备后续上下文输入评估使用的读取消费状态。"
  },
  "bevy_enhanced_input::EnhancedInputSystems::Trigger": {
    "summary": "派发本轮评估产生的动作事件。",
    "description": "在动作值与状态评估后触发对应的强类型事件，携带动作值、时间及触发状态；各上下文调度分别处理自身实例。"
  },
  "bevy_enhanced_input::EnhancedInputSystems::Update": {
    "summary": "评估上下文、绑定、条件与修饰器。",
    "description": "依据当前真实或模拟输入按上下文顺序计算各动作的值、触发状态、事件标志和累计时间，供回写与事件派发阶段使用。"
  },
  "bevy_gilrs::RumbleSystems": {
    "summary": "维护手柄振动效果的生命周期。",
    "description": "处理振动请求并清除到期效果，使设备力反馈随当前时间及停止请求更新。"
  },
  "bevy_gizmos_render::GizmoRenderSystems::QueueLineGizmos2d": {
    "summary": "把二维线条调试图元加入透明绘制阶段。",
    "description": "按二维视图准备线与连接处图元的绘制项，提交给 Transparent2d，供后续透明二维绘制使用。"
  },
  "bevy_gizmos_render::GizmoRenderSystems::QueueLineGizmos3d": {
    "summary": "把三维线条调试图元加入透明绘制阶段。",
    "description": "按三维视图把调试线及线段连接处排入 Transparent3d，使其与其他三维透明项共同排序绘制。"
  },
  "bevy_gizmos::frustum::FrustumGizmoSystems": {
    "summary": "收集并绘制相机视锥调试线。",
    "description": "在变换与相机数据就绪后，根据视锥调试配置生成选定或全部相机的视锥线条。"
  },
  "bevy_gizmos::GizmoMeshSystems": {
    "summary": "把调试绘制存储转换为渲染网格。",
    "description": "汇总各 GizmoConfigGroup 的本轮线条与连接数据，更新用于绘制调试图元的网格资产。"
  },
  "bevy_input_focus::InputFocusSystems::Dispatch": {
    "summary": "把设备输入派发给焦点实体。",
    "description": "在 PreUpdate 的输入状态更新后，把键盘、手柄或滚轮输入转为可冒泡的焦点事件；没有实体焦点时使用主窗口。"
  },
  "bevy_input_focus::InputFocusSystems::FocusChangeEvents": {
    "summary": "派发记录中的焦点获得和失去事件。",
    "description": "在 PostUpdate 消费 InputFocus 的焦点变化队列，按变化顺序触发 FocusGained 与 FocusLost，而不是再次选择焦点目标。"
  },
  "bevy_input::InputSystems": {
    "summary": "把原始设备消息汇总为本帧输入状态。",
    "description": "协调键盘、鼠标、手柄及触摸的消息处理与按钮、位移等资源更新，让后续玩法或 UI 读取统一的持续状态和单帧边沿。"
  },
  "bevy_kira_audio::AudioSystemSet::InstanceCleanup": {
    "summary": "清理已停止的音频实例引用。",
    "description": "安排 AudioOutput 移除停止或缺失实例的内部句柄及不再使用的子轨道，供音频后端释放资源。"
  },
  "bevy_kira_audio::AudioSystemSet::PlayDynamicChannels": {
    "summary": "处理动态音频通道的播放与控制命令。",
    "description": "遍历按运行时名称登记的通道，把当前队列中的播放、停止及参数控制交给 Kira 输出，并保留等待资产加载的请求。"
  },
  "bevy_kira_audio::AudioSystemSet::PlayTypedChannels": {
    "summary": "处理强类型音频通道的播放与控制命令。",
    "description": "为已注册的 AudioChannel 类型执行本轮音频命令，创建或控制实例；具体通道由泛型注册身份决定。"
  },
  "bevy_picking::PickingSystems::Backend": {
    "summary": "通过拾取后端生成指针命中。",
    "description": "在 PreUpdate 中让二维精灵、UI、窗口等后端读取指针和场景数据，发布 PointerHits，供统一遮挡与悬停处理。"
  },
  "bevy_picking::PickingSystems::Hover": {
    "summary": "把后端命中转换为悬停和交互状态。",
    "description": "整理 PointerHits 的深度与阻挡关系，更新悬停图及实体交互标记，并准备指针进入、离开、点击和拖动等事件。"
  },
  "bevy_picking::PickingSystems::Input": {
    "summary": "把设备动作转换为拾取指针输入。",
    "description": "在 First 中将窗口鼠标与触摸事件转换为稳定指针身份、位置及按下、移动、滚动、释放或取消动作。"
  },
  "bevy_picking::PickingSystems::Last": {
    "summary": "提供拾取流程最终的扩展位置。",
    "description": "标记 PreUpdate 中其他拾取集合之后的收尾边界，供额外拾取逻辑排序；空集合不代表执行新的命中检测。"
  },
  "bevy_picking::PickingSystems::PostHover": {
    "summary": "在悬停完成后、监听器触发前提供扩展。",
    "description": "允许逻辑读取已整理的 Hover 状态并在指针事件监听器触发前补充处理，不重复执行拾取后端。"
  },
  "bevy_picking::PickingSystems::PostInput": {
    "summary": "在指针输入生成后、命令提交前处理输入。",
    "description": "在 First 中提供设备 PointerInput 已生成但延迟命令尚未提交的处理阶段，本快照的视口拾取在该位置衔接输入。"
  },
  "bevy_picking::PickingSystems::ProcessInput": {
    "summary": "接收指针输入并重建视图射线。",
    "description": "在 PreUpdate 中更新指针位置和按钮输入，结合相机与视口重建 RayMap，为各拾取后端提供统一射线。"
  },
  "bevy_state::state::transitions::ApplyStateTransition": {
    "summary": "应用待处理状态及其依赖子状态转换。",
    "description": "处理指定状态的 NextState，并根据父状态重算依赖或子状态是否存在，把结果发布为转换消息，供后续退出与进入调度使用。"
  },
  "bevy_state::state::transitions::EnterSchedules": {
    "summary": "执行新状态的进入调度和进入生命周期。",
    "description": "在状态更新后运行对应 OnEnter，并按配置处理进入状态时需要销毁、禁用或启用的实体。"
  },
  "bevy_state::state::transitions::ExitSchedules": {
    "summary": "执行旧状态的退出调度和退出生命周期。",
    "description": "针对离开的状态运行 OnExit，并处理退出该状态时需要销毁、禁用或重新启用的实体。"
  },
  "bevy_state::state::transitions::StateTransitionSystems::DependentTransitions": {
    "summary": "先计算彼此依赖的状态转换。",
    "description": "从各状态的 NextState 及父状态派生规则计算转换，在运行状态相关调度前使父子、派生状态的转换结果一致。"
  },
  "bevy_state::state::transitions::TransitionSchedules": {
    "summary": "执行特定状态对的转换和谓词生命周期。",
    "description": "针对同时具有旧状态与新状态的转换运行 OnTransition，并处理由状态转换谓词控制的销毁、启用或禁用行为。"
  },
  "bevy_text::EditableTextSystems": {
    "summary": "统一应用可编辑文字的待处理操作。",
    "description": "把文本输入、输入法或剪贴板排队的编辑交给 EditableText 应用，随后再由布局阶段更新光标、文字几何和视口。"
  },
  "bevy_time::TimeSystems": {
    "summary": "更新真实、虚拟及当前通用时钟。",
    "description": "推进应用的本帧累计时间和时间增量，协调渲染时刻、时间策略及虚拟时钟；依赖 Time 的系统通常应排在这一更新之后。"
  },
  "bevy_transform_interpolation::TransformEasingSystems::Ease": {
    "summary": "在固定状态之间计算本帧平滑变换。",
    "description": "固定循环结束后、普通 Update 之前，根据起止采样和固定步 overstep 插值或外推平移、旋转和缩放。"
  },
  "bevy_transform_interpolation::TransformEasingSystems::Reset": {
    "summary": "在固定步开始清空旧平滑端点。",
    "description": "把各平滑状态重置为 None，为当前固定步重新采集起点及终点，避免复用上一轮失效的采样。"
  },
  "bevy_transform_interpolation::TransformEasingSystems::UpdateEasingTick": {
    "summary": "记录最近一次平滑更新的刻度。",
    "description": "在变换平滑阶段末更新 LastEasingTick，使后续检查可以区分正常平滑回写与外部 Transform 修改。"
  },
  "bevy_transform_interpolation::TransformEasingSystems::UpdateEnd": {
    "summary": "在固定步结束采集平滑终点。",
    "description": "更新插值的结束采样，或根据外推速度来源准备端点，使显示帧能够在固定步之间恢复连续姿态。"
  },
  "bevy_transform_interpolation::TransformEasingSystems::UpdateStart": {
    "summary": "在固定步开始采集平滑起点。",
    "description": "记录当前平移、旋转和缩放作为该固定步的起始状态，与结束采样配对供本帧插值使用。"
  },
  "bevy_transform::plugins::TransformSystems::Propagate": {
    "summary": "沿父子层级传播世界空间变换。",
    "description": "标记变化的变换树并由父到子更新 GlobalTransform，同时同步不需要层级传播的独立实体；其他布局、可见性和物理变换逻辑可相对此阶段排序。"
  },
  "bevy_ui_widgets::menu::MenuFocusSystem": {
    "summary": "为新打开的菜单取得首个内部焦点。",
    "description": "在 PostUpdate 中按菜单的导航方向选择可聚焦项并更新 InputFocus，使菜单打开后能够接收键盘导航。"
  },
  "bevy_ui_widgets::text_input::ImeSystems::HandleEvents": {
    "summary": "把输入法消息转换为聚焦文字的编辑操作。",
    "description": "在 PreUpdate 为聚焦的可编辑文本整理预编辑、提交及输入法启停操作，保留到 EditableText 的统一应用阶段。"
  },
  "bevy_ui_widgets::text_input::ImeSystems::ToggleWindowIMEInput": {
    "summary": "根据当前可编辑焦点开关窗口输入法。",
    "description": "在 PreUpdate 检查聚焦文本是否允许编辑，启用或关闭窗口 IME，并在转为只读时清理组合文本。"
  },
  "bevy_ui_widgets::text_input::ImeSystems::UpdatePosition": {
    "summary": "让输入法候选窗口跟随文字光标。",
    "description": "在 PostUpdate 把当前光标或预编辑区域从文字布局空间换算到窗口位置，使系统候选窗口显示在编辑位置附近。"
  },
  "bevy_ui::accessibility::AccessibilityUiSystems": {
    "summary": "更新 UI 控件的可访问性语义和几何。",
    "description": "把按钮、图像、文本等 UI 数据及布局边界转换为 AccessibilityNode 信息，供平台可访问性树更新使用。"
  },
  "bevy_ui::AmbiguousWithText": {
    "summary": "声明图像类 UI 更新可与 UI 文字系统无序。",
    "description": "把只观察自身图像或只更新视口图像的成员与 widget::text_system 标为允许歧义，避免因共同声明 Assets<Image> 访问产生不必要的排序警告；不建立额外执行依赖。"
  },
  "bevy_ui::AmbiguousWithUpdateText2dLayout": {
    "summary": "声明图像类 UI 更新可与二维文字布局无序。",
    "description": "把图像尺寸和视口图像更新成员与 update_text2d_layout 标为允许歧义；源码确认文字只创建新图像、相关成员仅处理各自图像，因此无需仅因 Assets<Image> 声明强行排序。"
  },
  "bevy_ui::UiSystems::Content": {
    "summary": "在 UI 布局前测量文字和内容需求。",
    "description": "更新内联图像、文字测量、可编辑文字样式及内容尺寸，并同步字体到 Em 单位，为布局算法提供内容约束。"
  },
  "bevy_ui::UiSystems::Focus": {
    "summary": "更新本帧 UI 指针交互状态。",
    "description": "在 PreUpdate 中依据指针位置、节点几何和交互规则刷新 UI 的悬停、按下等状态，供随后按钮或控件行为读取。"
  },
  "bevy_ui::UiSystems::Layout": {
    "summary": "计算 UI 节点本帧的布局几何。",
    "description": "在 PostUpdate 更新节点尺寸、位置和布局结果，并协调依赖该几何的弹出层或滚动条等布局内处理。"
  },
  "bevy_ui::UiSystems::PostLayout": {
    "summary": "根据完成的布局生成裁切和文字几何。",
    "description": "把需要本帧 UI 布局结果的裁切、文字渲染布局、可编辑文字光标和视口尺寸等处理排在 Layout 之后。"
  },
  "bevy_ui::UiSystems::Prepare": {
    "summary": "建立 PostUpdate 中 UI 更新的准备边界。",
    "description": "提供本轮 UI 更新的起始位置，准备目标相机等后续内容测量与布局需要的信息；其余 UI 后更新阶段排在该边界中或之后。"
  },
  "bevy_ui::UiSystems::Propagate": {
    "summary": "沿 UI 层级传播布局所需的组件值。",
    "description": "传播计算后的目标相机和渲染目标信息等布局输入，处理源覆盖、继承及输出，使每个节点在布局前取得对应值。"
  },
  "bevy_ui::UiSystems::Stack": {
    "summary": "按层级和 Z 顺序重建 UI 绘制栈。",
    "description": "在 PostUpdate 整理 UI 根节点与子树，更新 UiStack 和计算栈索引，为 UI 绘制和指针遮挡提供一致顺序。"
  },
  "bevy_window::cursor::CursorSystems::Update": {
    "summary": "把 CursorIcon 变化准备给窗口后端。",
    "description": "读取应用指定的光标图标并安排原生窗口更新；需要本帧生效的光标修改应排在该阶段之前。"
  },
  "bevy_window::system::ExitSystems": {
    "summary": "按窗口关闭策略请求应用退出。",
    "description": "安排 exit_on_all_closed 或 exit_on_primary_closed 等策略系统，在满足配置的窗口关闭条件时发布应用退出请求。"
  },
  "demo::audio::AudioSystems::Mix": {
    "summary": "在播放请求前更新有效音量。",
    "description": "更新设置与预览产生的有效混音，并把素材音量和通道增益同步到实例，保证同帧播放阶段采用当前音量。"
  },
  "demo::audio::AudioSystems::Playback": {
    "summary": "消费声音请求并处理场景退出停播。",
    "description": "在混音之后把业务声音请求转换为通道命令，处理播放去重、实例跟踪和离开会话时的停止行为。"
  },
  "demo::game_flow::FixedGameplaySystems::Attachment": {
    "summary": "完成持物关系清理和共享碰撞体装配。",
    "description": "在固定步交互和目标更新之后，清除失效持握及碰撞代理、恢复质量，应用挂接变更并同步持物物理姿态；结构变更按链式同步边界提交。"
  },
  "demo::game_flow::FixedGameplaySystems::Facing": {
    "summary": "在固定步运动前处理人物朝向。",
    "description": "消费待处理转向并检查持物旋转路径，先处理真实受阻时的安全释放，再让人物朝向进入当前固定模拟。"
  },
  "demo::game_flow::FixedGameplaySystems::Interaction": {
    "summary": "在固定步内处理拾取和释放请求。",
    "description": "消费角色的一次性交互意图，执行物品拾取、共享持握或主动释放，给后续目标与装配阶段提供更新后的关系。"
  },
  "demo::game_flow::FixedGameplaySystems::Motion": {
    "summary": "观察接地并施加角色移动与跳跃。",
    "description": "在恢复和朝向处理之后更新接地状态，按角色意图施加水平运动并执行单次跳跃，先于物品交互与装配。"
  },
  "demo::game_flow::FixedGameplaySystems::Recover": {
    "summary": "在固定步开始恢复越界实体。",
    "description": "先把落水或越界的可恢复实体放回各自出生姿态并协调插值恢复，再进行该步朝向、角色运动及交互。"
  },
  "demo::game_flow::FixedGameplaySystems::Target": {
    "summary": "在装配前同步本帧持物呈现目标。",
    "description": "根据人物呈现姿态和唯一挂接局部姿态更新持物模型及 HeldTarget，为随后的挂接装配与约束检查提供目标。"
  },
  "demo::game_flow::PresentationSystems::Camera": {
    "summary": "在持物呈现同步之后更新第一人称相机。",
    "description": "固定循环后的呈现链中，根据人物本帧插值姿态和观察角更新镜头；即使本帧没有固定步也按同一顺序执行。"
  },
  "demo::game_flow::PresentationSystems::Facing": {
    "summary": "在插值后处理本帧人物转向。",
    "description": "在变换平滑之后、持物物理与显示姿态同步之前消费完整转向，处理持物旋转受阻并保持镜头观察自由。"
  },
  "demo::game_flow::PresentationSystems::HeldPhysics": {
    "summary": "在显示帧同步持物碰撞姿态。",
    "description": "人物本帧朝向确定后，同步箱根和共享碰撞代理，保证没有固定步的帧中物理朝向也能与人物呈现一致。"
  },
  "demo::game_flow::PresentationSystems::HeldPresentation": {
    "summary": "在显示帧同步持物模型及检查目标。",
    "description": "持物物理姿态更新后，依据人物插值 Transform 和挂接局部姿态同步独立物品模型与握持检查目标，再更新相机。"
  },
  "demo::game_flow::PresentationSystems::Visibility": {
    "summary": "在相机更新后隐藏受控角色自身模型。",
    "description": "根据本帧控制关系和第一人称镜头，更新人物模型可见性，完成固定循环后的呈现链。"
  },
  "demo::ui::UiSystems::Build": {
    "summary": "按页面和视口变化重建菜单实体树。",
    "description": "在本帧指针采样前生成或替换 BSN 页面结构，并先应用生成与销毁命令；只改变数值、焦点或提示时保留已有滚动控件。"
  },
  "demo::ui::UiSystems::Pointer": {
    "summary": "在菜单实体树就绪后处理指针交互。",
    "description": "使用当前页面的真实按钮和控件实体读取指针，生成点击、悬停等菜单交互状态，为随后视觉样式更新提供来源。"
  },
  "demo::ui::UiSystems::Style": {
    "summary": "更新菜单文字、视觉焦点及音频预览。",
    "description": "在页面构建与指针处理之后更新按钮高亮、设置值、说明文本和焦点滚动，并发布当前音量预览，供音频混音阶段使用。"
  }
});
