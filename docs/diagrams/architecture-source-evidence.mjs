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
  EguiGlobalSettings: 'bevy_egui', EnableMultipassForPrimaryContext: 'bevy_egui',
  Gravity: 'avian3d', ColliderTrees: 'avian3d', ContactGraph: 'avian3d', Physics: 'avian3d',
  CollisionStart: 'avian3d', CollisionEnd: 'avian3d', LastEasingTick: 'bevy_transform_interpolation',
  AudioChannel: 'bevy_kira_audio', AudioSource: 'bevy_kira_audio', AudioInstance: 'bevy_kira_audio',
  WorldInstanceReady: 'bevy_world_serialization', Pointer: 'bevy_picking', Scroll: 'bevy_picking',
  Press: 'bevy_picking', Add: 'bevy_ecs', Remove: 'bevy_ecs', Despawn: 'bevy_ecs',
  ChildOf: 'bevy_ecs', AnimatedBy: 'bevy_animation', ColliderOf: 'avian3d',
  ActionOf: 'bevy_enhanced_input', BindingOf: 'bevy_enhanced_input', Scrollbar: 'bevy_ui_widgets',
});

const project = (path, contains, role, label, extra = {}) => ({ path, contains, role, label, ...extra });
const dependency = (packageName, path, contains, role, label, extra = {}) => ({ package: packageName, path, contains, role, label, ...extra });
const stateCleanup = dependency('bevy_state', 'src/state_scoped.rs', 'commands.entity(entity).try_despawn();', 'destroy', '框架执行：退出状态后销毁匹配的实体', { line: 183 });
const gameExit = project('src/ui/requests.rs', 'app_state.set(AppState::MainMenu)', 'destroy', '触发退出游戏会话：切换至 MainMenu');
const rootState = (path, contains, extra = {}) => [project(path, contains, 'destroy', '配置：DespawnOnExit(AppState::InGame)', extra), gameExit, stateCleanup];
const menuCleanup = [project('src/ui/backdrop.rs', 'template_value(DespawnOnExit(AppState::MainMenu))', 'destroy', '配置：退出主菜单时清理展示舞台'), stateCleanup];
const pageCleanup = project('src/ui/pages.rs', 'commands.entity(entity).despawn();', 'destroy', '页面结构变化或隐藏：销毁旧菜单根及其后代');

export const ENTITY_SOURCE_EVIDENCE = Object.freeze({
  'entity-controller': [project('src/first_person/actions.rs', '.spawn((', 'create', '创建：spawn_keyboard_controller'), ...rootState('src/scene_assembly/actors.rs', '.insert(DespawnOnExit(AppState::InGame));')],
  'entity-character': [project('src/scene_assembly/actors.rs', '.spawn_scene(courier_scene(', 'create', '创建：装配角色业务根'), project('src/scene_assembly/actors.rs', 'Name("Courier")', 'create', 'BSN：角色根的组件组合'), ...rootState('src/scene_assembly/actors.rs', '.insert((character_body(&config), DespawnOnExit(AppState::InGame)))')],
  'entity-parcel': [project('src/scene_assembly/actors.rs', 'let mut entity = commands.spawn_scene(carryable_scene', 'create', '创建：独立可搬物品业务根'), project('src/scene_assembly/actors.rs', 'Name({model.name()})', 'create', 'BSN：可搬物品根的组件组合'), ...rootState('src/scene_assembly/actors.rs', 'entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))')],
  'entity-camera': [project('src/scene_assembly/loading.rs', 'commands.spawn_scene(bsn!', 'create', '创建：加载相机，随后复用为玩法相机', { line: 17 }), ...rootState('src/scene_assembly/loading.rs', 'template_value(DespawnOnExit(AppState::InGame))', { line: 22 })],
  'entity-visual': [project('src/scene_assembly/actors.rs', 'Name("Courier visual")', 'create', 'BSN：角色直属视觉根'), project('src/scene_assembly/actors.rs', 'Children [(Name("Carryable visual")', 'create', 'BSN：物品直属视觉根')],
  'entity-window': [dependency('bevy_window', 'src/lib.rs', 'app.world_mut().spawn(primary_window.clone())', 'create', '框架创建：WindowPlugin 创建主窗口'), dependency('bevy_window', 'src/lib.rs', 'app.add_systems(Last, close_when_requested.before(ExitSystems))', 'destroy', '配置：WindowPlugin 在 Last 中注册窗口关闭清理'), dependency('bevy_window', 'src/system.rs', 'commands.entity(window).despawn();', 'destroy', '框架执行：窗口关闭标记后销毁窗口实体')],
  'entity-action': [project('src/first_person/actions.rs', 'actions!(GameplayContext[', 'create', '配置：玩法动作子实体列表'), dependency('bevy_enhanced_input', 'src/action/relationship.rs', '::bevy::prelude::related!($crate::prelude::Actions<$context>', 'create', '框架执行：actions! 通过 related! 创建动作关系实体')],
  'entity-binding': [project('src/first_person/actions.rs', 'bindings![Binding::mouse_motion()]', 'create', '配置：鼠标绑定子实体'), project('src/first_person/actions.rs', 'Bindings::spawn(Cardinal::wasd_keys())', 'create', '配置：WASD 绑定子实体'), dependency('bevy_enhanced_input', 'src/binding/relationship.rs', '::bevy::prelude::related!($crate::prelude::Bindings[', 'create', '框架执行：bindings! 通过 related! 创建绑定关系实体')],
  'entity-world': [project('src/scene_assembly/loading.rs', 'commands.spawn_scene(bsn!', 'create', '创建：地图静态碰撞子实体', { line: 210 }), project('src/scene_assembly/loading.rs', 'Name("Display NPC collider")', 'create', 'BSN：展示 NPC 碰撞子实体')],
  'entity-island': [project('src/scene_assembly/loading.rs', 'commands.spawn_scene(island_scene(scene.clone()))', 'create', '创建：海岛实例根'), ...rootState('src/scene_assembly/loading.rs', 'template_value(DespawnOnExit(AppState::InGame))', { line: 34 })],
  'entity-npc': [],
  'entity-animation_player': [],
  'entity-model_node': [],
  'entity-menu_controller': [project('src/ui/navigation.rs', 'commands.spawn((', 'create', '创建：跨页面保留的菜单控制者')],
  'entity-menu_root': [project('src/ui/pages.rs', 'commands.spawn_scene(page_scene(', 'create', '创建：当前菜单页面根'), project('src/ui/pages.rs', '        MenuRoot', 'create', 'BSN：菜单根组件组合'), pageCleanup],
  'entity-menu_button': [project('src/ui/widgets.rs', 'template_value(MenuButton { action, index })', 'create', 'BSN：菜单按钮组件组合', { all: true }), pageCleanup],
  'entity-menu_scroll': [project('src/ui/scroll.rs', '        MenuScroll', 'create', 'BSN：设置内容视口'), pageCleanup],
  'entity-menu_backdrop': [project('src/ui/backdrop.rs', '.spawn_scene(bsn!', 'create', '创建：独立主菜单展示舞台'), ...menuCleanup],
  'entity-menu_camera': [project('src/ui/backdrop.rs', '        #MenuCamera', 'create', 'BSN：展示舞台相机'), ...menuCleanup],
  'entity-menu_model': [project('src/ui/backdrop.rs', '        WorldAssetRoot(path)', 'create', 'BSN：菜单模型实例根'), project('src/ui/backdrop.rs', 'WorldAssetRoot("models/characters/chr_courier.glb#Scene0")', 'create', 'BSN：菜单快递员实例根'), ...menuCleanup],
  'entity-menu_text': [project('src/ui/widgets.rs', '        Text(value)', 'create', 'BSN：菜单文字叶节点', { all: true }), pageCleanup],
  'entity-menu_volume': [project('src/ui/volume.rs', 'template_value(VolumeFill(key))', 'create', 'BSN：音量填充节点'), pageCleanup],
  'entity-settings_panel': [project('src/ui/pages.rs', '                        SettingsPanel', 'create', 'BSN：设置内容面板'), pageCleanup],
  'entity-settings_scrollbar': [project('src/ui/scroll.rs', 'template_value(SettingsScrollbar { min_thumb_length:', 'create', 'BSN：设置滚动条轨道'), pageCleanup],
  'entity-settings_scrollbar_thumb': [project('src/ui/scroll.rs', '            SettingsScrollbarThumb', 'create', 'BSN：原生滚动条滑块'), pageCleanup],
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
  'physics-file-log': [project('src/session_log/lifecycle.rs', 'fn create_session_file(', 'create', '创建：会话日志文件'), project('src/session_log/output.rs', 'sink.write_all(&bytes)', 'implementation', '执行：后台线程把排队记录写入文件'), project('src/session_log/lifecycle.rs', 'self.file_worker.shutdown()', 'close', '关闭：会话守卫等待文件后台线程刷新退出')],
  'log-file-worker': [project('src/session_log/output.rs', 'fn spawn(', 'create', '创建：文件后台线程', { all: true }), project('src/session_log/output.rs', 'sink.write_all(&bytes)', 'implementation', '执行：排队记录写入 sink'), project('src/session_log/output.rs', 'fn shutdown(', 'close', '关闭：提交 Shutdown 并等待线程退出')],
  'log-producer': [project('src/session_log/lifecycle.rs', '.remove_resource::<SessionWriter>()', 'close', '关闭：取出并刷新文件日志生产者')],
  'log-console-worker': [project('src/session_log/lifecycle.rs', '.remove_resource::<ConsoleWriter>()', 'close', '关闭：取出并刷新控制台日志生产者'), project('src/session_log/output.rs', 'sink.write_all(&bytes)', 'implementation', '执行：排队记录写入控制台 sink'), project('src/session_log/lifecycle.rs', 'self.console_worker.shutdown()', 'close', '关闭：会话守卫等待控制台后台线程刷新退出')],
  'window-native-policy': [project('src/window_policy/windows.rs', 'pub(super) fn install(', 'install', 'Windows：安装原生窗口策略'), project('src/window_policy/macos.rs', 'pub(super) fn install(', 'install', 'macOS：安装原生窗口策略'), project('src/window_policy/windows.rs', 'fn drop(&mut self)', 'close', 'Windows：NativeWindowPolicy 释放子类注册'), project('src/window_policy/macos.rs', 'fn drop(&mut self)', 'close', 'macOS：NativeWindowPolicy 释放原生策略')],
  'native-window-events': [project('src/window_policy/windows.rs', 'fn window_subclass(', 'definition', 'Windows：窗口子类事件回调定义'), project('src/window_policy/windows.rs', '        SetWindowSubclass(', 'install', 'Windows：向 OS 注册窗口回调'), project('src/window_policy/windows.rs', 'RemoveWindowSubclass(self.hwnd', 'close', 'Windows：卸载 OS 窗口回调')],
});
