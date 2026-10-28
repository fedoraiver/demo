// 按锁定 Avian／Bevy UI 声明、字段及本次导出的实际调用核对。
export const PHYSICS_UI_SCHEDULE_TYPE_PURPOSES = {
  "bevy_ui::interaction_states::Pressed": {
    "summary": "标记按钮或控件当前处于按住状态。",
    "description": "这是控件正在被按下或保持按住的状态标记，用于驱动相应交互样式。本项目在指针取消、鼠标失焦或离窗时与 PrimaryPress 一同移除，结束已经失效的主键样式；它不记录触发指针身份或一次点击消息。"
  },
  "avian3d::collision::collision_events::CollisionEventsEnabled": {
    "summary": "为此碰撞体开启接触开始与结束事件。",
    "description": "为碰撞体选择是否接收 CollisionStart、CollisionEnd；事件生成系统根据碰撞双方的此标记分别构造以接收方为 collider1 的事件。它不启停碰撞检测或求解，也不表示碰撞每帧都会发出开始事件。"
  },
  "avian3d::dynamics::solver::schedule::SubstepCount": {
    "summary": "把一次物理步分为指定数量的求解子步。",
    "description": "以整数指定每次 PhysicsSchedule 中运行 SubstepSchedule 的次数，子步时长由物理步长除以该数得到；增大数量可提高约束求解精度，也增加每帧计算量。"
  },
  "avian3d::dynamics::solver::xpbd::plugin::XpbdVelocityProjection": {
    "summary": "要求由 XPBD 位置修正重建刚体速度。",
    "description": "标记参加 XPBD 约束的刚体，使速度投影阶段把子步位置、旋转变化转换回速度。关节图自动为有 XPBD 关节的刚体维护此标记；未注册到关节图的自定义约束需自行添加。"
  },
  "avian3d::collision::collision_events::CollisionStart": {
    "summary": "报告一对碰撞体开始接触及其所属刚体。",
    "description": "保存开始接触的两个碰撞体及可选所属刚体。既作为缓冲消息供系统读取，也可在物理求解后向启用碰撞事件的一侧触发 EntityEvent；collider1 是事件目标，事件不等价于每帧持续接触。"
  },
  "avian3d::collision::collision_events::CollisionEnd": {
    "summary": "报告一对碰撞体结束接触及其所属刚体。",
    "description": "保存结束接触的两个碰撞体及可选所属刚体。既可作为消息读取，也可向启用碰撞事件的一侧触发 EntityEvent；collider1 是事件目标。接触对可能已经删除，因此不能保证还能从接触图取得旧接触数据。"
  },
  "avian3d::collision::collider::constructor::ColliderConstructorReady": {
    "summary": "通知单实体碰撞体已成功构造。",
    "description": "以原来持有 ColliderConstructor 的实体为事件目标，仅在成功插入新 Collider 时触发；构造失败或实体本来已有碰撞体时不发送。"
  },
  "avian3d::collision::collider::constructor::ColliderConstructorHierarchyReady": {
    "summary": "通知层级碰撞体构造尝试已经结束。",
    "description": "以持有 ColliderConstructorHierarchy 的根实体为事件目标，在遍历完后代并尝试构造后触发；没有可构造项或所有项均失败时仍会发送，因此不保证层级内确实存在新 Collider。"
  },
  "avian3d::schedule::LastPhysicsTick": {
    "summary": "记录上一轮物理调度结束的变化刻度。",
    "description": "保存上次 PhysicsSchedule 结束时的 ECS Tick，供位姿同步和休眠唤醒等系统识别此后发生的组件变化；它是变化检测边界，不是经过时间。"
  },
  "avian3d::collision::contact_types::contact_graph::ContactGraph": {
    "summary": "维护碰撞体接触对及其碰撞数据。",
    "description": "以无向图连接 AABB 相交的碰撞体，分别保存活跃和休眠接触对及快速查找索引；广相、窄相、求解器和物理岛维护共同使用它。"
  },
  "avian3d::collider_tree::ColliderTrees": {
    "summary": "按运动类别组织碰撞体加速树。",
    "description": "分别保存动态、运动学、静态及独立碰撞体的树结构，用于广相寻找潜在碰撞对及射线、形状扫掠等空间查询。"
  },
  "avian3d::dynamics::integrator::Gravity": {
    "summary": "设置作用于动态刚体的全局重力。",
    "description": "以世界空间加速度向量保存重力，速度积分结合每个刚体的 GravityScale 使用；运行时可修改或设为零，自定义速度积分的刚体自行处理该作用。"
  },
  "avian3d::dynamics::rigid_body::physics_material::Friction": {
    "summary": "配置碰撞对象的静摩擦和动摩擦。",
    "description": "分别保存相对静止和滑动时的摩擦系数，以及两个对象接触时的系数合并规则；窄相把材质结果传给后续接触约束。"
  },
  "avian3d::dynamics::rigid_body::physics_material::Restitution": {
    "summary": "配置碰撞后的弹跳恢复程度。",
    "description": "保存恢复系数及接触双方的合并规则；零值表示无弹跳恢复，一值趋向完全弹性，求解器还依据恢复速度阈值避免低速接触抖动。"
  },
  "avian3d::ancestor_marker::AncestorMarker": {
    "summary": "标记含指定组件的实体祖先。",
    "description": "由 AncestorMarkerPlugin 自动维护，用于在层级遍历中识别含目标组件的后代分支；碰撞体变换传播据此跳过无关分支。"
  },
  "avian3d::collider_tree::diagnostics::ColliderTreeDiagnostics": {
    "summary": "记录碰撞体树维护耗时。",
    "description": "分别累计碰撞体树优化和 AABB／BVH 节点更新的耗时，供物理诊断汇总树结构维护成本。"
  },
  "avian3d::collider_tree::optimization::ColliderTreeOptimization": {
    "summary": "配置碰撞体树的优化方式。",
    "description": "保存树优化模式、是否原位优化等设置，控制 BVH 何时重组以及重组时是否允许空间查询继续访问原树。"
  },
  "avian3d::collider_tree::optimization::OptimizationTasks": {
    "summary": "追踪后台碰撞体树优化任务。",
    "description": "保存待完成的树优化作业及后台任务；后台按顺序优化各树，收尾系统可以接手尚未开始的作业并合并结果。"
  },
  "avian3d::collider_tree::proxy_key::ColliderTreeProxyKey": {
    "summary": "定位特定碰撞体树中的代理。",
    "description": "把 ProxyId 与 ColliderTreeType 编码进同一个键，用于在不同运动类型的树之间识别、移动和更新碰撞代理。"
  },
  "avian3d::collider_tree::update::EnlargedProxies": {
    "summary": "标记需要扩大边界的碰撞代理。",
    "description": "以动态与运动学代理位向量记录 ColliderAabb 已越过旧 EnlargedAabb 的代理，供碰撞体树更新阶段处理。"
  },
  "avian3d::collider_tree::update::LastDynamicKinematicAabbUpdate": {
    "summary": "记录动态与运动学 AABB 更新刻度。",
    "description": "保存上次更新这些碰撞体包围盒时的 ECS 变化刻度，使后续更新能够识别此后变化的刚体与碰撞体。"
  },
  "avian3d::collider_tree::update::MovedProxies": {
    "summary": "收集需要重检碰撞对的移动代理。",
    "description": "保存移动代理键及其索引；代理加入树或实际 AABB 越过扩大包围盒时进入此目录，供广相重新寻找候选接触对。"
  },
  "avian3d::collision::collider::cache::ColliderCache": {
    "summary": "复用由网格构建的碰撞体形状。",
    "description": "按网格 AssetId 与 ColliderConstructor 配置缓存 Collider，避免层级及单体构造器重复执行昂贵的凸分解等网格转换。"
  },
  "avian3d::collision::collider::collider_hierarchy::ColliderOf": {
    "summary": "指定碰撞体附着的刚体。",
    "description": "以 Relationship 保存目标刚体 Entity；未手动指定时取层级中最近的刚体，质量重算和碰撞响应据此归属到同一刚体。"
  },
  "avian3d::collision::collider::collider_hierarchy::RigidBodyColliders": {
    "summary": "维护刚体附着的碰撞体集合。",
    "description": "作为 ColliderOf 的关系反向集合，自动记录挂接到刚体的碰撞体实体；应修改 ColliderOf 以保持关系两端同步。"
  },
  "avian3d::collision::collider::collider_transform::ColliderTransform": {
    "summary": "缓存碰撞体相对于刚体的变换。",
    "description": "保存刚体坐标系中的平移与旋转以及碰撞体全局缩放，供接触点、质心和尺寸计算使用，避免反复遍历层级。"
  },
  "avian3d::collision::collider::ColliderAabb": {
    "summary": "保存碰撞体的世界轴对齐包围盒。",
    "description": "以 min 和 max 描述世界空间中的碰撞边界，由物理系统自动更新，用于广相树与候选接触筛选。"
  },
  "avian3d::collision::collider::ColliderAabbMargin": {
    "summary": "控制碰撞体树包围盒的扩大余量。",
    "description": "依据形状尺寸及物理长度单位计算余量，允许碰撞体在扩大边界内小幅移动而不重建树节点；这与接触形状的 CollisionMargin 不同。"
  },
  "avian3d::collision::collider::ColliderDisabled": {
    "summary": "暂停碰撞体检测和空间查询。",
    "description": "给单个碰撞体添加此标记后，它不再参与碰撞检测或空间查询，但仍可贡献刚体质量；移除此标记可恢复检测。"
  },
  "avian3d::collision::collider::CollidingEntities": {
    "summary": "记录当前与碰撞体相交的实体。",
    "description": "仅为主动添加此组件的碰撞体维护当前碰撞实体集合，供后续系统读取相交对象；窄相根据接触状态更新结果。"
  },
  "avian3d::collision::collider::CollisionMargin": {
    "summary": "为碰撞形状添加接触外皮。",
    "description": "在形状外扩额外厚度以改善薄形状接触和数值稳定性；子碰撞体未单独设置时可沿用所属刚体的余量。"
  },
  "avian3d::collision::collider::constructor::ColliderConstructor": {
    "summary": "描述待构建的碰撞体形状。",
    "description": "保存基本形状或网格转换的构造配置；初始化系统在所需网格可用后据此创建实际 Collider，并可复用形状缓存。"
  },
  "avian3d::collision::collider::constructor::ColliderConstructorHierarchy": {
    "summary": "批量配置层级中的碰撞体构造。",
    "description": "为后代网格设置默认构造器、碰撞层及按名称覆盖的配置，初始化系统遍历层级并为命中的实体构建碰撞体。"
  },
  "avian3d::collision::collider::EnlargedAabb": {
    "summary": "保存用于树更新的扩大包围盒。",
    "description": "在 ColliderAabb 外加入余量，实际边界越出后才重新扩大并更新树节点，从而减少小幅运动引发的 BVH 维护。"
  },
  "avian3d::collision::collider::layers::CollisionLayers": {
    "summary": "声明碰撞体所属层和可交互层。",
    "description": "以 memberships 和 filters 两组掩码控制候选交互；双方的所属层均须被对方过滤器接受，碰撞检测才允许配对。"
  },
  "avian3d::collision::collider::parry::Collider": {
    "summary": "保存 Parry 碰撞后端的几何形状。",
    "description": "保存原始形状、缩放后的形状及其缩放值，提供接触检测、包围盒、质量计算和形状扫掠所需的真实几何数据。"
  },
  "avian3d::collision::collider::Sensor": {
    "summary": "将碰撞体设为不阻挡运动的触发器。",
    "description": "传感器保留相交记录和碰撞事件，但允许其他物体穿过，且不计入刚体质量属性；用于区域进入、离开等检测。"
  },
  "avian3d::collision::diagnostics::CollisionDiagnostics": {
    "summary": "汇总碰撞检测耗时与接触数量。",
    "description": "记录广相候选配对、窄相接触更新的耗时以及接触相关计数，供诊断系统展示碰撞检测成本。"
  },
  "avian3d::collision::narrow_phase::NarrowPhaseConfig": {
    "summary": "配置窄相的接触容差。",
    "description": "保存窄相接触生成与稳定性相关参数；接触容差随物理长度单位缩放，帮助持续接触的物体避免数值误差漏检。"
  },
  "avian3d::collision::narrow_phase::system_param::ColliderQuery": {
    "summary": "汇集窄相所需的碰撞体数据。",
    "description": "以 QueryData 汇集形状、位姿、扩大包围盒、碰撞层、材质及传感器状态，供窄相更新接触点；它不是独立存储的组件。"
  },
  "avian3d::collision::narrow_phase::system_param::ContactStatusBits": {
    "summary": "标记接触对新增或移除的状态。",
    "description": "用位向量追踪发生状态变化的接触对，帮助窄相把接触增删传给求解阶段，避免把每对接触都作为新变化处理。"
  },
  "avian3d::collision::narrow_phase::system_param::ContactStatusChangeQueue": {
    "summary": "暂存窄相产生的接触状态变化。",
    "description": "窄相在接触开始或停止生成流形时写入队列，求解器随后据此更新约束图和物理岛连接。"
  },
  "avian3d::collision::narrow_phase::system_param::NarrowPhase": {
    "summary": "组织窄相接触更新与碰撞事件。",
    "description": "作为 SystemParam 汇集碰撞体、刚体、接触图和状态队列，更新活动接触、移除失去 AABB 重叠的对，并产生碰撞开始／结束事件。"
  },
  "avian3d::collision::narrow_phase::system_param::RigidBodyQuery": {
    "summary": "汇集窄相所需的刚体运动数据。",
    "description": "查询刚体类型、位姿、质心、速度、尺寸与可选材质及 CCD 配置，供窄相结合运动状态判断和生成接触。"
  },
  "avian3d::dynamics::ccd::CcdBodyQuery": {
    "summary": "读取刚体单步扫掠所需的数据。",
    "description": "以只读查询连接 SolverBodyIndex、初始位姿、质心、附着碰撞体和尺寸，连续碰撞检测据此重建当前时间步的运动轨迹。"
  },
  "avian3d::dynamics::ccd::SpeculativeCcd": {
    "summary": "配置基于速度的预测接触范围。",
    "description": "启用速度扩大的 AABB 与预测碰撞余量，并以 max_distance 限制最远预测距离；扩大范围会增加候选接触及近似碰撞的风险。"
  },
  "avian3d::dynamics::ccd::SweptCcd": {
    "summary": "配置快速动态刚体的连续扫掠。",
    "description": "选择参与扫掠的刚体类别、线性或非线性模式及触发阈值，减少高速运动穿透；此配置不作用于静态或运动学刚体。"
  },
  "avian3d::dynamics::integrator::CustomPositionIntegration": {
    "summary": "将位姿积分交给自定义逻辑。",
    "description": "标记后不再自动按速度更新刚体位置和旋转，调用方需自行维护位姿；求解器准备阶段保留这一积分方式选择。"
  },
  "avian3d::dynamics::integrator::CustomVelocityIntegration": {
    "summary": "将速度积分交给自定义逻辑。",
    "description": "标记后跳过自动重力、阻尼及外力积分，由调用方维护速度；动态刚体接触、关节冲量及 Forces 直接冲量仍可生效。"
  },
  "avian3d::dynamics::integrator::VelocityIntegrationData": {
    "summary": "缓存子步速度增量和阻尼系数。",
    "description": "累加线性与角加速度，准备阶段乘时间步转成每子步速度增量，并保存阻尼方程系数供积分阶段重复使用。"
  },
  "avian3d::dynamics::integrator::VelocityIntegrationQuery": {
    "summary": "汇集速度积分写入入口。",
    "description": "以 QueryData 关联求解器索引、可变 VelocityIntegrationData 及三维惯量和旋转，供积分系统把阻尼和增量应用到活跃刚体。"
  },
  "avian3d::dynamics::joints::distance::DistanceJoint": {
    "summary": "限制两刚体锚点之间的距离。",
    "description": "保存两端刚体、锚点及距离上下限，约束求解维持锚点间距，可表达弹簧、绳索或距离受限的连接。"
  },
  "avian3d::dynamics::joints::fixed::FixedJoint": {
    "summary": "锁定两刚体的相对位姿。",
    "description": "保存两端参考框架以约束相对平移与旋转；该约束通过迭代求解，可配置刚度并读取连接力，仍可能存在数值误差。"
  },
  "avian3d::dynamics::joints::joint_graph::JointGraph": {
    "summary": "保存刚体之间的关节连接图。",
    "description": "以稳定图记录刚体节点和关节边，并提供实体到图索引的映射，供关节变化、物理岛划分及碰撞配对规则查询连接。"
  },
  "avian3d::dynamics::joints::JointDamping": {
    "summary": "衰减关节两端的相对速度。",
    "description": "分别配置线性与角阻尼，关节阻尼系统按时间步调整两端求解器刚体的相对运动，减弱连接振荡。"
  },
  "avian3d::dynamics::joints::prismatic::PrismaticJoint": {
    "summary": "将相对运动限制在滑动轴上。",
    "description": "以两端参考框架和 slider_axis 构建滑动关节，可设置行程距离限制及线性电机，其他相对平移和旋转由约束限制。"
  },
  "avian3d::dynamics::joints::revolute::RevoluteJoint": {
    "summary": "将相对旋转限制在枢轴周围。",
    "description": "以两端参考框架构建铰链关节，保持枢轴连接并允许绕指定轴转动，可配置角度限制和角电机。"
  },
  "avian3d::dynamics::joints::spherical::SphericalJoint": {
    "summary": "保持球铰锚点重合并允许转动。",
    "description": "约束两刚体相对平移，同时允许各轴旋转；可用扭转轴、扭转限制及摆动限制约束可转动范围。"
  },
  "avian3d::dynamics::rigid_body::AngularDamping": {
    "summary": "随物理步衰减刚体角速度。",
    "description": "为动态刚体提供角阻尼系数，积分预处理据此计算阻尼因子；默认零值不产生角阻尼。"
  },
  "avian3d::dynamics::rigid_body::AngularVelocity": {
    "summary": "保存刚体的世界角速度。",
    "description": "以旋转轴乘角速度表示三维角速度，单位为弧度每秒，供旋转积分、接触求解以及插值／外推使用。"
  },
  "avian3d::dynamics::rigid_body::body_size_metrics::BodySizeMetrics": {
    "summary": "缓存刚体及碰撞体的尺寸指标。",
    "description": "由附着碰撞体与质心计算保守厚度等指标，连续碰撞检测用它判断单步运动是否可能穿过几何体。"
  },
  "avian3d::dynamics::rigid_body::body_size_metrics::BodySizeMetricsData": {
    "summary": "连接刚体尺寸更新所需的数据。",
    "description": "此查询元组包含可变 BodySizeMetrics、RigidBodyColliders 和 ComputedCenterOfMass，供尺寸系统在质心或碰撞体变化后重新计算指标。"
  },
  "avian3d::dynamics::rigid_body::Dominance": {
    "summary": "指定动态刚体交互的支配等级。",
    "description": "与较低等级刚体交互时，较高等级的一方表现为无限质量而不受响应影响；静态和运动学刚体始终高于动态刚体。"
  },
  "avian3d::dynamics::rigid_body::forces::AccumulatedLocalAcceleration": {
    "summary": "累积物理步前的局部加速度。",
    "description": "保存刚体坐标系中的线性与角加速度；局部恒力和恒加速度先写入此处，再转换后参与速度积分，随后清理。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantAngularAcceleration": {
    "summary": "持续施加世界空间角加速度。",
    "description": "在每个时间步累加指定的角加速度，单位通常为弧度每秒平方；组件持续存在，不随单个子步自动消耗。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantForce": {
    "summary": "持续施加世界空间力。",
    "description": "保存持续作用于动态刚体的力，积分阶段结合总质量转为线性加速度并与其他作用累加，适合恒定推力等外力。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantLinearAcceleration": {
    "summary": "持续施加世界空间线性加速度。",
    "description": "直接指定每步累加的线性加速度，无需先按质量换算力；它与其他加速度共同形成该步的速度增量。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantLocalAngularAcceleration": {
    "summary": "持续施加局部空间角加速度。",
    "description": "保存相对于刚体自身坐标轴的恒定角加速度，先累加到局部加速度缓存，再依据当前姿态用于积分。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantLocalForce": {
    "summary": "持续施加随刚体转动的局部力。",
    "description": "保存刚体局部坐标系的恒力，结合总质量换算局部线性加速度；刚体姿态改变时该力在世界空间的方向随之改变。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantLocalLinearAcceleration": {
    "summary": "持续施加局部空间线性加速度。",
    "description": "保存相对于刚体坐标轴的恒定线性加速度，写入 AccumulatedLocalAcceleration 后再转换到积分所需方向。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantLocalTorque": {
    "summary": "持续施加局部空间扭矩。",
    "description": "保存跟随刚体朝向的恒定扭矩，结合总角惯量形成局部角加速度并参与后续速度积分。"
  },
  "avian3d::dynamics::rigid_body::forces::ConstantTorque": {
    "summary": "持续施加世界空间扭矩。",
    "description": "保存不随刚体朝向改变方向的恒定扭矩，求解阶段依据惯量将其转为角速度变化，并与其他旋转作用累加。"
  },
  "avian3d::dynamics::rigid_body::GravityScale": {
    "summary": "缩放单个刚体受到的重力。",
    "description": "以倍率调整全局 Gravity 对此刚体的作用；零值关闭重力，负值反转方向，变化也会触发休眠刚体唤醒检查。"
  },
  "avian3d::dynamics::rigid_body::LinearDamping": {
    "summary": "随物理步衰减刚体线速度。",
    "description": "为动态刚体提供线性阻尼系数，积分预处理据此计算速度衰减因子；默认零值不产生线性阻尼。"
  },
  "avian3d::dynamics::rigid_body::LinearVelocity": {
    "summary": "保存刚体的世界线速度。",
    "description": "描述刚体移动方向和速率，通常以米每秒表示，供位置积分、接触求解、速度限制以及插值／外推使用。"
  },
  "avian3d::dynamics::rigid_body::locked_axes::LockedAxes": {
    "summary": "锁定刚体的平移或旋转轴。",
    "description": "以六个位分别表示三条平移轴和三条旋转轴的锁定状态；求解器准备与积分据此抑制被锁方向的运动。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::AngularInertia": {
    "summary": "指定实体自身的局部角惯量。",
    "description": "以主惯量和局部惯性框架表达对角加速度的阻力；该输入不含子实体贡献，总惯量由 ComputedAngularInertia 另行汇总。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::CenterOfMass": {
    "summary": "指定实体自身的局部质心。",
    "description": "保存质量集中位置的局部偏移，质量属性重算时与附着碰撞体及后代的质量分布共同形成刚体总质心。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::collider::ColliderDensity": {
    "summary": "以密度参与碰撞体质量计算。",
    "description": "依据形状体积和密度计算 ColliderMassProperties，默认密度为 1；若实体明确提供 Mass，则总质量计算优先采用该值。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::collider::ColliderMassProperties": {
    "summary": "缓存由碰撞形状计算的质量属性。",
    "description": "由几何形状和 ColliderDensity 自动计算质量、惯量及质心；汇总刚体时，显式 Mass、AngularInertia 或 CenterOfMass 可分别覆盖相应贡献。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::computed::ComputedAngularInertia": {
    "summary": "保存汇总后的刚体局部角惯量。",
    "description": "计入刚体自身及附着碰撞体、后代的惯量和质心偏移，内部以逆张量保存，供力矩及约束求解使用；零总惯量解释为无限惯量。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::computed::ComputedCenterOfMass": {
    "summary": "保存汇总后的刚体局部质心。",
    "description": "按质量加权平均刚体自身与附着碰撞体、后代的质心，供位姿回写、连续扫掠和接触杠杆臂计算使用。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::computed::ComputedMass": {
    "summary": "保存汇总后的刚体总质量。",
    "description": "合计刚体自身、附着碰撞体及后代的质量，内部以逆质量保存供积分和求解使用；零总质量解释为无限质量。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::Mass": {
    "summary": "指定实体自身的质量输入。",
    "description": "表示对线性加速度的阻力，质量重算时可覆盖该实体的碰撞体推导质量；它自身不包含后代，总量另存 ComputedMass。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::NoAutoAngularInertia": {
    "summary": "阻止后代贡献总角惯量。",
    "description": "让 ComputedAngularInertia 仅采用刚体自身 AngularInertia，忽略附着碰撞体与后代惯量，以便手动控制总惯量。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::NoAutoCenterOfMass": {
    "summary": "阻止后代贡献总质心。",
    "description": "让 ComputedCenterOfMass 仅采用刚体自身 CenterOfMass，不再合并后代和附着碰撞体的质心贡献。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::NoAutoMass": {
    "summary": "阻止后代贡献总质量。",
    "description": "让 ComputedMass 仅采用刚体自身 Mass，忽略后代与附着碰撞体质量，以便单独控制刚体总质量。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::components::RecomputeMassProperties": {
    "summary": "请求重新计算刚体质量属性。",
    "description": "在质量输入、碰撞体或相关变换变化时自动加入，促使更新总质量、总惯量和总质心；本轮重算完成后移除。"
  },
  "avian3d::dynamics::rigid_body::mass_properties::system_param::MassPropertyHelper": {
    "summary": "汇集质量属性计算与更新操作。",
    "description": "作为 SystemParam 读取实体及后代的质量输入、碰撞体局部变换与自动汇总开关，并写回三种 Computed 质量属性。"
  },
  "avian3d::dynamics::rigid_body::MaxAngularSpeed": {
    "summary": "限制刚体的最大角速度。",
    "description": "按弧度每秒设置角速度大小上限，限速系统在超限时保留旋转方向并缩放速度，避免过快旋转导致不稳定。"
  },
  "avian3d::dynamics::rigid_body::MaxLinearSpeed": {
    "summary": "限制刚体的最大线速度。",
    "description": "通常按米每秒设置线速度大小上限，限速系统在超限时保留移动方向并缩放速度。"
  },
  "avian3d::dynamics::rigid_body::physics_material::DefaultFriction": {
    "summary": "提供未单独配置时的默认摩擦。",
    "description": "保存默认静摩擦、动摩擦系数及合并规则，窄相在碰撞体或刚体未提供 Friction 时采用此资源。"
  },
  "avian3d::dynamics::rigid_body::physics_material::DefaultRestitution": {
    "summary": "提供未单独配置时的默认恢复系数。",
    "description": "保存默认 Restitution 及合并规则，窄相在对象未自行配置时采用；默认系数为零，不产生额外弹跳恢复。"
  },
  "avian3d::dynamics::rigid_body::RigidBody": {
    "summary": "选择动态、静态或运动学刚体行为。",
    "description": "Dynamic 受力、速度及碰撞响应影响；Static 只能手动改位姿；Kinematic 可由速度移动并影响动态刚体，但不受外力和碰撞响应推动。"
  },
  "avian3d::dynamics::rigid_body::RigidBodyDisabled": {
    "summary": "暂停刚体求解和附着关节。",
    "description": "保留实体但关闭其速度、受力、接触响应与关节参与；附着碰撞体的碰撞检测及空间查询仍可继续。"
  },
  "avian3d::dynamics::rigid_body::sleeping::Sleeping": {
    "summary": "标记暂不参与模拟的休眠刚体。",
    "description": "低速保持足够时间且整个连接岛允许休眠后加入；接触、关节、位姿、速度或外力变化等条件会唤醒其所在物理岛。"
  },
  "avian3d::dynamics::rigid_body::sleeping::SleepingDisabled": {
    "summary": "禁止刚体进入休眠。",
    "description": "使该刚体保持活跃，并通过物理岛唤醒检查影响与其连接的岛，适合需要持续模拟的对象。"
  },
  "avian3d::dynamics::rigid_body::sleeping::SleepThreshold": {
    "summary": "设置允许休眠的线速度和角速度。",
    "description": "刚体两类速度均低于各自阈值才计入静止时间；线速度阈值随 PhysicsLengthUnit 缩放，负阈值可禁用休眠。"
  },
  "avian3d::dynamics::rigid_body::sleeping::SleepTimer": {
    "summary": "累计刚体持续低速的时间。",
    "description": "记录速度保持低于 SleepThreshold 的秒数，超过 TimeToSleep 后才允许该刚体及其连接岛进入休眠。"
  },
  "avian3d::dynamics::rigid_body::sleeping::TimeToSleep": {
    "summary": "设置刚体进入休眠前的等待时间。",
    "description": "指定低速状态必须持续的秒数，与每个刚体的 SleepTimer 及速度阈值共同控制休眠判定，默认半秒。"
  },
  "avian3d::dynamics::solver::constraint_graph::ConstraintGraph": {
    "summary": "为并行接触求解维护约束着色图。",
    "description": "把共享刚体不能并行的接触流形分配到不同颜色；同色约束可并行求解，无法分色的溢出约束串行处理。"
  },
  "avian3d::dynamics::solver::diagnostics::SolverDiagnostics": {
    "summary": "记录物理求解各阶段耗时。",
    "description": "分别累计约束准备、速度增量更新、积分、热启动及约束求解等耗时，供物理诊断汇总求解成本。"
  },
  "avian3d::dynamics::solver::islands::BodyIslandNode": {
    "summary": "记录刚体在物理岛中的连接位置。",
    "description": "保存所属岛及链表连接信息，添加和移除钩子维护岛结构；接触与关节连接变化时用于合并或拆分模拟岛。"
  },
  "avian3d::dynamics::solver::islands::PhysicsIslands": {
    "summary": "管理模拟岛及接触和关节连接。",
    "description": "保存物理岛集合、接触节点和关节节点，支持连接变化后的合并、候选拆分与整岛休眠／唤醒判断。"
  },
  "avian3d::dynamics::solver::islands::sleeping::AwakeIslandBitVec": {
    "summary": "记录哪些物理岛必须保持唤醒。",
    "description": "用位向量区分本轮保持活跃与允许休眠的岛，汇集速度变化、禁用休眠和显式唤醒等条件后供休眠更新使用。"
  },
  "avian3d::dynamics::solver::plugin::BodyQuery": {
    "summary": "汇集接触约束准备所需的刚体索引。",
    "description": "以只读 QueryData 提供刚体类型、线速度及可选 SolverBodyIndex，接触约束据此选择实际或静态占位求解状态。"
  },
  "avian3d::dynamics::solver::plugin::ContactSoftnessCoefficients": {
    "summary": "缓存动态与非动态接触的柔度系数。",
    "description": "分别保存动态对象之间及对静态／运动学对象接触所用的 SoftnessCoefficients，由时间步和 SolverConfig 自动计算，不应手动修改。"
  },
  "avian3d::dynamics::solver::plugin::SolverConfig": {
    "summary": "配置接触与关节约束求解参数。",
    "description": "提供接触阻尼、刚度／频率及恢复相关设置，控制接触稳定性、弹性和迭代行为，供柔度更新与约束求解阶段读取。"
  },
  "avian3d::dynamics::solver::solver_body::SolverBodies": {
    "summary": "连续存储活跃刚体的求解状态。",
    "description": "以平行数组保存醒着的动态与运动学刚体实体、求解体及惯性数据，供子步约束并行访问并在结束后回写 ECS 组件。"
  },
  "avian3d::dynamics::solver::solver_body::SolverBodyIndex": {
    "summary": "定位实体对应的求解器刚体。",
    "description": "组件索引指向 SolverBodies，只为醒着的动态和运动学刚体自动维护；静态或休眠动态刚体使用占位状态。"
  },
  "avian3d::interpolation::AngVelSource::Current": {
    "summary": "指定角速度插值的当前数据类型。",
    "description": "VelocitySource 关联类型在 AngVelSource 实现中绑定到 AngularVelocity，供旋转外推和 Hermite 平滑读取当前角速度；它不是另一个存储组件。"
  },
  "avian3d::interpolation::AngVelSource::Previous": {
    "summary": "指定角速度插值的历史数据类型。",
    "description": "VelocitySource 关联类型在 AngVelSource 实现中绑定到 PreviousAngularVelocity，供 Hermite 旋转平滑读取前一帧角速度。"
  },
  "avian3d::interpolation::LinVelSource::Current": {
    "summary": "指定线速度插值的当前数据类型。",
    "description": "VelocitySource 关联类型在 LinVelSource 实现中绑定到 LinearVelocity，供平移外推和 Hermite 平滑读取当前线速度。"
  },
  "avian3d::interpolation::LinVelSource::Previous": {
    "summary": "指定线速度插值的历史数据类型。",
    "description": "VelocitySource 关联类型在 LinVelSource 实现中绑定到 PreviousLinearVelocity，供 Hermite 平移平滑读取前一帧线速度。"
  },
  "avian3d::interpolation::PreviousAngularVelocity": {
    "summary": "保存上一帧的角速度快照。",
    "description": "由速度历史更新系统缓存实体前一帧角速度，为旋转平滑提供时间相邻的导数数据。"
  },
  "avian3d::interpolation::PreviousLinearVelocity": {
    "summary": "保存上一帧的线速度快照。",
    "description": "由速度历史更新系统缓存实体前一帧线速度，为平移平滑提供时间相邻的导数数据。"
  },
  "avian3d::physics_transform::ParentComponents": {
    "summary": "读取物理位姿回写所需的父级数据。",
    "description": "此查询元组读取父实体 GlobalTransform 及可选物理 Position、Rotation，供子刚体把世界物理位姿换算为本地 Transform。"
  },
  "avian3d::physics_transform::PhysicsTransformConfig": {
    "summary": "配置物理位姿与显示变换的同步。",
    "description": "控制物理步前的 Transform 传播、Transform 到 Position／Rotation 的写入以及物理位姿回写，决定两套变换如何互相更新。"
  },
  "avian3d::physics_transform::PosToTransformComponents": {
    "summary": "汇集物理位姿写回的目标组件。",
    "description": "此查询元组连接可变 Transform、只读 Position／Rotation 及可选 ChildOf，供同步系统保持嵌套刚体的独立世界运动。"
  },
  "avian3d::physics_transform::transform::Position": {
    "summary": "保存刚体或碰撞体的世界位置。",
    "description": "作为物理内部位置状态，在子步模拟中参与运动与碰撞计算，再由 PhysicsTransformPlugin 与显示 Transform 同步。"
  },
  "avian3d::physics_transform::transform::Rotation": {
    "summary": "保存刚体或碰撞体的世界旋转。",
    "description": "作为物理内部旋转状态参与接触、扫掠和积分，并与 Transform 同步；三维实现以四元数表达方向。"
  },
  "avian3d::spatial_query::diagnostics::SpatialQueryDiagnostics": {
    "summary": "记录射线与形状查询耗时。",
    "description": "分别累计更新 RayCaster 和 ShapeCaster 命中结果的耗时，供物理诊断展示组件式空间查询的成本。"
  },
  "avian3d::spatial_query::ray_caster::RayHits": {
    "summary": "保存 RayCaster 最近生成的命中。",
    "description": "命中数量受 max_hits 限制；默认不保证列表顺序，需要按距离查看时可使用排序迭代接口，max_hits 为一可确保最近命中。"
  },
  "avian3d::spatial_query::RayCasterPositionQueryComponents": {
    "summary": "汇集射线发射器世界位姿的输入。",
    "description": "查询可变 RayCaster 以及可选物理位姿、父实体和 GlobalTransform，供位置更新阶段把局部原点与方向换算到世界空间。"
  },
  "avian3d::spatial_query::shape_caster::ShapeHits": {
    "summary": "保存 ShapeCaster 最近生成的命中。",
    "description": "保存形状扫掠命中，数量受 max_hits 限制，可通过排序接口按距离遍历；禁用发射器时本轮查询清除旧命中。"
  },
  "avian3d::spatial_query::ShapeCasterPositionQueryComponents": {
    "summary": "汇集形状发射器世界位姿的输入。",
    "description": "查询可变 ShapeCaster 以及可选物理位姿、父实体和 GlobalTransform，供位置更新阶段计算世界空间扫掠原点与朝向。"
  },
  "unresolved:avian3d::spatial_query::system_param::SpatialQuery": {
    "summary": "提供即时射线和形状空间查询。",
    "description": "当前已核实调用场景是 RayCaster 与 ShapeCaster 更新命中结果，通过该参数执行射线检测和形状扫掠；声明尚未唯一定位，保留来源缺口。"
  },
  "bevy_ui::experimental::ghost_hierarchy::UiChildren": {
    "summary": "按 UI 层级访问子节点。",
    "description": "封装 UI 子节点、父级与子列表变化查询，供目标相机传播和布局树维护使用；启用 ghost_nodes 时遍历会跳过幽灵节点并维持子节点顺序。"
  },
  "bevy_ui::experimental::ghost_hierarchy::UiRootNodes": {
    "summary": "枚举 UI 布局的根节点。",
    "description": "当前锁定配置的别名查询筛选有 Node 且无 ChildOf 的实体，供目标相机和布局准备从各 UI 根开始传播。"
  },
  "bevy_ui::focus::DeprecatedInteraction": {
    "summary": "记录旧式 UI 按下和悬停状态。",
    "description": "以 Pressed、Hovered、None 表示 ui_focus_system 更新的交互状态；Pressed 只表达按住，不等同完整点击或按下后释放事件。"
  },
  "bevy_ui::focus::FocusPolicy": {
    "summary": "控制 UI 命中是否阻挡后方节点。",
    "description": "Block 阻断后续交互，Pass 允许交互继续穿过，焦点处理结合堆叠顺序决定哪些 UI 节点接收指针状态。"
  },
  "bevy_ui::focus::NodeQuery": {
    "summary": "汇集旧式 UI 焦点处理数据。",
    "description": "查询节点计算尺寸、全局变换、可写交互及相对光标位置，并读取焦点策略、可见性和目标相机，供 ui_focus_system 更新指针状态。"
  },
  "bevy_ui::focus::RelativeCursorPosition": {
    "summary": "记录光标在 UI 节点中的相对位置。",
    "description": "保存光标是否位于未裁剪区域以及按节点尺寸归一化的坐标；未知光标位置用 None 表示。"
  },
  "bevy_ui::gradients::BackgroundGradient": {
    "summary": "为 UI 节点背景配置渐变。",
    "description": "保存背景渐变列表，渲染提取阶段据节点形状和渐变参数生成背景绘制数据，表达从一种颜色到另一种颜色的填充。"
  },
  "bevy_ui::gradients::BorderGradient": {
    "summary": "为 UI 节点边框配置渐变。",
    "description": "保存作用于边框的渐变列表，渲染提取阶段将其与节点边框几何结合，形成边缘颜色渐变。"
  },
  "bevy_ui::interaction_states::InteractionDisabled": {
    "summary": "标记禁止交互的 UI 控件。",
    "description": "用于禁用态及无障碍状态同步，阻止控件响应操作，但不停止更新或绘制，也不必取消其键盘焦点。"
  },
  "bevy_ui::interaction_states::Selected": {
    "summary": "记录控件的 ARIA 选中状态。",
    "description": "表达 selected 而非 checked 状态，标签列表等控件同步派生状态时据此更新选中表现和无障碍信息。"
  },
  "bevy_ui::layout::ui_surface::UiSurface": {
    "summary": "维护 ECS UI 与布局树之间的映射。",
    "description": "保存实体到 Taffy 布局节点、UI 根到视口节点及布局树本身，布局系统通过它更新层级并计算节点尺寸和位置。"
  },
  "bevy_ui::measurement::ContentSize": {
    "summary": "提供内容驱动的固有尺寸测量。",
    "description": "保存可交给布局树的 NodeMeasure，文本及图像等测量系统据内容生成测量函数，使自动尺寸节点按内容参与布局。"
  },
  "bevy_ui::picking_backend::NodeQuery": {
    "summary": "汇集 UI 拾取的节点命中数据。",
    "description": "以 QueryData 读取节点几何、全局变换、Pickable、可见性、目标相机、文本布局和裁剪范围，供拾取后端计算 PointerHits。"
  },
  "bevy_ui::picking_backend::UiPickingCamera": {
    "summary": "标记允许参与 UI 拾取的相机。",
    "description": "仅在 UiPickingSettings.require_markers 为真时参与筛选；未开启该要求时无需为相机添加此标记。"
  },
  "bevy_ui::picking_backend::UiPickingSettings": {
    "summary": "配置 UI 拾取的显式标记要求。",
    "description": "require_markers 决定拾取是否只接受带 UiPickingCamera 的相机及带 Pickable 的节点，允许运行时收窄参与范围。"
  },
  "bevy_ui::stack::ComputedStackIndex": {
    "summary": "保存节点计算后的绘制堆叠位置。",
    "description": "由 UI 堆叠系统自动计算，较高索引的节点绘制在较低索引之上，并优先获得交互命中机会。"
  },
  "bevy_ui::stack::UiStack": {
    "summary": "保存按相机分区的 UI 绘制顺序。",
    "description": "以从后到前的实体列表及相机分区表达当前 UI 堆叠，渲染依次绘制，拾取和焦点处理从前层开始判断。"
  },
  "bevy_ui::ui_node::BackgroundColor": {
    "summary": "设置 UI 节点背景填充色。",
    "description": "保存节点背景的 Color，默认透明，渲染提取阶段将其转换为节点背景绘制数据。"
  },
  "bevy_ui::ui_node::BorderColor": {
    "summary": "分别设置 UI 四边的边框颜色。",
    "description": "保存上、右、下、左四侧颜色，与节点布局计算出的边框宽度结合，供渲染提取生成边框绘制数据。"
  },
  "bevy_ui::ui_node::BoxShadow": {
    "summary": "配置节点的多层阴影。",
    "description": "按列表从后到前绘制各 ShadowStyle，以偏移、模糊与扩张等样式为节点添加阴影效果。"
  },
  "bevy_ui::ui_node::CalculatedClip": {
    "summary": "缓存节点从祖先继承的裁剪结果。",
    "description": "记录祖先裁剪矩形集合或完全裁剪状态，供渲染和命中检测排除超出可见区域的节点内容。"
  },
  "bevy_ui::ui_node::ComputedNode": {
    "summary": "保存 UI 布局计算后的物理尺寸。",
    "description": "由布局阶段更新尺寸、内容范围、滚动偏移和边框等结果，数值以物理像素表示，可结合 inverse_scale_factor 换回逻辑像素。"
  },
  "bevy_ui::ui_node::ComputedUiRenderTargetInfo": {
    "summary": "缓存 UI 目标的尺寸与缩放。",
    "description": "保存目标相机视口的物理像素大小和缩放因子，随目标相机信息传播，供布局和渲染把逻辑值换算成目标像素。"
  },
  "bevy_ui::ui_node::ComputedUiTargetCamera": {
    "summary": "缓存 UI 节点实际采用的相机。",
    "description": "由 UI 准备阶段根据根节点目标及默认相机选择计算并传播，供布局、绘制和拾取确定对应视图。"
  },
  "bevy_ui::ui_node::DefaultUiCamera": {
    "summary": "选择没有显式目标时的默认 UI 相机。",
    "description": "封装相机、渲染目标、IsDefaultUiCamera 标记与主窗口查询，为 UI 根选择默认相机并提供其视口信息。"
  },
  "bevy_ui::ui_node::FixedNode": {
    "summary": "将子 UI 节点按视口根节点布局。",
    "description": "即使存在 UI 父级也相对于目标相机视口定位，不继承父节点的布局、裁剪或变换上下文。"
  },
  "bevy_ui::ui_node::GlobalZIndex": {
    "summary": "跨 UI 层级指定全局绘制层次。",
    "description": "允许节点摆脱层级树的隐式顺序，正值可覆盖默认层、负值可置于默认层后方，同值再按局部 ZIndex 等稳定规则排序。"
  },
  "bevy_ui::ui_node::IgnoreScroll": {
    "summary": "按轴忽略父节点的滚动偏移。",
    "description": "分别控制水平和垂直方向是否应用父级 ScrollPosition，使指定方向的内容保持视觉固定。"
  },
  "bevy_ui::ui_node::IsDefaultUiCamera": {
    "summary": "优先选择一台默认 UI 相机。",
    "description": "为相机添加此标记后，默认目标选择优先于主窗口相机，适合多相机或默认 UI 位于其他窗口的情形。"
  },
  "bevy_ui::ui_node::LayoutConfig": {
    "summary": "控制 UI 节点的像素舍入。",
    "description": "use_rounding 作用于节点及后代，将布局坐标舍入到物理像素，以减轻亚像素位置引起的模糊图像和半透明边缘。"
  },
  "bevy_ui::ui_node::Node": {
    "summary": "声明 UI 节点的布局规则。",
    "description": "配置 Flex／Grid／隐藏、位置、尺寸、边距、内距和溢出等布局输入，布局系统据此计算 ComputedNode 与 UiGlobalTransform。"
  },
  "bevy_ui::ui_node::OuterColor": {
    "summary": "填充圆角边框外侧产生的区域。",
    "description": "为 Node 设置圆角后边框外侧留下的区域提供颜色，可组合相邻节点形成内凹圆角等效果，默认透明。"
  },
  "bevy_ui::ui_node::Outline": {
    "summary": "绘制不占布局空间的外轮廓。",
    "description": "以宽度、偏移和颜色描述节点边缘外侧的轮廓；布局只换算其实际像素值，不为轮廓额外占用盒子空间。"
  },
  "bevy_ui::ui_node::OverrideClip": {
    "summary": "忽略祖先施加的 UI 裁剪。",
    "description": "带此标记的节点不受祖先 Overflow 产生的继承裁剪矩形限制，裁剪更新阶段据此处理其可见范围。"
  },
  "bevy_ui::ui_node::ScrollPosition": {
    "summary": "指定 UI 内容的逻辑像素滚动位置。",
    "description": "增大 x 或 y 会使内容分别向左或向上移动，布局系统据此偏移子节点，并可在范围变化后修正失效位置。"
  },
  "bevy_ui::ui_node::UiTargetCamera": {
    "summary": "为 UI 根指定渲染目标相机。",
    "description": "UI 按所选相机的视口和缩放布局并渲染到其 RenderTarget；非根节点的此组件会被根的传播结果覆盖。"
  },
  "bevy_ui::ui_node::ZIndex": {
    "summary": "设置同级 UI 节点的局部前后顺序。",
    "description": "数值较高的节点覆盖较低的兄弟节点，同值按层级顺序排列；跨独立层级排序应使用 GlobalZIndex。"
  },
  "bevy_ui::ui_transform::UiGlobalTransform": {
    "summary": "保存 UI 节点的绝对二维变换。",
    "description": "由布局系统结合 Node 与 UiTransform 自动更新为仿射变换，供绘制、裁剪和指针位置映射使用。"
  },
  "bevy_ui::ui_transform::UiTransform": {
    "summary": "配置 UI 节点的相对二维变换。",
    "description": "保存响应式平移、二维缩放及顺时针旋转，布局阶段解析后合入 UiGlobalTransform；负缩放可形成轴向镜像。"
  },
  "bevy_ui::UiScale": {
    "summary": "统一缩放 UI 的固定尺寸值。",
    "description": "作为固定 UI 值的倍率影响 Val::Px 等尺寸，目标相机传播与布局将其纳入比例计算，不等于所有响应式值的统一缩放。"
  },
  "bevy_ui::widget::button::Button": {
    "summary": "标记兼容旧 API 的 UI 按钮。",
    "description": "锁定版本中 Button 是 DeprecatedButton 的弃用别名，要求 Node、阻挡焦点和旧交互状态；无障碍更新为它建立按钮角色与文本标签。"
  },
  "bevy_ui::widget::image::ImageNode": {
    "summary": "描述 UI 图像及其绘制参数。",
    "description": "保存图像句柄、颜色调制和可选纹理图集等配置，内容尺寸系统解析纹理尺寸，渲染阶段生成图像节点绘制数据。"
  },
  "bevy_ui::widget::image::ImageNodeSize": {
    "summary": "缓存 UI 图像纹理的像素尺寸。",
    "description": "由 update_image_content_size_system 根据图像与图集资源自动更新，供图像节点的固有尺寸测量和布局使用。"
  },
  "bevy_ui::widget::inline_image::InlineImage": {
    "summary": "在文本流中插入图像。",
    "description": "保存图像句柄、颜色和可选固定尺寸，内联图像更新阶段把它转换为随文本排版的图像盒。"
  },
  "bevy_ui::widget::label::Label": {
    "summary": "标记需要生成无障碍标签的文本。",
    "description": "标签无障碍系统收集其文本元素，把拼接内容写为 AccessibilityNode 的标签值，并在节点不存在时创建。"
  },
  "bevy_ui::widget::text_input_layout::EditableTextContentSizeState": {
    "summary": "缓存可编辑文本的尺寸测量输入。",
    "description": "保存可见宽度和可见行数等输入，内容尺寸更新据此识别测量条件变化并重新计算可编辑文本的固有尺寸。"
  },
  "bevy_ui::widget::text::Text": {
    "summary": "保存 UI 文本根的第一段内容。",
    "description": "作为 UI 文本树根自动带入字体、颜色、行高、布局和内容测量组件；自身字符串与后代 TextSpan 一起形成 ComputedTextBlock。"
  },
  "bevy_ui::widget::text::TextNodeFlags": {
    "summary": "追踪 UI 文本测量与重排状态。",
    "description": "记录是否需要重建测量函数或重新计算文本，并缓存不换行文本的固定测量，供测量和排版系统协调更新。"
  },
  "bevy_ui::widget::text::TextShadow": {
    "summary": "为 UI 文本绘制偏移阴影。",
    "description": "以逻辑像素偏移和颜色描述文字后方阴影，提取阶段生成对应绘制数据；Text2d 使用独立阴影组件。"
  },
  "bevy_ui::widget::text::TextUiReader": {
    "summary": "按 UI 文本根读取文本层级。",
    "description": "此类型是 TextReader<Text> 的别名，封装对根 Text 及后代文本段的读取，供文本测量等系统遍历完整内容。"
  },
  "bevy_ui::widget::viewport::ViewportNode": {
    "summary": "把相机渲染目标嵌入 UI 节点。",
    "description": "保存关联相机并按节点大小维护其输出目标，交互时还可把指针转换进该视口；移除节点组件不会自动销毁相机。"
  }
};
