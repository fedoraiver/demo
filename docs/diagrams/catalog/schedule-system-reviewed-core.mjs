// 完整锁定声明身份的系统职责；项目函数复用已有来源相同的对象说明。
export const CORE_SCHEDULE_SYSTEM_PURPOSES = Object.freeze({
  "bevy_animation::graph::thread_animation_graphs": {
    "summary": "维护动画图的快速求值结构。",
    "description": "消费动画图与片段的新增、修改、加载和移除消息，重新构建受影响图的线程化遍历结构并维护片段到图的反向索引；同一帧已重建的图不重复处理。"
  },
  "bevy_animation::transition::expire_completed_transitions": {
    "summary": "结束已完全淡出的动画过渡。",
    "description": "检查 AnimationTransitions 中各过渡的当前权重，对权重已降至零的条目停止对应动画并移除该过渡，保留仍在淡出的动画。"
  },
  "bevy_animation::trigger_untargeted_animation_events": {
    "summary": "派发动画片段的根目标事件。",
    "description": "遍历正在播放且未暂停的动画，根据当前播放区间收集片段中以根实体为目标的定时事件，并携带采样时间与动画权重排入触发命令；缺少图或片段时不臆造事件。"
  },
  "bevy_app::hierarchy::check_parent_has_component": {
    "summary": "报告仍不满足组件层级要求的父子关系。",
    "description": "读取延后检查父组件的消息，再次核对带指定组件的子实体是否仍有父实体，以及父实体是否仍缺少同种组件；仅对仍成立的违规关系输出包含实体名称、类型和调用来源的警告。"
  },
  "bevy_app::terminal_ctrl_c_handler::TerminalCtrlCHandlerPlugin::exit_on_flag": {
    "summary": "把终端中断请求转换为应用退出消息。",
    "description": "读取终端 Ctrl+C 处理器设置的原子退出标志，标志大于零时按该插件约定的退出码发布 AppExit，由应用正常退出流程处理。"
  },
  "bevy_diagnostic::frame_count::update_frame_count": {
    "summary": "递增应用帧计数。",
    "description": "对 FrameCount 使用回绕加法增加一帧，超过 u32 上限后从零继续，避免计数溢出导致异常。"
  },
  "bevy_egui::begin_pass_system": {
    "summary": "把本轮输入交给 Egui 并开始界面帧。",
    "description": "遍历自动运行的 Egui 上下文，取走本轮 EguiInput 并调用上下文的 begin_pass；标记 run_manually 的上下文由调用者负责开始和结束。"
  },
  "bevy_egui::end_pass_system": {
    "summary": "结束 Egui 界面帧并保存完整输出。",
    "description": "对非手动运行的 Egui 上下文调用 end_pass，把生成的 FullOutput 保存到组件，供随后拆分平台命令、纹理增量与绘制图元。"
  },
  "bevy_egui::free_egui_textures_system": {
    "summary": "回收 Egui 已释放或失效的纹理引用。",
    "description": "消费 Egui 纹理释放增量，从托管纹理表及图像资产集合移除相应托管纹理；同时读取图像移除消息，清除引用该资产的 Egui 用户纹理登记。"
  },
  "bevy_egui::input::absorb_bevy_input_system": {
    "summary": "在 Egui 使用输入时吸收对应 Bevy 输入。",
    "description": "当 Egui 请求键盘或指针输入时，分别清空对应消息及按钮状态，避免其他玩法继续响应已被界面使用的输入；保留此前按下的修饰键。该行为由全局输入吸收选项启用。"
  },
  "bevy_egui::input::process_ime_system": {
    "summary": "同步 Egui 编辑区域的原生输入法状态。",
    "description": "依据 Egui 平台输出决定原生窗口是否允许 IME，并把当前编辑矩形按 Egui 缩放换算为窗口输入法光标区域；上下文禁用 IME 或没有窗口映射时跳过。"
  },
  "bevy_egui::input::read_egui_zoom_factor_system": {
    "summary": "记录 Egui 当前界面缩放因子。",
    "description": "从每个 egui::Context 读取 zoom_factor，仅在数值变化时更新 EguiZoomFactor，为随后指针坐标及界面尺寸换算提供比例。"
  },
  "bevy_egui::input::WindowToEguiContextMap::on_egui_context_added_system": {
    "summary": "登记新 Egui 上下文对应的窗口。",
    "description": "为新上下文建立窗口到上下文及上下文到窗口的双向映射。存在 Winit 事件循环代理时还安装重绘回调，在 Egui 请求立即重绘时唤醒事件循环。"
  },
  "bevy_egui::input::WindowToEguiContextMap::on_egui_context_removed_system": {
    "summary": "移除已销毁 Egui 上下文的窗口索引。",
    "description": "读取 EguiContext 移除记录，从上下文到窗口映射及该窗口的上下文集合中删除旧实体；对应窗口索引缺失时记录警告。"
  },
  "bevy_egui::input::write_egui_input_system": {
    "summary": "把界面输入和文件拖放写入 Egui 输入批次。",
    "description": "按消息中的上下文身份，把 EguiInputEvent 加入对应 EguiInput.events；把拖入、拖离和文件放下消息转换为悬停文件及已放下文件列表，接收上下文失效时记录错误并跳过。"
  },
  "bevy_egui::input::write_egui_wants_input_system": {
    "summary": "汇总所有 Egui 上下文的输入占用。",
    "description": "重置 EguiWantsInput 后遍历各上下文，合并指针悬停、指针使用、键盘输入需求及弹出层打开状态，供其他输入系统判断是否响应。"
  },
  "bevy_egui::input::write_file_dnd_messages_system": {
    "summary": "把文件拖放路由到对应 Egui 上下文。",
    "description": "读取窗口文件拖放消息，优先按非窗口悬停上下文或窗口映射选择接收者；在上下文允许文件拖放时发布带上下文身份的 EguiFileDragAndDropMessage。"
  },
  "bevy_egui::input::write_ime_messages_system": {
    "summary": "向聚焦的 Egui 上下文传递输入法文本。",
    "description": "把窗口或已聚焦非窗口上下文的 IME 预编辑和提交内容转换为 Egui 输入法事件，保留预编辑活动字符范围；上下文未开启输入法或禁用此输入系统时跳过。"
  },
  "bevy_egui::input::write_keyboard_input_messages_system": {
    "summary": "把键盘文本与按键转换为 Egui 输入。",
    "description": "向对应窗口或聚焦非窗口上下文发送可打印文本、逻辑及物理按键事件，并附带修饰键；启用本机剪贴板集成时将命令组合键转换为复制、剪切或粘贴输入。"
  },
  "bevy_egui::input::write_modifiers_keys_state_system": {
    "summary": "更新 Egui 修饰键并清除失焦残留。",
    "description": "根据键盘消息记录 Shift、Control、Alt 与平台主修饰键的按下和释放；收到键盘焦点丢失消息时先清空修饰键，避免切换窗口后按键状态卡住。"
  },
  "bevy_egui::input::write_mouse_wheel_messages_system": {
    "summary": "向悬停 Egui 上下文传递滚轮输入。",
    "description": "把窗口滚轮位移和单位转换为 Egui MouseWheel 事件，附带当前修饰键；通过窗口映射或悬停非窗口上下文路由，并遵守接收上下文的输入开关。"
  },
  "bevy_egui::input::write_non_window_pointer_moved_messages_system": {
    "summary": "刷新非窗口 Egui 界面的指针位置。",
    "description": "存在光标移动消息时，清除该读者批次，并把悬停非窗口上下文已有的局部指针位置发给 Egui；没有悬停目标或目标禁用此输入时不发送。"
  },
  "bevy_egui::input::write_non_window_touch_messages_system": {
    "summary": "向聚焦的非窗口 Egui 界面传递触摸。",
    "description": "读取触摸消息，使用 FocusedNonWindowEguiContext 指定的接收者和该上下文的局部指针位置生成 Egui 触摸输入，同时维护活动触点；没有有效焦点或接收者禁用此输入时跳过。"
  },
  "bevy_egui::input::write_pinch_gesture_messages_system": {
    "summary": "把捏合手势转换为 Egui 缩放。",
    "description": "对捏合增量取指数得到缩放比例，优先发给悬停的非窗口上下文；没有该目标时向所有窗口上下文广播，因为原始捏合消息不携带窗口身份。"
  },
  "bevy_egui::input::write_pointer_moved_and_button_messages_system": {
    "summary": "按原生事件顺序转换 Egui 指针输入。",
    "description": "依次处理 WindowEvent 中的光标移动及鼠标按钮事件，缩放并缓存指针位置，保证按钮使用事件发生时的位置；按钮可重定向到悬停非窗口上下文，并按配置更新该上下文的键盘焦点。"
  },
  "bevy_egui::input::write_window_touch_messages_system": {
    "summary": "把窗口触摸转换为 Egui 指针和触摸事件。",
    "description": "按窗口映射选择上下文，把触点位置除以 Egui 缩放并更新缓存，通过触摸转换逻辑维护活动触点；触摸开始时按配置设置或清除非窗口上下文焦点。"
  },
  "bevy_egui::output::process_output_system": {
    "summary": "拆分 Egui 绘制输出并执行平台命令。",
    "description": "取走 Egui FullOutput，将形状细分为绘制图元并保存纹理增量、平台输出和像素比例；按已启用功能处理剪贴板、URL及光标更新，需要时请求重绘，缺少 pass 输出时记录错误。"
  },
  "bevy_egui::render::extract_egui_camera_view_system": {
    "summary": "为活动相机提取独立 Egui 渲染视图。",
    "description": "从主世界取走 Egui 绘制输出，为有效且未禁用的相机创建左上角原点的正交 Egui 视图，设置目标格式、视口及像素比例，并建立主相机与 Egui 视图的双向关联。停用或带 Disabled 的相机移除 EguiCameraView；没有有效视口时不创建新视图。"
  },
  "bevy_egui::render::systems::prepare_egui_render_target_data_system": {
    "summary": "准备 Egui 顶点索引和裁剪绘制命令。",
    "description": "按 Egui 渲染视图整理绘制图元，计算物理裁剪矩形并排除视口外内容，把网格顶点和索引装入绘制缓冲；识别自定义绘制回调并保存延后准备项，解析目标格式与纹理引用。"
  },
  "bevy_egui::render::systems::prepare_egui_transforms_system": {
    "summary": "上传 Egui 屏幕变换缓冲。",
    "description": "按相机目标尺寸和 Egui 像素比例建立屏幕变换，记录各主实体的动态缓冲偏移并上传 GPU；底层缓冲改变时重建变换绑定组。"
  },
  "bevy_egui::render::systems::queue_bind_groups_system": {
    "summary": "建立 Egui 纹理与采样器绑定。",
    "description": "为已准备的 Egui 托管及用户图像建立纹理绑定组；支持 bindless 时按设备容量分组纹理与采样器数组，并给每个纹理记录组内偏移，否则逐纹理建立绑定。"
  },
  "bevy_egui::render::systems::queue_pipelines_system": {
    "summary": "按目标格式选择 Egui 渲染管线。",
    "description": "遍历 Egui 视图所指向的相机，根据 HDR 或普通目标格式特化 EguiPipeline，把主实体到缓存管线身份的映射写入 EguiPipelines；缺少相机数据的视图跳过。"
  },
  "bevy_egui::run_egui_context_pass_loop_system": {
    "summary": "运行每个自动 Egui 上下文的专属调度。",
    "description": "收集非手动 Egui 上下文及输入，在上下文的 run_ui 回调内执行其 EguiSchedule 并保存完整输出；每个上下文必须使用唯一调度，重复调度会报错，调度运行错误向外返回。"
  },
  "bevy_egui::setup_primary_egui_context_system": {
    "summary": "为首个合适相机建立主 Egui 上下文。",
    "description": "检查新相机及本系统已创建上下文的标志，尚无主上下文时向首个相机插入 EguiContext 与 PrimaryEguiContext；已有上下文或已处理过时不再创建。自动创建行为由插件配置控制。"
  },
  "bevy_egui::update_egui_textures_system": {
    "summary": "应用 Egui 托管纹理的图像增量。",
    "description": "读取纹理 set 增量，把完整图像转换为 Bevy Image 并登记句柄，或按矩形逐像素写入已有纹理；用户纹理不在此处理，局部更新缺少目标或写入失败时记录日志。"
  },
  "bevy_egui::update_ui_screen_rect": {
    "summary": "把相机视口换算为 Egui 逻辑屏幕区域。",
    "description": "读取相机物理视口，将其除以 Egui 像素点比例得到逻辑矩形并写入 RawInput.screen_rect；视口缺失或尺寸小于一个逻辑单位时跳过。"
  },
  "bevy_gilrs::gilrs_system::gilrs_event_startup_system": {
    "summary": "登记启动时已经连接的手柄。",
    "description": "枚举 gilrs 已连接设备，为每个设备预留 Bevy 实体并建立双向编号映射，发布携带名称、厂商和产品信息的连接消息，交由后续输入系统添加设备组件。"
  },
  "bevy_gilrs::gilrs_system::gilrs_event_system": {
    "summary": "把 gilrs 原始手柄事件转换为 Bevy 消息。",
    "description": "持续轮询并更新 gilrs，维护新连接手柄的实体映射，将连接、断开、按钮数值与轴变化写入对应原始消息及汇总事件；无法映射的轴不转发。"
  },
  "bevy_gilrs::rumble::play_gilrs_rumble": {
    "summary": "执行手柄振动请求并清除过期效果。",
    "description": "依据真实经过时间移除到期振动，再把新增或停止请求交给 gilrs 力反馈后端；不支持反馈、设备不存在或后端失败时记录相应诊断。"
  },
  "bevy_input_focus::gained_and_lost::process_recorded_focus_changes": {
    "summary": "按记录顺序派发焦点获得和失去事件。",
    "description": "逐项消费 InputFocus 的焦点变化记录，只有实体确实变化时才向旧目标触发 FocusLost、向新目标触发 FocusGained；同步内部原焦点快照但不再次修改对外当前焦点。"
  },
  "bevy_input_focus::set_initial_focus": {
    "summary": "在没有焦点目标时使用主窗口。",
    "description": "当前 InputFocus 为空时，把可用的主窗口设为初始导航焦点；已有焦点时保持原目标。"
  },
  "bevy_input::gamepad::gamepad_connection_system": {
    "summary": "按连接消息添加或移除手柄组件。",
    "description": "连接时给已登记的设备实体写入名称及 Gamepad 状态，断开时移除 Gamepad；保留实体和可能存在的设备设置，以便重新连接时复用。"
  },
  "bevy_input::gamepad::gamepad_event_processing_system": {
    "summary": "过滤原始手柄数值并更新设备状态。",
    "description": "读取 RawGamepadEvent，按各设备阈值和轴设置过滤、缩放输入，更新模拟轴及数字按钮状态，并发布处理后的轴、按钮和汇总事件；每轮先清理数字按钮的单帧变化。"
  },
  "bevy_input::keyboard::keyboard_input_system": {
    "summary": "把键盘事件汇总为物理和逻辑按键状态。",
    "description": "清理上一轮的单帧键盘边沿，再根据按下或释放消息更新 KeyCode 与逻辑 Key 两份 ButtonInput；收到键盘焦点丢失时释放缓存的物理按键，避免窗口切换后残留按下状态。"
  },
  "bevy_input::mouse::accumulate_mouse_motion_system": {
    "summary": "累计本帧鼠标位移。",
    "description": "从零开始求和本轮所有 MouseMotion.delta，写入 AccumulatedMouseMotion；没有消息时结果为零，不沿用上一帧位移。"
  },
  "bevy_input::mouse::accumulate_mouse_scroll_system": {
    "summary": "累计本帧滚轮位移和单位。",
    "description": "从零开始合计本轮 MouseWheel 的横纵位移，记录最后采用的滚动单位并更新 AccumulatedMouseScroll；没有消息时写入零位移。"
  },
  "bevy_input::mouse::mouse_button_input_system": {
    "summary": "把鼠标按钮事件汇总为按钮状态。",
    "description": "清理上一轮的单帧按钮边沿，再按 MouseButtonInput 的按下和释放更新 ButtonInput<MouseButton>，供持续状态和刚按下查询使用。"
  },
  "bevy_input::touch::touch_screen_input_system": {
    "summary": "维护持续触点与本帧触摸边沿。",
    "description": "清理刚开始、刚结束和刚取消集合，读取 TouchInput 更新触点位置、压力与阶段；保留没有新消息但仍按住的触点，防止静止触摸被误判释放。"
  },
  "bevy_kira_audio::audio_output::cleanup_stopped_instances": {
    "summary": "释放已停止播放实例的内部引用。",
    "description": "从 AudioOutput 的各通道实例表中移除缺失或已停止的句柄，并清理不再需要保留的实例子轨道，使 Kira 音频图能够释放对应轨道。"
  },
  "bevy_kira_audio::audio_output::play_audio_channel": {
    "summary": "执行指定类型音频通道的命令队列。",
    "description": "声音资产集合可用时，把该类型通道的当前命令交给 AudioOutput，执行播放、停止、暂停及音量等控制；音频管理器未就绪时不执行，尚未加载的播放请求保留重试，停止命令清除此前待重试播放。"
  },
  "bevy_kira_audio::audio_output::play_dynamic_channels": {
    "summary": "执行按名称创建的动态音频通道命令。",
    "description": "声音资产集合及输出管理器可用时，逐个处理动态通道当前排队的播放和控制命令，并更新音频实例；等待声音加载的命令重新入队，留待后续运行重试。"
  },
  "bevy_kira_audio::audio_output::update_instance_states": {
    "summary": "把实际播放状态回写到类型通道。",
    "description": "查找该通道由 AudioOutput 跟踪的实例，重建通道的实例状态映射；资产中已不存在的实例按 Stopped 记录，供调用者查询播放进度状态。"
  },
  "bevy_picking::hover::update_is_directly_hovered": {
    "summary": "更新鼠标直接悬停的实体标记。",
    "description": "依据 HoverMap 中鼠标直接命中的实体，更新已声明兴趣的 DirectlyHovered；鼠标没有悬停目标时清除先前为真的标记，不把后代悬停算为直接命中。"
  },
  "bevy_picking::hover::update_is_hovered": {
    "summary": "把鼠标悬停传播到实体祖先。",
    "description": "从鼠标 HoverMap 的命中实体向上收集祖先，再更新所有带 Hovered 的实体：自身或任一后代命中即为悬停，离开该集合时清除标记。"
  },
  "bevy_picking::input::deactivate_touch_pointers": {
    "summary": "销毁已经结束或取消的触摸指针。",
    "description": "读取结束和取消的 TouchInput，收集触点编号匹配的指针实体并去重，通过 Commands 销毁它们，避免已结束触摸继续参与拾取。"
  },
  "bevy_picking::input::mouse_pick_events": {
    "summary": "把窗口鼠标事件转换为拾取指针动作。",
    "description": "保持 WindowEvent 的原始顺序，将光标移动、主次中按钮和滚轮转换为 PointerInput；缓存最近光标位置供按钮与滚轮使用，并把窗口目标归一化。"
  },
  "bevy_picking::input::touch_pick_events": {
    "summary": "把触摸阶段转换为独立拾取指针。",
    "description": "触摸开始时创建带稳定触点编号和位置的指针实体并发送按下动作；移动时用缓存计算位移，结束或取消时发送释放或取消动作并清除该触点缓存。"
  },
  "bevy_picking::window::update_window_hits": {
    "summary": "把所在窗口作为拾取的最底层命中。",
    "description": "读取各相机与指针组合的射线入口，根据指针当前窗口位置生成窗口实体的 PointerHits，深度设为零、后端顺序设为负无穷，使窗口排在其他可交互实体之后。"
  },
  "bevy_scene::spawn::resolve_scene_patches": {
    "summary": "解析已完成依赖加载的场景补丁。",
    "description": "消费场景和场景列表的依赖加载完成消息，解析资产引用并缓存可用于实例化的结果；资产移除时清理等待队列，对仍在等待该资产的生成请求记录错误。"
  },
  "bevy_sprite::calculate_bounds_2d": {
    "summary": "为二维网格和精灵计算局部包围盒。",
    "description": "从 Mesh2d 资产包围盒或精灵的尺寸、图集区域及锚点计算 Aabb；新实体排入组件插入，已有包围盒并行更新，缺少必需资产时等待后续处理。"
  },
  "bevy_sprite::text2d::calculate_bounds_text2d": {
    "summary": "按文字布局与锚点更新二维文字包围盒。",
    "description": "把 TextLayoutInfo 的尺寸换回逻辑单位，结合 TextBounds 和 Anchor 得到局部最小最大坐标；已有 Aabb 直接更新，没有时插入，显式关闭视锥裁剪的实体不在此处理。"
  },
  "bevy_sprite::text2d::update_text2d_layout": {
    "summary": "重新排版变化的二维文字并准备字形。",
    "description": "根据文本、样式、边界、字体 hinting、渲染层和相机缩放选择排版参数，调用 TextPipeline 更新布局、字形和尺寸；多个目标采用匹配层中的最大缩放，字体未就绪的实体保留到后续帧重试。"
  },
  "bevy_state::state::transitions::last_transition": {
    "summary": "从当前消息批次取得最后一次状态转换。",
    "description": "消费指定状态类型本轮可读的 StateTransitionEvent，克隆并返回最后一条；没有消息时返回 None，供后续管道阶段决定是否运行转换调度。"
  },
  "bevy_state::state::transitions::run_enter": {
    "summary": "执行新状态的进入调度。",
    "description": "从管道输入读取状态转换，存在 entered 值且未被相同状态抑制规则排除时尝试运行 OnEnter；没有进入目标或没有转换时直接返回。"
  },
  "bevy_state::state::transitions::run_exit": {
    "summary": "执行旧状态的退出调度。",
    "description": "从管道输入读取状态转换，存在 exited 值且未被相同状态抑制规则排除时尝试运行 OnExit；没有退出目标或没有转换时直接返回。"
  },
  "bevy_state::state::transitions::run_transition": {
    "summary": "执行特定旧状态到新状态的转换调度。",
    "description": "只有转换同时包含 exited 与 entered 时，尝试运行对应 OnTransition { exited, entered }；缺少任一端时跳过，不由此阶段设置状态资源。"
  },
  "bevy_text::editing::apply_text_edits": {
    "summary": "应用可编辑文字排队的编辑操作。",
    "description": "对有待处理编辑或跨帧粘贴的 EditableText 调用编辑器，使用字体、布局、剪贴板及逐字符过滤规则应用操作；编辑器代数变化时触发 TextEditChange，供后续布局同步。"
  },
  "bevy_text::font::load_font_assets_into_font_collection": {
    "summary": "把字体资产注册到排版字体数据库。",
    "description": "本地跟踪新字体并按内嵌家族名和资产身份别名分别注册，标记引用受影响字体的 TextFont 发生变化；移除字体时重建字体集合、恢复通用家族映射并让所有文字字体重新布局。"
  },
  "bevy_text::pipeline::trim_source_cache": {
    "summary": "裁减排版字体来源缓存。",
    "description": "按两轮保留年龄调用字体来源缓存清理，丢弃长期未使用的数据，在复用频繁更新文字的缓存与控制内存之间保持本版本约定的窗口。"
  },
  "bevy_text::text::detect_text_needs_rerender": {
    "summary": "把文字段和层级变化标为需要重绘。",
    "description": "标记变化根文字块的 ComputedTextBlock，并从变化的 TextSpan 或 InlineBox 向上找到最近文字块标记重绘；缺少父级、失效关系或错误嵌套布局会输出一次性警告。根文本内容自身的变化由各根文字系统处理。"
  },
  "bevy_time::delayed_commands::check_delayed_command_queues": {
    "summary": "提交到期的延迟命令并删除队列实体。",
    "description": "将默认 Time 的累计时间与每个 DelayedCommandQueue.submit_at 比较，到期时把其中命令追加到当前 Commands，并排入队列实体的销毁。"
  },
  "bevy_time::delayed_commands::silence_delayed_command_queues_on_exit": {
    "summary": "在退出时关闭未执行延迟队列的丢弃警告。",
    "description": "遍历仍存在的 DelayedCommandQueue，对内部命令队列设置 silence_drop_warning，使应用退出时不会因为尚未到期的队列被丢弃而产生警告；不执行这些命令。"
  },
  "bevy_ui_widgets::dialog::sync_dialog_z": {
    "summary": "按对话框栈顺序设置全局层级。",
    "description": "从 DialogStack 底部到顶部遍历对话框，将栈索引加到浮动层基值并限制在最大层级内，为每个实体排入 GlobalZIndex，使绘制和指针拾取采用同一顺序。"
  },
  "bevy_ui_widgets::menu::menu_acquire_focus": {
    "summary": "在菜单打开时为菜单项取得焦点。",
    "description": "查找处于 Opening 的菜单，按记录的导航方向初始化第一个或最后一个可聚焦目标；成功后切换到 Open 并设置导航焦点，没有可聚焦菜单项时记录警告。"
  },
  "bevy_ui_widgets::menu::menu_on_lose_focus": {
    "summary": "关闭不再持有内部焦点的菜单。",
    "description": "对已打开或正在打开的菜单，检查焦点是否为自身或后代；焦点移出或消失时把状态改为 Closed，并触发该菜单的 CloseAll 事件。"
  },
  "bevy_ui_widgets::scrollbar::update_scrollbar_thumb": {
    "summary": "按内容比例与滚动位置更新滚动条滑块。",
    "description": "比较可见区域、内容尺寸与轨道长度，计算满足最小尺寸的滑块长度和偏移；把滚动偏移限制在合法范围，内容不足以滚动时使用整段轨道，再更新滑块布局。"
  },
  "bevy_ui_widgets::tabs::update_tablist_derived_state": {
    "summary": "从标签选择和焦点派生每个标签的状态。",
    "description": "验证 SelectedTab 必须指向启用的直接子标签，再同步 Selected 标记；按当前焦点、有效选择和第一个可用项的优先级选择唯一 TabIndex(0)，其余标签为 -1，实现标签栏的游走焦点导航。"
  },
  "bevy_ui_widgets::text_input::apply_queued_select_all": {
    "summary": "在指针释放时应用延后的文本全选。",
    "description": "存在等待全选的目标且读到主按钮释放时，给仍有效的 EditableText 排入 SelectAllIfCollapsed 并清空等待目标；释放不必发生在同一实体上，已有拖动选区不会被该操作覆盖。"
  },
  "bevy_ui_widgets::text_input::listen_for_ime_input_when_text_input_focused": {
    "summary": "按可编辑焦点控制主窗口输入法。",
    "description": "检查当前焦点是否是允许编辑的 EditableText，据此设置主窗口 ime_enabled；文本模式改为只读或静态时排入清除输入法预编辑操作。"
  },
  "bevy_ui_widgets::text_input::on_ime_input": {
    "summary": "把输入法组合和提交转换为文字编辑操作。",
    "description": "为可编辑且未禁用的聚焦 EditableText 排入预编辑文本、光标范围或提交操作，启停 IME 时清理残留组合；无有效编辑目标时仍读尽消息，避免焦点切换后重放旧输入。实际编辑随后统一应用。"
  },
  "bevy_ui_widgets::text_input::text_input_autoscroll_system": {
    "summary": "在拖选越出文字视口时自动滚动。",
    "description": "从焦点目标的主按钮拖动状态取得指针位置，转换到文字局部坐标，按越界距离、视口大小及帧时间计算滚动，限制在文字布局范围并同步拖动选择；组合输入法文本时不执行。"
  },
  "bevy_ui_widgets::text_input::update_ime_position": {
    "summary": "把输入法候选窗口放到当前文字光标下方。",
    "description": "读取聚焦且可编辑目标的 Parley 光标或预编辑矩形，将其底边位置结合内容盒、文字滚动偏移、UI 变换及缩放换算为窗口坐标，更新主窗口 ime_position。"
  },
  "bevy_winit::accessibility::update_accessibility_nodes": {
    "summary": "把变化的可访问性节点同步给原生适配器。",
    "description": "主窗口和 AccessKit 适配器可用时，依据输入焦点及变化的 AccessibilityNode 更新可访问性树；焦点指向尚未存在的实体时暂缓，只有已激活适配器才提交更新。"
  },
  "bevy_winit::system::changed_cursor_options": {
    "summary": "把光标配置变化同步到原生窗口。",
    "description": "对变化的 CursorOptions 尝试更新捕获模式、可见性和命中测试，并维护已成功应用的缓存；平台拒绝捕获或命中测试时记录警告并恢复缓存值，避免每帧因自身回写重复触发。"
  },
  "bevy_winit::system::check_keyboard_focus_lost": {
    "summary": "处理跨窗口键盘焦点丢失并补发释放。",
    "description": "读取窗口焦点变化，只有本轮没有任何窗口获得焦点时才发布 KeyboardFocusLost；对失焦窗口缓存的每个按键发出释放消息并清空记录，窗口间切换不会误判为整体键盘失焦。"
  },
  "bevy_world_serialization::world_asset_spawner::world_instance_spawner": {
    "summary": "根据世界资产根组件排队生成或替换实例。",
    "description": "分别处理 WorldAssetRoot 和 DynamicWorldRoot，把对应资产排入当前实体子树生成；已有 WorldInstance 时销毁旧实例并替换身份，没有时排入新身份组件，连接后续世界资产生成器。"
  },
  "demo::audio::mix::sync_audio_mix": {
    "summary": "合成设置预览或正式配置的有效音量。",
    "description": "优先使用 UI 发布的 AudioPreview，否则使用最近成功应用的正式音量。"
  },
  "demo::audio::mix::sync_voice_volumes": {
    "summary": "将有效混音与素材音量同步到播放实例。",
    "description": "按每条素材清单音量与 UI/SFX 有效混音，更新正在播放及刚就绪实例的绝对分贝。 Kira 将 Queued 句柄写入 Assets 后再次同步新实例，避免旧增益多留一帧。"
  },
  "demo::audio::playback::log_load_failures": {
    "summary": "记录声音资源加载失败的路径与错误。",
    "description": "消费 Kira AudioSource 加载失败消息，记录原始路径与错误。"
  },
  "demo::audio::playback::play_requests": {
    "summary": "按有效音量与播放策略处理短音请求。",
    "description": "消费 SoundRequest；静音直接丢弃，其余按加载、冷却与实例限额排队，并保持清单素材间响度。"
  },
  "demo::audio::playback::preload_sounds": {
    "summary": "预加载界面与音效短音并保存播放策略。",
    "description": "检查嵌入清单后预加载 UI/SFX 短音，将事件映射与播放策略保存到 SoundBank。"
  },
  "demo::audio::playback::stop_on_exit": {
    "summary": "停止音频通道并记录退出。",
    "description": "在 AppExit 消息到达时停止 UI 与 SFX 通道并写统一会话日志。"
  },
  "demo::bounds_recovery::recovery::recover_from_water": {
    "summary": "将落水实体恢复到各自出生姿态。",
    "description": "物理 y < -1.5 时回各自出生姿态，清除速度与单次请求，解除持握。"
  },
  "demo::bounds_recovery::recovery::resume_interpolation": {
    "summary": "撤销落水恢复添加的临时插值暂停。",
    "description": "下一固定步清理本模块添加的插值暂停，再从恢复位置采样。"
  },
  "demo::character_animation::binding::initialize_ready_couriers": {
    "summary": "绑定主角命名动画并缓存鞋底补偿节点。",
    "description": "等待 16 个命名片段与合法时长，绑定播放器及统一步相位；缓存八个鞋底节点用于视觉高度补偿。"
  },
  "demo::character_animation::grounding::compensate_courier_sole_penetration": {
    "summary": "补偿鞋底穿地并平滑恢复视觉高度。",
    "description": "根据本帧鞋底节点姿态向上补偿主角视觉根，解除时平滑回落。"
  },
  "demo::character_animation::state::sync_courier_animation": {
    "summary": "按角色运动状态连续混合移动与跳跃动画。",
    "description": "真实速度转入角色局部空间，连续混合四向静走、持箱与跳跃/下落/落地阶段。"
  },
  "demo::character::lifecycle::clear_character_intents": {
    "summary": "清空持续移动意图与单次动作请求。",
    "description": "角色功能在暂停或返回主菜单时清空持续移动轴及一次性请求，不依赖设备或相机插件。"
  },
  "demo::character::log_configuration": {
    "summary": "记录角色运动与持物行为的初始化配置。",
    "description": "记录实际配置、Avian 版本、共享刚体持握与保留速度释放方式。"
  },
  "demo::character::motion::jump_characters": {
    "summary": "执行角色跳跃并消费单次请求。",
    "description": "只消费一次跳跃请求，接地时施加向上冲量；重力和位姿积分交给 Avian。"
  },
  "demo::character::motion::log_character_velocity": {
    "summary": "定期记录角色实际速度与接地状态。",
    "description": "每 0.5 模拟秒采样一次实际速度和接地状态。"
  },
  "demo::character::motion::move_characters": {
    "summary": "按移动意图和速度为角色施加水平运动力。",
    "description": "由输入和实际速度计算有上限的水平加速度，通过 Forces 施力；不手动积分位置。"
  },
  "demo::character::motion::update_grounded": {
    "summary": "准备运动前更新接地状态。",
    "description": "准备运动前更新接地状态。 物理回写之后观察实际接地状态。"
  },
  "demo::first_person::camera::follow_first_person_camera": {
    "summary": "按人物本帧位置与观察角度更新第一人称镜头。",
    "description": "读取本帧已插值的角色 Transform 与观察角度，在固定眼高计算第一人称镜头。"
  },
  "demo::first_person::camera::sync_character_visibility": {
    "summary": "隐藏第一人称控制角色的自身模型。",
    "description": "有效第一人称控制关联隐藏对应角色直属视觉，失去关联时恢复；木箱保持可见。"
  },
  "demo::first_person::capture::sync_mouse_capture": {
    "summary": "管理光标捕获及玩法输入启停。",
    "description": "按 F3、窗口焦点、游戏状态和控制关联切换光标捕获，统一设置 GameplayContext 活动与 Egui 输入转发；主菜单和暂停始终释放光标。"
  },
  "demo::first_person::facing::sync_character_facing": {
    "summary": "同步人物朝向并处理持物转向受阻。",
    "description": "消费完整有符号转向，检查持物旋转路径；真实受阻先在安全旧姿态释放箱体，随后人物转向，镜头保持自由。"
  },
  "demo::first_person::resume_capture": {
    "summary": "重置光标捕获并丢弃自由光标阶段位移。",
    "description": "标记下一次捕获初始化，并丢弃自由光标阶段累积位移。"
  },
  "demo::first_person::suspend_controls": {
    "summary": "停用玩法输入并释放光标。",
    "description": "进入主菜单或暂停时停用 GameplayContext 并释放光标；角色意图由 CharacterPlugin 的独立生命周期系统清空。"
  },
  "demo::game_flow::enter_main_menu": {
    "summary": "保留主菜单展示时间并冻结物理模拟。",
    "description": "主菜单允许虚拟时间播放展示动画，并暂停、清零物理时钟。"
  },
  "demo::game_flow::pause_simulation": {
    "summary": "冻结游戏与物理时钟并清零当前增量。",
    "description": "暂停虚拟与物理时钟，立即清零当帧增量。"
  },
  "demo::game_flow::resume_simulation": {
    "summary": "恢复游戏与物理时钟。",
    "description": "恢复虚拟与物理时钟，保留现有会话实体。"
  },
  "demo::item_interaction::attachment::align_attachments": {
    "summary": "沿安全碰撞路径将物品对齐双手。",
    "description": "按固定步沿连续碰撞检查的小步对齐双手；受阻保留安全姿态，持续受阻 0.35s 后统一释放。"
  },
  "demo::item_interaction::attachment::finish_attachments": {
    "summary": "为持物装配共享碰撞代理并累计质量。",
    "description": "刚体移除与 Observer 命令完成后，复制真实箱体形状到无视觉代理并挂到人物刚体，累加质量。"
  },
  "demo::item_interaction::audio_events::emit_parcel_land": {
    "summary": "识别自由物品落地并发出声音请求。",
    "description": "逐步检查真实支撑接触和冲量，在自由包裹落地时发出一次声音请求。"
  },
  "demo::item_interaction::audio_events::warn_hold_strain": {
    "summary": "检查持续持握偏差并发出失稳提示音。",
    "description": "根据持有者真实 Position 与最新朝向检查包裹持续偏差，发出一次失稳提示。"
  },
  "demo::item_interaction::interaction::handle_interaction": {
    "summary": "处理物品拾取、共享持握与主动释放。",
    "description": "消费交互请求并筛选自由箱；拾取保持世界姿态、移除独立刚体，开始共享挂接；主动释放使用统一卸载恢复独立运动。"
  },
  "demo::item_interaction::lifecycle::cleanup_orphaned_colliders": {
    "summary": "清理物品销毁后残留的碰撞代理。",
    "description": "箱体销毁后停用并卸载孤儿代理，避免人物继续携带不可见碰撞。"
  },
  "demo::item_interaction::lifecycle::release_orphaned_items": {
    "summary": "清理失效持握并恢复物品独立运动。",
    "description": "持有者消失或 HeldBy 异常解除时，统一卸载并恢复独立箱体与自由碰撞，保留真实姿态和速度。"
  },
  "demo::item_interaction::lifecycle::restore_empty_holder_mass": {
    "summary": "归还不再持物角色的原有质量。",
    "description": "HoldingItems 已空时归还人物原质量，移除 CarryBaseMass。"
  },
  "demo::item_interaction::lifecycle::resume_carry_easing": {
    "summary": "恢复物品释放前未暂停的插值通道。",
    "description": "下一固定步重置旧插值端点后，仅撤销本模块拥有的释放插值暂停。"
  },
  "demo::item_interaction::pose::sync_held_physics": {
    "summary": "按人物物理姿态同步持物位置与碰撞代理。",
    "description": "由人物真实物理状态与局部挂接姿态同步箱根和代理，派生箱体点速度。 Avian 回写后以最新真实位姿同步箱根及碰撞代理。 本帧朝向命令应用后同步组合碰撞姿态，即使本帧没有固定步也保持物理与显示朝向一致。"
  },
  "demo::item_interaction::pose::sync_held_presentation": {
    "summary": "按人物呈现姿态同步持物模型与握持目标。",
    "description": "按本帧人物呈现 Transform 与唯一挂接局部姿态直接同步独立箱根 Transform，同时更新握持检查目标 HeldTarget。"
  },
  "demo::physics::collision::log_collisions": {
    "summary": "将碰撞开始与结束写入统一日志。",
    "description": "读取碰撞开始/结束缓冲消息，通过统一文件日志记录碰撞双方。"
  },
  "demo::physics::sync_gravity": {
    "summary": "将共享重力配置同步到物理世界。",
    "description": "配置变化时更新唯一 Gravity 资源。"
  },
  "demo::physics::wake_changed_bodies": {
    "summary": "使休眠身体的外部受力和位姿修改在本固定步生效。",
    "description": "物理准备前检查休眠身体的变更 tick；仅当外部位姿、速度或施力计时变化晚于上一物理步末尾时，排队 WakeBody 唤醒所属物理岛。"
  },
  "demo::scene_assembly::assets::log_asset_requests": {
    "summary": "记录运行模型资源的加载请求。",
    "description": "记录五份运行 GLB 的请求；实际加载在资源初始化时开始。"
  },
  "demo::scene_assembly::assets::poll_art_assets": {
    "summary": "检查资源及其依赖的加载结果。",
    "description": "检查全部资源及递归依赖，进入 Ready 或 Failed。"
  },
  "demo::scene_assembly::loading::begin_island": {
    "summary": "请求创建已加载海岛的运行实例。",
    "description": "五份资源就绪且地图不存在时请求海岛实例。"
  },
  "demo::settings::frame_pacing::apply_frame_rate_limit": {
    "summary": "将帧率设置同步给原生窗口循环。",
    "description": "将已应用的 max_fps 同步到 WinitSettings 的前台与后台更新策略，由 Bevy 原生窗口循环负责计时与等待。"
  },
  "demo::settings::frame_pacing::log_simulation_timestep": {
    "summary": "记录固定模拟频率。",
    "description": "记录固定模拟频率。"
  },
  "demo::ui::backdrop::log_asset_failures": {
    "summary": "记录菜单模型与界面资源加载失败。",
    "description": "读取 models/ 与 ui/ 资产加载失败消息，写入统一会话日志。"
  },
  "demo::ui::backdrop::play_courier_animation": {
    "summary": "绑定并循环播放展示快递员的持物待机动画。",
    "description": "等待 Carry_Idle 命名片段入库，创建图并循环播放实际骨架播放器，然后移除 pending。"
  },
  "demo::ui::backdrop::spawn_backdrop": {
    "summary": "装配主菜单海岛展示舞台、相机与日光。",
    "description": "声明独立海岛 GLB 舞台、相机与日光；展示快递员根保存父 GLTF 句柄，待命名动画可用后绑定。"
  },
  "demo::ui::lifecycle::hide_menu": {
    "summary": "隐藏菜单并清除提示。",
    "description": "进入 Running 时隐藏菜单并清提示；捕获恢复和时钟由所属功能响应同一状态。"
  },
  "demo::ui::lifecycle::show_main_menu": {
    "summary": "打开主菜单并重置页面、返回来源与焦点。",
    "description": "进入主菜单时重置页面、返回来源和焦点；时钟与输入分别由所属功能响应。"
  },
  "demo::ui::lifecycle::show_pause_menu": {
    "summary": "打开暂停菜单并重置焦点。",
    "description": "打开 Pause 页面并重置焦点；不退出 InGame，也不生成或销毁玩法实体。"
  },
  "demo::ui::navigation::sync_context": {
    "summary": "跟随窗口焦点启停菜单输入。",
    "description": "按主窗口聚焦替换 MenuContext 启用状态。"
  },
  "demo::ui::pointer::clear_cancelled_primary_presses": {
    "summary": "清理被取消、失焦或离窗的菜单主键按压。",
    "description": "清理被取消、失焦或离窗的菜单主键按压。"
  },
  "demo::ui::requests::handle_requests": {
    "summary": "处理菜单导航、设置应用与音量编辑请求。",
    "description": "集中消费菜单语义请求，导航与保存应用设置；归并同一拖动数值与释放，试听复用拾取声音消息。"
  },
  "demo::ui::scroll::bind_settings_scrollbars": {
    "summary": "将设置滚动条绑定到对应内容视口。",
    "description": "用 BSN 生成后的真实 sibling Entity 绑定原生 Scrollbar.target。"
  },
  "demo::ui::scroll::scroll_focused_button": {
    "summary": "将当前聚焦设置按钮滚入可视范围。",
    "description": "等待真实布局后，沿 ChildOf 找视口，把当前焦点按钮滚入可视范围。"
  },
  "demo::ui::scroll::sync_settings_scrollbars": {
    "summary": "同步滚动条显隐、拾取范围与高亮。",
    "description": "依据实际溢出更新显隐和拾取，夹取滚动位置并同步滑块高亮。"
  },
  "demo::ui::style::publish_audio_preview": {
    "summary": "向音频功能发布或清除临时音量预览。",
    "description": "菜单发布临时音量契约；离开设置时清空预览，音频不读取 UI 私有状态。"
  },
  "demo::ui::style::style_buttons": {
    "summary": "按当前输入来源更新按钮背景与焦点边框。",
    "description": "按输入来源更新所有可操作按钮的纸色/金色背景与深色焦点边框，鼠标离开恢复。"
  },
  "demo::ui::style::update_description": {
    "summary": "更新当前聚焦设置的说明标题与正文。",
    "description": "从聚焦设置按钮读取说明，更新右侧标题与正文文本。"
  },
  "demo::ui::style::update_settings_text": {
    "summary": "原位更新设置草稿数值与保存提示。",
    "description": "草稿数值与保存提示变更时原位更新 Text，保留视口与焦点身份。"
  },
  "demo::ui::volume::sample_slider_pointer": {
    "summary": "从光标位置生成音量采样与释放请求。",
    "description": "仅 Audio 页捕获原生命中的滑条；按物理光标局部位置生成精确音量与释放请求。"
  },
  "demo::ui::volume::update_volume_visuals": {
    "summary": "原位更新音量百分比文字与轨道填充。",
    "description": "草稿变化时更新已有百分比文字与轨道填充；静音显示 Muted，不重建音量实体树。"
  },
  "demo::window_policy::install_native_policy": {
    "summary": "安装并维护原生窗口比例与尺寸策略。",
    "description": "安装、刷新并清理原生窗口策略；成功后显示，失败时固定尺寸显示。"
  }
});
