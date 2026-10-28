// 按锁定声明的实际算法、分支和生命周期核对的系统职责。
export const PHYSICS_UI_SCHEDULE_SYSTEM_PURPOSES = {
  "avian3d::collider_tree::optimization::finish_optimize_trees": {
    "summary": "合并完成的碰撞体树优化结果。",
    "description": "接手后台尚未开始的优化作业；仍有作业执行时等待任务完成，然后把各作业的 BVH 和工作区写回对应树并累计优化耗时。没有任务时直接返回。"
  },
  "avian3d::collider_tree::update::clear_moved_proxies": {
    "summary": "清空本轮广相使用的移动代理目录。",
    "description": "同时清空全局 MovedProxies 和每棵碰撞体树自己的移动代理列表，结束这一轮位移引起的候选接触重检记录，避免带到下一轮。"
  },
  "avian3d::collider_tree::update::update_moved_collider_aabbs": {
    "summary": "重算物理步后被手动改变的碰撞边界。",
    "description": "只处理自 LastPhysicsTick 之后位姿或形状改变且未禁用的碰撞体；重算实际 AABB，形状变化时更新扩大余量，边界越出旧包围盒才把代理重新插入对应树并标为移动。"
  },
  "avian3d::collider_tree::update::update_solver_body_aabbs": {
    "summary": "按物理结果更新活跃刚体的碰撞边界。",
    "description": "遍历醒着的动态和运动学求解体，更新其附着碰撞体 AABB；启用 SpeculativeCcd 时按线速度、旋转及质心偏移扩展预测运动。越出扩大边界的代理更新树位置，并记录更新刻度和耗时。"
  },
  "avian3d::collision::broad_phase::bvh_broad_phase::collect_collision_pairs": {
    "summary": "为移动碰撞代理收集广相候选接触。",
    "description": "并行查询动态、运动学、静态和独立碰撞体树，普通静态对静态组合不查询；汇总筛选后的候选对加入 ContactGraph，并依事件、传感器和刚体禁用标记设置通知与约束生成规则。"
  },
  "avian3d::collision::collider::backend::init_collider_constructors": {
    "summary": "把就绪的碰撞构造配置变成实际形状。",
    "description": "为未有 Collider 的实体执行构造器，网格尚未加载时保留配置等待；可用时复用网格形状缓存，成功后排入 Collider 和就绪事件。已有形状或构造失败时报告并移除配置，缺少必需网格句柄会报错。"
  },
  "avian3d::collision::collider::backend::update_collider_mass_properties": {
    "summary": "按变化的形状和密度重算碰撞体质量。",
    "description": "仅处理形状或 ColliderDensity 发生变化的非传感器碰撞体，以当前几何与密度计算 ColliderMassProperties，替换其质量属性缓存。"
  },
  "avian3d::collision::collider::backend::update_collider_scale": {
    "summary": "把根节点和附属碰撞体的缩放传给形状。",
    "description": "根碰撞体仅在配置允许时采用 Transform.scale；子碰撞体采用已传播的 ColliderTransform.scale。只有缩放值实际不同时才重新缩放几何形状。"
  },
  "avian3d::collision::collider::collider_transform::plugin::propagate_collider_transforms": {
    "summary": "沿实体层级计算碰撞体相对刚体的变换。",
    "description": "从包含碰撞体后代的根节点向下累积变换与缩放，遇到子刚体时重新开始其局部坐标系；传播时校验父子关系一致，避免跨分支写入错误的 ColliderTransform。"
  },
  "avian3d::collision::collider::collider_transform::plugin::update_child_collider_position": {
    "summary": "由所属刚体位姿更新附属碰撞体的世界位姿。",
    "description": "对自身不是刚体的碰撞体，依据 ColliderOf 找到所属刚体，把 ColliderTransform 的局部平移和旋转合成到刚体世界位姿；找不到目标刚体时跳过。"
  },
  "avian3d::collision::narrow_phase::trigger_collision_events": {
    "summary": "把碰撞开始和结束消息触发为实体事件。",
    "description": "读取接触变化，对开启 CollisionEventsEnabled 的每一方生成以该方为 collider1 的事件；先汇集到可复用缓冲，再通过独占 World 直接触发，避免为每条事件单独排入命令。"
  },
  "avian3d::collision::narrow_phase::update_narrow_phase": {
    "summary": "更新窄相接触并输出碰撞变化消息。",
    "description": "调用 NarrowPhase 根据当前时间步、形状上下文及碰撞钩子更新接触，维护开始和结束消息及后续命令，并保存窄相耗时和接触图中的接触数量。"
  },
  "avian3d::dynamics::integrator::clear_velocity_increments": {
    "summary": "在子步循环后清零速度积分增量。",
    "description": "并行清空具有求解器索引的刚体的线性及角速度增量，并累计清理耗时，防止本轮累加作用沿用到下一物理步。"
  },
  "avian3d::dynamics::integrator::pre_process_velocity_increments": {
    "summary": "把加速度、重力和轴锁转成子步速度增量。",
    "description": "仅处理动态刚体：先按阻尼系数和子步时长缓存衰减因子，累加带 GravityScale 的重力，再屏蔽锁定轴，最后乘时间步把加速度转为速度增量。"
  },
  "avian3d::dynamics::joints::distance::update_local_anchors": {
    "summary": "将距离关节的锚点换算到刚体局部空间。",
    "description": "只处理发生变化的 DistanceJoint；锚点已全为局部坐标时跳过，否则读取两端位姿并求出局部锚点，缺少任一刚体时不更新。"
  },
  "avian3d::dynamics::joints::fixed::update_local_frames": {
    "summary": "将固定关节参考框架换算到两端局部空间。",
    "description": "只处理变化的 FixedJoint，锚点和基向均已局部化时保持原值；否则按两端刚体位姿计算局部框架，供约束保持相对位置和朝向。"
  },
  "avian3d::dynamics::joints::joint_graph::plugin::on_change_joint_entities": {
    "summary": "在关节换端后重接刚体连接图。",
    "description": "比较变化关节的两端实体与旧图边，确有变更时移除旧边并以新端点重新加入，发送移除和新增消息供物理岛更新；启用 XPBD 时同步转移速度投影标记。"
  },
  "avian3d::dynamics::joints::prismatic::update_local_frames": {
    "summary": "将滑动关节参考框架换算到局部空间。",
    "description": "只处理变化的 PrismaticJoint，读取两端位姿把非局部锚点和基向换成本体坐标；框架已全为局部或端点缺失时跳过。"
  },
  "avian3d::dynamics::joints::revolute::update_local_frames": {
    "summary": "将旋转关节参考框架换算到局部空间。",
    "description": "只处理变化的 RevoluteJoint，依据两端刚体位姿把锚点和基向转换成本地框架，使枢轴约束使用稳定的局部输入；已转换或缺少端点时跳过。"
  },
  "avian3d::dynamics::joints::spherical::update_local_frames": {
    "summary": "将球铰参考框架换算到局部空间。",
    "description": "只处理变化的 SphericalJoint，依据两端位姿计算局部锚点与基向；已有完整局部框架时不再转换，找不到任一端点时保留原值。"
  },
  "avian3d::dynamics::rigid_body::body_size_metrics::update_body_size_metrics": {
    "summary": "重算刚体的 CCD 厚度和最大扫掠半径。",
    "description": "质心或附着碰撞体形状、相对变换变化时，遍历刚体碰撞体，取最小保守厚度及到质心的最大距离，更新 BodySizeMetrics 供连续碰撞检测使用。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_angular_acceleration": {
    "summary": "把恒定世界角加速度加入待积分增量。",
    "description": "将 ConstantAngularAcceleration 直接累加到 VelocityIntegrationData 的角增量；此时增量仍表示加速度，后续预处理才乘子步时长。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_forces": {
    "summary": "按总质量把恒力换成待积分线加速度。",
    "description": "用 ComputedMass 的逆质量乘 ConstantForce，累加到线性积分数据；不同质量的刚体会得到不同加速度，时间步换算留给后续预处理。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_linear_acceleration": {
    "summary": "把恒定世界线加速度加入待积分增量。",
    "description": "将 ConstantLinearAcceleration 直接累加到线性积分数据，不经过质量换算，随后与其他加速度一起按子步时长积分。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_local_angular_acceleration": {
    "summary": "累加刚体局部坐标中的恒定角加速度。",
    "description": "把 ConstantLocalAngularAcceleration 写入局部角加速度缓存，保留在本体坐标系中，稍后结合当前姿态转换并作用于求解器速度。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_local_forces": {
    "summary": "按总质量把局部恒力转成局部线加速度。",
    "description": "将 ConstantLocalForce 乘逆总质量后累加到 AccumulatedLocalAcceleration；方向仍相对于刚体，后续应用阶段再转换到世界空间。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_local_linear_acceleration": {
    "summary": "累加刚体局部坐标中的恒定线加速度。",
    "description": "把 ConstantLocalLinearAcceleration 直接加入局部线加速度缓存，不经过质量换算，供随后按当前旋转和轴锁应用。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_local_torques": {
    "summary": "按局部惯量把恒定局部扭矩转成角加速度。",
    "description": "用 ComputedAngularInertia 的逆惯量作用于 ConstantLocalTorque，累加局部角加速度缓存，之后再转换到世界空间并积分。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_constant_torques": {
    "summary": "按求解器有效惯量换算世界恒定扭矩。",
    "description": "通过 SolverBodyIndex 读取当前求解器惯性数据，把 ConstantTorque 转成待积分角加速度；索引没有对应惯性数据时跳过。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::apply_local_acceleration": {
    "summary": "在子步中把局部加速度作用到世界速度。",
    "description": "对未使用自定义速度积分的刚体，结合起始旋转与本子步旋转增量转换局部线／角加速度，屏蔽锁定轴后乘子步时长并更新求解器速度。"
  },
  "avian3d::dynamics::rigid_body::forces::plugin::clear_accumulated_local_acceleration": {
    "summary": "清空本轮已变化的局部加速度缓存。",
    "description": "只访问发生变化的 AccumulatedLocalAcceleration，将线性和三维角加速度归零；清理绕过变化检测，避免清零本身再次触发下一轮变化处理。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::queue_mass_recomputation_on_collider_mass_change": {
    "summary": "在附属碰撞体质量输入变化时请求刚体重算。",
    "description": "检测碰撞体质量属性、相对变换或显式质量输入变化，通过 ColliderOf 找到所属刚体并排入 RecomputeMassProperties；目标已不存在时不发命令。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::warn_invalid_mass": {
    "summary": "报告动态刚体无效的总质量或总惯量。",
    "description": "在已变化且需要检查的质量属性上验证有效性，只为动态刚体报告警告并给出补充形状或质量属性的建议，不直接修改模拟数据。"
  },
  "avian3d::dynamics::solver::islands::sleeping::update_sleeping_states": {
    "summary": "按刚体静止时间判断物理岛的休眠资格。",
    "description": "线速度和角速度低于阈值时累计 SleepTimer，否则归零；未达到等待时间的刚体将整岛标为保持清醒。已够静止但有约束移除的岛会被选为后续拆分候选。"
  },
  "avian3d::dynamics::solver::islands::sleeping::wake_all_islands": {
    "summary": "批量请求唤醒当前全部休眠物理岛。",
    "description": "收集 is_sleeping 的岛并排入 WakeIslands 命令，没有休眠岛时不发命令；用于重力等全局变化后使物体重新参与模拟。"
  },
  "avian3d::dynamics::solver::islands::sleeping::wake_islands_with_sleeping_disabled": {
    "summary": "让禁止休眠或已禁用的刚体所属岛保持清醒。",
    "description": "查找带 SleepingDisabled、Disabled 或 RigidBodyDisabled 的刚体，设置其岛的唤醒位并重置 SleepTimer，使岛休眠判定不会把这些状态当作持续静止。"
  },
  "avian3d::dynamics::solver::islands::sleeping::wake_on_changed": {
    "summary": "因外部位姿、速度或受力变化标记物理岛唤醒。",
    "description": "对休眠刚体，仅当位姿、速度或睡眠计时在上次物理结束刻度之后变化才标记，避免把物理内部写入误作用户改动；恒力或 GravityScale 变化则直接标记所属岛。"
  },
  "avian3d::dynamics::solver::plugin::apply_contact_status_changes": {
    "summary": "把接触增删同步到约束图和物理岛。",
    "description": "排空窄相记录的接触状态变化，逐项维护约束与岛连接，汇总受到影响的休眠岛；唤醒名单排序去重后通过 WakeIslands 命令统一应用。"
  },
  "avian3d::dynamics::solver::plugin::apply_joint_graph_changes": {
    "summary": "把关节连接变化同步到模拟岛。",
    "description": "读取关节图新增和移除消息，连接或解除对应岛节点，并请求唤醒受影响的休眠岛；已失效的关节变化会跳过，未启用物理岛时只清空消息。"
  },
  "avian3d::dynamics::solver::plugin::prepare_contact_constraints": {
    "summary": "从有效接触流形生成本轮求解约束。",
    "description": "清空上一轮约束，按图颜色并行处理接触流形；跳过不生成约束、缺少刚体及双方均非动态的对，结合惯量、相对速度和柔度生成非空接触约束并汇总数量。"
  },
  "avian3d::dynamics::solver::plugin::store_contact_impulses": {
    "summary": "保存已求得的接触冲量供下一轮热启动。",
    "description": "逐接触流形把法向和切向约束冲量写回 ContactGraph，同时记录法向总冲量以供碰撞数据查询，避免下轮从零开始求解已有接触。"
  },
  "avian3d::dynamics::solver::plugin::update_contact_softness": {
    "summary": "按时间步和配置更新接触柔度系数。",
    "description": "SolverConfig 或物理／子步时钟变化时重算阻尼和频率系数，频率受时间步上限约束；对静态和运动学对象的接触采用更高频率，以减轻穿入环境的情况。"
  },
  "avian3d::dynamics::solver::solver_body::plugin::prepare_solver_bodies": {
    "summary": "把 ECS 刚体状态准备成子步求解数据。",
    "description": "复制速度、清零本轮位姿增量，并按世界旋转、总质量和惯量、轴锁与支配等级准备惯性状态；同时设置运动学、自定义位姿积分和三维陀螺运动标志。"
  },
  "avian3d::dynamics::solver::solver_body::plugin::update_solver_body_angular_inertia": {
    "summary": "按当前朝向刷新求解器的有效逆惯量。",
    "description": "通过每个刚体的求解器索引，把 ComputedAngularInertia 旋转到当前朝向并更新有效逆角惯量，使后续旋转约束使用当前世界方向上的响应。"
  },
  "avian3d::dynamics::solver::solver_body::plugin::writeback_solver_bodies": {
    "summary": "将求解后的位姿和速度回写 ECS。",
    "description": "合并求解体的平移和旋转增量，并用旋转前后的局部质心偏移修正位置，使物体绕质心转动；随后写回线速度和角速度，并记录回写耗时。"
  },
  "avian3d::interpolation::update_previous_velocity": {
    "summary": "更新平滑显示所需的历史速度快照。",
    "description": "分别把当前 LinearVelocity 和 AngularVelocity 复制到 PreviousLinearVelocity 与 PreviousAngularVelocity，供后续平移和旋转插值读取前一帧速度。"
  },
  "avian3d::physics_transform::transform_to_position": {
    "summary": "把用户改变的世界变换同步到物理位姿。",
    "description": "仅处理新增或在上次物理刻度之后改变的 GlobalTransform；物理 Position／Rotation 若也被用户单独改变则优先保留，否则在差异超出容差时采用变换中的世界位置和旋转。"
  },
  "avian3d::schedule::assert_components_finite": {
    "summary": "在调试构建检查物理位置和速度是否有限。",
    "description": "遍历 Position、LinearVelocity 与 AngularVelocity，使用调试断言拒绝 NaN 或无穷值，并报告实体、组件种类及可用的最后写入位置，帮助定位数值失效来源。"
  },
  "avian3d::schedule::run_physics_schedule": {
    "summary": "使用物理时钟推进 PhysicsSchedule 并恢复原时钟。",
    "description": "按原通用时钟步长和物理速度倍率推进物理与子步时钟，临时以物理时钟替换通用 Time，仅在步长非零时运行调度。暂停时允许手动推进的一步，随后清零暂停增量并恢复原时钟。"
  },
  "avian3d::schedule::update_last_physics_tick": {
    "summary": "记录本次物理阶段结束的 ECS 变化刻度。",
    "description": "把系统当前 Tick 写入 LastPhysicsTick，作为后续变换同步和外部改动检测的时间边界，区分物理内部写入与下一轮用户修改。"
  },
  "avian3d::spatial_query::update_ray_caster_positions": {
    "summary": "把射线发射器的局部原点和方向换到世界空间。",
    "description": "优先采用自身物理 Position／Rotation，否则采用 GlobalTransform；自身缺少对应世界位姿时尝试继承父实体位姿，无父节点时使用原始配置，并更新 RayCaster 的全局射线。"
  },
  "avian3d::spatial_query::update_shape_caster_positions": {
    "summary": "把形状扫掠的原点、方向和形状朝向换到世界空间。",
    "description": "优先读取自身物理位姿或 GlobalTransform，缺失时从父实体补足世界位姿；组合局部原点、方向及形状旋转后更新 ShapeCaster 的全局扫掠配置。"
  },
  "bevy_transform_interpolation::ease_rotation_slerp": {
    "summary": "按固定步剩余比例球面插值显示旋转。",
    "description": "起点和终点均存在时，以 Time<Fixed> 的 overstep_fraction 在两端四元数之间取最短路径球面插值，写入显示 Transform；非线性旋转和平滑禁用标记会排除此路径。"
  },
  "bevy_transform_interpolation::ease_scale_lerp": {
    "summary": "按固定步剩余比例线性插值显示缩放。",
    "description": "起止缩放均有效且没有 NoScaleEasing 时，在 ScaleEasingState 两端按固定时钟剩余比例线性插值，把结果写入 Transform.scale。"
  },
  "bevy_transform_interpolation::ease_translation_lerp": {
    "summary": "按固定步剩余比例线性插值显示位置。",
    "description": "起止位置均有效时，按固定时钟 overstep_fraction 计算线性插值并写入 Transform.translation；已选择非线性平移或禁用平滑的实体不走此路径。"
  },
  "bevy_transform_interpolation::extrapolation::reset_rotation_extrapolation": {
    "summary": "在固定步开始前还原真实旋转。",
    "description": "对启用旋转外推且未禁用平滑的实体，把显示 Transform.rotation 恢复为外推起点，避免把上一帧预测朝向作为下一次固定模拟的真实输入。"
  },
  "bevy_transform_interpolation::extrapolation::reset_translation_extrapolation": {
    "summary": "在固定步开始前还原真实位置。",
    "description": "对启用平移外推且未禁用平滑的实体，把显示 Transform.translation 恢复为外推起点，防止预测出的显示位移再次进入固定模拟。"
  },
  "bevy_transform_interpolation::extrapolation::update_rotation_extrapolation_states": {
    "summary": "依据当前角速度预测下一个旋转端点。",
    "description": "把当前 Transform.rotation 记为起点，取 VelocitySource 当前角速度乘时间步生成增量四元数，组合后记为终点，供固定步之间的旋转外推显示使用。"
  },
  "bevy_transform_interpolation::extrapolation::update_translation_extrapolation_states": {
    "summary": "依据当前线速度预测下一个位置端点。",
    "description": "把当前显示位置记为起点，按 VelocitySource 当前线速度乘时间步得到预测位移并形成终点，仅对启用平移外推且未禁用平滑的实体更新。"
  },
  "bevy_transform_interpolation::hermite::ease_rotation_hermite": {
    "summary": "用两端角速度做 Hermite 旋转平滑。",
    "description": "起止旋转均存在时，从 VelocitySource 读取历史与当前角速度，以固定步时长缩放为切向量，再按剩余步长比例计算四元数 Hermite 曲线并写入显示旋转。"
  },
  "bevy_transform_interpolation::hermite::ease_translation_hermite": {
    "summary": "用两端线速度做 Hermite 位置平滑。",
    "description": "起止位置均存在时，读取历史及当前线速度，以固定步时长缩放后作为 Hermite 切向量，按剩余步长比例求平滑位置并更新 Transform.translation。"
  },
  "bevy_transform_interpolation::interpolation::complete_rotation_easing": {
    "summary": "在新一轮插值前完成上一段旋转。",
    "description": "对使用旋转插值的实体，若保存了上一段终点就直接写入 Transform.rotation，确保下一次模拟从完整应用的真实旋转开始。"
  },
  "bevy_transform_interpolation::interpolation::complete_scale_easing": {
    "summary": "在新一轮插值前完成上一段缩放。",
    "description": "对使用缩放插值的实体，把已有终点应用到 Transform.scale，避免上一帧尚未走完的显示平滑影响后续固定更新。"
  },
  "bevy_transform_interpolation::interpolation::complete_translation_easing": {
    "summary": "在新一轮插值前完成上一段平移。",
    "description": "对使用平移插值的实体，把已有终点应用到 Transform.translation，使下一次固定更新从上一轮完整结果继续。"
  },
  "bevy_transform_interpolation::interpolation::update_rotation_interpolation_end": {
    "summary": "把当前旋转记录为插值终点。",
    "description": "对启用旋转插值且未禁用平滑的实体，更新 RotationEasingState.end 为当前 Transform.rotation，与已保存起点共同供显示阶段取样。"
  },
  "bevy_transform_interpolation::interpolation::update_rotation_interpolation_start": {
    "summary": "把当前旋转记录为插值起点。",
    "description": "对启用旋转插值且未禁用平滑的实体，将当前 Transform.rotation 保存到 RotationEasingState.start，为本轮平滑区间保留初始朝向。"
  },
  "bevy_transform_interpolation::interpolation::update_scale_interpolation_end": {
    "summary": "把当前缩放记录为插值终点。",
    "description": "对启用缩放插值且未禁用平滑的实体，将当前 Transform.scale 写入 ScaleEasingState.end，供显示阶段与起点之间插值。"
  },
  "bevy_transform_interpolation::interpolation::update_scale_interpolation_start": {
    "summary": "把当前缩放记录为插值起点。",
    "description": "对启用缩放插值且未禁用平滑的实体，将当前 Transform.scale 写入 ScaleEasingState.start，保留本轮平滑前的缩放状态。"
  },
  "bevy_transform_interpolation::interpolation::update_translation_interpolation_end": {
    "summary": "把当前位置记录为插值终点。",
    "description": "对启用平移插值且未禁用平滑的实体，将当前 Transform.translation 写入 TranslationEasingState.end，供固定步之间的显示位置插值。"
  },
  "bevy_transform_interpolation::interpolation::update_translation_interpolation_start": {
    "summary": "把当前位置记录为插值起点。",
    "description": "对启用平移插值且未禁用平滑的实体，将当前 Transform.translation 保存到 TranslationEasingState.start，为本轮平滑提供起始位置。"
  },
  "bevy_transform_interpolation::reset_easing_states_on_transform_change": {
    "summary": "在外部直接改变变换时取消失效的平滑区间。",
    "description": "通过 LastEasingTick 识别平滑逻辑之外的 Transform 修改；平移、旋转和缩放分别检查，新值既不等于旧起点也不等于旧终点时才清除该通道端点，使瞬移不会被插值拉回。"
  },
  "bevy_transform_interpolation::reset_rotation_easing": {
    "summary": "清除旧旋转平滑的起点和终点。",
    "description": "把 RotationEasingState 的 start 与 end 同时设为 None；没有完整端点时显示插值会跳过，从而终止失效或被移除的旋转平滑区间。"
  },
  "bevy_transform_interpolation::reset_scale_easing": {
    "summary": "清除旧缩放平滑的起点和终点。",
    "description": "把 ScaleEasingState 的两端设为 None，让后续显示插值不再沿旧缩放区间取样，本系统不改当前 Transform。"
  },
  "bevy_transform_interpolation::reset_translation_easing": {
    "summary": "清除旧位置平滑的起点和终点。",
    "description": "把 TranslationEasingState 的两端设为 None，停止旧位置区间的显示插值，同时保留当前 Transform 的真实值。"
  },
  "bevy_transform_interpolation::update_last_easing_tick": {
    "summary": "记录平滑系统完成后的变化检测边界。",
    "description": "把当前系统 Tick 写入 LastEasingTick，供随后判断 Transform 是否由外部逻辑再次修改，避免把平滑自身写入误判为瞬移。"
  },
  "bevy_transform::systems::mark_dirty_trees": {
    "summary": "沿祖先链标记需要重算变换的子树。",
    "description": "启用静态变换优化时，收集局部变换、父关系变化及新增世界变换和失去父关系的实体，将 TransformTreeChanged 标记一路传播到祖先；多线程路径用位集去重，让未标脏子树可被后续传播整体跳过。"
  },
  "bevy_transform::systems::parallel::propagate_parent_transforms": {
    "summary": "沿父子层级并行合成世界变换。",
    "description": "从有子节点的根开始，把局部 Transform 合成为 GlobalTransform，再通过共享工作队列向后代传播父级结果；启用静态优化时跳过未标脏的子树，须与标脏及独立实体同步系统配合。"
  },
  "bevy_transform::systems::propagate_transforms_for": {
    "summary": "按指定查询过滤器即时计算世界变换。",
    "description": "对匹配泛型过滤器的实体，通过 TransformHelper 沿层级计算当前 GlobalTransform，成功才写回；计算失败保留旧值，启用追踪时给出诊断，适合同帧移动后立即取用世界变换。"
  },
  "bevy_transform::systems::sync_simple_transforms": {
    "summary": "同步没有父子层级的独立实体世界变换。",
    "description": "为局部变换已改变或新增 GlobalTransform 的无父无子实体直接复制 Transform；对刚移除父关系的独立实体另做补偿更新，避免沿用旧父级的世界变换。"
  },
  "bevy_ui::accessibility::sync_bounds_and_transforms": {
    "summary": "把 UI 几何同步到无障碍树。",
    "description": "节点尺寸、自身变换或无障碍父级变换变化时，更新 AccessibilityNode 边界，并在父变换可逆时换算为父级相对变换；无效或恒等变换则清除变换属性。"
  },
  "bevy_ui::focus::ui_focus_system": {
    "summary": "按鼠标和触摸更新旧式 UI 交互状态。",
    "description": "仅为输出到窗口的相机换算指针坐标，按 UI 堆叠由前向后检查可见区域和裁剪；更新相对光标、Hovered／Pressed／None，遇到阻挡焦点策略时停止向下穿透，并处理释放与同帧按下后释放的清理。"
  },
  "bevy_ui::layout::clipping::update_clipping_system": {
    "summary": "从 UI 根递归更新继承裁剪范围。",
    "description": "沿 UI 子树把节点布局、全局变换与父级裁剪交给裁剪计算，维护每个节点的 CalculatedClip，并处理 OverrideClip 和 FixedNode 对祖先裁剪上下文的例外。"
  },
  "bevy_ui::layout::sync_font_size_to_em_size": {
    "summary": "把文本字号解析为节点的 EmSize。",
    "description": "TextFont、目标视口信息或 RemSize 变化时，按目标逻辑尺寸解析字体大小并更新 EmSize；没有 TextFont 的节点及移除字体后的旧 EmSize 不由此系统改写。"
  },
  "bevy_ui::layout::ui_layout_system": {
    "summary": "求解 UI 布局并回写节点尺寸和二维变换。",
    "description": "把变化的样式、内容测量和层级同步到 Taffy，清理移除的节点，再对 UI 根及 FixedNode 按目标视口求布局。递归回写物理像素尺寸、边框和内容范围，组合相对变换与滚动偏移，并处理像素舍入、轮廓及滚动范围。"
  },
  "bevy_ui::stack::ui_stack_system": {
    "summary": "重建稳定的 UI 绘制和命中顺序。",
    "description": "从 UI 根及带 GlobalZIndex 的节点建立排序根，按全局及局部层级顺序遍历各子树且避免重复纳入全局排序节点，生成 UiStack 分段并回写每个节点的 ComputedStackIndex。"
  },
  "bevy_ui::update::propagate_ui_target_cameras": {
    "summary": "为 UI 根配置目标相机和视口信息传播源。",
    "description": "优先选择根的 UiTargetCamera，否则采用默认 UI 相机；结合相机缩放、UiScale 和视口像素大小，排入两个 Propagate 组件，供层级传播系统传给后代，并移除非根节点上的旧传播源。"
  },
  "bevy_ui::widget::image::update_image_content_size_system": {
    "summary": "按图像或图集区域更新 UI 的固有尺寸测量。",
    "description": "仅为 Auto 图像模式且非透明占位图建立图像测量，优先采用显式裁片，再取图集区域或纹理尺寸并乘目标缩放；图像模式变化时清除不再适用的测量，尺寸和输入未变时避免重算。"
  },
  "bevy_ui::widget::inline_image::update_inline_image_boxes": {
    "summary": "把内联图像尺寸同步到文本排版盒。",
    "description": "图像组件或图像资产变化时解析实际尺寸；资源存在且尺寸有限、正数时建立随文本流动的 InlineBox，否则把盒子设为零尺寸并移出文本流。"
  },
  "bevy_ui::widget::text_input_layout::sync_editable_text_viewports": {
    "summary": "在文本编辑前同步可编辑区域的视口。",
    "description": "从 ComputedNode 的内容盒取得实际尺寸，只有视口大小变化时才更新 EditableText.viewport，并把新宽度传给文本编辑器用于后续换行和编辑。"
  },
  "bevy_ui::widget::text_input_layout::update_editable_text_content_size": {
    "summary": "按可见字符宽度和行数设置输入框固有尺寸。",
    "description": "输入配置、字体、行高或目标缩放变化时，用字体中字符 0 的前进宽度计算 visible_width，用解析行高计算 visible_lines，并换算为目标像素测量；两维都没有约束时清除旧内容测量。"
  },
  "bevy_ui::widget::text_input_layout::update_editable_text_layout": {
    "summary": "刷新可编辑文本的字形布局和编辑反馈。",
    "description": "布局代数或字体提示变化时重建 TextLayoutInfo 的字形、行几何、选区和输入法预编辑下划线，并把所需字形加入图集；同时依据焦点和实时时钟更新光标闪烁，必要时显露光标并限制文本视口滚动范围。"
  },
  "bevy_ui::widget::text_input_layout::update_editable_text_styles": {
    "summary": "把字体和排版配置同步到可编辑文本引擎。",
    "description": "按 TextFont、LineHeight、TextLayout 及目标缩放的变化更新编辑器字体族、字号、字重、字形特性、行高和对齐，并把各类换行规则转换为 Parley 的断词和溢出配置。"
  },
  "bevy_ui::widget::text::measure_text_system": {
    "summary": "在文本变化后更新内容测量并安排文字重排。",
    "description": "文本、目标缩放或计算文本状态需要更新时重新生成测量；不换行文本缓存固定尺寸，其他文本使用动态测量，并标记后续重排。字体暂缺或比例退化时保留重试标记，字形图集等不可恢复错误则报错终止。"
  },
  "bevy_ui::widget::viewport::update_viewport_render_target_size": {
    "summary": "按 UI 视口节点尺寸调整相机图像目标。",
    "description": "节点或相机引用变化时，只对有效相机的图像 RenderTarget 调整像素尺寸，宽高至少为一；相机已失效时清空节点的相机引用，其他目标类型保持原样。"
  }
};
