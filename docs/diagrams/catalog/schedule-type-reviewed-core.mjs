// 基于锁定源码声明、字段和直接调用用途逐族审阅；已有对象仅按相同定义入口精确复用。
export const CORE_SCHEDULE_TYPE_PURPOSES = Object.freeze({
  "bevy_state::state_scoped::DespawnOnEnter":{"summary":"指定进入某状态时自动销毁的实体。","description":"泛型组件保存目标状态值；StateTransition 的 EnterSchedules 框架系统读取最新转换，在进入该值时排入销毁，包括禁用实体。本项目会话根保存 AppState::MainMenu，暂停恢复保持身份；后代由现有层级关系清理。"},
  "bevy_transform_interpolation::interpolation::TransformInterpolation":{"summary":"为实体启用平移、旋转和缩放插值。","description":"组合标记通过required components启用TranslationInterpolation、RotationInterpolation和ScaleInterpolation，使FixedUpdate内的变换变化在渲染帧之间平滑；实际端点分别由各通道的EasingState保存。"},
  "bevy_extract::sync_world::MainEntity":{"summary":"在子世界中关联原始主世界实体。","description":"子世界组件封装主世界Entity，保存同步实体对应的原始实体身份；提取系统把它插入新建的渲染实体，以供保留视图、缓存和跨世界实体映射使用。它不是主世界实体本身的额外数据副本。"},
  "bevy_state::state_scoped::DespawnOnExit":{"summary":"指定离开某状态时自动销毁的实体。","description":"泛型组件保存状态值S，状态作用域清理系统在离开该值时销毁带有此组件的实体；本实例明确保存对应AppState，子树清理由已有实体层级生命周期负责。"},
  "bevy_scene::spawn::QueuedScenes":{"summary":"暂存等待创建的场景及关联场景列表。","description":"资源保存新场景实体与ScenePatch句柄、关联场景列表的创建请求及独立SceneListPatch句柄；spawn_queued从资源作用域取出这些排队请求，在依赖就绪后完成场景解析和实例创建。"},
  "bevy_picking::hover::Hovered":{"summary":"记录实体当前是否被任一指针悬停。","description":"布尔组件表示实体当前是否由任一指针悬停；update_is_hovered把本帧HoverMap结果同步到已具有该组件的实体，并清除先前悬停而本帧未命中的状态。"},
  "bevy_picking::events::PointerOut":{"summary":"通知指针离开目标并向全部祖先传播。","description":"指针离开目标边界时触发的EntityEvent和Message，携带实体、指针及先前命中数据；与PointerLeave不同，会不加共同祖先限制地向目标全部祖先传播。"},
  "bevy_picking::events::PointerLeave":{"summary":"通知指针离开目标或其独有祖先范围。","description":"指针离开目标时触发，携带先前命中及was_in_bounds；只传播到本帧不再具有悬停子孙的祖先，共同祖先不接收此离开事件，因此子孙范围也可使父节点收到事件。"},
  "bevy_picking::events::PointerEnter":{"summary":"通知指针进入目标或其独有祖先范围。","description":"指针进入目标时触发，携带命中及is_in_bounds；只传播到上帧没有悬停子孙的祖先，已被前后悬停实体共同覆盖的祖先不再收到进入事件。"},
  "bevy_picking::events::PointerOver":{"summary":"通知指针进入目标并向全部祖先传播。","description":"指针跨入目标边界时触发的EntityEvent和Message，携带实体、指针及命中数据；与PointerEnter不同，会不加共同祖先限制地沿ChildOf向上冒泡。"},
  "bevy_picking::events::PointerPress":{"summary":"通知目标上的指针按钮按下及连按次数。","description":"指针按钮在目标上按下时触发，保存目标实体、指针、按钮、命中信息及从1开始的连续按下计数；可按PointerTraversal向层级传播。"},
  "bevy_picking::events::PointerRelease":{"summary":"通知目标上的指针按钮释放。","description":"指针按钮在目标上释放时触发的EntityEvent和Message，携带目标实体、指针、被释放按钮及命中信息，不单独证明同一目标曾收到对应按下。"},
  "bevy_picking::events::PointerClick":{"summary":"通知同一目标的成对按压和释放点击。","description":"同一目标先收到指针按下再收到释放时触发；载荷包含按钮、命中、两次动作间Duration及连续点击计数，可区分单击、多击及长按后释放。"},
  "bevy_picking::events::PointerMove":{"summary":"通知目标上的指针移动及屏幕位移。","description":"指针在目标上移动时触发，保存目标、指针、命中以及自上次移动以来的delta；delta使用左上到右下的屏幕像素坐标，不能直接视作世界位移。"},
  "bevy_picking::events::PointerDragStart":{"summary":"通知按下后移动开始拖拽目标。","description":"目标收到指针按下后又收到移动时开始拖拽；事件携带原目标、指针、拖拽按钮及命中数据，标志该交互进入拖拽状态。"},
  "bevy_picking::events::PointerDrag":{"summary":"通知正在拖拽的目标及累计和本次位移。","description":"目标持续被拖拽时触发，包含按钮、从拖拽起点累计的distance及本次delta；二者都是屏幕像素向量，不是世界坐标变换。"},
  "bevy_picking::events::PointerDragEnd":{"summary":"通知拖拽按钮释放及最终累计位移。","description":"拖拽目标时收到指针释放后触发，保存目标实体、指针、按钮及从拖拽起点到最终位置的屏幕像素distance，表示本次拖拽结束。"},
  "bevy_picking::events::PointerDragEnter":{"summary":"通知携带拖拽对象的指针进入接收目标。","description":"拖拽某实体的指针进入另一目标时触发；entity是接收目标，dragged是被拖拽实体，载荷还保留指针、按钮和当前命中信息。"},
  "bevy_picking::events::PointerDragOver":{"summary":"通知拖拽对象正悬停于接收目标。","description":"指针携带dragged实体在接收目标上拖动时触发；载荷区分接收entity与被拖拽实体，并保存按钮、指针和接收目标命中数据。"},
  "bevy_picking::events::PointerDragLeave":{"summary":"通知拖拽对象离开接收目标。","description":"携带dragged实体的指针离开接收目标时触发，保留接收entity、拖拽实体、指针、按钮及最后一次先前命中数据。"},
  "bevy_picking::events::PointerDragDrop":{"summary":"通知被拖拽实体释放到接收目标。","description":"指针把dropped实体放到接收目标时触发；entity指接收目标，dropped指被放下实体，并携带释放按钮、指针及命中数据。"},
  "bevy_picking::events::PointerScroll":{"summary":"通知目标上的横向和纵向滚动输入。","description":"指针在目标上滚动时触发的EntityEvent和Message，携带目标、指针、MouseScrollUnit以及x和y滚动值，保留像素或行单位供控件解释。"},
  "bevy_picking::events::PointerCancel":{"summary":"通知指针取消并丢弃当前交互状态。","description":"指针被取消时触发，携带目标实体、指针及命中数据；对应交互状态会被丢弃，不等同于正常按钮释放或点击。"},
  "bevy_app::main_schedule::MainScheduleOrder":{"summary":"规定主调度及启动调度的运行顺序。","description":"保存Main阶段与首次启动阶段的InternedScheduleLabel列表；Main::run_main按列表先执行一次启动调度，再逐帧执行主阶段调度，插件可调整列表而不改变系统依赖图。"},
  "bevy_app::main_schedule::FixedMainScheduleOrder":{"summary":"规定每次固定步内各子调度的顺序。","description":"保存FixedMain的InternedScheduleLabel顺序列表，缺省为FixedFirst、FixedPreUpdate、FixedUpdate、FixedPostUpdate及FixedLast；FixedMain::run_fixed_main按该列表运行一个固定步。"},
  "bevy_winit::cursor::PendingCursor":{"summary":"把待应用的窗口光标传递给winit事件循环。","description":"窗口组件保存可选CursorSource，表示CursorIcon变化后待应用的系统光标或自定义光标来源；winit事件循环消费它以更新原生窗口光标。"},
  "bevy_enhanced_input::context::ContextActivity":{"summary":"控制保留绑定的输入上下文启停。","description":"带上下文类型参数的不可变组件保存active开关；注册上下文时作为required component提供，通过替换组件切换输入评估，同时保留上下文实体及绑定。"},
  "bevy_input_focus::gained_and_lost::FocusLost":{"summary":"通知实体及祖先已失去输入焦点。","description":"可冒泡的EntityEvent携带失去InputFocus的实体身份；处理焦点记录变化时触发，使实体与父层级可响应焦点离开。"},
  "bevy_input_focus::gained_and_lost::FocusGained":{"summary":"通知实体及祖先已获得输入焦点。","description":"可冒泡的EntityEvent携带获得InputFocus的实体和FocusCause原因，区分导航、按压及自动聚焦，供控件根据焦点来源响应。"},
  "bevy_input_focus::FocusedInput":{"summary":"把输入消息路由到焦点实体并向窗口冒泡。","description":"泛型EntityEvent封装原始输入消息、接收焦点实体和主窗口身份；输入分发系统选择当前焦点实体，若无焦点则选择主窗口，并按WindowTraversal自动向上传播。"},
  "bevy_text::editing::TextEditChange":{"summary":"通知可编辑文本已应用待处理编辑。","description":"EntityEvent携带EditableText所在实体，apply_text_edits完成排队编辑并检测编辑器generation变化后触发；光标移动也是编辑，因此事件不保证文本value已改变。"},
  "bevy_ui_widgets::menu::MenuEvent":{"summary":"通过菜单层级传递开关和焦点操作。","description":"EntityEvent包含触发菜单项或弹出菜单的source及MenuAction，沿菜单容器、portal关系和菜单拥有者向上冒泡，以请求菜单打开、关闭或焦点返回等行为。"},
  "bevy_ui_widgets::scrollbar::Scrollbar":{"summary":"指定滚动条目标、方向和最小滑块长度。","description":"组件保存被滚动的目标实体、水平或垂直ControlOrientation及min_thumb_length；滚动条系统据可见范围与内容比例更新带ScrollbarThumb子实体的位置和尺寸。"},
  "demo::ui::backdrop::CourierAnimationPending":{"summary":"等待菜单展示角色的命名动画资源就绪。","description":"主菜单展示角色子场景就绪后插入的标记；play_courier_animation继续等待父GLB及命名动画片段，绑定并开始展示动作后移除，以兼容异步资产完成顺序。"},
  "bevy_egui::PrimaryEguiContext": {
    "summary": "标记运行主Egui调度的上下文。",
    "description": "标记主Egui上下文，并通过required components确保该实体具有EguiContext和运行EguiPrimaryContextPass的EguiSchedule；自动设置系统在尚无主上下文时给新相机插入此标记。"
  },
  "bevy_egui::EguiPassQuery": {
    "summary": "查询运行Egui调度所需的上下文状态。",
    "description": "可变QueryData包含实体身份、EguiContext、EguiInput、EguiFullOutput，以及只读EguiSchedule和EguiContextSettings。独占pass循环用它跳过手动运行的上下文、取走输入、运行指定调度并写回输出；它是查询接口而不是独立数据组件。"
  },
  "bevy_egui::render::systems::EguiTextureBindGroups": {
    "summary": "索引Egui纹理绑定组及数组偏移。",
    "description": "渲染资源保存EguiTextureId到GPU BindGroup及可选数组偏移的映射；queue_bind_groups按已提取纹理和bindless模式重建此表，egui_pass据纹理ID绑定绘制所需的图像和采样器。"
  },
  "bevy_egui::render::systems::EguiPipelines": {
    "summary": "索引每个Egui视图的专用化绘制管线。",
    "description": "渲染资源保存主世界实体MainEntity到CachedRenderPipelineId的映射；queue_pipelines按视图目标纹理格式专用化Egui管线，egui_pass按保留视图主实体取出缓存管线ID并准备绘制。"
  },
  "bevy_extract::sync_world::TemporaryEntity": {
    "summary": "标记子世界中帧末清理的临时实体。",
    "description": "以AppLabel区分子应用的临时实体标记；该组件表示实体需在帧末清理，despawn_temporary_entities按对应AppLabel的标记查询并销毁实体，不表示主世界业务实体同步身份。"
  },
  "bevy_a11y::AccessibilityNode": {
    "summary": "把实体转换为 AccessKit 可访问性节点",
    "description": "把实体转换为 AccessKit 可访问性节点，保存平台无关的控件语义。只有父子双方都有此组件时才保留对应的可访问性树层级。"
  },
  "bevy_animation::AnimatedBy": {
    "summary": "把动画目标连接到驱动它的 AnimationPlayer 实体",
    "description": "把动画目标连接到驱动它的 AnimationPlayer 实体。AnimationTargetId 决定播放器中哪些动画曲线作用于这个目标。"
  },
  "bevy_animation::AnimationEntityMut": {
    "summary": "动画求值使用的 EntityMutExcept 查询别名",
    "description": "动画求值使用的 EntityMutExcept 查询别名，在排除动画求值所借用组件的前提下访问目标实体其余组件。"
  },
  "bevy_animation::AnimationPlayer": {
    "summary": "保存当前激活动画及其播放控制状态",
    "description": "保存当前激活动画及其播放控制状态，由动画推进和求值系统处理。每个 AnimationNodeIndex 对应一份 ActiveAnimation。"
  },
  "bevy_animation::AnimationTargetId": {
    "summary": "使用 UUID 标识动画曲线的目标路径",
    "description": "使用 UUID 标识动画曲线的目标路径，使动画片段中的曲线与骨骼或其他目标实体匹配。相同名称路径可用于动画重定向。"
  },
  "bevy_animation::graph::AnimationGraphHandle": {
    "summary": "选择播放器使用的动画图资产。",
    "description": "保存同一实体上 AnimationPlayer 使用的 AnimationGraph 资产句柄。动画求值通过它选择节点、混合和遮罩结构。"
  },
  "bevy_animation::graph::ThreadedAnimationGraphs": {
    "summary": "缓存动画图的线程化遍历加速结构",
    "description": "缓存动画图的线程化遍历加速结构，并维护动画片段到引用图的反向索引。图或片段资产变化时更新对应缓存。"
  },
  "bevy_animation::transition::AnimationTransitions": {
    "summary": "管理动画混合权重的淡出过程",
    "description": "管理动画混合权重的淡出过程，保存主动画和过渡列表，使不同动画间平滑切换。"
  },
  "bevy_app::propagate::Inherited": {
    "summary": "保存层级传播算法继承到当前节点的中间组件值",
    "description": "保存层级传播算法继承到当前节点的中间组件值，用来判断是否继续更新关系目标。它是 HierarchyPropagatePlugin 的内部传播状态。"
  },
  "bevy_app::propagate::Propagate": {
    "summary": "从当前实体向直接及间接关系目标传播内部组件值",
    "description": "从当前实体向直接及间接关系目标传播内部组件值。目标若有自身的 Propagate 值，则从该节点开始覆盖上游传播。"
  },
  "bevy_app::propagate::PropagateOver": {
    "summary": "阻止传播结果组件添加到当前实体",
    "description": "阻止传播结果组件添加到当前实体，同时允许关系目标继续继承当前实体或祖先的值。"
  },
  "bevy_app::propagate::PropagateStop": {
    "summary": "在当前实体截断该组件的层级传播",
    "description": "在当前实体截断该组件的层级传播，使子目标不再继承上游值。"
  },
  "bevy_clipboard::Clipboard": {
    "summary": "提供剪贴板文本读写接口",
    "description": "提供剪贴板文本读写接口。启用 system_clipboard 时连接系统剪贴板，否则使用进程内字符串缓冲。"
  },
  "bevy_diagnostic::diagnostic::Diagnostics": {
    "summary": "提供诊断测量值的记录入口",
    "description": "提供诊断测量值的记录入口，读取诊断存储并通过延迟缓冲提交新测量值。"
  },
  "bevy_diagnostic::diagnostic::DiagnosticsStore": {
    "summary": "按 DiagnosticPath 保存诊断项、测量历史和统计结果",
    "description": "按 DiagnosticPath 保存诊断项、测量历史和统计结果，供诊断采集及展示系统查询。"
  },
  "bevy_diagnostic::frame_count::FrameCount": {
    "summary": "记录应用启动以来的帧计数",
    "description": "记录应用启动以来的帧计数，在 Last 调度中递增，超过 u32 上限后回绕。"
  },
  "bevy_ecs::entity_disabling::Disabled": {
    "summary": "标记被禁用的实体",
    "description": "标记被禁用的实体，使默认查询过滤器排除它。显式提及禁用组件的查询仍可访问该实体。"
  },
  "bevy_ecs::entity::Entities": {
    "summary": "保存所有已知实体索引及其代际和位置元数据",
    "description": "保存所有已知实体索引及其代际和位置元数据，为实体存活性及存储位置查询提供基础表。"
  },
  "bevy_ecs::entity::Entity": {
    "summary": "以实体索引和代际组成实体身份",
    "description": "以实体索引和代际组成实体身份，区分同一索引被释放后重新分配的不同实体。它本身不保存组件数据。"
  },
  "bevy_ecs::entity::EntityAllocator": {
    "summary": "并发分配唯一实体身份并追踪可复用索引",
    "description": "并发分配唯一实体身份并追踪可复用索引，支持实体生成、指定身份生成及释放流程。"
  },
  "bevy_ecs::hierarchy::ChildOf": {
    "summary": "保存当前实体的父实体身份",
    "description": "保存当前实体的父实体身份，作为规范父子层级的关系源。关系钩子同步维护父实体的 Children 集合。"
  },
  "bevy_ecs::hierarchy::Children": {
    "summary": "保存以 ChildOf 指向当前父实体的子实体集合",
    "description": "保存以 ChildOf 指向当前父实体的子实体集合。应通过修改子实体的 ChildOf 维护关系，避免直接改集合导致不同步。"
  },
  "bevy_ecs::lifecycle::RemovedComponents": {
    "summary": "读取曾移除指定组件或连同该组件一起销毁的实体身份",
    "description": "读取曾移除指定组件或连同该组件一起销毁的实体身份。该参数保留独立读取游标，不提供被移除前的组件值。"
  },
  "bevy_ecs::message::message_registry::MessageRegistry": {
    "summary": "登记 World 中各消息缓冲的更新函数及是否需要轮换的状态",
    "description": "登记 World 中各消息缓冲的更新函数及是否需要轮换的状态，供 message_update_system 统一更新。"
  },
  "bevy_ecs::message::messages::Messages": {
    "summary": "保存最近两次轮换期间产生的指定类型消息",
    "description": "保存最近两次轮换期间产生的指定类型消息。各 MessageReader 独立维护读取进度，消息写入和读取顺序由调度决定。"
  },
  "bevy_ecs::name::Name": {
    "summary": "保存供调试和界面展示的实体名称及缓存哈希",
    "description": "保存供调试和界面展示的实体名称及缓存哈希。多个实体可拥有相同名称，名称不能替代 Entity 身份。"
  },
  "bevy_ecs::name::NameOrEntity": {
    "summary": "查询可选的实体 Name 和必有的 Entity 身份",
    "description": "查询可选的实体 Name 和必有的 Entity 身份，显示时优先使用名称，没有名称时显示索引与代际。"
  },
  "bevy_ecs::query::state::QueryState": {
    "summary": "缓存查询数据、过滤条件和匹配存储的状态",
    "description": "缓存查询数据、过滤条件和匹配存储的状态，使重复查询能够复用匹配结果。查询属于创建它的 World。"
  },
  "bevy_ecs::resource::IsResource": {
    "summary": "标记承载资源值的内部实体并保存实际资源组件的 ComponentId",
    "description": "标记承载资源值的内部实体并保存实际资源组件的 ComponentId，供资源实体映射及生命周期钩子使用。"
  },
  "bevy_ecs::system::commands::Commands": {
    "summary": "保存延迟执行的 World 操作队列",
    "description": "保存延迟执行的 World 操作队列，可排入生成、销毁、组件及资源操作。排队不等于即时执行，操作在 ApplyDeferred 阶段应用。"
  },
  "bevy_ecs::system::commands::parallel_scope::ParallelCommands": {
    "summary": "在并行查询等多线程上下文中排入延迟命令",
    "description": "在并行查询等多线程上下文中排入延迟命令。不同线程的命令应用顺序可能不同，不能据此推断稳定的执行次序。"
  },
  "bevy_ecs::system::function_system::SystemState": {
    "summary": "持久保存 SystemParam 的状态及所属 World 身份",
    "description": "持久保存 SystemParam 的状态及所属 World 身份，使独占系统或手动参数获取能够复用查询、消息游标和 Local 状态。"
  },
  "bevy_ecs::system::system_param::Deferred": {
    "summary": "保存稍后在 ApplyDeferred 中应用的系统缓冲",
    "description": "保存稍后在 ApplyDeferred 中应用的系统缓冲，用于把 World 修改延后到调度同步点。"
  },
  "bevy_ecs::system::system_param::If": {
    "summary": "包装另一个系统参数",
    "description": "包装另一个系统参数，当内部参数当前不可用时跳过系统，而不是以参数验证失败终止执行。"
  },
  "bevy_ecs::system::system_param::lifetimeless::SQuery": {
    "summary": "为 Query 提供静态生命周期形式",
    "description": "为 Query 提供静态生命周期形式，便于把查询声明保存在泛型参数或其他静态类型中。具体查询数据和过滤条件由类型参数指定。"
  },
  "bevy_ecs::system::system_param::NonSendMarker": {
    "summary": "利用不可 Send 的标记约束系统在主线程运行",
    "description": "利用不可 Send 的标记约束系统在主线程运行；该参数不代表任何共享数据内容。"
  },
  "bevy_ecs::system::system_param::StaticSystemParam": {
    "summary": "适配泛型 SystemParam",
    "description": "适配泛型 SystemParam，使参数的 Item 类型在忽略生命周期时保持自身类型，支持泛型系统及派生参数结构。"
  },
  "bevy_ecs::system::system_param::SystemChangeTick": {
    "summary": "提供系统上次与本次运行的变化刻度",
    "description": "提供系统上次与本次运行的变化刻度，用于判断组件或资源是否在两次运行之间发生变化。"
  },
  "bevy_ecs::world::entity_access::entity_mut::EntityMut": {
    "summary": "提供一个实体及其全部现有组件的可变访问",
    "description": "提供一个实体及其全部现有组件的可变访问。它不提供 EntityWorldMut 那样的任意结构变化或整个 World 访问。"
  },
  "bevy_ecs::world::entity_access::entity_ref::EntityRef": {
    "summary": "提供一个实体及其全部组件的只读引用",
    "description": "提供一个实体及其全部组件的只读引用，供动态组件读取或实体信息查询。"
  },
  "bevy_ecs::world::entity_access::filtered::FilteredEntityMut": {
    "summary": "按已声明 Access 集合提供一个实体的可变组件访问",
    "description": "按已声明 Access 集合提供一个实体的可变组件访问，实际可访问范围由 QueryBuilder 等构造时的配置限定。"
  },
  "bevy_ecs::world::entity_access::filtered::FilteredEntityRef": {
    "summary": "按已声明 Access 集合提供一个实体的只读组件访问",
    "description": "按已声明 Access 集合提供一个实体的只读组件访问，实际可访问范围由查询构造配置限定。"
  },
  "bevy_ecs::world::World": {
    "summary": "保存实体、组件、资源及关联元数据",
    "description": "保存实体、组件、资源及关联元数据，并提供生成、查询、访问与生命周期操作。每个主应用或子应用有各自的 World。"
  },
  "bevy_egui::EguiClipboard": {
    "summary": "为 Egui 提供剪贴板集成",
    "description": "为 Egui 提供剪贴板集成，按平台持有系统剪贴板接口；仅 manage_clipboard 功能启用时可用。"
  },
  "bevy_egui::EguiContext": {
    "summary": "包装一个 egui::Context",
    "description": "包装一个 egui::Context，保存该界面的输入处理、UI 构建和绘制状态。不同 Egui 上下文由不同实体承载。"
  },
  "bevy_egui::EguiContextSettings": {
    "summary": "保存单个 Egui 上下文的运行、输入、指针捕获、光标和 IME 集成选项",
    "description": "保存单个 Egui 上下文的运行、输入、指针捕获、光标和 IME 集成选项。"
  },
  "bevy_egui::EguiFullOutput": {
    "summary": "暂存 Egui pass 结束时产生的完整输出",
    "description": "暂存 Egui pass 结束时产生的完整输出，随后由 process_output_system 拆分为平台输出和渲染输出。"
  },
  "bevy_egui::EguiInput": {
    "summary": "保存送入当前 Egui 上下文的 RawInput",
    "description": "保存送入当前 Egui 上下文的 RawInput，输入写入阶段结束时重置相应输入批次。"
  },
  "bevy_egui::EguiManagedTextures": {
    "summary": "保存 Egui 分配并绘制的纹理及其 Bevy 图像句柄",
    "description": "保存 Egui 分配并绘制的纹理及其 Bevy 图像句柄，供纹理增量处理和渲染提取使用。"
  },
  "bevy_egui::EguiOutput": {
    "summary": "保存上一轮 Egui 的平台输出和像素点比例",
    "description": "保存上一轮 Egui 的平台输出和像素点比例，供窗口、剪贴板、光标等平台集成使用。"
  },
  "bevy_egui::EguiPixelsPerPoint": {
    "summary": "在渲染世界保存 Egui 当前每逻辑点对应的物理像素数",
    "description": "在渲染世界保存 Egui 当前每逻辑点对应的物理像素数，用于正确缩放绘制。"
  },
  "bevy_egui::EguiRenderOutput": {
    "summary": "保存 Egui 绘制图元和纹理增量",
    "description": "保存 Egui 绘制图元和纹理增量，连接 UI pass 输出与后续渲染数据准备。"
  },
  "bevy_egui::EguiSchedule": {
    "summary": "为额外 Egui 上下文指定执行 UI pass 的调度",
    "description": "为额外 Egui 上下文指定执行 UI pass 的调度，支持额外窗口或图像目标上的独立界面。"
  },
  "bevy_egui::EguiUserTextures": {
    "summary": "登记由用户提供给 Egui 的 Bevy 图像纹理",
    "description": "登记由用户提供给 Egui 的 Bevy 图像纹理，维护图像资产身份到 Egui 纹理编号的映射和可复用编号列表。"
  },
  "bevy_egui::EguiZoomFactor": {
    "summary": "在主世界保存 Egui 上下文的缩放因子",
    "description": "在主世界保存 Egui 上下文的缩放因子，用于 UI 尺寸及输入坐标换算。"
  },
  "bevy_egui::input::EguiContextImeState": {
    "summary": "保存各 Egui 上下文是否允许输入法以及活动编辑区域矩形",
    "description": "保存各 Egui 上下文是否允许输入法以及活动编辑区域矩形，供输入法和窗口集成更新。"
  },
  "bevy_egui::input::EguiContextMessageReader": {
    "summary": "把输入消息与对应的 Egui 上下文配对迭代",
    "description": "把输入消息与对应的 Egui 上下文配对迭代，结合窗口映射及非窗口上下文的悬停、焦点状态决定接收者。"
  },
  "bevy_egui::input::EguiContextPointerPosition": {
    "summary": "缓存当前 Egui 指针坐标",
    "description": "缓存当前 Egui 指针坐标，构造指针按钮事件时使用该位置。"
  },
  "bevy_egui::input::EguiContextPointerTouchId": {
    "summary": "保存当前驱动 Egui 指针的活动触摸编号",
    "description": "保存当前驱动 Egui 指针的活动触摸编号，区分多个并发触点。"
  },
  "bevy_egui::input::EguiWantsInput": {
    "summary": "汇总 Egui 是否正在使用指针、需要键盘输入或打开弹出层",
    "description": "汇总 Egui 是否正在使用指针、需要键盘输入或打开弹出层，供其他输入逻辑决定是否响应。"
  },
  "bevy_egui::input::FocusedNonWindowEguiContext": {
    "summary": "保存当前获得键盘焦点的非窗口 Egui 上下文实体",
    "description": "保存当前获得键盘焦点的非窗口 Egui 上下文实体。指针按下或触摸开始时根据悬停目标更新。"
  },
  "bevy_egui::input::HoveredNonWindowEguiContext": {
    "summary": "保存指针当前悬停的非窗口 Egui 上下文实体",
    "description": "保存指针当前悬停的非窗口 Egui 上下文实体，作为指针输入及焦点分配目标。"
  },
  "bevy_egui::input::ModifierKeysState": {
    "summary": "缓存 Shift、Control、Alt 和平台主修饰键的按下状态",
    "description": "缓存 Shift、Control、Alt 和平台主修饰键的按下状态，转换为 Egui 输入修饰信息。"
  },
  "bevy_egui::input::WindowToEguiContextMap": {
    "summary": "维护窗口实体与 Egui 上下文实体的双向索引",
    "description": "维护窗口实体与 Egui 上下文实体的双向索引，支持一个窗口关联多个上下文。"
  },
  "bevy_egui::render::EguiCameraView": {
    "summary": "在主渲染目标视图上保存对应的 Egui 渲染视图实体",
    "description": "在主渲染目标视图上保存对应的 Egui 渲染视图实体，使相机绘制流程找到该界面。"
  },
  "bevy_egui::render::EguiPipeline": {
    "summary": "描述 Egui 渲染管线的变换与纹理绑定布局",
    "description": "描述 Egui 渲染管线的变换与纹理绑定布局，以及可用时的 bindless 纹理数量。"
  },
  "bevy_egui::render::EguiViewTarget": {
    "summary": "在 Egui 渲染视图上保存对应的主目标视图实体",
    "description": "在 Egui 渲染视图上保存对应的主目标视图实体，是 EguiCameraView 映射的反向关联。"
  },
  "bevy_egui::render::systems::EguiRenderData": {
    "summary": "缓存 EguiPipeline 各特化实例的渲染管线身份",
    "description": "缓存 EguiPipeline 各特化实例的渲染管线身份，供绘制阶段选用已准备的管线。"
  },
  "bevy_egui::render::systems::EguiTransforms": {
    "summary": "保存 Egui 变换的动态统一缓冲、主世界实体到缓冲偏移的映射及对应绑定组",
    "description": "保存 Egui 变换的动态统一缓冲、主世界实体到缓冲偏移的映射及对应绑定组。"
  },
  "bevy_egui::render::systems::ExtractedEguiManagedTextures": {
    "summary": "在渲染世界保存从 EguiManagedTextures 提取的纹理句柄表",
    "description": "在渲染世界保存从 EguiManagedTextures 提取的纹理句柄表，供渲染绑定查找。"
  },
  "bevy_egui::render::systems::ExtractedEguiManagedTextures::Source": {
    "summary": "声明 Egui 纹理资源提取所使用的源类型",
    "description": "声明 Egui 纹理资源提取所使用的源类型，实际别名为主世界的 EguiManagedTextures。它是提取接口声明而非另一份纹理组件。"
  },
  "bevy_egui::render::systems::ExtractedEguiTextures": {
    "summary": "聚合提取后的 Egui 管理纹理和用户纹理资源",
    "description": "聚合提取后的 Egui 管理纹理和用户纹理资源，为绘制批次解析两种纹理编号。"
  },
  "bevy_egui::UpdateUiSizeAndScaleQuery": {
    "summary": "查询 Egui 尺寸和缩放更新所需的数据。",
    "description": "查询 UI 尺寸与缩放更新所需的 Egui 上下文、输入、设置、平台输出和相机数据。"
  },
  "bevy_enhanced_input::action::ActionSettings": {
    "summary": "配置输入动作的值累积、首次激活重置及输入吞取消费策略",
    "description": "配置输入动作的值累积、首次激活重置及输入吞取消费策略，影响动作评估和上下文切换行为。"
  },
  "bevy_enhanced_input::action::ActionTime": {
    "summary": "累计动作处于 Ongoing 或 Fired 状态的时间",
    "description": "累计动作处于 Ongoing 或 Fired 状态的时间，以及单独处于 Fired 状态的时间，供持续条件和动作事件使用。"
  },
  "bevy_enhanced_input::action::events::ActionEvents": {
    "summary": "保存动作状态转换产生的事件标记",
    "description": "保存动作状态转换产生的事件标记，包括开始、触发、取消和完成，供后续类型化事件派发。"
  },
  "bevy_enhanced_input::action::fns::ActionFns": {
    "summary": "保存动作类型对应的函数指针",
    "description": "保存动作类型对应的函数指针，用于把类型擦除的动作值写回组件并派发强类型动作事件。"
  },
  "bevy_enhanced_input::action::mock::ActionMock": {
    "summary": "保存模拟动作的触发状态、值、模拟时段和启用状态",
    "description": "保存模拟动作的触发状态、值、模拟时段和启用状态，让评估流程使用指定模拟输入。"
  },
  "bevy_enhanced_input::action::TriggerState": {
    "summary": "记录条件或动作的触发状态：未触发、进行中和已满足条件",
    "description": "记录条件或动作的触发状态：未触发、进行中和已满足条件。动作事件根据状态变化派生。"
  },
  "bevy_enhanced_input::action::value::ActionValue": {
    "summary": "以布尔、一维、二维或三维轴的形式保存类型擦除的动作值",
    "description": "以布尔、一维、二维或三维轴的形式保存类型擦除的动作值，供绑定评估、修饰器和强类型回写共享。"
  },
  "bevy_enhanced_input::binding::Binding": {
    "summary": "描述动作输入源",
    "description": "描述动作输入源，包括键盘、鼠标、滚轮、手柄及自定义输入等，并保留修饰键等匹配条件。"
  },
  "bevy_enhanced_input::binding::FirstActivation": {
    "summary": "记录绑定是否已出现过有效激活",
    "description": "记录绑定是否已出现过有效激活，用于 require_reset 策略，防止新上下文立即响应仍被按住的输入。"
  },
  "bevy_enhanced_input::binding::relationship::Bindings": {
    "summary": "保存属于当前动作实体的输入绑定实体集合",
    "description": "保存属于当前动作实体的输入绑定实体集合，由 BindingOf 关系自动维护。"
  },
  "bevy_enhanced_input::condition::fns::ConditionFns": {
    "summary": "保存动态获取条件组件的函数接口",
    "description": "保存动态获取条件组件的函数接口，使评估器在不知道具体条件类型时仍能调用 InputCondition。"
  },
  "bevy_enhanced_input::context::ExternallyMocked": {
    "summary": "标记由外部手动模拟的动作",
    "description": "标记由外部手动模拟的动作，使常规输入评估跳过该动作，保留外部指定的数据。"
  },
  "bevy_enhanced_input::context::input_reader::custom::CustomInputs": {
    "summary": "保存自定义输入编号到动作值的映射",
    "description": "保存自定义输入编号到动作值的映射，供 Binding::Custom 读取。未提供的输入返回布尔 false。"
  },
  "bevy_enhanced_input::context::input_reader::InputReader": {
    "summary": "聚合键盘、鼠标、手柄和自定义输入",
    "description": "聚合键盘、鼠标、手柄和自定义输入，按动作绑定读取并在输入插件自身的状态中记录消费，不清除 Bevy 原生输入资源。"
  },
  "bevy_enhanced_input::context::instance::ContextInstances": {
    "summary": "保存某一 Schedule 的上下文实例及其优先顺序",
    "description": "保存某一 Schedule 的上下文实例及其优先顺序，供类型擦除的输入评估、回写和事件派发遍历。"
  },
  "bevy_enhanced_input::context::time::ContextTime": {
    "summary": "提供动作条件和修饰器使用的当前调度时钟与真实时钟",
    "description": "提供动作条件和修饰器使用的当前调度时钟与真实时钟，允许选择是否受时间缩放影响。"
  },
  "bevy_enhanced_input::modifier::fns::ModifierFns": {
    "summary": "保存动态获取修饰器组件的函数接口",
    "description": "保存动态获取修饰器组件的函数接口，使评估器按 InputModifier trait 处理未知具体类型。"
  },
  "bevy_gilrs::Gilrs": {
    "summary": "持有 gilrs 手柄后端实例",
    "description": "持有 gilrs 手柄后端实例，用于轮询手柄事件以及控制振动输出。"
  },
  "bevy_gilrs::GilrsGamepads": {
    "summary": "维护已连接 gilrs 手柄编号与 Bevy 手柄实体的双向映射",
    "description": "维护已连接 gilrs 手柄编号与 Bevy 手柄实体的双向映射。"
  },
  "bevy_gilrs::rumble::RunningRumbleEffects": {
    "summary": "按手柄保存正在运行的振动效果",
    "description": "按手柄保存正在运行的振动效果，多个效果的强度在设备上以饱和加法合成。"
  },
  "bevy_input::button_input::ButtonInput": {
    "summary": "保存指定按钮类型当前按下、本帧刚按下和刚释放的集合",
    "description": "保存指定按钮类型当前按下、本帧刚按下和刚释放的集合，支持持续输入与单帧边沿查询。"
  },
  "bevy_input::gamepad::Gamepad": {
    "summary": "保存一个手柄的数字按钮状态、模拟轴值及厂商产品信息",
    "description": "保存一个手柄的数字按钮状态、模拟轴值及厂商产品信息，作为游戏逻辑读取的设备状态。"
  },
  "bevy_input::gamepad::GamepadSettings": {
    "summary": "保存手柄按钮、轴及按钮轴的默认阈值与逐输入覆盖设置",
    "description": "保存手柄按钮、轴及按钮轴的默认阈值与逐输入覆盖设置，影响原始值转换为输入状态。"
  },
  "bevy_input::mouse::AccumulatedMouseScroll": {
    "summary": "汇总本帧滚轮事件的位移与单位",
    "description": "汇总本帧滚轮事件的位移与单位，在每帧重新归零后累计，供输入动作读取。"
  },
  "bevy_input::touch::Touches": {
    "summary": "按触摸编号保存当前按住、刚开始、刚结束和刚取消的触点",
    "description": "按触摸编号保存当前按住、刚开始、刚结束和刚取消的触点，供系统查询触屏状态。"
  },
  "bevy_input_focus::InputFocus": {
    "summary": "保存当前输入焦点实体、待派发的焦点变化及原焦点",
    "description": "保存当前输入焦点实体、待派发的焦点变化及原焦点，驱动焦点获得和失去事件。"
  },
  "bevy_input_focus::tab_navigation::TabGroup": {
    "summary": "把实体子树标记为可参与 Tab 导航的组",
    "description": "把实体子树标记为可参与 Tab 导航的组，保存组顺序及是否将导航限制在组内的模态策略。"
  },
  "bevy_input_focus::tab_navigation::TabIndex": {
    "summary": "声明实体参与 Tab 导航及其排序值",
    "description": "声明实体参与 Tab 导航及其排序值，需要祖先 TabGroup 才生效。"
  },
  "bevy_input_focus::tab_navigation::TabNavigation": {
    "summary": "聚合焦点和层级查询",
    "description": "聚合焦点和层级查询，查找 Tab 导航的前后目标并应用组顺序及模态范围。"
  },
  "bevy_kira_audio::audio_output::AudioOutput": {
    "summary": "持有 Kira 音频管理器及实例、通道、轨道状态",
    "description": "持有 Kira 音频管理器及实例、通道、轨道状态，执行声音播放和设备输出；它是主线程访问的非 Send 资源。"
  },
  "bevy_kira_audio::channel::dynamic::DynamicAudioChannels": {
    "summary": "按运行时字符串维护动态音频通道",
    "description": "按运行时字符串维护动态音频通道，适用于编译时无法确定通道数量的播放与控制。"
  },
  "bevy_kira_audio::channel::typed::AudioChannel": {
    "summary": "保存特定通道类型的音频命令队列及实例播放状态",
    "description": "保存特定通道类型的音频命令队列及实例播放状态，供输出系统执行播放、暂停及参数控制。"
  },
  "bevy_picking::backend::ray::RayMap": {
    "summary": "按指针和相机组合保存拾取射线",
    "description": "按指针和相机组合保存拾取射线，每帧在后端运行前重建，统一处理视口和 DPI 坐标。"
  },
  "bevy_picking::hover::DirectlyHovered": {
    "summary": "标记实体是否被指针直接悬停",
    "description": "标记实体是否被指针直接悬停，使普通组件变化检测可观察悬停变化；不包含后代的悬停。"
  },
  "bevy_picking::hover::PickingInteraction": {
    "summary": "汇总所有指针对实体的交互状态",
    "description": "汇总所有指针对实体的交互状态，按按下优先于悬停的顺序选择当前状态。"
  },
  "bevy_picking::hover::PointerCaptureMap": {
    "summary": "保存指针捕获目标",
    "description": "保存指针捕获目标，用单个实体覆盖普通悬停命中，使拖动离开边界后仍持续交互；释放或取消时解除。"
  },
  "bevy_picking::Pickable": {
    "summary": "配置实体是否可被拾取及是否阻挡深度更低的命中目标",
    "description": "配置实体是否可被拾取及是否阻挡深度更低的命中目标，覆盖拾取后端的默认行为。"
  },
  "bevy_picking::pointer::PointerId": {
    "summary": "以鼠标、触摸编号或自定义 UUID 提供稳定指针身份",
    "description": "以鼠标、触摸编号或自定义 UUID 提供稳定指针身份，不依赖可被销毁重建的指针实体。"
  },
  "bevy_picking::pointer::PointerInteraction": {
    "summary": "保存当前指针命中的实体及 HitData",
    "description": "保存当前指针命中的实体及 HitData，并按由近到远的顺序排列。"
  },
  "bevy_picking::pointer::PointerLocation": {
    "summary": "保存指针当前目标及该目标上的位置",
    "description": "保存指针当前目标及该目标上的位置；没有有效位置时为 None。"
  },
  "bevy_picking::pointer::PointerPressState": {
    "summary": "记录指针主键、次键及中键的按下状态",
    "description": "记录指针主键、次键及中键的按下状态，由 PointerInput 更新。"
  },
  "bevy_scene::spawn::WaitingScenes": {
    "summary": "保存等待场景资产加载的实体与场景列表生成请求",
    "description": "保存等待场景资产加载的实体与场景列表生成请求，资产就绪后继续实例化。"
  },
  "bevy_sprite::picking_backend::SpritePickingCamera": {
    "summary": "在精灵拾取启用标记限制时",
    "description": "在精灵拾取启用标记限制时，标识可供该后端使用的相机。"
  },
  "bevy_sprite::picking_backend::SpritePickingSettings": {
    "summary": "配置精灵拾取是否要求相机标记",
    "description": "配置精灵拾取是否要求相机标记，以及按透明像素阈值还是包围盒判定命中。"
  },
  "bevy_sprite::sprite::Anchor": {
    "summary": "保存二维可渲染实体相对自身尺寸的归一化锚点偏移",
    "description": "保存二维可渲染实体相对自身尺寸的归一化锚点偏移，决定图像或文字相对 Transform 的位置。"
  },
  "bevy_sprite::sprite::Sprite": {
    "summary": "描述二维精灵的图像、图集、颜色、翻转、尺寸和裁剪区域",
    "description": "描述二维精灵的图像、图集、颜色、翻转、尺寸和裁剪区域，供提取、绘制及拾取使用。"
  },
  "bevy_sprite::text2d::Text2d": {
    "summary": "保存二维世界文字块的根文本内容",
    "description": "保存二维世界文字块的根文本内容，与 TextSpan 后代共同组成用于布局和渲染的文字块。"
  },
  "bevy_sprite::text2d::Text2dReader": {
    "summary": "提供二维文字的 TextReader 查询别名",
    "description": "提供二维文字的 TextReader 查询别名，遍历 Text2d 及其 TextSpan 后代的文本和样式。"
  },
  "bevy_sprite::text2d::Text2dShadow": {
    "summary": "为二维文字保存阴影的偏移与颜色",
    "description": "为二维文字保存阴影的偏移与颜色，在原文字后方绘制阴影。"
  },
  "bevy_state::state_scoped::DespawnWhen": {
    "summary": "保存状态转换谓词",
    "description": "保存状态转换谓词，匹配到指定状态转换消息时销毁标记实体。"
  },
  "bevy_state::state_scoped::DisableOnEnter": {
    "summary": "指定进入某一状态时禁用当前实体的生命周期规则",
    "description": "指定进入某一状态时禁用当前实体的生命周期规则。"
  },
  "bevy_state::state_scoped::DisableOnExit": {
    "summary": "指定离开某一状态时禁用当前实体的生命周期规则",
    "description": "指定离开某一状态时禁用当前实体的生命周期规则。"
  },
  "bevy_state::state_scoped::DisableWhen": {
    "summary": "保存状态转换谓词",
    "description": "保存状态转换谓词，匹配到状态转换消息时禁用当前实体。"
  },
  "bevy_state::state_scoped::EnableOnEnter": {
    "summary": "指定进入某一状态时重新启用当前实体的生命周期规则",
    "description": "指定进入某一状态时重新启用当前实体的生命周期规则。"
  },
  "bevy_state::state_scoped::EnableOnExit": {
    "summary": "指定离开某一状态时重新启用当前实体的生命周期规则",
    "description": "指定离开某一状态时重新启用当前实体的生命周期规则。"
  },
  "bevy_state::state_scoped::EnableWhen": {
    "summary": "保存状态转换谓词",
    "description": "保存状态转换谓词，匹配到状态转换消息时重新启用当前实体。"
  },
  "bevy_state::state::resources::NextState": {
    "summary": "保存待处理的状态切换请求",
    "description": "保存待处理的状态切换请求，可表示不切换、强制切换或仅目标不同时切换。真正的 State 更新在状态转换调度执行。"
  },
  "bevy_state::state::resources::PreviousState": {
    "summary": "保存最近一次转换前的状态值",
    "description": "保存最近一次转换前的状态值，供退出、进入或后续逻辑查询先前状态。"
  },
  "bevy_state::state::resources::State": {
    "summary": "保存某个状态类型当前生效的值",
    "description": "保存某个状态类型当前生效的值。切换请求通过 NextState 提交，由状态转换流程应用。"
  },
  "bevy_text::bounds::TextBounds": {
    "summary": "保存文字逻辑像素宽高上限",
    "description": "保存文字逻辑像素宽高上限，用于换行及边界外字符裁切；它主要约束排版，不能保证严格几何裁剪。"
  },
  "bevy_text::cursor::TextCursorStyle": {
    "summary": "配置可编辑文字的光标、选中背景及选中文字颜色等外观",
    "description": "配置可编辑文字的光标、选中背景及选中文字颜色等外观。"
  },
  "bevy_text::editing::EditableText": {
    "summary": "持有 Parley 编辑器、文本、光标及待应用编辑操作",
    "description": "持有 Parley 编辑器、文本、光标及待应用编辑操作，供文字输入、选择和排版系统协作。"
  },
  "bevy_text::editing::EditableTextFilter": {
    "summary": "保存逐字符过滤规则",
    "description": "保存逐字符过滤规则，插入或粘贴包含任意不合格字符时拒绝该次编辑，不追溯已有文本。"
  },
  "bevy_text::editing::EditableTextGeneration": {
    "summary": "保存 Parley 排版代数",
    "description": "保存 Parley 排版代数，用于判断可编辑文字的 TextLayoutInfo 是否过期并需要重新生成。"
  },
  "bevy_text::editing::TextReadWriteMode": {
    "summary": "控制文字输入的编辑模式",
    "description": "控制文字输入的编辑模式，可正常编辑、只读但允许选择复制，或完全静态显示。"
  },
  "bevy_text::font_atlas_set::FontAtlasSet": {
    "summary": "保存字体光栅化结果所在的 FontAtlas 集合",
    "description": "保存字体光栅化结果所在的 FontAtlas 集合，供字形纹理查找及渲染使用。"
  },
  "bevy_text::inline_box::InlineBox": {
    "summary": "描述与文字同行排版的盒子尺寸和流内、流外行为",
    "description": "描述与文字同行排版的盒子尺寸和流内、流外行为，它在文字树中作为叶节点参与布局。"
  },
  "bevy_text::parley_context::FontCx": {
    "summary": "维护字体数据库、家族解析与字体缓存",
    "description": "维护字体数据库、家族解析与字体缓存，并保存通用字体家族的恢复映射，供排版时选字形使用。"
  },
  "bevy_text::parley_context::LayoutCx": {
    "summary": "持有 Parley 文字布局上下文",
    "description": "持有 Parley 文字布局上下文，复用排版过程中需要的工作状态。"
  },
  "bevy_text::parley_context::ScaleCx": {
    "summary": "持有字形缩放上下文",
    "description": "持有字形缩放上下文，复用字体缩放和光栅化所需的状态。"
  },
  "bevy_text::pipeline::TextLayoutInfo": {
    "summary": "保存文字块完成排版后的缩放、字形位置、文字运行几何及尺寸",
    "description": "保存文字块完成排版后的缩放、字形位置、文字运行几何及尺寸，作为渲染提取输入。"
  },
  "bevy_text::pipeline::TextPipeline": {
    "summary": "执行文字块布局与渲染数据生成",
    "description": "执行文字块布局与渲染数据生成，复用文本段和拼接字符串缓冲以减少逐帧分配。"
  },
  "bevy_text::text::ComputedTextBlock": {
    "summary": "缓存文字块的 Parley 布局、文本实体树和重绘标记",
    "description": "缓存文字块的 Parley 布局、文本实体树和重绘标记，由二维文字和 UI 文字系统维护。"
  },
  "bevy_text::text::EmSize": {
    "summary": "保存当前 UI 节点用于解析 Em 单位的实际字体大小",
    "description": "保存当前 UI 节点用于解析 Em 单位的实际字体大小，通常由 TextFont、RemSize 及渲染目标比例计算。"
  },
  "bevy_text::text::FontHinting": {
    "summary": "选择字形光栅化时是否启用字体 hinting",
    "description": "选择字形光栅化时是否启用字体 hinting，以改善特定字号和分辨率下的轮廓清晰度。"
  },
  "bevy_text::text::LetterSpacing": {
    "summary": "配置相邻文字之间的额外间距",
    "description": "配置相邻文字之间的额外间距，使用逻辑像素或根字号倍数表示。"
  },
  "bevy_text::text::LineHeight": {
    "summary": "配置每行文字的高度",
    "description": "配置每行文字的高度，使用像素值或当前字号的倍数表示。"
  },
  "bevy_text::text::RemSize": {
    "summary": "保存全局根字号",
    "description": "保存全局根字号，作为字体、字距和 UI 布局中 Rem 单位的统一参照。"
  },
  "bevy_text::text::Strikethrough": {
    "summary": "标记文字实体需要绘制删除线",
    "description": "标记文字实体需要绘制删除线，供排版和装饰渲染收集。"
  },
  "bevy_text::text::StrikethroughColor": {
    "summary": "覆盖文字删除线颜色",
    "description": "覆盖文字删除线颜色；未提供时使用对应文字颜色。"
  },
  "bevy_text::text::TextBackgroundColor": {
    "summary": "保存当前文字段的背景色",
    "description": "保存当前文字段的背景色，供文字装饰几何生成及渲染。"
  },
  "bevy_text::text::TextColor": {
    "summary": "保存当前文字段的前景色",
    "description": "保存当前文字段的前景色，供字形绘制使用。"
  },
  "bevy_text::text::TextFont": {
    "summary": "保存文字段的字体来源、字号及抗锯齿方式等字体样式",
    "description": "保存文字段的字体来源、字号及抗锯齿方式等字体样式，参与文字布局和字形缓存选择。"
  },
  "bevy_text::text::TextLayout": {
    "summary": "保存文字块的内部对齐与换行策略",
    "description": "保存文字块的内部对齐与换行策略，将各文本段汇总为 ComputedTextBlock 后生成渲染布局。"
  },
  "bevy_text::text::TextSpan": {
    "summary": "保存附加到 Text 或 Text2d 根文字块的子文本段内容",
    "description": "保存附加到 Text 或 Text2d 根文字块的子文本段内容。各段拥有独立字体和颜色，由根布局统一排列。"
  },
  "bevy_text::text::Underline": {
    "summary": "标记文字实体需要绘制下划线",
    "description": "标记文字实体需要绘制下划线，供排版和装饰渲染收集。"
  },
  "bevy_text::text::UnderlineColor": {
    "summary": "覆盖文字下划线颜色",
    "description": "覆盖文字下划线颜色；未提供时使用对应文字颜色。"
  },
  "bevy_time::delayed_commands::DelayedCommandQueue": {
    "summary": "保存到达指定启动后时间才提交的命令队列",
    "description": "保存到达指定启动后时间才提交的命令队列。TimePlugin 的检查系统在默认时钟达到 submit_at 后应用该队列。"
  },
  "bevy_time::time::Time": {
    "summary": "保存时钟上下文、帧间隔及累计时间",
    "description": "保存时钟上下文、帧间隔及累计时间。Real、Virtual 和 Fixed 分别提供真实、可缩放虚拟及固定步时间，默认 Time 按当前调度切换。"
  },
  "bevy_time::TimeReceiver": {
    "summary": "接收渲染世界发送的当前时刻",
    "description": "接收渲染世界发送的当前时刻，用于主世界帧时间更新。"
  },
  "bevy_time::TimeSender": {
    "summary": "从渲染世界向主世界发送帧时刻",
    "description": "从渲染世界向主世界发送帧时刻，使时间更新与渲染节奏协调。"
  },
  "bevy_time::TimeUpdateStrategy": {
    "summary": "配置时间更新来源",
    "description": "配置时间更新来源，可使用渲染侧或系统时钟、手动时刻、手动时间增量及固定步策略。"
  },
  "bevy_transform::components::global_transform::GlobalTransform": {
    "summary": "保存实体合并祖先变换后的世界空间仿射变换",
    "description": "保存实体合并祖先变换后的世界空间仿射变换，由变换传播系统更新；与局部 Transform 区分。"
  },
  "bevy_transform::components::transform::Transform": {
    "summary": "保存实体相对父实体的平移、旋转和缩放",
    "description": "保存实体相对父实体的平移、旋转和缩放。无父实体时表示世界变换，GlobalTransform 保存传播后的结果。"
  },
  "bevy_transform::components::transform::TransformTreeChanged": {
    "summary": "以变化检测标记存在变换变化的层级分支",
    "description": "以变化检测标记存在变换变化的层级分支，使静态场景传播可以跳过未变化的子树。"
  },
  "bevy_transform::helper::TransformHelper": {
    "summary": "沿父子关系读取最新局部 Transform",
    "description": "沿父子关系读取最新局部 Transform，按需计算包含尚未传播变动的 GlobalTransform。"
  },
  "bevy_transform::systems::parallel::NodeQuery": {
    "summary": "为并行变换传播声明重复使用的非根节点查询",
    "description": "为并行变换传播声明重复使用的非根节点查询，访问父关系、局部与世界变换以及可选子节点。"
  },
  "bevy_transform::systems::StaticTransformOptimizations": {
    "summary": "控制变换传播是否追踪并跳过静态子树",
    "description": "控制变换传播是否追踪并跳过静态子树，静态场景可节省传播工作，频繁变化场景可关闭该优化。"
  },
  "bevy_transform_interpolation::extrapolation::RotationExtrapolation": {
    "summary": "启用旋转外推",
    "description": "启用旋转外推，利用配置的角速度来源平滑显示固定步之间的旋转。"
  },
  "bevy_transform_interpolation::extrapolation::TranslationExtrapolation": {
    "summary": "启用平移外推",
    "description": "启用平移外推，利用配置的线速度来源平滑显示固定步之间的位置。"
  },
  "bevy_transform_interpolation::interpolation::RotationInterpolation": {
    "summary": "启用旋转插值",
    "description": "启用旋转插值，在固定步之间平滑显示采样旋转。"
  },
  "bevy_transform_interpolation::interpolation::ScaleInterpolation": {
    "summary": "启用缩放插值",
    "description": "启用缩放插值，在固定步之间平滑显示采样缩放。"
  },
  "bevy_transform_interpolation::interpolation::TranslationInterpolation": {
    "summary": "启用平移插值",
    "description": "启用平移插值，在固定步之间平滑显示采样位置。"
  },
  "bevy_transform_interpolation::NonlinearRotationEasing": {
    "summary": "标识当前实体使用非线性旋转平滑",
    "description": "标识当前实体使用非线性旋转平滑，阻止再应用线性旋转平滑。"
  },
  "bevy_transform_interpolation::NonlinearTranslationEasing": {
    "summary": "标识当前实体使用非线性平移平滑",
    "description": "标识当前实体使用非线性平移平滑，阻止再应用线性平移平滑。"
  },
  "bevy_transform_interpolation::NoRotationEasing": {
    "summary": "显式禁止当前实体的旋转插值和外推",
    "description": "显式禁止当前实体的旋转插值和外推。"
  },
  "bevy_transform_interpolation::NoScaleEasing": {
    "summary": "显式禁止当前实体的缩放插值和外推",
    "description": "显式禁止当前实体的缩放插值和外推。"
  },
  "bevy_transform_interpolation::NoTranslationEasing": {
    "summary": "显式禁止当前实体的平移插值和外推",
    "description": "显式禁止当前实体的平移插值和外推。"
  },
  "bevy_transform_interpolation::RotationEasingState": {
    "summary": "保存固定步旋转插值的起点与终点",
    "description": "保存固定步旋转插值的起点与终点，本身不会自动更新，需要插值后端采样和应用。"
  },
  "bevy_transform_interpolation::ScaleEasingState": {
    "summary": "保存固定步缩放插值的起点与终点",
    "description": "保存固定步缩放插值的起点与终点，本身不会自动更新，需要插值后端采样和应用。"
  },
  "bevy_transform_interpolation::TranslationEasingState": {
    "summary": "保存固定步平移插值的起点与终点",
    "description": "保存固定步平移插值的起点与终点，本身不会自动更新，需要插值后端采样和应用。"
  },
  "bevy_ui_widgets::dialog::DialogStack": {
    "summary": "按从底到顶的顺序保存已打开浮动对话框",
    "description": "按从底到顶的顺序保存已打开浮动对话框，最后一项为最前方对话框。"
  },
  "bevy_ui_widgets::menu::MenuFocusState": {
    "summary": "保存菜单弹出层的打开、获得焦点和关闭状态",
    "description": "保存菜单弹出层的打开、获得焦点和关闭状态，菜单只在其内部仍持有焦点时保持打开。"
  },
  "bevy_ui_widgets::menu::MenuPopup": {
    "summary": "定义弹出菜单的布局方向及模态焦点范围",
    "description": "定义弹出菜单的布局方向及模态焦点范围，配合 MenuFocusState 管理菜单打开和关闭。"
  },
  "bevy_ui_widgets::popover::Popover": {
    "summary": "保存弹出层相对父元素的候选位置及窗口边缘留白",
    "description": "保存弹出层相对父元素的候选位置及窗口边缘留白，使其根据可用空间动态定位。"
  },
  "bevy_ui_widgets::tabs::SelectedTab": {
    "summary": "保存标签列表当前选中的直接子标签实体",
    "description": "保存标签列表当前选中的直接子标签实体，失效、禁用或无关实体按未选择处理。"
  },
  "bevy_ui_widgets::tabs::Tab": {
    "summary": "标识可聚焦的标签标题",
    "description": "标识可聚焦的标签标题，通过游走 TabIndex 参与导航，Selected 状态由所属列表的有效选择派生。"
  },
  "bevy_ui_widgets::tabs::TabList": {
    "summary": "定义标签栏的导航轴及自动激活策略",
    "description": "定义标签栏的导航轴及自动激活策略。交互发出选择变更事件，是否自行更新 SelectedTab 由观察者决定。"
  },
  "bevy_ui_widgets::text_input::QueuedSelectAll": {
    "summary": "暂存由指针按下触发焦点的编辑实体",
    "description": "暂存由指针按下触发焦点的编辑实体，等待对应释放时在没有其他选择的前提下执行全选。"
  },
  "bevy_ui_widgets::text_input::SelectAllOnFocus": {
    "summary": "标记获得焦点时应全选的文本输入",
    "description": "标记获得焦点时应全选的文本输入；指针引发的焦点会延后到释放，避免覆盖用户拖动选区。"
  },
  "bevy_ui_widgets::text_input::TextInput": {
    "summary": "标识可编辑文本控件",
    "description": "标识可编辑文本控件，并要求 EditableText 及文本输入的可访问性节点。"
  },
  "bevy_window::cursor::CursorIcon": {
    "summary": "保存窗口光标的系统图标或自定义图像配置",
    "description": "保存窗口光标的系统图标或自定义图像配置，供 Winit 光标更新使用。"
  },
  "bevy_window::raw_handle::RawHandleWrapper": {
    "summary": "持有原始窗口及显示服务器句柄",
    "description": "持有原始窗口及显示服务器句柄，并共享底层窗口所有权，避免渲染线程仍需窗口时提前释放。"
  },
  "bevy_window::window::ClosingWindow": {
    "summary": "标记窗口已收到关闭请求并正在关闭",
    "description": "标记窗口已收到关闭请求并正在关闭，供后续帧清理窗口及渲染资源。"
  },
  "bevy_window::window::CursorOptions": {
    "summary": "保存窗口光标的可见、捕获和命中测试等选项",
    "description": "保存窗口光标的可见、捕获和命中测试等选项，供平台窗口系统同步。"
  },
  "bevy_window::window::OnMonitor": {
    "summary": "保存窗口当前所在显示器的关系目标",
    "description": "保存窗口当前所在显示器的关系目标，窗口创建后由平台集成补充。"
  },
  "bevy_window::window::PrimaryWindow": {
    "summary": "标识唯一的主窗口",
    "description": "标识唯一的主窗口，供默认相机目标、指针输入及窗口策略选择。"
  },
  "bevy_window::window::Window": {
    "summary": "保存窗口的呈现模式、位置、分辨率、标题、全屏及平台行为配置",
    "description": "保存窗口的呈现模式、位置、分辨率、标题、全屏及平台行为配置，平台窗口系统据此创建和同步原生窗口。"
  },
  "bevy_winit::accessibility::WinitActionRequestHandlers": {
    "summary": "把窗口实体映射到 AccessKit 动作请求处理入口",
    "description": "把窗口实体映射到 AccessKit 动作请求处理入口，使可访问性操作进入对应窗口事件流程。"
  },
  "bevy_winit::cursor::custom_cursor::WinitCustomCursorCache": {
    "summary": "缓存已创建的自定义原生光标",
    "description": "缓存已创建的自定义原生光标，避免每次切换时重复执行昂贵的平台创建操作。"
  },
  "bevy_winit::EventLoopProxyWrapper": {
    "summary": "包装 Winit 事件循环代理",
    "description": "包装 Winit 事件循环代理，供 Bevy 外部请求重绘或发送插件约定的用户事件。"
  },
  "bevy_winit::system::CachedCursorOptions": {
    "summary": "缓存上次同步到原生窗口的光标选项",
    "description": "缓存上次同步到原生窗口的光标选项，比较应用侧变更并减少重复平台调用。"
  },
  "bevy_winit::system::CachedWindow": {
    "summary": "缓存上次同步到原生窗口的 Window 状态",
    "description": "缓存上次同步到原生窗口的 Window 状态，识别应用侧修改并更新对应平台属性。"
  },
  "bevy_winit::system::WinitWindowPressedKeys": {
    "summary": "逐窗口保存当前按下的键",
    "description": "逐窗口保存当前按下的键，窗口失去焦点时据此补发释放事件，避免按键卡住。"
  },
  "bevy_winit::winit_monitors::WinitMonitors": {
    "summary": "保存 Winit 显示器句柄与对应 Bevy 实体的映射",
    "description": "保存 Winit 显示器句柄与对应 Bevy 实体的映射，供窗口显示器关系及模式查询。"
  },
  "bevy_world_serialization::components::DynamicWorldRoot": {
    "summary": "持有动态世界资产句柄",
    "description": "持有动态世界资产句柄，要求把该资产实例化为当前实体的子树，生成后通过 WorldInstance 记录实例身份。"
  },
  "bevy_world_serialization::components::WorldAssetRoot": {
    "summary": "持有 WorldAsset 句柄",
    "description": "持有 WorldAsset 句柄，要求把世界资产实例化为当前实体的子树，生成后通过 WorldInstance 记录实例身份。"
  },
  "bevy_world_serialization::world_asset_spawner::WorldInstance": {
    "summary": "保存已生成世界资产的实例身份",
    "description": "保存已生成世界资产的实例身份，可配合 WorldInstanceSpawner 查询或销毁该实例。"
  },
  "bevy_world_serialization::world_asset_spawner::WorldInstanceSpawner": {
    "summary": "管理世界资产的同步及排队生成、销毁和热更新",
    "description": "管理世界资产的同步及排队生成、销毁和热更新，维护资产到实例集合及实例实体映射。"
  },
  "bevy_picking::hover::HoverMap": {
    "summary": "保存各指针当前可交互的悬停目标。",
    "description": "按 PointerId 保存经过遮挡与捕获规则处理的实际悬停实体和命中信息，是拾取事件及交互组件状态的依据；后端报告命中并不必然成为悬停目标。"
  },
  "bevy_picking::events::PointerState": {
    "summary": "保存各指针按钮的按下和拖动状态。",
    "description": "按指针及按钮保存按下、拖动等交互状态，并缓存悬停实体的祖先集合，用于派发指针事件及处理层级进入和离开。"
  },
  "bevy_egui::EguiGlobalSettings": {
    "summary": "配置 Egui 上下文创建和全局输入集成。",
    "description": "保存自动创建主上下文、非窗口上下文焦点更新、输入读取、输入吸收、光标及输入法等插件全局策略。"
  },
  "bevy_input::mouse::AccumulatedMouseMotion": {
    "summary": "累计当前帧鼠标移动位移。",
    "description": "汇总本帧收到的 MouseMotion 事件位移，每帧重置为零后重新累计，供相机和输入动作等系统读取。"
  },
  "bevy_picking::pointer::PointerMap": {
    "summary": "索引稳定指针编号对应的指针实体。",
    "description": "维护 PointerId 到当前指针实体的映射，使拾取事件流程能以稳定编号查找承载位置及交互组件的实体。"
  },
  "bevy_picking::hover::PreviousHoverMap": {
    "summary": "保留上一轮指针悬停目标。",
    "description": "保存上一轮按指针组织的悬停实体和命中信息，与当前 HoverMap 比较以判断进入、离开及其他交互变化。"
  },
  "bevy_enhanced_input::context::input_reader::ActionSources": {
    "summary": "配置动作可使用的输入设备来源。",
    "description": "分别控制键盘、鼠标按钮、鼠标位移、滚轮及手柄按钮和轴对动作是否可见，可在界面交互时屏蔽特定设备输入。"
  },
  "bevy_enhanced_input::context::input_reader::ConsumedInputs": {
    "summary": "逐调度记录动作已消费的输入。",
    "description": "保存各 Schedule 已消费的输入，InputReader 在所有调度中忽略这些输入；某调度再次运行时清除自身旧记录，使固定步多次运行与帧调度消费正确协调。"
  },
  "bevy_enhanced_input::context::input_reader::PendingBindings": {
    "summary": "等待已移除绑定的输入释放。",
    "description": "保存 require_reset 动作移除后仍处于活动状态的绑定及忽略输入集合，直到输入恢复非活动状态才移除，避免新上下文立即响应仍被按住的输入。"
  },
  "bevy_transform_interpolation::LastEasingTick": {
    "summary": "记录最近一次变换平滑的系统刻度。",
    "description": "保存最近执行插值或外推平滑时的 Tick，用于区分正常平滑更新与随后外部修改 Transform 的变化。"
  },
  "demo::item_interaction::components::ResumeCarryEasing": {
    "summary": "记录物品释放后需要恢复的插值通道。",
    "description": "释放后暂缓插值至下一 FixedFirst，只恢复原来未暂停的通道。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "parcel.ResumeCarryEasing"
      ],
      "definition": {
        "path": "src/item_interaction/components.rs",
        "line": 62
      }
    }
  },
  "demo::bounds_recovery::recovery::ResumeInterpolation": {
    "summary": "记录本次恢复临时添加的暂停项。",
    "description": "记录本次恢复临时添加的暂停项。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "character.ResumeInterpolation",
        "parcel.ResumeInterpolation"
      ],
      "definition": {
        "path": "src/bounds_recovery/recovery.rs",
        "line": 26
      }
    }
  },
  "demo::item_interaction::components::HeldBy": {
    "summary": "关联当前物品的持有者。",
    "description": "可选关系组件，仅持有时存在；指向持有者，增删通过 Commands 延迟执行。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "parcel.HeldBy"
      ],
      "definition": {
        "path": "src/item_interaction/components.rs",
        "line": 24
      }
    }
  },
  "demo::item_interaction::components::HeldTarget": {
    "summary": "保存本帧握持姿态的检查目标。",
    "description": "本帧握持检查目标；实际箱体 Transform 由 HeldAttachment.local_pose 与人物姿态派生。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "parcel.HeldTarget"
      ],
      "definition": {
        "path": "src/item_interaction/components.rs",
        "line": 34
      }
    }
  },
  "demo::item_interaction::components::HeldAttachment": {
    "summary": "保存物品挂接姿态与装卸状态。",
    "description": "持握期间真实箱体局部姿态与装卸生命周期唯一数据源；业务根仍独立。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "parcel.HeldAttachment"
      ],
      "definition": {
        "path": "src/item_interaction/components.rs",
        "line": 41
      }
    }
  },
  "demo::item_interaction::components::CarryBaseMass": {
    "summary": "挂接时保存，释放或箱体销毁时恢复原人物质量。",
    "description": "挂接时保存，释放或箱体销毁时恢复原人物质量。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "character.CarryBaseMass"
      ],
      "definition": {
        "path": "src/item_interaction/components.rs",
        "line": 58
      }
    }
  },
  "demo::item_interaction::components::HeldCollider": {
    "summary": "关联代理所对应的真实物品。",
    "description": "普通 Entity 引用用于孤儿代理清理。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "held_proxy.HeldCollider"
      ],
      "definition": {
        "path": "src/item_interaction/components.rs",
        "line": 54
      }
    }
  },
  "demo::character_animation::grounding::CourierFootGrounding": {
    "summary": "保存鞋底高度补偿与骨链引用。",
    "description": "主角视觉根保存鞋底高度补偿状态与骨链引用；节点只在绑定时按 Name 缓存，普通 Entity 引用不提供关系生命周期。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "visual.CourierFootGrounding"
      ],
      "definition": {
        "path": "src/character_animation/grounding.rs",
        "line": 21
      }
    }
  },
  "demo::ui::pointer::PrimaryPress": {
    "summary": "区分菜单主键按压与其他按钮来源。",
    "description": "菜单主键按下的指针身份；主键 PointerPress Observer 插入，Pressed 移除及取消/窗口生命周期清理时删除。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "menu_button.PrimaryPress"
      ],
      "definition": {
        "path": "src/ui/pointer.rs",
        "line": 18
      }
    }
  },
  "demo::character_animation::binding::CourierAnimationPending": {
    "summary": "实例就绪后等待命名动画绑定。",
    "description": "实例就绪后等待命名动画绑定。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "visual.CourierAnimationPending"
      ],
      "definition": {
        "path": "src/character_animation/binding.rs",
        "line": 15
      }
    }
  },
  "demo::character_animation::state::CourierAnimation": {
    "summary": "保存角色动画混合权重、步相位与跳跃阶段。",
    "description": "播放器关联、连续混合权重、统一步相位与跳跃阶段时钟；状态/节点辅助值不是 ECS 组件或 Local。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "animation_player.CourierAnimation"
      ],
      "definition": {
        "path": "src/character_animation/state.rs",
        "line": 137
      }
    }
  },
  "demo::scene_assembly::DisplayNpc": {
    "summary": "标记导入地图中的展示人物。",
    "description": "导入边界识别展示 NPC。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "npc.DisplayNpc"
      ],
      "definition": {
        "path": "src/scene_assembly/mod.rs",
        "line": 45
      }
    }
  },
  "demo::scene_assembly::IslandPending": {
    "summary": "标记等待构建碰撞的海岛实例。",
    "description": "实例就绪，等待 CPU 几何准备。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "island.IslandPending"
      ],
      "definition": {
        "path": "src/scene_assembly/mod.rs",
        "line": 39
      }
    }
  },
  "demo::scene_assembly::IslandReady": {
    "summary": "静态碰撞与布局已准备。",
    "description": "静态碰撞与布局已准备。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "island.IslandReady"
      ],
      "definition": {
        "path": "src/scene_assembly/mod.rs",
        "line": 58
      }
    }
  },
  "demo::scene_assembly::IslandCollider": {
    "summary": "地图静态碰撞标签。",
    "description": "地图静态碰撞标签。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "world.IslandCollider"
      ],
      "definition": {
        "path": "src/scene_assembly/mod.rs",
        "line": 49
      }
    }
  },
  "demo::scene_assembly::loading::LoadingCamera": {
    "summary": "加载期间相机身份，准备后移除。",
    "description": "加载期间相机身份，准备后移除。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "camera.LoadingCamera"
      ],
      "definition": {
        "path": "src/scene_assembly/loading.rs",
        "line": 29
      }
    }
  },
  "demo::first_person::FirstPersonCamera": {
    "summary": "保存跟随目标、眼高与观察角度。",
    "description": "第一人称目标与观察状态；默认水平角和俯仰为 0°，俯仰限制 -85°..85°，眼位在角色脚底上方 1.65 m；实际姿态由 Transform 保存。pending_yaw_delta 使用 reflect(ignore)，留给朝向系统消费完整转角。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "camera.FirstPersonCamera"
      ],
      "definition": {
        "path": "src/first_person/mod.rs",
        "line": 63
      }
    }
  },
  "demo::first_person::MouseLookState": {
    "summary": "保存光标捕获与观察输入初始化状态。",
    "description": "保存捕获、初始化、跳过位移与目标可用状态。F3 在游戏控制和检查器操作之间切换；主菜单、暂停及失焦释放光标，检查器模式停用整个 GameplayContext。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "camera.MouseLookState"
      ],
      "definition": {
        "path": "src/first_person/mod.rs",
        "line": 98
      }
    }
  },
  "demo::first_person::ControlsCamera": {
    "summary": "普通实体引用，指向受控相机。",
    "description": "普通实体引用，指向受控相机。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "controller.ControlsCamera"
      ],
      "definition": {
        "path": "src/first_person/mod.rs",
        "line": 53
      }
    }
  },
  "demo::scene_assembly::ActorsSpawned": {
    "summary": "业务角色已生成，防止重复。",
    "description": "业务角色已生成，防止重复。",
    "reviewedFrom": {
      "file": "ecs-data.json",
      "objectIds": [
        "island.ActorsSpawned"
      ],
      "definition": {
        "path": "src/scene_assembly/mod.rs",
        "line": 41
      }
    }
  }
});
