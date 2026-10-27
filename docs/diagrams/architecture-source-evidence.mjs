// 映射只记录已核实的语义和包身份；本机 Cargo 根目录由构建上下文提供。
export const TYPE_PACKAGES = Object.freeze({
  Time: 'bevy_time', Fixed: 'bevy_time', Real: 'bevy_time', Virtual: 'bevy_time',
  ButtonInput: 'bevy_input', AccumulatedMouseMotion: 'bevy_input', KeyboardInput: 'bevy_input',
  KeyboardFocusLost: 'bevy_input', MouseButtonInput: 'bevy_input', MouseMotion: 'bevy_input',
  WindowFocused: 'bevy_window', Window: 'bevy_window', ClearColor: 'bevy_camera',
  GlobalAmbientLight: 'bevy_light', WinitSettings: 'bevy_winit', AppTypeRegistry: 'bevy_ecs',
  Messages: 'bevy_ecs', State: 'bevy_state', NextState: 'bevy_state', StateTransitionEvent: 'bevy_state',
  Assets: 'bevy_asset', AssetServer: 'bevy_asset', AssetLoadFailedEvent: 'bevy_asset', UntypedAssetLoadFailedEvent: 'bevy_asset',
  Mesh: 'bevy_mesh', StandardMaterial: 'bevy_pbr', Gltf: 'bevy_gltf', WorldAsset: 'bevy_world_serialization',
  AnimationClip: 'bevy_animation', AnimationGraph: 'bevy_animation',
  AppExit: 'bevy_app', ContextInstances: 'bevy_enhanced_input', ActionSources: 'bevy_enhanced_input',
  ConsumedInputs: 'bevy_enhanced_input', PendingBindings: 'bevy_enhanced_input',
  Fire: 'bevy_enhanced_input', Complete: 'bevy_enhanced_input', Cancel: 'bevy_enhanced_input',
  EguiGlobalSettings: 'bevy_egui',
  Gravity: 'avian3d', ColliderTrees: 'avian3d', ContactGraph: 'avian3d', Physics: 'avian3d',
  LastPhysicsTick: 'avian3d', WakeBody: 'avian3d',
  CollisionStart: 'avian3d', CollisionEnd: 'avian3d', LastEasingTick: 'bevy_transform_interpolation',
  AudioChannel: 'bevy_kira_audio', AudioSource: 'bevy_kira_audio', AudioInstance: 'bevy_kira_audio',
  WorldInstanceReady: 'bevy_world_serialization', Pointer: 'bevy_picking', PointerInput: 'bevy_picking',
  PointerPress: 'bevy_picking', PointerScroll: 'bevy_picking', Pressed: 'bevy_ui',
  PointerRelease: 'bevy_picking', PointerClick: 'bevy_picking', PointerDragEnd: 'bevy_picking', PointerCancel: 'bevy_picking',
  HoverMap: 'bevy_picking', PreviousHoverMap: 'bevy_picking', PointerState: 'bevy_picking', PointerMap: 'bevy_picking', PickingSettings: 'bevy_picking',
  FocusedInput: 'bevy_input_focus', Activate: 'bevy_ui_widgets',
  Add: 'bevy_ecs', Remove: 'bevy_ecs', RemoveEvent: 'bevy_ecs', Despawn: 'bevy_ecs', DespawnEvent: 'bevy_ecs',
  ChildOf: 'bevy_ecs', AnimatedBy: 'bevy_animation', ColliderOf: 'avian3d',
  ActionOf: 'bevy_enhanced_input', BindingOf: 'bevy_enhanced_input', Scrollbar: 'bevy_ui_widgets',
});

const project = (path, contains, role, label, extra = {}) => ({ path, contains, role, label, ...extra });
const dependency = (packageName, path, contains, role, label, extra = {}) => ({ package: packageName, path, contains, role, label, ...extra });
const stateCleanup = dependency('bevy_state', 'src/state_scoped.rs', 'commands.despawn_all_where::<&DespawnOnExit<S>, Allow<Disabled>>', 'destroy', '框架执行：退出状态后销毁匹配的 DespawnOnExit 实体');
const gameExit = project('src/ui/requests.rs', 'app_state.set(AppState::MainMenu)', 'destroy', '触发退出游戏会话：切换至 MainMenu');
const rootState = (path, contains, extra = {}) => [project(path, contains, 'destroy', '配置：DespawnOnExit(AppState::InGame)', extra), gameExit, stateCleanup];
const menuCleanup = [project('src/ui/backdrop.rs', 'DespawnOnExit::<AppState>(AppState::MainMenu)', 'destroy', '配置：退出主菜单时清理展示舞台'), stateCleanup];
const pageCleanup = project('src/ui/pages.rs', 'commands.entity(entity).despawn();', 'destroy', '页面结构变化或隐藏：销毁旧菜单根及其后代');
const relatedSceneCreation = [
  dependency('bevy_scene_macros', 'src/bsn/codegen.rs', '#bevy_scene::RelatedScenes::<#relationship_path>::new(#scenes)', 'create', '配置展开：关系场景列表交由 RelatedScenes 装配'),
  dependency('bevy_scene', 'src/scene.rs', 'let related = scene.get_or_insert_related_resolved_scenes::<R::Relationship>();', 'create', '框架解析：按真实 RelationshipTarget 记录子场景'),
  dependency('bevy_scene', 'src/resolved_scene.rs', 'world.spawn_empty()', 'create', '框架执行：apply_related 为未引用现有实体的子场景创建实体', { line: 374 }),
  dependency('bevy_scene', 'src/resolved_scene.rs', '(related_resolved_scenes.insert_relationship)(', 'create', '框架执行：为子场景插入关系组件并指向父实体'),
];

export const ENTITY_SOURCE_EVIDENCE = Object.freeze({
  'entity-controller': [project('src/first_person/actions.rs', '.spawn_scene(keyboard_context())', 'create', '创建：spawn_keyboard_controller 请求键盘上下文场景'), ...rootState('src/scene_assembly/actors.rs', '.insert(DespawnOnExit(AppState::InGame));')],
  'entity-character': [project('src/scene_assembly/actors.rs', '.spawn_scene(courier_scene(', 'create', '创建：装配角色业务根'), project('src/scene_assembly/actors.rs', 'Name("Courier")', 'create', 'BSN：角色根的组件组合'), ...rootState('src/scene_assembly/actors.rs', '.insert((character_body(&config), DespawnOnExit(AppState::InGame)))')],
  'entity-parcel': [project('src/scene_assembly/actors.rs', 'let mut entity = commands.spawn_scene(carryable_scene', 'create', '创建：独立可搬物品业务根'), project('src/scene_assembly/actors.rs', 'Name({model.name()})', 'create', 'BSN：可搬物品根的组件组合'), ...rootState('src/scene_assembly/actors.rs', 'entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))')],
  'entity-camera': [project('src/scene_assembly/loading.rs', 'commands.spawn_scene(bsn!', 'create', '创建：spawn_scene 装配加载相机，随后复用为玩法相机', { line: 17 }), ...rootState('src/scene_assembly/loading.rs', 'DespawnOnExit::<AppState>(AppState::InGame)', { line: 22 })],
  'entity-visual': [project('src/scene_assembly/actors.rs', 'Name("Courier visual")', 'create', '场景声明：角色直属视觉根'), project('src/scene_assembly/actors.rs', 'Children [Name("Carryable visual")', 'create', '关系场景声明：物品直属视觉根'), ...relatedSceneCreation],
  'entity-window': [dependency('bevy_window', 'src/lib.rs', 'app.world_mut().spawn(primary_window.clone())', 'create', '框架创建：WindowPlugin 创建主窗口'), dependency('bevy_window', 'src/lib.rs', 'app.add_systems(Last, close_when_requested.before(ExitSystems))', 'destroy', '配置：WindowPlugin 在 Last 中注册窗口关闭清理'), dependency('bevy_window', 'src/system.rs', 'commands.entity(window).despawn();', 'destroy', '框架执行：窗口关闭标记后销毁窗口实体')],
  'entity-action': [project('src/first_person/actions.rs', 'Actions<GameplayContext> [', 'create', '关系场景声明：玩法动作子实体列表'), ...relatedSceneCreation],
  'entity-binding': [project('src/first_person/actions.rs', 'Bindings [ Binding::mouse_motion() ]', 'create', '关系场景声明：鼠标绑定子实体'), project('src/first_person/actions.rs', 'Bindings [ {preset::cardinal::wasd_keys()} ]', 'create', '关系场景声明：WASD 绑定子实体'), dependency('bevy_enhanced_input', 'src/preset/cardinal.rs', 'pub fn wasd_keys() -> impl SceneList', 'create', '预设展开：WASD 返回四个绑定子场景'), ...relatedSceneCreation],
  'entity-world': [project('src/scene_assembly/loading.rs', 'commands.spawn_scene(bsn!', 'create', '创建：spawn_scene 装配地图静态碰撞子实体', { line: 210 }), project('src/scene_assembly/loading.rs', 'Name("Display NPC collider")', 'create', 'BSN：展示 NPC 碰撞子实体')],
  'entity-island': [project('src/scene_assembly/loading.rs', 'commands.spawn_scene(island_scene(scene.clone()))', 'create', '创建：spawn_scene 装配海岛实例根'), ...rootState('src/scene_assembly/loading.rs', 'DespawnOnExit::<AppState>(AppState::InGame)', { line: 34 })],
  'entity-npc': [],
  'entity-animation_player': [],
  'entity-model_node': [],
  'entity-menu_controller': [project('src/ui/navigation.rs', 'commands.spawn_scene(bsn!', 'create', '创建：spawn_scene 装配跨页面保留的菜单控制者')],
  'entity-menu_root': [project('src/ui/pages.rs', 'commands.spawn_scene(page_scene(', 'create', '创建：当前菜单页面根'), project('src/ui/pages.rs', '        MenuRoot', 'create', 'BSN：菜单根组件组合'), pageCleanup],
  'entity-menu_button': [project('src/ui/widgets.rs', '        MenuButton { action, index }', 'create', '场景声明：菜单按钮组件组合', { all: true }), ...relatedSceneCreation, pageCleanup],
  'entity-menu_scroll': [project('src/ui/scroll.rs', '        MenuScroll', 'create', '场景声明：设置内容视口'), ...relatedSceneCreation, pageCleanup],
  'entity-menu_backdrop': [project('src/ui/backdrop.rs', '.spawn_scene(bsn!', 'create', '创建：独立主菜单展示舞台'), ...menuCleanup],
  'entity-menu_camera': [project('src/ui/backdrop.rs', '        #MenuCamera', 'create', '场景声明：展示舞台相机'), ...relatedSceneCreation, ...menuCleanup],
  'entity-menu_model': [project('src/ui/backdrop.rs', '        WorldAssetRoot(path)', 'create', '场景声明：菜单模型实例根'), project('src/ui/backdrop.rs', 'WorldAssetRoot("models/characters/chr_courier.glb#Scene0")', 'create', '场景声明：菜单快递员实例根'), ...relatedSceneCreation, ...menuCleanup],
  'entity-menu_text': [project('src/ui/widgets.rs', '        Text(value)', 'create', '场景声明：菜单文字叶节点', { all: true }), ...relatedSceneCreation, pageCleanup],
  'entity-menu_volume': [project('src/ui/volume.rs', '                        VolumeFill(key)', 'create', '场景声明：音量填充节点'), ...relatedSceneCreation, pageCleanup],
  'entity-settings_panel': [project('src/ui/pages.rs', '                SettingsPanel', 'create', '场景声明：设置内容面板'), ...relatedSceneCreation, pageCleanup],
  'entity-settings_scrollbar': [project('src/ui/scroll.rs', '        SettingsScrollbar { min_thumb_length }', 'create', '场景声明：设置滚动条轨道'), ...relatedSceneCreation, pageCleanup],
  'entity-settings_scrollbar_thumb': [project('src/ui/scroll.rs', '            SettingsScrollbarThumb', 'create', '场景声明：原生滚动条滑块'), ...relatedSceneCreation, pageCleanup],
  'entity-held_proxy': [project('src/item_interaction/attachment.rs', 'commands.spawn_empty().id()', 'create', '创建：持物碰撞代理（初始为空实体）'), project('src/item_interaction/lifecycle.rs', 'proxy.despawn();', 'destroy', '实际销毁：释放物品时移除代理'), project('src/item_interaction/lifecycle.rs', '.despawn();', 'destroy', '实际销毁：业务物品失效后清理代理', { line: 113 })],
});

// 这些实体的 ChildOf/关系所有权已由源码和清单核实；不把普通 Entity 字段当作级联关系。
export const HIERARCHY_OWNED_ENTITIES = Object.freeze(new Set([
  'entity-visual', 'entity-action', 'entity-binding', 'entity-world', 'entity-npc',
  'entity-animation_player', 'entity-model_node', 'entity-menu_button', 'entity-menu_scroll',
  'entity-menu_camera', 'entity-menu_model', 'entity-menu_text', 'entity-menu_volume',
  'entity-settings_panel', 'entity-settings_scrollbar', 'entity-settings_scrollbar_thumb',
]));

export const IMPORTED_ENTITIES = Object.freeze(new Set(['entity-npc', 'entity-animation_player', 'entity-model_node', 'entity-menu_model']));
export const MARKER_ONLY_RESOURCES = Object.freeze(new Set(['resource.UiTrack', 'resource.SfxTrack']));

export const RELATED_IMPLEMENTATIONS = Object.freeze({
  'ecs-component-lifecycle': [
    dependency('bevy_ecs', 'src/world/mod.rs', 'self.register_event_key::<RemoveEvent>()', 'configure', 'World 初始化：注册组件移除生命周期事件'),
    dependency('bevy_ecs', 'src/world/mod.rs', 'self.register_event_key::<DespawnEvent>()', 'configure', 'World 初始化：注册实体销毁生命周期事件'),
    dependency('bevy_ecs', 'src/world/entity_access/world_mut.rs', 'pub(crate) fn despawn_no_free_no_flush_with_caller(', 'implementation', '实际销毁：派发实体销毁与组件移除事件'),
    dependency('bevy_ecs', 'src/bundle/remove.rs', '&mut RemoveEvent { entity },', 'implementation', '实际移除：按待移除组件集合派发生命周期事件'),
    dependency('bevy_state', 'src/state_scoped.rs', 'commands.despawn_all_where::<&DespawnOnExit<S>, Allow<Disabled>>', 'implementation', '生产清理路径：退出状态后销毁匹配的 DespawnOnExit 实体'),
  ],
  'resource.SessionWriter': [project('src/session_log/lifecycle.rs', 'writer: SessionWriter {', 'initialize', '初始化：创建文件日志写入器'), project('src/session_log/mod.rs', 'app.insert_resource(self.writer.clone());', 'insert', '构建期暂存：将文件写入器插入 App'), project('src/session_log/lifecycle.rs', '.remove_resource::<SessionWriter>()', 'remove', '构建期移交：文件日志 layer 取走写入器')],
  'resource.ConsoleWriter': [project('src/session_log/lifecycle.rs', 'console: ConsoleWriter(console_worker.writer.clone()),', 'initialize', '初始化：创建控制台日志写入器'), project('src/session_log/mod.rs', 'app.insert_resource(self.console.clone());', 'insert', '构建期暂存：将控制台写入器插入 App'), project('src/session_log/lifecycle.rs', '.remove_resource::<ConsoleWriter>()', 'remove', '构建期移交：控制台日志 layer 取走写入器')],
  'param-recoverable-body': [project('src/bounds_recovery/recovery.rs', 'Query<RecoverableBody, Or<(With<Character>, With<Pickable>)>>', 'parameter', '参数声明：recover_from_water 注入落水恢复查询')],
  'param-carry-rotation': [project('src/first_person/facing.rs', 'collision: CarryRotationQuery', 'parameter', '参数声明：sync_character_facing 使用持物路径查询'), project('src/item_interaction/attachment.rs', 'safety: CarryRotationQuery', 'parameter', '参数声明：align_attachments 使用持物路径查询')],
  'time_update': [dependency('bevy_time', 'src/lib.rs', '.in_set(TimeSystems)', 'configure', '集合配置：TimePlugin 把时钟更新系统加入 TimeSystems')],
  'input_update': [dependency('bevy_input', 'src/lib.rs', '.in_set(InputSystems)', 'configure', '集合配置：InputPlugin 安装各类设备输入更新成员', { all: true })],
  'transform_propagate': [dependency('bevy_transform', 'src/plugins.rs', '.in_set(TransformSystems::Propagate)', 'configure', '集合配置：TransformPlugin 在 PostStartup／PostUpdate 安装变换传播成员', { all: true })],
  'animation_engine': [dependency('bevy_animation', 'src/lib.rs', '.in_set(AnimationSystems)', 'configure', '集合配置：AnimationPlugin 把动画执行链加入 AnimationSystems')],
  'kira-play-typed': [dependency('bevy_kira_audio', 'src/audio.rs', 'play_audio_channel::<T>.in_set(AudioSystemSet::PlayTypedChannels)', 'configure', '集合配置：AudioApp 为类型通道安装 PlayTypedChannels 成员')],
  'native-visibility': [dependency('bevy_camera', 'src/visibility/mod.rs', '(UpdateFrusta, VisibilityPropagate)', 'configure', '集合约束：VisibilityPlugin 配置传播阶段与可见性检查的顺序'), dependency('bevy_camera', 'src/visibility/mod.rs', '.in_set(VisibilityPropagate)', 'configure', '集合配置：VisibilityPlugin 安装可见性传播成员')],
  'state-paused': [project('src/game_flow/mod.rs', '.add_systems(OnEnter(PlayState::Paused), pause_simulation)', 'related', '生命周期说明：进入暂停状态的实际系统注册')],
  'volume-request-source': [project('src/ui/volume.rs', 'fn sample_slider_pointer(', 'related', '交互说明：滑条局部捕获与消息采样实现')],
  'ui-next-state': [project('src/ui/requests.rs', 'app_state.set(', 'related', '实际赋值：菜单请求写入 NextState<AppState>', { all: true }), project('src/ui/requests.rs', 'play_state.set(', 'related', '实际赋值：暂停／恢复写入 NextState<PlayState>', { all: true })],
  'ui-volume-set': [project('src/ui/volume.rs', '(sample_slider_pointer, update_volume_visuals)', 'configure', '匿名系统元组配置：成员及 before／after 约束')],
  'plugin-sound-events': [project('src/item_interaction/mod.rs', 'audio_events::register_feedback(app)', 'configure', '装配调用：ItemInteractionPlugin 启用反馈系统')],
  'world_spawn': [dependency('bevy_world_serialization', 'src/lib.rs', '(world_instance_spawner, world_instance_spawner_system)', 'configure', '流程安装：WorldSerializationPlugin 注册场景实例化链'), dependency('bevy_world_serialization', 'src/world_asset_spawner.rs', 'pub fn world_instance_spawner_system(', 'implementation', '流程执行：场景实例队列与生命周期处理'), dependency('bevy_world_serialization', 'src/world_asset_spawner.rs', 'pub fn world_instance_spawner(', 'implementation', '流程执行：WorldAssetRoot 实例化请求')],
  'render': [dependency('bevy_render', 'src/lib.rs', 'impl Plugin for RenderPlugin {', 'configure', '流程安装：RenderPlugin 创建并装配渲染子应用')],
  'audio-output': [project('src/audio/mod.rs', '.configure_sets(Update, (AudioSystems::Mix, AudioSystems::Playback).chain())', 'configure', '播放流程配置：混音与播放阶段约束'), project('src/audio/mod.rs', '(play_requests, stop_on_exit)', 'configure', '播放流程配置：请求播放与退出停止系统'), project('src/game_flow/mod.rs', '.configure_sets(', 'configure', '跨功能配置：UI Style → Mix → Playback', { line: 95 })],
  'kira-output': [project('src/audio/mod.rs', '.add_audio_channel::<UiTrack>()', 'configure', '项目启用：界面类型通道'), project('src/audio/mod.rs', '.add_audio_channel::<SfxTrack>()', 'configure', '项目启用：物品音效类型通道'), dependency('bevy_kira_audio', 'src/audio.rs', 'play_audio_channel::<T>.in_set(AudioSystemSet::PlayTypedChannels)', 'configure', '框架配置：类型通道播放系统加入 PlayTypedChannels'), dependency('bevy_kira_audio', 'src/audio_output.rs', 'pub(crate) fn play_audio_channel<T: Resource>(', 'implementation', '框架执行：消费类型通道命令并播放')],
  'physics-file-log': [project('src/session_log/lifecycle.rs', 'fn create_session_file(', 'create', '创建：会话日志文件'), project('src/session_log/output.rs', 'sink.write_all(&bytes)', 'implementation', '执行：后台线程把排队记录写入文件'), project('src/session_log/lifecycle.rs', 'self.file_worker.shutdown()', 'close', '关闭：会话守卫等待文件后台线程刷新退出')],
  'log-file-worker': [project('src/session_log/output.rs', 'fn spawn(', 'create', '创建：文件后台线程', { all: true }), project('src/session_log/output.rs', 'sink.write_all(&bytes)', 'implementation', '执行：排队记录写入 sink'), project('src/session_log/output.rs', 'fn shutdown(', 'close', '关闭：提交 Shutdown 并等待线程退出')],
  'log-producer': [project('src/session_log/lifecycle.rs', '.remove_resource::<SessionWriter>()', 'implementation', '构建期移交：文件日志 layer 取走写入器')],
  'log-console-worker': [project('src/session_log/lifecycle.rs', '.remove_resource::<ConsoleWriter>()', 'implementation', '构建期移交：控制台日志 layer 取走写入器'), project('src/session_log/output.rs', 'sink.write_all(&bytes)', 'implementation', '执行：排队记录写入控制台 sink'), project('src/session_log/lifecycle.rs', 'self.console_worker.shutdown()', 'close', '关闭：会话守卫等待控制台后台线程刷新退出')],
  'window-native-policy': [project('src/window_policy/windows.rs', 'pub(super) fn install(', 'install', 'Windows：安装原生窗口策略'), project('src/window_policy/macos.rs', 'pub(super) fn install(', 'install', 'macOS：安装原生窗口策略'), project('src/window_policy/windows.rs', 'fn drop(&mut self)', 'close', 'Windows：NativeWindowPolicy 释放子类注册'), project('src/window_policy/macos.rs', 'fn drop(&mut self)', 'close', 'macOS：NativeWindowPolicy 释放原生策略')],
  'native-window-events': [project('src/window_policy/windows.rs', 'fn window_subclass(', 'definition', 'Windows：窗口子类事件回调定义'), project('src/window_policy/windows.rs', '        SetWindowSubclass(', 'install', 'Windows：向 OS 注册窗口回调'), project('src/window_policy/windows.rs', 'RemoveWindowSubclass(self.hwnd', 'close', 'Windows：卸载 OS 窗口回调')],
});

// 泛型注册保留已核实的具体实参链，不能按 helper 函数名关联到另一上下文。
export const SYSTEM_REGISTRATION_EVIDENCE = Object.freeze({
  'enhanced-reset-gameplay-action': [
    project('src/first_person/mod.rs', 'app.add_input_context::<GameplayContext>()', 'registration', '项目注册：GameplayContext 上下文启用其独立 reset_action 注册'),
    dependency('bevy_enhanced_input', 'src/context.rs', '.add_observer(reset_action::<C>)', 'registration', '框架注册：C = GameplayContext 的动作移除 Observer'),
  ],
  'native-focused-keyboard-dispatch': [
    dependency('bevy_input_focus', 'src/lib.rs', '                dispatch_focused_input::<KeyboardInput>,', 'registration', 'Schedule 注册：PreUpdate，InputFocusSystems::Dispatch，after(InputSystems)'),
  ],
});

const actionEmission = (event, line) => [
  dependency('bevy_enhanced_input', 'src/context.rs', '            fns.trigger(', 'operation', 'Trigger 阶段：按上下文遍历动作并调用类型对应派发器', { line: 760 }),
  dependency('bevy_enhanced_input', 'src/action/fns.rs', 'commands.trigger(event);', 'operation', `实际排入：${event}<A>`, { line }),
];
const resetEmission = (event, line) => [
  dependency('bevy_enhanced_input', 'src/context.rs', '    fns.trigger(', 'operation', '动作移除：状态清零后调用对应动作派发器', { line: 428 }),
  dependency('bevy_enhanced_input', 'src/action/fns.rs', 'commands.trigger(event);', 'operation', `实际排入：${event}<A>`, { line }),
];
const pointerEmission = variable => [dependency('bevy_picking', 'src/events.rs', `commands.trigger(${variable}.clone());`, 'operation', '实际派发：排入对应指针事件命令')];
const worldReadyEmission = [dependency('bevy_world_serialization', 'src/world_asset_spawner.rs', 'world.commands().trigger(WorldInstanceReady {', 'operation', '实际派发：场景实例完成后排入就绪事件', { all: true })];
const removeEmission = [
  dependency('bevy_ecs', 'src/bundle/remove.rs', '&mut RemoveEvent { entity },', 'operation', '组件移除：按待移除组件集合触发生命周期 Observer'),
  dependency('bevy_ecs', 'src/world/entity_access/world_mut.rs', '&mut RemoveEvent {', 'operation', '实体销毁：为原组件集合触发 RemoveEvent'),
];
const projectSubscription = (path, pattern, extra = {}) => [project(path, pattern, 'parameter', '事件匹配：已注册 Observer 的 On 参数', extra)];
const buttonSubscription = pattern => [dependency('bevy_ui_widgets', 'src/button.rs', pattern, 'parameter', '事件匹配：原生 Button Observer 的 On 参数')];
const actionObservers = [
  ['observe_move', 'src/first_person/actions.rs', 'Fire<MoveAction>', 'Fire', 110],
  ['observe_complete', 'src/first_person/actions.rs', 'Complete<MoveAction>', 'Complete', 131],
  ['observe_cancel', 'src/first_person/actions.rs', 'Cancel<MoveAction>', 'Cancel', 120],
  ['observe_jump', 'src/first_person/actions.rs', 'Fire<JumpAction>', 'Fire', 110],
  ['observe_interact', 'src/first_person/actions.rs', 'Fire<InteractAction>', 'Fire', 110],
  ['observe_look', 'src/first_person/camera.rs', 'Fire<LookAction>', 'Fire', 110],
  ...['previous', 'next', 'left', 'right', 'confirm', 'back'].map(name => [`observe_menu_${name}`, 'src/ui/navigation.rs', `Fire<${name[0].toUpperCase()}${name.slice(1)}Action>`, 'Fire', 110]),
];

// 事件对象 ID 表示精确匹配入口；同名事件不会在这里按名称合并。
export const EDGE_SOURCE_EVIDENCE = Object.freeze({
  ...Object.fromEntries(actionObservers.flatMap(([observer, path, type, event, line]) => [
    [`observer-${observer}`, projectSubscription(path, `On<${type}>`)],
    [`trigger-input_trigger-event-${observer}`, actionEmission(event, line)],
  ])),
  'observer-island_ready_observer': projectSubscription('src/scene_assembly/loading.rs', 'ready: On<WorldInstanceReady>'),
  'observer-courier_ready_observer': projectSubscription('src/character_animation/binding.rs', 'ready: On<WorldInstanceReady>'),
  'observer-observe_courier_ready': projectSubscription('src/ui/backdrop.rs', 'ready: On<WorldInstanceReady>'),
  'trigger-world_spawn-world-ready-event': worldReadyEmission,
  'trigger-world_spawn-event-observe_courier_ready': worldReadyEmission,
  'observer-observe_menu_scroll': projectSubscription('src/ui/scroll.rs', 'mut event: On<PointerScroll>', { line: 269 }),
  'observer-observe_scrollbar_scroll': projectSubscription('src/ui/scroll.rs', 'mut event: On<PointerScroll>', { line: 216 }),
  'observer-observe_scrollbar_press': projectSubscription('src/ui/scroll.rs', 'fn scrollbar_pointer_source(_: On<PointerPress>'),
  'observer-observe_menu_primary_press': projectSubscription('src/ui/pointer.rs', 'event: On<PointerPress>'),
  'observer-observe_menu_primary_clear': projectSubscription('src/ui/pointer.rs', 'event: On<Remove<Pressed>>'),
  'observer-carry_holder_despawn': projectSubscription('src/item_interaction/lifecycle.rs', 'event: On<Despawn<Character>>'),
  'observer-enhanced-reset-gameplay-action': [dependency('bevy_enhanced_input', 'src/context.rs', 'remove: On<Remove<ActionOf<C>>>', 'parameter', '事件匹配：C = GameplayContext 的动作关系移除')],
  'trigger-enhanced-reset-gameplay-action-event-observe_complete': resetEmission('Complete', 131),
  'trigger-enhanced-reset-gameplay-action-event-observe_cancel': resetEmission('Cancel', 120),
  'trigger-ecs-component-lifecycle-carry-despawn-event': [dependency('bevy_ecs', 'src/world/entity_access/world_mut.rs', '&mut DespawnEvent {', 'operation', '实际销毁：触发匹配 Character 的 DespawnEvent')],
  'trigger-ecs-component-lifecycle-event-observe_menu_primary_clear': removeEmission,
  'trigger-ecs-component-lifecycle-event-remove-action-of-gameplay': removeEmission,
  'trigger-menu_clear_cancelled_primary-event-observe_menu_primary_clear': [project('src/ui/pointer.rs', '.remove::<(PrimaryPress, Pressed)>()', 'operation', '实际清理：移除 Pressed，命令应用时触发生命周期事件', { all: true }), ...removeEmission],
  ...Object.fromEntries([
    ['event-native_button_down', 'pressed_event'], ['event-native_button_up', 'released_event'],
    ['event-native_button_click', 'click_event'], ['event-native_button_drag_end', 'drag_end_event'],
    ['event-native_button_cancel', 'cancel_event'], ['event-observe_menu_primary_press', 'pressed_event'],
    ['event-observe_scrollbar_press', 'pressed_event'], ['event-observe_menu_scroll', 'scroll_event'],
    ['event-observe_scrollbar_scroll', 'scroll_event'],
  ].map(([event, variable]) => [`trigger-native_pointer_events-${event}`, pointerEmission(variable)])),
  ...Object.fromEntries([
    ['native_button_down', 'press: On<PointerPress>'], ['native_button_up', 'release: On<PointerRelease>'],
    ['native_button_click', 'click: On<PointerClick>'], ['native_button_drag_end', 'drag_end: On<PointerDragEnd>'],
    ['native_button_cancel', 'cancel: On<PointerCancel>'], ['native_button_key', 'event: On<FocusedInput<KeyboardInput>>'],
  ].map(([observer, parameter]) => [`observer-${observer}`, buttonSubscription(parameter)])),
  ...Object.fromEntries([
    ['native_button_up', 110], ['native_button_drag_end', 123], ['native_button_cancel', 136],
  ].map(([observer, line]) => [`trigger-${observer}-event-observe_menu_primary_clear`, [dependency('bevy_ui_widgets', 'src/button.rs', 'commands.entity(button).remove::<Pressed>();', 'operation', '实际移除：原生 Button 移除 Pressed，命令应用时触发生命周期事件', { line }), ...removeEmission]])),
  'trigger-native-focused-keyboard-dispatch-native-focused-keyboard-event': [dependency('bevy_input_focus', 'src/lib.rs', 'commands.trigger(FocusedInput {', 'operation', '实际派发：向焦点实体或主窗口排入键盘事件', { all: true })],
});
