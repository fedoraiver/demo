// 按所属函数、参数槽及真实变量使用核对系统私有状态职责。
export const LOCAL_SCHEDULE_TYPE_PURPOSES = {
  "bevy_ecs::message::update::message_update_system|last_change_tick": {
    "summary": "保存上次消息缓冲更新的变更刻度。",
    "description": "message_update_system 把该刻度传给消息注册目录执行更新，并在本次处理后保存 World 当前刻度，用于下次消息缓冲更新检查。"
  },
  "bevy_time::time_system|arg6": {
    "summary": "记录是否曾收到渲染世界发送的时间。",
    "description": "time_system 的 has_received_time 在成功接收渲染时间后置真；后续接收失败时据此输出时间同步警告，避免首次尚未收到时间时误报。"
  },
  "bevy_picking::input::mouse_pick_events|cursor_last": {
    "summary": "保存上一次鼠标位置以生成指针输入。",
    "description": "mouse_pick_events 用 cursor_last 计算移动事件的位置差，并为鼠标按键和滚轮事件补充最近的光标位置。"
  },
  "bevy_picking::input::touch_pick_events|touch_cache": {
    "summary": "按触点标识缓存上一次触摸输入。",
    "description": "touch_pick_events 比较同一触点的新旧输入，跳过重复移动并计算移动差值；触摸结束或取消时移除该触点缓存。"
  },
  "avian3d::schedule::run_physics_schedule|is_first_run": {
    "summary": "记录物理调度是否处于首次调用。",
    "description": "IsFirstRun 初值为真，run_physics_schedule 完成调度作用域处理后将其置为假，保留该系统已经被调用的记录。"
  },
  "bevy_transform::systems::mark_dirty_trees|arg5": {
    "summary": "用共享原子位集去重变换树祖先遍历。",
    "description": "mark_dirty_trees 的 shared_bitset 按实体索引记录已访问祖先，多个遍历任务通过原子操作协作提前停止重复的向上遍历。"
  },
  "bevy_transform::systems::mark_dirty_trees|arg6": {
    "summary": "为超出共享容量的变换遍历保存线程位集。",
    "description": "mark_dirty_trees 的 local_bitset 在实体索引超过共享原子位集容量时，记录各任务已访问的祖先，避免同一任务重复遍历并复用其临时分配。"
  },
  "bevy_transform::systems::mark_dirty_trees|arg7": {
    "summary": "传递需要标记变换树变化的实体批次。",
    "description": "mark_dirty_trees 的 consumer_channels 接收并行祖先遍历发现的实体，由单一消费者逐批调用 TransformTreeChanged.set_changed。"
  },
  "bevy_transform::systems::mark_dirty_trees|arg8": {
    "summary": "向并行变换树遍历任务分发变化实体。",
    "description": "mark_dirty_trees 的 traversal_channels 把变化或失去父节点的实体批次发送给祖先遍历任务，作为向上传播脏标记的起点。"
  },
  "bevy_transform::systems::parallel::propagate_parent_transforms|queue": {
    "summary": "分派父子全局变换传播的并行任务。",
    "description": "propagate_parent_transforms 从根节点处理生成线程局部任务批次，再发送到共享工作队列，由多个传播 worker 继续更新子树。"
  },
  "bevy_winit::cursor::update_cursors|queue": {
    "summary": "保留等待自定义光标图像加载的窗口。",
    "description": "update_cursors 将光标图像尚未准备好的窗口放入 queue；下一次运行时即使 CursorIcon 未变化，也会重试这些窗口的光标更新。"
  },
  "bevy_winit::system::despawn_windows|windows_to_drop": {
    "summary": "把原生窗口包装器保留到下次主线程调用释放。",
    "description": "despawn_windows 将关闭或退出时移出的 WindowWrapper 暂存到 windows_to_drop，下次系统开始时清空，确保包装器在主线程的安全时机释放。"
  },
  "bevy_picking::input::deactivate_touch_pointers|despawn_list": {
    "summary": "去重收集需要销毁的触摸指针实体。",
    "description": "deactivate_touch_pointers 根据结束或取消的触摸查找对应指针，以实体与指针标识的集合去重，再排入实体销毁命令。"
  },
  "bevy_app::main_schedule::Main::run_main|run_at_least_once": {
    "summary": "确保主调度的启动阶段只执行一次。",
    "description": "Main::run_main 首次调用时依次运行 startup_labels 中的调度，然后置真 run_at_least_once；以后直接执行常规主调度顺序。"
  },
  "avian3d::collision::narrow_phase::trigger_collision_events|started": {
    "summary": "暂存待触发的碰撞开始实体事件。",
    "description": "trigger_collision_events 从消息中筛选启用了碰撞事件的双方，按各接收方方向生成 CollisionStart，随后排空缓冲并直接触发事件。"
  },
  "avian3d::collision::narrow_phase::trigger_collision_events|ended": {
    "summary": "暂存待触发的碰撞结束实体事件。",
    "description": "trigger_collision_events 从碰撞结束消息中生成各启用接收方对应的 CollisionEnd，随后排空缓冲并直接触发事件。"
  },
  "avian3d::dynamics::solver::islands::sleeping::sleep_islands|sleep_buffer": {
    "summary": "收集本轮应进入休眠的物理岛。",
    "description": "sleep_islands 找出不在唤醒位集、尚未休眠且没有待处理约束移除的岛，将其标识收集到 sleep_buffer，再通过延迟命令应用 SleepIslands。"
  },
  "avian3d::dynamics::solver::islands::sleeping::sleep_islands|wake_buffer": {
    "summary": "收集本轮应从休眠中唤醒的物理岛。",
    "description": "sleep_islands 将唤醒位集中仍处于休眠的岛加入 wake_buffer，再通过延迟命令应用 WakeIslands；每轮开始清空旧列表。"
  },
  "bevy_camera::visibility::check_visibility_cpu_culling|thread_queues": {
    "summary": "按线程和可见性类别收集相机可见实体。",
    "description": "check_visibility_cpu_culling 并行筛选实体时把结果写入线程私有的类别队列，最后汇总到每台相机各类别的 VisibleEntities 列表。"
  },
  "bevy_camera::visibility::range::check_visibility_ranges|par_local": {
    "summary": "暂存并行计算得到的实体距离可见位掩码。",
    "description": "check_visibility_ranges 在线程队列中收集非零可见位掩码与实体的配对，遍历结束后统一写入 VisibleEntityRanges。"
  },
  "bevy_light::check_dir_light_mesh_visibility|defer_visible_entities_queue": {
    "summary": "暂存方向光阴影检测后需要标为可见的实体。",
    "description": "check_dir_light_mesh_visibility 将通过阴影视锥筛选的实体汇入并行队列，再通过延迟命令更新 ViewVisibility，使检测可与点光源检测并行。"
  },
  "bevy_light::check_dir_light_mesh_visibility|view_visible_entities_queue": {
    "summary": "按线程和阴影级联收集方向光可见网格。",
    "description": "check_dir_light_mesh_visibility 为每个视图的各级联维护线程私有实体列表，筛选后汇总到 CascadesVisibleEntities，并按当前级联数量调整列表。"
  },
  "bevy_light::check_point_light_mesh_visibility|cubemap_visible_entities_queue": {
    "summary": "按线程收集点光源六个阴影面的可见网格。",
    "description": "check_point_light_mesh_visibility 为立方体阴影的六个视锥分别累积实体，完成并行筛选后合并到对应面的可见列表。"
  },
  "bevy_light::check_point_light_mesh_visibility|spot_visible_entities_queue": {
    "summary": "并行收集聚光灯阴影视锥中的可见网格。",
    "description": "check_point_light_mesh_visibility 为聚光灯维护线程私有的可见实体队列，完成范围、层和视锥检查后汇总到聚光灯的 VisibleMeshEntities。"
  },
  "bevy_light::check_point_light_mesh_visibility|checked_lights": {
    "summary": "避免同一光源被多个相机可见列表重复处理。",
    "description": "check_point_light_mesh_visibility 每轮清空 checked_lights，遍历各相机可见的聚簇光源时先插入集合，已处理的光源直接跳过。"
  },
  "bevy_light::cluster::assign::assign_objects_to_clusters|clusterable_objects": {
    "summary": "汇总等待 CPU 聚簇分配的可见光源和体积对象。",
    "description": "assign_objects_to_clusters 在 CPU 路径收集点光、聚光、区域光、探针和贴花的空间分配数据，再按视图层与聚簇范围分配；列表每轮清空并保留容量。"
  },
  "bevy_light::cluster::assign::assign_objects_to_clusters|cluster_aabb_spheres": {
    "summary": "按需缓存聚簇包围盒的包围球。",
    "description": "assign_objects_to_clusters 为当前视图各簇准备可选 Sphere 槽位，在需要精细聚光灯相交检查时计算并复用该簇的包围球。"
  },
  "bevy_light::cluster::assign::assign_objects_to_clusters|max_clusterable_objects_warning_emitted": {
    "summary": "避免聚簇对象数量超限警告重复输出。",
    "description": "assign_objects_to_clusters 在缺少存储缓冲支持且对象超出统一缓冲限制时仅首次警告，将标志置真；对象列表仍按设备上限截断。"
  },
  "bevy_animation::graph::thread_animation_graphs|animation_target_graphs_rebuilt_this_frame": {
    "summary": "记录本帧已重建目标子图的动画图资产。",
    "description": "thread_animation_graphs 在图或动画片段变化时把已重建的图标识加入集合，避免同一帧因多个资产事件重复重建目标子图。"
  },
  "bevy_animation::animate_targets|animation_evaluation_state": {
    "summary": "为并行动画求值复用各线程的求值工作状态。",
    "description": "animate_targets 为工作线程取得独立的 AnimationEvaluationState，用于动画图节点求值、曲线与混合中间结果处理，减少重复分配并避免线程间共享可变求值状态。"
  },
  "bevy_app::propagate::propagate_inherited|to_process": {
    "summary": "保存等待传播或移除继承值的后代任务。",
    "description": "propagate_inherited 把变化或移除的继承组件转换为实体与可选继承值的任务栈，沿关系后代逐项处理并继续加入需要递归的子节点。"
  },
  "bevy_ui::widget::text_input_layout::update_editable_text_layout|cursor_timer": {
    "summary": "累计可编辑文本光标的闪烁时间。",
    "description": "update_editable_text_layout 累加真实时间，焦点或布局变化及闪烁周期到达时重置计时，再据半周期决定光标几何是否显示。"
  },
  "bevy_ui::widget::text_input_layout::update_editable_text_layout|previous_focus": {
    "summary": "记录上一轮可编辑文本的焦点实体。",
    "description": "update_editable_text_layout 比较 previous_focus 与当前 InputFocus，识别焦点切换以更新光标显示和重置闪烁计时，处理结束后保存当前焦点。"
  },
  "bevy_ui::stack::ui_stack_system|cache": {
    "summary": "为 UI 层级堆叠遍历复用实体与局部层次缓存。",
    "description": "ui_stack_system 将 cache 传入递归堆叠构建，暂存后代实体和局部 Z 顺序，生成 UiStack 绘制顺序并复用临时容量。"
  },
  "bevy_ui::stack::ui_stack_system|stack_roots": {
    "summary": "收集本轮参与排序的 UI 堆叠根。",
    "description": "ui_stack_system 汇总普通 UI 根和带 GlobalZIndex 的独立堆叠根，保存全局及局部 Z 值和原顺序，排序后逐根展开到 UiStack。"
  },
  "bevy_ui::stack::ui_stack_system|stack_root_order": {
    "summary": "保留上一帧 UI 堆叠根的相对顺序。",
    "description": "ui_stack_system 从原 UiStack 分区记录各根顺序，构造本轮 StackRoot 时带入旧位置，使 Z 值相同时的排序跨帧保持稳定。"
  },
  "bevy_ui::stack::ui_stack_system|visited_stack_roots": {
    "summary": "避免 UI 根同时从两条查询路径重复加入。",
    "description": "ui_stack_system 记录已从 UiRootNodes 收集的根，遍历带 GlobalZIndex 的节点时跳过这些实体，保证每个堆叠根只收集一次。"
  },
  "bevy_egui::output::process_output_system|last_cursor_icon": {
    "summary": "按 Egui 上下文记住上次输出的光标样式。",
    "description": "process_output_system 仅在 Egui 平台输出的光标图标发生变化时向对应窗口插入 CursorIcon，避免每帧重复提交相同光标。"
  },
  "bevy_sprite::text2d::update_text2d_layout|last_logical_viewport_size": {
    "summary": "保存二维文字布局上次使用的逻辑视口尺寸。",
    "description": "update_text2d_layout 取得主窗口逻辑尺寸并与上次值比较，更新缓存后将比较结果参与文本布局是否需要重新计算的判断。"
  },
  "bevy_sprite::text2d::update_text2d_layout|target_scale_factors": {
    "summary": "收集二维文字各目标相机的缩放因子和渲染层。",
    "description": "update_text2d_layout 从具有可见精灵的相机收集缩放因子与层，对文字匹配的相机选取最大缩放因子以生成单一文字布局。"
  },
  "bevy_sprite::text2d::update_text2d_layout|reprocess_queue": {
    "summary": "保留因字体或字形尚未就绪而待重排的二维文字。",
    "description": "update_text2d_layout 将布局或字形生成暂时失败的文字实体放入 reprocess_queue，后续帧取出重试，避免文本未变化时遗漏恢复。"
  },
  "bevy_sprite_render::mesh2d::material::check_entities_needing_specialization|par_local": {
    "summary": "并行收集二维材质管线需要更新的实体。",
    "description": "check_entities_needing_specialization 将变化的 Mesh2d 或二维材质实体写入线程队列，再排空到该材质类型的 changed 列表。"
  },
  "bevy_sprite_render::sprite_mesh::add_mesh|quad": {
    "summary": "复用所有默认精灵共用的单位四边形网格。",
    "description": "add_mesh 首次调用时创建单位矩形网格并缓存句柄，之后为新增精灵插入引用同一网格的 Mesh2d。"
  },
  "bevy_sprite_render::sprite_mesh::add_material|cached_materials": {
    "summary": "按精灵与锚点配置复用默认网格材质。",
    "description": "add_material 先逐出失效缓存，再为没有自定义精灵材质的实体查找或创建 SpriteMeshMaterial，复用相同精灵和锚点配置的材质句柄。"
  },
  "bevy_text::font::load_font_assets_into_font_collection|loaded_fonts": {
    "summary": "记录已载入文字排版字体集合的字体资产。",
    "description": "load_font_assets_into_font_collection 根据 loaded_fonts 查找新增字体；检测到字体被移除时重建排版字体集合并重新登记剩余字体。"
  },
  "bevy_pbr::material::check_entities_needing_specialization|par_local": {
    "summary": "并行收集三维材质管线需要更新的实体。",
    "description": "check_entities_needing_specialization 将变化的 Mesh3d 或三维材质实体写入线程私有队列，再汇总到该材质类型的 changed 列表。"
  },
  "bevy_egui::setup_primary_egui_context_system|egui_context_exists": {
    "summary": "记住主 Egui 上下文是否已找到或创建。",
    "description": "setup_primary_egui_context_system 首次发现相机已有上下文或插入主上下文后置真，防止后续新增相机重复建立默认主上下文。"
  },
  "bevy_ui::focus::ui_focus_system|hovered_nodes": {
    "summary": "按 UI 堆叠顺序收集光标覆盖的节点。",
    "description": "ui_focus_system 将命中的节点放入 hovered_nodes，再从前到后设置 Pressed 或 Hovered，遇到阻挡节点后清除更低层节点的悬停状态。"
  },
  "bevy_ui::focus::ui_focus_system|state": {
    "summary": "保留同帧按下又释放的 UI 交互重置任务。",
    "description": "ui_focus_system 在按下与释放发生于同一帧时记录 entities_to_reset，下次运行先将这些节点从临时按下状态恢复。"
  },
  "bevy_picking::hover::generate_hovermap|over_map": {
    "summary": "暂存各指针的后端命中结果以生成悬停映射。",
    "description": "generate_hovermap 使用 over_map 汇总 PointerHits 和指针输入，再依据 Pickable 规则生成 HoverMap，并结合指针捕获调整最终悬停目标。"
  },
  "bevy_enhanced_input::context::input_reader::update_pending|reader.gamepad_device": {
    "summary": "保存输入读取器当前选择的游戏手柄。",
    "description": "InputReader 的 gamepad_device 记录本轮输入查询采用的手柄设备范围，update_pending 的绑定忽略检查和输入重置据此读取正确设备。"
  },
  "bevy_enhanced_input::context::input_reader::update_pending|reader.skip_ignore_check": {
    "summary": "控制输入读取器是否跳过忽略绑定检查。",
    "description": "InputReader 的 skip_ignore_check 决定读取绑定时是否检查等待释放的忽略项，待处理输入更新期间可绕过该过滤以判断输入真实激活状态。"
  },
  "bevy_enhanced_input::context::update|arg0": {
    "summary": "暂存本次动作求值后需要消费的输入绑定。",
    "description": "context::update 在绑定累积或覆盖动作结果时维护 consume_buffer，仅当最终动作状态有效时将这些绑定标记为已消费，随后清空列表。"
  },
  "(bevy_ecs::system::system_param::Local<'_, alloc::vec::Vec<bevy_enhanced_input::binding::Binding>>, bevy_enhanced_input::context::time::ContextTime<'_>, bevy_enhanced_input::context::input_reader::InputReader<'_, '_>, bevy_ecs::change_detection::params::Res<'_, bevy_enhanced_input::context::instance::ContextInstances<bevy_app::main_schedule::PreUpdate>>, bevy_ecs::system::query::Query<'_, '_, bevy_ecs::world::entity_access::filtered::FilteredEntityMut<'_, '_>>, bevy_ecs::system::query::Query<'_, '_, (bevy_ecs::entity::Entity, &bevy_ecs::name::Name, &bevy_enhanced_input::action::ActionSettings, core::option::Option<&bevy_enhanced_input::binding::relationship::Bindings>, core::option::Option<&bevy_enhanced_input::modifier::fns::ModifierFns>, core::option::Option<&bevy_enhanced_input::condition::fns::ConditionFns>, &mut bevy_enhanced_input::action::mock::ActionMock), bevy_ecs::query::filter::Without<bevy_enhanced_input::context::ExternallyMocked>>, bevy_ecs::system::query::Query<'_, '_, (&mut bevy_enhanced_input::action::value::ActionValue, &mut bevy_enhanced_input::action::TriggerState, &mut bevy_enhanced_input::action::events::ActionEvents, &mut bevy_enhanced_input::action::ActionTime)>, bevy_ecs::system::query::Query<'_, '_, (bevy_ecs::entity::Entity, &bevy_enhanced_input::binding::Binding, &mut bevy_enhanced_input::binding::FirstActivation, core::option::Option<&bevy_enhanced_input::modifier::fns::ModifierFns>, core::option::Option<&bevy_enhanced_input::condition::fns::ConditionFns>), bevy_ecs::query::filter::Without<bevy_enhanced_input::action::ActionSettings>>, bevy_ecs::system::query::Query<'_, '_, bevy_ecs::world::entity_access::filtered::FilteredEntityMut<'_, '_>>)|arg2.gamepad_device": {
    "summary": "保存动作更新读取器当前选择的游戏手柄。",
    "description": "动作更新系统内 InputReader.gamepad_device 记录输入查询采用的手柄设备范围，使不同上下文按指定设备读取和消费绑定。"
  },
  "(bevy_ecs::system::system_param::Local<'_, alloc::vec::Vec<bevy_enhanced_input::binding::Binding>>, bevy_enhanced_input::context::time::ContextTime<'_>, bevy_enhanced_input::context::input_reader::InputReader<'_, '_>, bevy_ecs::change_detection::params::Res<'_, bevy_enhanced_input::context::instance::ContextInstances<bevy_app::main_schedule::PreUpdate>>, bevy_ecs::system::query::Query<'_, '_, bevy_ecs::world::entity_access::filtered::FilteredEntityMut<'_, '_>>, bevy_ecs::system::query::Query<'_, '_, (bevy_ecs::entity::Entity, &bevy_ecs::name::Name, &bevy_enhanced_input::action::ActionSettings, core::option::Option<&bevy_enhanced_input::binding::relationship::Bindings>, core::option::Option<&bevy_enhanced_input::modifier::fns::ModifierFns>, core::option::Option<&bevy_enhanced_input::condition::fns::ConditionFns>, &mut bevy_enhanced_input::action::mock::ActionMock), bevy_ecs::query::filter::Without<bevy_enhanced_input::context::ExternallyMocked>>, bevy_ecs::system::query::Query<'_, '_, (&mut bevy_enhanced_input::action::value::ActionValue, &mut bevy_enhanced_input::action::TriggerState, &mut bevy_enhanced_input::action::events::ActionEvents, &mut bevy_enhanced_input::action::ActionTime)>, bevy_ecs::system::query::Query<'_, '_, (bevy_ecs::entity::Entity, &bevy_enhanced_input::binding::Binding, &mut bevy_enhanced_input::binding::FirstActivation, core::option::Option<&bevy_enhanced_input::modifier::fns::ModifierFns>, core::option::Option<&bevy_enhanced_input::condition::fns::ConditionFns>), bevy_ecs::query::filter::Without<bevy_enhanced_input::action::ActionSettings>>, bevy_ecs::system::query::Query<'_, '_, bevy_ecs::world::entity_access::filtered::FilteredEntityMut<'_, '_>>)|arg2.skip_ignore_check": {
    "summary": "控制动作更新读取器的忽略绑定检查。",
    "description": "动作更新系统内 InputReader.skip_ignore_check 控制绑定读取是否跳过等待释放的忽略项，供输入读取器内部的激活状态检查使用。"
  },
  "bevy_scene::spawn::spawn_queued|queued": {
    "summary": "暂存从世界队列交换出的待生成场景。",
    "description": "spawn_queued 将 QueuedScenes 资源与该工作队列交换，逐批生成场景并继续处理生成过程中加入的新请求，直到队列为空。"
  },
  "bevy_scene::spawn::spawn_queued|bundle_scratch": {
    "summary": "复用场景补丁应用和实体生成的 Bundle 临时区。",
    "description": "spawn_queued 把 bundle_scratch 传给已解析场景补丁的应用及待生成场景处理，为组件束写入提供可复用的工作内存。"
  },
  "bevy_scene::spawn::spawn_queued|reader": {
    "summary": "保留场景补丁资产消息的独立读取游标。",
    "description": "spawn_queued 用 reader 读取尚未处理的 ScenePatch 资产事件，在补丁连同依赖加载完成后恢复等待的场景实体。"
  },
  "bevy_scene::spawn::spawn_queued|list_reader": {
    "summary": "保留场景列表补丁资产消息的独立读取游标。",
    "description": "spawn_queued 用 list_reader 读取 SceneListPatch 的依赖加载完成事件，继续处理等待该列表补丁的场景生成请求。"
  },
  "bevy_core_pipeline::tonemapping::node::tonemapping|cache": {
    "summary": "缓存色调映射绑定组及上次选择的映射方式。",
    "description": "tonemapping 记录视图参数缓冲、源颜色纹理、LUT 与色调映射模式；输入身份或映射方式改变时重建绑定，其他帧复用原组。"
  },
  "bevy_anti_alias::fxaa::node::fxaa|cached_bind_group": {
    "summary": "按源颜色纹理复用 FXAA 绑定组。",
    "description": "fxaa 在 cached_bind_group 中保存源 TextureViewId 与绑定组；当前后处理源纹理相同时复用，变化时重新绑定。"
  },
  "bevy_anti_alias::contrast_adaptive_sharpening::node::cas|cached_bind_group": {
    "summary": "按参数缓冲和颜色纹理复用 CAS 绑定组。",
    "description": "cas 缓存 Uniform 缓冲标识、源纹理标识及绑定组，只有两项输入身份均相同时复用该组。"
  },
  "bevy_core_pipeline::upscaling::node::upscaling|cache": {
    "summary": "按主颜色纹理复用最终缩放输出绑定组。",
    "description": "upscaling 在 cache 中保存主纹理视图身份与 Blit 绑定组，源主纹理变化时重新创建绑定，用于相机最终颜色输出。"
  },
  "bevy_render::render_asset::extract_render_asset|needs_extracting": {
    "summary": "去重收集本轮需要提取的渲染资产标识。",
    "description": "extract_render_asset 汇总新增、修改和显式重提取请求，Unused 事件会从待提取集合移除资产；随后排空集合并提取具备渲染世界用途的源资产。"
  },
  "bevy_ui_render::extract_uinode_changes|extra_nodes_to_invalidate": {
    "summary": "收集文字子节点变化后还需失效的祖先文本节点。",
    "description": "extract_uinode_changes 处理 TextSpan 或内联内容时向上找到所属 Text，将其加入 extra_nodes_to_invalidate，最后补做祖先节点的渲染数据失效处理。"
  },
  "bevy_ui_render::extract_ui_camera_view|live_entities": {
    "summary": "记录仍然有效的 UI 相机视图身份。",
    "description": "extract_ui_camera_view 在创建或更新 UI 子视图后登记 RetainedViewEntity，相机失效或移除时删除，最后据集合保留仍存活的透明 UI 阶段。"
  },
  "bevy_ui_render::extract_ui_camera_view|cached_ui_view_data": {
    "summary": "按主世界相机缓存已提取的 UI 子视图。",
    "description": "extract_ui_camera_view 记录主相机对应的 UI 渲染实体和保留视图身份，下次提取复用实体；相机停用或移除时据缓存销毁旧 UI 子视图。"
  },
  "bevy_ui_render::extract_ui_camera_view|cameras_updated_this_frame": {
    "summary": "记录本轮成功更新的主世界 UI 相机。",
    "description": "extract_ui_camera_view 在相机满足输出和活动条件时登记实体，随后读取 Camera 移除消息时跳过本轮已重新更新的相机，避免误删其 UI 视图。"
  },
  "bevy_ui_render::box_shadow::extract_shadows|nodes_processed_this_frame": {
    "summary": "避免 UI 阴影节点在变化与移除路径重复处理。",
    "description": "extract_shadows 登记本轮已重新提取的主世界节点，处理组件移除集合时跳过这些节点，保护刚生成的阴影项。"
  },
  "bevy_pbr::render::mesh::extract_meshes_for_gpu_building|reextract_entities": {
    "summary": "收集变化查询未覆盖但仍需重提取的 GPU 网格。",
    "description": "extract_meshes_for_gpu_building 根据候选位集找出尚未在变化查询处理的实体，加入 reextract_entities，再从完整网格查询补提取这些实例。"
  },
  "bevy_pbr::render::mesh::extract_meshes_for_gpu_building|potential_reextraction_set": {
    "summary": "为 GPU 网格重提取候选建立有序实体索引。",
    "description": "extract_meshes_for_gpu_building 汇总延后重试与组件移除涉及的网格实体，保留稳定的候选索引，供原子位集标记哪些已在并行变化查询处理。"
  },
  "bevy_pbr::render::mesh::extract_meshes_for_gpu_building|potential_reextraction_bitfield": {
    "summary": "用原子位集标记 GPU 网格候选是否已被提取。",
    "description": "extract_meshes_for_gpu_building 按候选实体索引分配位集，并行变化查询处理实体后置位；遍历仍为零的位以补做缺失候选的重提取。"
  },
  "bevy_render::erased_render_asset::extract_erased_render_asset|needs_extracting": {
    "summary": "去重汇集类型擦除资产本轮的提取请求。",
    "description": "extract_erased_render_asset 收集新增、修改和显式重提取资产标识，Unused 事件撤回相应请求，再排空集合提取可用于渲染世界的源资产。"
  },
  "bevy_render::view::window::screenshot::extract_screenshots|system_state": {
    "summary": "缓存主世界截图提取使用的系统参数状态。",
    "description": "extract_screenshots 首次为 MainWorld 创建 SystemState，复用其中 Commands、主窗口查询和未捕获截图查询，并在结束时把命令应用回主世界。"
  },
  "bevy_render::view::window::screenshot::extract_screenshots|seen_targets": {
    "summary": "去重本帧指向相同渲染目标的截图请求。",
    "description": "extract_screenshots 记录已规范化的渲染目标，同一帧再次请求相同目标时警告并销毁重复请求实体；每轮开始清空集合。"
  },
  "bevy_extract::extract_component::extract_components|previous_len": {
    "summary": "根据上次组件提取数量预留批量插入容量。",
    "description": "extract_components 用 previous_len 为临时输出数组预分配空间，收集转换成功的目标组件后记录新长度，再批量插入到子世界。"
  },
  "bevy_core_pipeline::core_2d::extract_core_2d_camera_phases|live_entities": {
    "summary": "记录本帧仍活动的二维相机渲染阶段。",
    "description": "extract_core_2d_camera_phases 收集活动二维相机的 RetainedViewEntity，初始化本帧阶段后据此移除失效视图的透明、不透明和 AlphaMask 二维阶段。"
  },
  "bevy_core_pipeline::skybox::extract_skybox|previous_len": {
    "summary": "根据上次天空盒提取数量预留输出容量。",
    "description": "extract_skybox 用 previous_len 预分配天空盒与 Uniform 批次数组，计算亮度和变换后保存本轮数量并批量插入渲染组件。"
  },
  "bevy_core_pipeline::core_3d::extract_core_3d_camera_phases|live_entities": {
    "summary": "记录本帧仍活动的三维相机主渲染阶段。",
    "description": "extract_core_3d_camera_phases 收集活动三维相机的保留视图身份，准备主阶段后据此清除失效视图的不透明、AlphaMask 和透明三维阶段。"
  },
  "bevy_core_pipeline::core_3d::extract_camera_prepass_phase|live_entities": {
    "summary": "记录仍应保留预通道与延迟阶段的相机视图。",
    "description": "extract_camera_prepass_phase 为有效相机登记保留视图身份，按标记增减预通道，最后移除不再有效的普通和延迟预通道阶段。"
  },
  "bevy_sprite_render::mesh2d::mesh::extract_2d_meshes|reextract_entities": {
    "summary": "保留二维网格下一帧需要重提取的实体。",
    "description": "extract_2d_meshes 先与临时集合交换，提取过程把材质等条件尚未就绪、需继续尝试的网格写入当前集合，并据此避免误清理保留实例。"
  },
  "bevy_sprite_render::mesh2d::mesh::extract_2d_meshes|reextract_entities_temp": {
    "summary": "暂存上一帧等待重提取的二维网格。",
    "description": "extract_2d_meshes 将上帧请求交换到 reextract_entities_temp，排空该集合并结合相关组件移除实体进行重试，与本轮新请求分开处理。"
  },
  "bevy_pbr::light_probe::gather_light_probes|view_light_probe_info": {
    "summary": "为单个视图暂存已就绪并按距离排序的光照探针。",
    "description": "gather_light_probes 收集当前视图可见且纹理已加载的 LightProbeInfo，按到相机距离排序，再生成视图的探针列表与 GPU 数据。"
  },
  "bevy_pbr::transmission::phase::extract_transmissive_camera_phases|live_entities": {
    "summary": "记录本帧仍活动的透射相机阶段。",
    "description": "extract_transmissive_camera_phases 收集活动相机的保留视图身份，准备透射三维阶段，再据集合移除失效相机阶段。"
  },
  "bevy_pbr::decal::clustered::extract_clustered_decal|previous_len": {
    "summary": "根据上次聚簇贴花提取数量预留批量容量。",
    "description": "extract_clustered_decal 按 previous_len 为实体和贴花组件数组预分配空间，复制本轮查询结果后保存长度并批量插入子世界。"
  },
  "bevy_pbr::render::light::extract_lights|all_lights_found": {
    "summary": "记录本轮成功提取的渲染光源实体。",
    "description": "extract_lights 汇总仍有效的点光、聚光、方向光和区域光渲染实体，最后对未再出现的旧光源移除对应渲染和阴影可见状态。"
  },
  "bevy_pbr::render::light::extract_lights|rect_light_missing_luts_warning_emitted": {
    "summary": "避免区域光缺少 LUT 功能的警告重复输出。",
    "description": "extract_lights 首次发现区域光而未启用 area_light_luts 时发出警告并置真标志，后续区域光处理不重复输出同一警告。"
  },
  "bevy_pbr::render::light::extract_ambient_light|previous_len": {
    "summary": "根据上次环境光组件数量预留提取容量。",
    "description": "extract_ambient_light 用 previous_len 预分配实体与环境光组件数组，复制本轮相机环境光设置后保存数量并批量插入渲染世界。"
  },
  "bevy_pbr::render::light::extract_shadow_filtering_method|previous_len": {
    "summary": "根据上次阴影滤波配置数量预留提取容量。",
    "description": "extract_shadow_filtering_method 按 previous_len 预分配输出，收集各实体阴影滤波方式后记录长度并批量写入渲染世界。"
  },
  "bevy_gizmos_render::retained::extract_linegizmos|previous_len": {
    "summary": "根据上次保留式调试线数量预留提取容量。",
    "description": "extract_linegizmos 用 previous_len 预分配待生成的临时渲染实体数组，提取保留式 Gizmo 的变换及线型参数后保存数量并批量生成。"
  },
  "bevy_egui::render::extract_egui_camera_view_system|live_entities": {
    "summary": "记录本轮成功提取的 Egui 相机视图身份。",
    "description": "extract_egui_camera_view_system 每轮清空 live_entities，在建立 Egui 相机对应的 UI 视图并连接主相机后，记录其 RetainedViewEntity。"
  },
  "bevy_pbr::prepass::specialize_prepass_material_meshes|work_items": {
    "summary": "暂存待专用化的材质预通道工作项。",
    "description": "specialize_prepass_material_meshes 先收集可见实体、视图、网格键、布局及材质属性，再排空 work_items 创建或取得专用预通道管线并更新缓存。"
  },
  "bevy_pbr::prepass::specialize_prepass_material_meshes|removals": {
    "summary": "收集应移除的材质预通道缓存项。",
    "description": "specialize_prepass_material_meshes 将停用预通道、透明模式不适用或读取透射目标的材质登记为视图与实体配对，随后从对应视图缓存删除。"
  },
  "bevy_pbr::prepass::specialize_prepass_material_meshes|all_views": {
    "summary": "记录仍有效的材质预通道视图。",
    "description": "specialize_prepass_material_meshes 收集本轮视图身份，用于过期待处理材质队列并移除失效视图的专用预通道管线缓存。"
  },
  "bevy_pbr::render::light::prepare_lights|arg10.0": {
    "summary": "限制方向光数量超限警告只输出一次。",
    "description": "prepare_lights 的 max_directional_lights_warning_emitted 仅在方向光数量超过 MAX_DIRECTIONAL_LIGHTS 时首次警告并置真，与其他光源上限警告独立。"
  },
  "bevy_pbr::render::light::prepare_lights|arg10.1": {
    "summary": "限制非聚簇区域光数量超限警告只输出一次。",
    "description": "prepare_lights 的 max_rect_lights_warning_emitted 仅在区域光未走聚簇路径且数量超过 MAX_RECT_LIGHTS 时首次警告并置真。"
  },
  "bevy_pbr::render::light::prepare_lights|arg10.2": {
    "summary": "限制单个方向光阴影级联超限警告只输出一次。",
    "description": "prepare_lights 的 max_cascades_per_light_warning_emitted 在任一方向光级联数超过 MAX_CASCADES_PER_LIGHT 时首次警告并置真。"
  },
  "bevy_pbr::render::light::prepare_lights|arg10.3": {
    "summary": "记录本帧仍需保留的各类阴影视图。",
    "description": "prepare_lights 的 live_shadow_mapping_lights 汇总点光六面、聚光和方向光级联的保留视图身份，最后清理失效阴影阶段、光源键及专用阴影材质缓存。"
  },
  "bevy_sprite_render::mesh2d::material::specialize_material2d_meshes|work_items": {
    "summary": "暂存二维材质网格专用管线的工作项。",
    "description": "specialize_material2d_meshes 先收集可见网格、视图、布局及材质属性，再排空 work_items 构造材质管线键并更新各视图的专用管线缓存。"
  },
  "bevy_sprite_render::mesh2d::material::specialize_material2d_meshes|all_views": {
    "summary": "记录仍有效的二维材质管线视图。",
    "description": "specialize_material2d_meshes 收集本轮视图身份，处理工作项后据此保留有效的二维材质专用管线缓存，清除已消失视图。"
  },
  "bevy_pbr::material::specialize_material_meshes|work_items": {
    "summary": "暂存三维材质网格专用管线的工作项。",
    "description": "specialize_material_meshes 汇集可见网格、视图、网格键、布局及材质属性，再排空工作项为各实体取得或创建专用三维材质管线。"
  },
  "bevy_pbr::material::specialize_material_meshes|all_views": {
    "summary": "记录仍有效的三维材质专用化视图。",
    "description": "specialize_material_meshes 用 all_views 过期待处理材质队列，并在完成专用化后移除失效视图的材质管线缓存。"
  },
  "bevy_pbr::render::light::specialize_shadows|work_items": {
    "summary": "暂存阴影材质管线的专用化工作项。",
    "description": "specialize_shadows 汇集阴影视图可见网格的布局、管线键和材质属性，再排空工作项创建或复用阴影管线，写入按阴影视图分组的缓存。"
  },
  "bevy_pbr::render::light::specialize_shadows|all_shadow_views": {
    "summary": "记录本轮存在的材质阴影视图。",
    "description": "specialize_shadows 收集保留阴影视图身份，用于过期待处理阴影队列和移除失效视图的阴影材质专用管线缓存。"
  },
  "bevy_render::view::prepare_view_targets|main_texture_atomics": {
    "summary": "跨帧共享主颜色双缓冲的当前侧索引。",
    "description": "prepare_view_targets 按 MainTextureKey 保存 AtomicUsize 的弱引用，使使用同一主纹理的视图跨帧共享颜色缓冲切换状态，确保后处理写入能延续到 MSAA 回写。"
  },
  "bevy_sprite_render::mesh2d::material::queue_material2d_meshes|mesh_instances_queued_this_iteration_scratch_space": {
    "summary": "去重二维网格本轮需要重新排队的实例。",
    "description": "queue_material2d_meshes 将此集合传给 iter_to_queue，合并新可见、专用化变化及上帧待处理实例时保证同一主世界网格只返回一次。"
  },
  "bevy_pbr::prepass::queue_prepass_material_meshes|mesh_instances_queued_this_iteration_scratch_space": {
    "summary": "去重材质预通道本轮需要排队的网格实例。",
    "description": "queue_prepass_material_meshes 以此集合合并新可见、专用化变化及等待材质的网格，避免同一实例重复加入普通或延迟预通道。"
  },
  "bevy_pbr::material::queue_material_meshes|mesh_instances_queued_this_iteration_scratch_space": {
    "summary": "去重三维材质本轮需要重新排队的网格。",
    "description": "queue_material_meshes 将新可见、专用化变化与上帧待处理网格统一迭代，利用此集合防止同一实例重复加入三维渲染阶段。"
  },
  "bevy_pbr::render::light::queue_shadows|mesh_instances_queued_this_iteration_scratch_space": {
    "summary": "去重阴影阶段本轮需要排队的网格实例。",
    "description": "queue_shadows 在合并可见性变化、专用化变化及待处理材质队列时，用此集合确保每个主世界网格在该轮仅处理一次。"
  },
  "bevy_sprite_render::render::queue_sprites|view_entities": {
    "summary": "用位集快速检查当前相机可见的精灵实体。",
    "description": "queue_sprites 按当前视图可见精灵的实体索引填充 view_entities，遍历提取精灵时进行常数时间成员判断，只把可见精灵加入透明二维阶段。"
  },
  "bevy_core_pipeline::oit::resolve::queue_oit_resolve_pipeline|cached_pipeline_id": {
    "summary": "按视图和配置键缓存 OIT 解析管线标识。",
    "description": "queue_oit_resolve_pipeline 在配置键未变化时复用已排队管线，变化时重新生成并更新记录，最后清理已不存在视图的缓存项。"
  },
  "bevy_ui_render::prepare_uinodes|previous_len": {
    "summary": "按上次普通 UI 批次数预留批量插入空间。",
    "description": "prepare_uinodes 用 previous_len 为 UiBatch 输出数组预分配容量，完成本帧几何和批次构建后记录新批次数并批量插入组件。"
  },
  "bevy_ui_render::ui_texture_slice_pipeline::prepare_ui_slices|previous_len": {
    "summary": "按上次 UI 切片批次数预留输出空间。",
    "description": "prepare_ui_slices 用 previous_len 预分配 UiTextureSlicerBatch 数组，完成纹理切片几何准备后保存本轮批次数并批量写入。"
  },
  "bevy_ui_render::gradient::prepare_gradient|previous_len": {
    "summary": "按上次 UI 渐变批次数预留输出空间。",
    "description": "prepare_gradient 用 previous_len 预分配 GradientBatch 数组，准备渐变顶点、索引和批次后保存本轮数量并批量插入组件。"
  },
  "bevy_ui_render::box_shadow::prepare_shadows|previous_len": {
    "summary": "按上次 UI 阴影项数量预留输出空间。",
    "description": "prepare_shadows 用 previous_len 为 UiShadowsBatch 输出数组预分配容量，完成各阴影项的裁剪几何后保存数量并批量插入。"
  },
  "bevy_pbr::render::mesh_view_bindings::prepare_mesh_view_bind_groups|arg13": {
    "summary": "复用网格视图普通绑定条目数组的容量。",
    "description": "prepare_mesh_view_bind_groups 的 entries_cache 保存清空后的 BindGroupEntry 数组分配，下一次转为动态生命周期工作区重新填充普通绑定条目。"
  },
  "bevy_pbr::render::mesh_view_bindings::prepare_mesh_view_bind_groups|arg14": {
    "summary": "复用网格视图绑定数组条目列表的容量。",
    "description": "prepare_mesh_view_bind_groups 的 entries_binding_array_cache 保存清空后的条目数组分配，下一次重新填充绑定数组工作区，减少重复分配。"
  },
  "bevy_core_pipeline::mip_generation::experimental::depth::create_downsample_depth_pipelines|has_run": {
    "summary": "确保深度下采样管线初始化只尝试一次。",
    "description": "create_downsample_depth_pipelines 首次进入后即设置 has_run；后续直接返回，包括平台不支持 GPU 剔除而未创建管线的情况，避免持续重试。"
  },
  "bevy_pbr::volumetric_fog::render::prepare_volumetric_fog_uniforms|local_from_world_matrices": {
    "summary": "为各雾体预计算世界到局部空间的逆变换。",
    "description": "prepare_volumetric_fog_uniforms 先计算每个 FogVolume 的逆仿射矩阵并缓存，再为各视图复用这些矩阵，避免视图与雾体组合中重复求逆。"
  },
  "bevy_extract::sync_world::despawn_temporary_entities|local": {
    "summary": "按索引排序暂存待销毁的子世界临时实体。",
    "description": "despawn_temporary_entities 收集带 TemporaryEntity 的实体，按实体索引排序后逆序销毁，使下一帧重新分配实体时保持期望顺序。"
  },
  "bevy_render::view::visibility::collect_visible_cpu_culled_entities|visibility_classes": {
    "summary": "汇总当前视图已有和新提取的可见性类别。",
    "description": "collect_visible_cpu_culled_entities 在相机和阴影子视图中复用该集合，合并现有与 CPU 提取结果的类别，为每类准备本帧列表并同步可见实体。"
  },
  "bevy_pbr::render::mesh::check_views_need_specialization|seen_views": {
    "summary": "记录本轮仍存在的三维网格视图。",
    "description": "check_views_need_specialization 在检查各视图的网格管线设置时登记保留视图身份，结束后从 ViewKeyCache 删除未再出现的视图。"
  },
  "bevy_enhanced_input::context::input_reader::InputReader|gamepad_device": {
    "summary": "保存输入读取器当前选择的游戏手柄。",
    "description": "InputReader 根据 gamepad_device 从指定手柄读取轴和按键，并在输入消费与等待释放检查中使用相同的设备身份。"
  },
  "bevy_enhanced_input::context::input_reader::InputReader|skip_ignore_check": {
    "summary": "控制输入读取器是否跳过忽略绑定检查。",
    "description": "InputReader 更新等待释放的绑定时暂时启用 skip_ignore_check，直接检查输入实际值；处理结束后关闭该标志，恢复正常的忽略绑定过滤。"
  }
};
