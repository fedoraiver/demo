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

export const COMPONENT_BUNDLE_SOURCE_EVIDENCE = Object.freeze({
  'entity-character': [project('src/character/body.rs', 'pub(crate) fn character_body(', 'create', '组件 Bundle 工厂：角色根的动态身体配置'), project('src/scene_assembly/actors.rs', '.insert((character_body(&config), DespawnOnExit(AppState::InGame)))', 'create', '项目插入：把 character_body 返回的 Bundle 插入角色根')],
  'entity-parcel': [project('src/item_interaction/body.rs', 'pub(crate) fn parcel_body(', 'create', '组件 Bundle 工厂：自由物品根的动态身体配置'), project('src/scene_assembly/actors.rs', 'entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))', 'create', '项目插入：把 parcel_body 返回的 Bundle 插入物品根')],
});

export const COMPONENT_SCENE_SOURCE_EVIDENCE = Object.freeze({
  'entity-controller': [project('src/first_person/actions.rs', '        GameplayContext', 'create', 'BSN 根定位：keyboard_context 创建玩法控制者')],
  'entity-island': [project('src/scene_assembly/loading.rs', 'Name("Courier island") IslandMap WorldAssetRoot(scene)', 'create', 'BSN 根定位：island_scene 创建海岛实例根')],
});

const requiredComponent = (packageName, path, contains, label, line) => dependency(packageName, path, contains, 'create', label, line ? { line } : {});
const bodyAssemblies = {
  character: [project('src/character/body.rs', '        RigidBody::Dynamic,', 'create', '项目装配：角色 Bundle 插入 Dynamic 刚体')],
  parcel: [project('src/item_interaction/body.rs', '        RigidBody::Dynamic,', 'create', '项目装配：自由物品 Bundle 插入 Dynamic 刚体')],
  world: [project('src/scene_assembly/loading.rs', '                RigidBody::Static', 'create', '项目装配：静态碰撞子实体插入 Static 刚体', { line: 213 }), project('src/scene_assembly/loading.rs', '                    RigidBody::Static', 'create', '项目装配：展示 NPC 碰撞子实体插入 Static 刚体', { line: 232 })],
};
const rigidBodyRequirements = {
  Position: ['Position::PLACEHOLDER,', 268], Rotation: ['Rotation::PLACEHOLDER,', 269],
  LinearVelocity: ['LinearVelocity,', 270], AngularVelocity: ['AngularVelocity,', 271],
  ComputedMass: ['ComputedMass,', 272], ComputedAngularInertia: ['ComputedAngularInertia,', 273],
  ComputedCenterOfMass: ['ComputedCenterOfMass,', 274], BodySizeMetrics: ['BodySizeMetrics,', 277],
  AccumulatedLocalAcceleration: ['AccumulatedLocalAcceleration,', 279],
};
const rigidBodyComponentEvidence = Object.fromEntries(Object.entries(bodyAssemblies).flatMap(([owner, assembly]) =>
  Object.entries(rigidBodyRequirements).filter(([name]) => owner !== 'world' || ['Position', 'Rotation'].includes(name)).map(([name, [contains, line]]) => [`${owner}.${name}`, [
    ...assembly,
    requiredComponent('avian3d', 'src/dynamics/rigid_body/mod.rs', contains, `框架必需组件：插入 RigidBody 时补齐缺少的 ${name}`, line),
  ]])));
const transformRequirement = requiredComponent('bevy_transform', 'src/components/transform.rs', '    require(GlobalTransform, TransformTreeChanged)', '框架必需组件：插入 Transform 时补齐缺少的 GlobalTransform', 75);
const worldRootTransform = requiredComponent('bevy_world_serialization', 'src/components.rs', '#[require(Transform)]', '框架必需组件：WorldAssetRoot 自动补齐缺少的 Transform', 21);
const gltfRuntimeInsertion = dependency('bevy_world_serialization', 'src/world_asset_spawner.rs', 'world_asset.write_to_world_with(', 'create', '运行实例化：把已加载资产组件写入运行 World', { line: 346 });
const importedComponentEvidence = Object.fromEntries([
  ['model_node.Name', 'node.insert(name.clone());', 'glTF 装配：为模型节点插入名称'],
  ['model_node.Transform', 'let mut node = child_spawner.spawn((transform, Visibility::default()));', 'glTF 装配：创建带局部变换的模型节点'],
  ['model_node.Visibility', 'let mut node = child_spawner.spawn((transform, Visibility::default()));', 'glTF 装配：为模型节点插入可见性'],
  ['model_node.Mesh3d', 'Mesh3d(load_context.get_label_handle(primitive_label.to_string())),', 'glTF 装配：为网格原语子实体插入 Mesh3d'],
  ['model_node.SkinnedMesh', 'entity.insert(SkinnedMesh {', 'glTF 装配：为带蒙皮的网格原语插入蒙皮组件'],
  ['model_node.AnimationTargetId', 'AnimationTargetId::from_names(animation_context.path.iter()),', 'glTF 装配：为动画层级中的节点生成动画目标标识'],
  ['model_node.AnimatedBy', 'AnimatedBy(animation_context.root),', 'glTF 装配：让动画节点关联当前动画根'],
  ['animation_player.AnimationPlayer', '.insert(AnimationPlayer::default());', 'glTF 装配：仅为动画根节点插入 AnimationPlayer'],
  ['menu_model.AnimationPlayer', '.insert(AnimationPlayer::default());', 'glTF 装配：菜单角色的动画根插入 AnimationPlayer'],
].map(([id, contains, label]) => [id, [dependency('bevy_gltf', 'src/loader/mod.rs', contains, 'create', label), gltfRuntimeInsertion]]));

// 这些位置的接收实体和必需组件链已逐项核实；不按短名或同一函数推断投影归属。
export const COMPONENT_SOURCE_EVIDENCE = Object.freeze({
  ...rigidBodyComponentEvidence,
  ...importedComponentEvidence,
  ...Object.fromEntries(['character', 'parcel'].flatMap(owner => [
    ['ResumeInterpolation', 'recovered.remove::<Sleeping>().insert(ResumeInterpolation {', 'entity.remove::<ResumeInterpolation>();'],
    ['NoTranslationEasing', 'recovered.insert(NoTranslationEasing);', 'entity.remove::<NoTranslationEasing>();'],
    ['NoRotationEasing', 'recovered.insert(NoRotationEasing);', 'entity.remove::<NoRotationEasing>();'],
  ].map(([name, insert, remove]) => [`${owner}.${name}`, [
    project('src/bounds_recovery/recovery.rs', insert, 'create', `落水恢复：给当前${owner === 'character' ? '角色' : '物品'}插入 ${name}`),
    project('src/bounds_recovery/recovery.rs', remove, 'destroy', `恢复插值：移除当前${owner === 'character' ? '角色' : '物品'}的 ${name}`),
  ]]))),
  ...Object.fromEntries(['character', 'parcel'].map(owner => [`${owner}.GlobalTransform`, [
    project('src/scene_assembly/actors.rs', '        pose', 'create', `项目装配：${owner === 'character' ? '角色' : '物品'}根插入传入的 Transform`, { line: owner === 'character' ? 24 : 51 }), transformRequirement,
  ]])),
  'camera.GlobalTransform': [project('src/scene_assembly/loading.rs', '        Transform::from_xyz(-1.8, 6.0, 11.5)', 'create', '项目装配：加载相机插入 Transform'), transformRequirement],
  'visual.Transform': [project('src/scene_assembly/actors.rs', 'Name("Courier visual") CharacterVisual CourierVisual(gltf) WorldAssetRoot(scene)', 'create', '项目装配：角色视觉根插入 WorldAssetRoot'), project('src/scene_assembly/actors.rs', 'Children [Name("Carryable visual") WorldAssetRoot(scene)]', 'create', '项目装配：物品视觉子实体插入 WorldAssetRoot'), worldRootTransform],
  'visual.GlobalTransform': [project('src/scene_assembly/actors.rs', 'Name("Courier visual") CharacterVisual CourierVisual(gltf) WorldAssetRoot(scene)', 'create', '项目装配：角色视觉根插入 WorldAssetRoot'), project('src/scene_assembly/actors.rs', 'Children [Name("Carryable visual") WorldAssetRoot(scene)]', 'create', '项目装配：物品视觉子实体插入 WorldAssetRoot'), worldRootTransform, transformRequirement],
  'model_node.GlobalTransform': [dependency('bevy_gltf', 'src/loader/mod.rs', 'let mut node = child_spawner.spawn((transform, Visibility::default()));', 'create', 'glTF 装配：创建带 Transform 的模型节点'), transformRequirement, gltfRuntimeInsertion],
  ...Object.fromEntries(['character', 'parcel', 'world'].map(owner => [`${owner}.ColliderAabb`, [
    ...bodyAssemblies[owner], requiredComponent('avian3d', 'src/collision/collider/parry/mod.rs', '    ColliderAabb,', '框架必需组件：插入 Collider 时补齐缺少的 ColliderAabb', 376),
    ...(owner === 'character' ? [project('src/character/body.rs', '        character_collider(config),', 'create', '项目装配：角色 Bundle 插入胶囊复合碰撞体')]
      : owner === 'parcel' ? [project('src/item_interaction/body.rs', '        Collider::cuboid(size, size, size),', 'create', '项目装配：自由物品 Bundle 插入箱体碰撞形状')]
        : [project('src/scene_assembly/loading.rs', '                collider', 'create', '项目装配：静态碰撞子实体插入已生成的碰撞形状', { line: 214 })]),
  ]])),
  ...Object.fromEntries(['Translation', 'Rotation', 'Scale'].map(axis => [`parcel.${axis}Interpolation`, [
    project('src/item_interaction/body.rs', '        TransformInterpolation,', 'create', '项目装配：自由物品 Bundle 插入完整变换插值标记'),
    requiredComponent('bevy_transform_interpolation', 'src/interpolation.rs', '#[require(TranslationInterpolation, RotationInterpolation, ScaleInterpolation)]', `框架必需组件：完整变换插值补齐 ${axis}Interpolation`, 220),
  ]])),
  ...Object.fromEntries([['character', 'Translation'], ['parcel', 'Translation'], ['parcel', 'Rotation'], ['parcel', 'Scale']].map(([owner, axis]) => [`${owner}.${axis}EasingState`, [
    project(owner === 'character' ? 'src/character/body.rs' : 'src/item_interaction/body.rs', owner === 'character' ? '        TranslationInterpolation,' : '        TransformInterpolation,', 'create', `项目装配：${owner === 'character' ? '角色平移' : '物品完整变换'}插值标记`),
    ...(owner === 'parcel' ? [requiredComponent('bevy_transform_interpolation', 'src/interpolation.rs', '#[require(TranslationInterpolation, RotationInterpolation, ScaleInterpolation)]', `框架必需组件：完整变换插值补齐 ${axis}Interpolation`, 220)] : []),
    requiredComponent('bevy_transform_interpolation', 'src/interpolation.rs', `#[require(${axis}EasingState)]`, `框架必需组件：${axis}Interpolation 补齐 ${axis}EasingState`, { Translation: 229, Rotation: 238, Scale: 247 }[axis]),
  ]])),
  ...Object.fromEntries(['EguiContext', 'EguiMultipassSchedule', 'EguiContextSettings', 'EguiInput', 'EguiFullOutput'].map(name => [`camera.${name}`, [
    project('src/scene_assembly/loading.rs', 'bevy_inspector_egui::bevy_egui::PrimaryEguiContext', 'create', '项目装配：加载相机声明 PrimaryEguiContext'),
    requiredComponent('bevy_egui', 'src/lib.rs', '#[require(EguiContext, EguiSchedule::new(EguiPrimaryContextPass))]', '框架必需组件：PrimaryEguiContext 补齐 EguiContext 与主上下文 Schedule', 467),
    ...(['EguiContextSettings', 'EguiInput', 'EguiFullOutput'].includes(name) ? [requiredComponent('bevy_egui', 'src/lib.rs', `    ${name},`, `框架必需组件：EguiContext 补齐缺少的 ${name}`, { EguiContextSettings: 558, EguiInput: 559, EguiFullOutput: 564 }[name])] : []),
  ]])),
  ...Object.fromEntries(['ContextPriority', 'ContextActivity'].map(name => [`controller.${name}`, [
    project('src/first_person/mod.rs', 'app.add_input_context::<GameplayContext>()', 'create', '项目启用：注册 GameplayContext 的必需状态'),
    project('src/first_person/actions.rs', '        GameplayContext', 'create', '项目装配：键盘控制者插入 GameplayContext'),
    requiredComponent('bevy_enhanced_input', 'src/context.rs', `let _ = self.try_register_required_components::<C, ${name}<C>>();`, `框架必需组件：输入上下文补齐缺少的 ${name}<C>`),
  ]])),
  ...Object.fromEntries(['LookAction', 'MoveAction', 'JumpAction', 'InteractAction'].map(name => [`action.Action<${name}>`, [project('src/first_person/actions.rs', `            Action::<${name}>::new()`, 'create', `关系场景装配：创建独立 ${name} 动作实体`), ...relatedSceneCreation]])),
  ...Object.fromEntries([['Name', 'Name::new(any::type_name::<A>()),', 74], ['ActionFns', 'ActionFns::new::<A>(),', 75], ['ActionValue', 'ActionValue::zero(A::Output::DIM),', 76], ['TriggerState', 'TriggerState,', 78], ['ActionEvents', 'ActionEvents,', 79], ['ActionTime', 'ActionTime,', 80], ['ActionMock', 'ActionMock,', 81]].map(([name, contains, line]) => [`action.${name}`, [
    project('src/first_person/actions.rs', '        Actions<GameplayContext> [', 'create', '项目装配：动作列表分别插入四个已声明的 Action<A>'),
    requiredComponent('bevy_enhanced_input', 'src/action.rs', contains, `框架必需组件：Action<A> 补齐缺少的 ${name}`, line),
  ]])),
  'binding.Binding': [project('src/first_person/actions.rs', 'Bindings [ Binding::mouse_motion() ]', 'create', '关系场景装配：鼠标动作的绑定子实体'), project('src/first_person/actions.rs', 'Bindings [ Binding(KeyCode::Space) ]', 'create', '关系场景装配：跳跃动作的按键绑定'), project('src/first_person/actions.rs', 'Bindings [ Binding(KeyCode::KeyE) ]', 'create', '关系场景装配：交互动作的按键绑定'), dependency('bevy_enhanced_input', 'src/preset/cardinal.rs', 'pub fn wasd_keys() -> impl SceneList', 'create', '预设装配：WASD 返回四个绑定子场景'), ...relatedSceneCreation],
  'binding.FirstActivation': [project('src/first_person/actions.rs', 'Bindings [ Binding::mouse_motion() ]', 'create', '项目装配：绑定子实体插入 Binding'), requiredComponent('bevy_enhanced_input', 'src/binding.rs', '#[require(FirstActivation)]', '框架必需组件：Binding 补齐 FirstActivation', 59)],
  'binding.Negate': [project('src/first_person/actions.rs', 'Bindings [ {preset::cardinal::wasd_keys()} ]', 'create', '项目装配：启用 WASD 方向绑定预设'), dependency('bevy_enhanced_input', 'src/preset/cardinal.rs', '@{super::binding_scene((Negate::all(), west))}', 'create', '预设装配：西向绑定插入 Negate'), dependency('bevy_enhanced_input', 'src/preset/cardinal.rs', '@{super::binding_scene((Negate::all(), south, SwizzleAxis::YXZ))}', 'create', '预设装配：南向绑定插入 Negate')],
  'binding.SwizzleAxis': [project('src/first_person/actions.rs', 'Bindings [ {preset::cardinal::wasd_keys()} ]', 'create', '项目装配：启用 WASD 方向绑定预设'), dependency('bevy_enhanced_input', 'src/preset/cardinal.rs', '@{super::binding_scene((north, SwizzleAxis::YXZ))}', 'create', '预设装配：北向绑定插入轴交换'), dependency('bevy_enhanced_input', 'src/preset/cardinal.rs', '@{super::binding_scene((Negate::all(), south, SwizzleAxis::YXZ))}', 'create', '预设装配：南向绑定插入轴交换')],
  'controller.GameplayContext': [project('src/first_person/actions.rs', '        GameplayContext', 'create', 'BSN：为键盘控制者插入 GameplayContext')],
  'controller.Actions': [project('src/first_person/actions.rs', '        Actions<GameplayContext> [', 'create', '关系场景声明：控制者拥有 GameplayContext 动作列表'), dependency('bevy_enhanced_input', 'src/action/relationship.rs', '#[relationship_target(relationship = ActionOf<C>, linked_spawn)]', 'create', '关系声明：Actions<C> 是 ActionOf<C> 的目标组件'), dependency('bevy_ecs', 'src/relationship/mod.rs', 'let mut target = Self::RelationshipTarget::with_capacity(1);', 'create', '框架关系 hook：首次关联动作时为目标控制者创建 Actions<C>')],
  'character.HoldingItems': [project('src/item_interaction/components.rs', '#[relationship(relationship_target = HoldingItems)]', 'create', '关系声明：HeldBy 的目标自动维护 HoldingItems'), project('src/item_interaction/interaction.rs', '                HeldBy(character),', 'create', '项目触发：拾取物品时将 HeldBy 指向当前角色'), dependency('bevy_ecs', 'src/relationship/mod.rs', 'let mut target = Self::RelationshipTarget::with_capacity(1);', 'create', '框架关系 hook：首次持有物品时为角色创建 HoldingItems')],
  'menu_button.Button': [project('src/ui/widgets.rs', '        MenuButton { action, index }', 'create', '项目装配：菜单按钮场景插入 MenuButton', { all: true }), project('src/ui/mod.rs', '#[require(Button, Node, Hovered, BackgroundColor, BorderColor)]', 'create', '项目必需组件声明：MenuButton 自动补齐缺少的 Button')],
  ...Object.fromEntries(['menu_button', 'menu_scroll'].flatMap(owner => ['ComputedNode', 'UiGlobalTransform'].map(name => [`${owner}.${name}`, [
    ...(owner === 'menu_button' ? [project('src/ui/widgets.rs', '        MenuButton { action, index }', 'create', '项目装配：菜单按钮场景插入 MenuButton', { all: true }), project('src/ui/mod.rs', '#[require(Button, Node, Hovered, BackgroundColor, BorderColor)]', 'create', '项目必需组件声明：MenuButton 自动补齐缺少的 Node')]
      : [project('src/ui/scroll.rs', '        MenuScroll', 'create', '项目装配：滚动区域根声明 MenuScroll', { line: 251 }), project('src/ui/scroll.rs', '        Node {', 'create', '项目装配：滚动区域根声明布局 Node', { line: 252 })]),
    requiredComponent('bevy_ui', 'src/ui_node.rs', name === 'ComputedNode' ? '    ComputedNode,' : '    UiTransform,', `框架必需组件：Node 补齐缺少的 ${name === 'ComputedNode' ? 'ComputedNode' : 'UiTransform'}`, name === 'ComputedNode' ? 464 : 469),
    ...(name === 'UiGlobalTransform' ? [requiredComponent('bevy_ui', 'src/ui_transform.rs', '#[require(UiGlobalTransform)]', '框架必需组件：UiTransform 补齐缺少的 UiGlobalTransform', 143)] : []),
  ]]))),
  'model_node.GltfExtras': [dependency('bevy_gltf', 'src/loader/mod.rs', 'node.insert(GltfExtras {', 'create', 'glTF 装配：仅为含 extras 的模型节点插入 GltfExtras'), dependency('bevy_gltf', 'src/loader/mod.rs', 'mesh_entity.insert(GltfExtras {', 'create', 'glTF 装配：仅为含 extras 的网格原语插入 GltfExtras'), gltfRuntimeInsertion],
  'model_node.MeshMaterial3d': [dependency('bevy_pbr', 'src/gltf.rs', 'entity.insert(MeshMaterial3d(handle));', 'create', 'PBR glTF 扩展装配：网格原语插入 StandardMaterial 句柄'), gltfRuntimeInsertion],
  'controller.PlayerId': [project('src/first_person/actions.rs', '            player_id,', 'create', '装配：把调用方 PlayerId 插入新控制者')],
  'controller.Name': [project('src/first_person/actions.rs', '            Name::new(format!("Keyboard controller {id}")),', 'create', '装配：为新键盘控制者插入运行名称')],
  'controller.DespawnOnExit': [project('src/scene_assembly/actors.rs', '.insert(DespawnOnExit(AppState::InGame));', 'create', '装配：为当前玩法控制者插入会话清理标记')],
  'character.DespawnOnExit': [project('src/scene_assembly/actors.rs', '.insert((character_body(&config), DespawnOnExit(AppState::InGame)))', 'create', '装配：角色根与身体配置一起插入会话清理标记')],
  'parcel.DespawnOnExit': [project('src/scene_assembly/actors.rs', 'entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))', 'create', '装配：物品根与身体配置一起插入会话清理标记')],
  'controller.ControlsCharacter': [project('src/first_person/actions.rs', '            ControlsCharacter(character),', 'create', '装配：新控制者关联当前角色')],
  'controller.ControlsCamera': [project('src/scene_assembly/actors.rs', 'commands.entity(controller).insert(ControlsCamera(camera))', 'create', '装配：资源就绪后让控制者关联复用的相机')],
  'character.Transform': [project('src/scene_assembly/actors.rs', '        pose', 'create', 'BSN：角色根装配传入的 Transform', { line: 24 })],
  'parcel.Transform': [project('src/scene_assembly/actors.rs', '        pose', 'create', 'BSN：物品根装配传入的 Transform', { line: 51 })],
  'character.CarryBaseMass': [project('src/item_interaction/attachment.rs', 'commands.entity(holder).insert(CarryBaseMass(holder_mass.0))', 'create', '持握开始：为持有者保存基础质量')],
  'island.IslandPending': [project('src/scene_assembly/loading.rs', 'commands.entity(ready.entity).insert(IslandPending);', 'create', '资源就绪：为匹配的海岛实例根插入碰撞装配等待标记')],
  'island.IslandReady': [project('src/scene_assembly/loading.rs', '.insert(IslandReady { player, items });', 'create', '碰撞准备完成：为海岛根插入玩家与物品放置清单')],
  'island.ActorsSpawned': [project('src/scene_assembly/actors.rs', 'commands.entity(map).insert(ActorsSpawned);', 'create', '动态装配完成：为当前海岛根插入完成标记')],
  'visual.CourierAnimationPending': [project('src/character_animation/binding.rs', '.insert(CourierAnimationPending);', 'create', '角色视觉根资源就绪：等待动画玩家绑定')],
  'visual.CourierFootGrounding': [project('src/character_animation/binding.rs', 'commands.entity(visual_root).insert(CourierFootGrounding {', 'create', '足底标记齐备：为角色视觉根插入接地显示状态')],
  'animation_player.CourierAnimation': [project('src/character_animation/binding.rs', '                CourierAnimation {', 'create', '绑定：为当前角色视觉树中的动画玩家插入播放状态')],
  'animation_player.AnimationGraphHandle': [project('src/character_animation/binding.rs', 'AnimationGraphHandle(graph_handle.clone()),', 'create', '绑定：为当前角色视觉树中的动画玩家插入动画图句柄')],
  'menu_model.CourierAnimationPending': [project('src/ui/backdrop.rs', '.insert(CourierAnimationPending);', 'create', '菜单角色根资源就绪：等待独立展示动画绑定')],
  'menu_model.AnimationGraphHandle': [project('src/ui/backdrop.rs', '.insert(AnimationGraphHandle(graph.clone()));', 'create', '菜单展示子树：为真实动画玩家插入动画图句柄')],
  'menu_text.DescriptionTitle': [project('src/ui/pages.rs', '            DescriptionTitle', 'create', 'BSN：设置说明标题文字添加身份标记')],
  'menu_text.DescriptionBody': [project('src/ui/pages.rs', '            DescriptionBody', 'create', 'BSN：设置说明正文文字添加身份标记')],
  'menu_text.SettingsStatus': [project('src/ui/pages.rs', '@label(theme, status.to_owned(), 17.0, MUTED) SettingsStatus', 'create', 'BSN：设置状态文字添加更新目标标记')],
  'menu_text.SettingValue': [project('src/ui/widgets.rs', '                    SettingValue(key)', 'create', 'BSN：设置值文字添加对应字段标记')],
  'menu_text.VolumeValue': [project('src/ui/volume.rs', '                    VolumeValue(key)', 'create', 'BSN：音量值文字添加对应音量字段标记')],
  'menu_button.VolumeSlider': [project('src/ui/volume.rs', '                VolumeSlider { key }', 'create', 'BSN：音量滑条按钮添加字段标记')],
  'menu_button.SettingDescription': [
    ...[252, 272].map(line => project('src/ui/widgets.rs', '                details', 'create', 'BSN：步进按钮装配已构造的 SettingDescription', { line })),
    ...[105, 110, 157].map(line => project('src/ui/volume.rs', 'details', 'create', 'BSN：音量按钮装配已构造的 SettingDescription', { line })),
  ],
  'parcel.HeldBy': [project('src/item_interaction/interaction.rs', '                HeldBy(character),', 'create', '拾取成功：为当前物品插入持有者关系')],
  'parcel.HeldAttachment': [project('src/item_interaction/attachment.rs', '        HeldAttachment {', 'create', 'begin_attachment：给当前物品插入挂接状态')],
  'parcel.RigidBody': [project('src/item_interaction/attachment.rs', 'commands.entity(item).remove::<RigidBody>()', 'destroy', '持握开始：移除当前物品的独立刚体')],
  'parcel.ResumeCarryEasing': [project('src/item_interaction/lifecycle.rs', 'item_entity.insert(ResumeCarryEasing {', 'create', '释放物品：按原挂接状态插入插值恢复标记')],
  'camera.FirstPersonCamera': [project('src/scene_assembly/actors.rs', '            first_person,', 'create', '装配：把角色目标对应的第一人称状态插入加载相机')],
  'camera.MouseLookState': [project('src/scene_assembly/actors.rs', '            MouseLookState::default(),', 'create', '装配：为复用的玩法相机初始化观察输入状态')],
  'camera.LoadingCamera': [project('src/scene_assembly/loading.rs', '        LoadingCamera', 'create', 'BSN：为加载相机添加阶段标记'), project('src/scene_assembly/actors.rs', 'commands.entity(camera).remove::<LoadingCamera>()', 'destroy', '玩法装配完成：移除加载阶段标记')],
  'menu_controller.MenuContext': [project('src/ui/navigation.rs', '        MenuContext', 'create', 'BSN：菜单控制者装配独立输入上下文')],
  'menu_controller.ContextPriority': [project('src/ui/navigation.rs', '        ContextPriority::<MenuContext>::new(10)', 'create', 'BSN：菜单控制者装配输入优先级')],
  'menu_controller.ContextActivity': [project('src/ui/navigation.rs', '.insert(ContextActivity::<MenuContext>::new(focused))', 'create', '上下文同步：为菜单控制者插入当前聚焦活动状态')],
  'menu_controller.GamepadDevice': [project('src/ui/navigation.rs', '        GamepadDevice::Any', 'create', 'BSN：菜单控制者接受任意手柄')],
  'menu_controller.Actions': [project('src/ui/navigation.rs', '        Actions<MenuContext> [', 'create', 'BSN：为菜单控制者装配动作关系列表')],
  'held_proxy.HeldCollider': [project('src/item_interaction/attachment.rs', '                HeldCollider(item),', 'create', '挂接就绪：给 attachment.collider 代理插入物品归属')],
  'held_proxy.Name': [project('src/item_interaction/attachment.rs', 'Name::new("Held parcel collision proxy"),', 'create', '挂接就绪：为当前持物碰撞代理插入名称')],
  'held_proxy.ColliderOf': [project('src/item_interaction/attachment.rs', '.insert(ColliderOf { body: holder })', 'create', '挂接就绪：让当前代理碰撞体关联持有者刚体')],
  'held_proxy.ColliderTransform': [project('src/item_interaction/attachment.rs', '.insert(ColliderTransform::from(attachment.local_pose));', 'create', '挂接就绪：为当前碰撞代理插入局部姿态')],
  'held_proxy.ColliderDisabled': [project('src/item_interaction/attachment.rs', '.insert(ColliderDisabled);', 'create', '挂接就绪：原碰撞体已停用时给当前代理插入停用标记', { line: 101 })],
  'held_proxy.Collider': [project('src/item_interaction/attachment.rs', '                collider.clone(),', 'create', '挂接就绪：给代理装配物品碰撞形状')],
  'held_proxy.CollisionLayers': [project('src/item_interaction/attachment.rs', '                *layers,', 'create', '挂接就绪：给代理装配物品碰撞层')],
  'held_proxy.Friction': [project('src/item_interaction/attachment.rs', '                *friction,', 'create', '挂接就绪：给代理装配物品摩擦参数')],
  'held_proxy.Restitution': [project('src/item_interaction/attachment.rs', '                *restitution,', 'create', '挂接就绪：给代理装配物品恢复参数')],
  'held_proxy.Transform': [project('src/item_interaction/attachment.rs', '                Transform::IDENTITY,', 'create', '挂接就绪：给代理装配局部恒等变换')],
  'held_proxy.CollisionEventsEnabled': [project('src/item_interaction/attachment.rs', '                CollisionEventsEnabled,', 'create', '挂接就绪：为代理启用碰撞事件')],
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
  'read-resource.GameSettings-frame_limit': [project('src/settings/frame_pacing.rs', 'if *applied_max_fps == Some(settings.max_fps)', 'operation', '读取 max_fps：与已应用值比较，决定是否同步更新策略')],
  'read-local.FramePacing-frame_limit': [project('src/settings/frame_pacing.rs', 'if *applied_max_fps == Some(settings.max_fps)', 'operation', '读取 Local 缓存：跳过未变化的帧率设置')],
  'write-frame_limit-local.FramePacing': [project('src/settings/frame_pacing.rs', '*applied_max_fps = Some(settings.max_fps);', 'operation', '实际赋值：策略更新后保存已应用帧率')],
  'write-frame_limit-resource.WinitSettings': [
    project('src/settings/frame_pacing.rs', 'winit.focused_mode = mode;', 'operation', '实际赋值：更新前台窗口循环策略'),
    project('src/settings/frame_pacing.rs', 'winit.unfocused_mode = mode;', 'operation', '实际赋值：更新后台窗口循环策略'),
  ],
  'registration-plugin-SettingsPlugin-resource.WinitSettings': [
    project('src/settings/mod.rs', 'frame_pacing::register(app);', 'configure', '项目装配：SettingsPlugin 启用帧率设置同步'),
    project('src/settings/frame_pacing.rs', 'app.init_resource::<WinitSettings>()', 'initialize', '实际初始化：仅资源不存在时插入默认窗口更新策略'),
  ],
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
