// 只维护已核实的完整声明身份；短卡片标题不能决定对象归属。
export const SCHEDULE_OBJECT_MAPPING_VERSION = 1;

export const EXISTING_SCHEDULE_SYSTEM_NAMES = Object.freeze({
  inspector_pass: 'bevy_inspector_egui::quick::world_inspector_ui',
  native_pointer_events: 'bevy_picking::events::pointer_events',
  native_update_hovered: 'bevy_picking::hover::update_is_hovered',
  'native-focused-keyboard-dispatch': 'bevy_input_focus::dispatch_focused_input<bevy_input::keyboard::KeyboardInput>',
  'native-scrollbar-layout': 'bevy_ui_widgets::scrollbar::update_scrollbar_thumb',
});

// 两处 add_systems 都存在于正常装配；Startup 仅以 run_if 限制无状态测试用途。
// 旧对象保留进入游戏的身份，另一个真实注册实例复用同声明的数据访问证据。
export const SCHEDULE_REVIEWED_REGISTRATION_SPLITS = Object.freeze({
  startup_spawn: {
    fullName: 'demo::scene_assembly::loading::spawn_lighting',
    reuse: { application: 'main', schedule: 'OnEnter(AppState::InGame)' },
    instances: [{ application: 'main', schedule: 'Startup', scope: 'headless-test', run_if: ['not(resource_exists::<State<AppState>>)'] }],
  },
});

export const EXISTING_SCHEDULE_SET_DECLARATIONS = Object.freeze({
  time_update: ['bevy_time', 'TimeSystems'],
  input_update: ['bevy_input', 'InputSystems'],
  enhanced_prepare: ['bevy_enhanced_input', 'EnhancedInputSystems::Prepare'],
  enhanced_evaluate: ['bevy_enhanced_input', 'EnhancedInputSystems::Update'],
  input_apply: ['bevy_enhanced_input', 'EnhancedInputSystems::Apply'],
  input_trigger: ['bevy_enhanced_input', 'EnhancedInputSystems::Trigger'],
  transform_propagate: ['bevy_transform', 'TransformSystems::Propagate'],
  egui_input: ['bevy_egui', 'EguiPreUpdateSet::ProcessInput'],
  egui_begin: ['bevy_egui', 'EguiPreUpdateSet::BeginPass'],
  physics_prepare: ['avian3d', 'PhysicsSystems::Prepare'],
  physics_step: ['avian3d', 'PhysicsSystems::StepSimulation'],
  physics_writeback: ['avian3d', 'PhysicsSystems::Writeback'],
  easing_reset: ['bevy_transform_interpolation', 'TransformEasingSystems::Reset'],
  easing_end: ['bevy_transform_interpolation', 'TransformEasingSystems::UpdateEnd'],
  easing_apply: ['bevy_transform_interpolation', 'TransformEasingSystems::Ease'],
  easing_tick: ['bevy_transform_interpolation', 'TransformEasingSystems::UpdateEasingTick'],
  easing_start: ['bevy_transform_interpolation', 'TransformEasingSystems::UpdateStart'],
  animation_engine: ['bevy_app', 'AnimationSystems'],
  'ui-style-set': ['demo', 'UiSystems::Style'],
  'kira-play-typed': ['bevy_kira_audio', 'AudioSystemSet::PlayTypedChannels'],
  'native-ui-layout': ['bevy_ui', 'UiSystems::Layout'],
  'native-visibility': ['bevy_camera', 'VisibilitySystems::VisibilityPropagate'],
  picking_last: ['bevy_picking', 'PickingSystems::Last'],
  picking_hover: ['bevy_picking', 'PickingSystems::Hover'],
  picking_post_hover: ['bevy_picking', 'PickingSystems::PostHover'],
});

// 逐项核对既有声明、具体泛型与主世界使用；运行时不按显示名推断复用。
export const EXISTING_MAIN_WORLD_RESOURCE_NAMES = Object.freeze({
  'resource.TimeFixed': 'bevy_time::time::Time<bevy_time::fixed::Fixed>',
  'resource.Time': 'bevy_time::time::Time',
  'resource.TimeReal': 'bevy_time::time::Time<bevy_time::real::Real>',
  'resource.TimeVirtual': 'bevy_time::time::Time<bevy_time::virt::Virtual>',
  'resource.ButtonInputKeyCode': 'bevy_input::button_input::ButtonInput<bevy_input::keyboard::KeyCode>',
  'resource.ButtonInputMouseButton': 'bevy_input::button_input::ButtonInput<bevy_input::mouse::MouseButton>',
  'resource.AccumulatedMouseMotion': 'bevy_input::mouse::AccumulatedMouseMotion',
  'resource.KeyboardInputMessages': 'bevy_ecs::message::messages::Messages<bevy_input::keyboard::KeyboardInput>',
  'resource.KeyboardFocusLostMessages': 'bevy_ecs::message::messages::Messages<bevy_input::keyboard::KeyboardFocusLost>',
  'resource.MouseButtonInputMessages': 'bevy_ecs::message::messages::Messages<bevy_input::mouse::MouseButtonInput>',
  'resource.WindowFocusedMessages': 'bevy_ecs::message::messages::Messages<bevy_window::event::WindowFocused>',
  'resource.MouseMotionMessages': 'bevy_ecs::message::messages::Messages<bevy_input::mouse::MouseMotion>',
  'resource.AssetsMesh': 'bevy_asset::assets::Assets<bevy_mesh::mesh::Mesh>',
  'resource.AssetsStandardMaterial': 'bevy_asset::assets::Assets<bevy_pbr::pbr_material::StandardMaterial>',
  'resource.ClearColor': 'bevy_camera::clear_color::ClearColor',
  'resource.GlobalAmbientLight': 'bevy_light::ambient_light::GlobalAmbientLight',
  'resource.ContextInstances': 'bevy_enhanced_input::context::instance::ContextInstances<bevy_app::main_schedule::PreUpdate>',
  'resource.ActionSources': 'bevy_enhanced_input::context::input_reader::ActionSources',
  'resource.ConsumedInputs': 'bevy_enhanced_input::context::input_reader::ConsumedInputs',
  'resource.PendingBindings': 'bevy_enhanced_input::context::input_reader::PendingBindings',
  'resource.EguiGlobalSettings': 'bevy_egui::EguiGlobalSettings',
  'resource.Gravity': 'avian3d::dynamics::integrator::Gravity',
  'resource.ColliderTrees': 'avian3d::collider_tree::ColliderTrees',
  'resource.CollisionStartMessages': 'bevy_ecs::message::messages::Messages<avian3d::collision::collision_events::CollisionStart>',
  'resource.CollisionEndMessages': 'bevy_ecs::message::messages::Messages<avian3d::collision::collision_events::CollisionEnd>',
  'resource.LastEasingTick': 'bevy_transform_interpolation::LastEasingTick',
  'resource.AssetServer': 'bevy_asset::server::AssetServer',
  'resource.AssetsGltf': 'bevy_asset::assets::Assets<bevy_gltf::assets::Gltf>',
  'resource.AssetsWorldAsset': 'bevy_asset::assets::Assets<bevy_world_serialization::world_asset::WorldAsset>',
  'resource.AssetsAnimationClip': 'bevy_asset::assets::Assets<bevy_animation::AnimationClip>',
  'resource.AssetsAnimationGraph': 'bevy_asset::assets::Assets<bevy_animation::graph::AnimationGraph>',
  'resource.TimePhysics': 'bevy_time::time::Time<avian3d::schedule::time::Physics>',
  'resource.AppTransitionMessages': 'bevy_ecs::message::messages::Messages<bevy_state::state::transitions::StateTransitionEvent<demo::game_flow::AppState>>',
  'resource.PlayTransitionMessages': 'bevy_ecs::message::messages::Messages<bevy_state::state::transitions::StateTransitionEvent<demo::game_flow::PlayState>>',
  'resource.UiAudioChannel': 'bevy_kira_audio::channel::typed::AudioChannel<demo::audio::UiTrack>',
  'resource.SfxAudioChannel': 'bevy_kira_audio::channel::typed::AudioChannel<demo::audio::SfxTrack>',
  'resource.AudioSources': 'bevy_asset::assets::Assets<bevy_kira_audio::source::AudioSource>',
  'resource.AppExitMessages': 'bevy_ecs::message::messages::Messages<bevy_app::app::AppExit>',
  'resource.ContactGraph': 'avian3d::collision::contact_types::contact_graph::ContactGraph',
  'resource.AudioInstances': 'bevy_asset::assets::Assets<bevy_kira_audio::instance::AudioInstance>',
  'resource.LastPhysicsTick': 'avian3d::schedule::LastPhysicsTick',
  'resource.PointerInputMessages': 'bevy_ecs::message::messages::Messages<bevy_picking::pointer::PointerInput>',
  'resource.HoverMap': 'bevy_picking::hover::HoverMap',
  'resource.PreviousHoverMap': 'bevy_picking::hover::PreviousHoverMap',
  'resource.PointerState': 'bevy_picking::events::PointerState',
  'resource.PointerMap': 'bevy_picking::pointer::PointerMap',
});

export const SCHEDULE_CONTEXT_DECLARATIONS = Object.freeze({
  ApplyDeferred: Object.freeze({
    kind: 'Synchronization', name: 'ApplyDeferred · 类型集合端点',
    description: '此端点来自 ApplyDeferred 的系统类型集合，表达本调度中的延迟命令同步依赖；它不是另一个同名函数或额外执行实例。',
    display_summary: '标记延迟命令同步依赖的类型集合端点。',
    package: 'bevy_ecs', path: 'src/schedule/executor/mod.rs', symbol: 'ApplyDeferred', declarationKind: 'struct',
  }),
  '<missing> generate_environment_map_light': Object.freeze({
    kind: 'Scheduling constraint', name: '<missing> generate_environment_map_light',
    description: 'ExtractSchedule 的提取系统通过 after 引用 generate_environment_map_light；目标函数注册在主应用 Update，本调度中没有该系统实例，因此 debugdump 保留缺失目标的类型集合依赖端点。',
    display_summary: '保留本调度中未注册目标系统的顺序约束。',
    package: 'bevy_pbr', path: 'src/light_probe/generate.rs', symbol: 'generate_environment_map_light', declarationKind: 'fn',
    configuration: { contains: 'extract_generated_environment_map_entities.after(generate_environment_map_light)', role: 'configure' },
  }),
});
