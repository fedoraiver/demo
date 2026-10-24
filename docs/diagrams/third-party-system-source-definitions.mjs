// 集合概览定位到真实枚举成员，聚合检查器节点定位到执行 UI 的核心函数。
function member(packageName, path, enumeration, variant) {
  return { package: packageName, path, pattern: `(?<=^pub enum ${enumeration} \\{[^}]*\\n)^[ \\t]*${variant},` };
}

const input = variant => member('bevy_enhanced_input', 'src/lib.rs', 'EnhancedInputSystems', variant);
const egui = variant => member('bevy_egui', 'src/lib.rs', 'EguiPreUpdateSet', variant);
const physics = variant => member('avian3d', 'src/schedule/mod.rs', 'PhysicsSystems', variant);
const easing = variant => member('bevy_transform_interpolation', 'src/lib.rs', 'TransformEasingSystems', variant);

export const THIRD_PARTY_SYSTEM_SOURCE_DEFINITIONS = {
  enhanced_prepare: input('Prepare'),
  enhanced_evaluate: input('Update'),
  input_apply: input('Apply'),
  input_trigger: input('Trigger'),
  egui_input: egui('ProcessInput'),
  egui_begin: egui('BeginPass'),
  inspector_pass: { package: 'bevy-inspector-egui', path: 'src/quick.rs', symbol: 'world_inspector_ui', kind: 'fn' },
  physics_prepare: physics('Prepare'),
  physics_step: physics('StepSimulation'),
  physics_writeback: physics('Writeback'),
  easing_reset: easing('Reset'),
  easing_end: easing('UpdateEnd'),
  easing_apply: easing('Ease'),
  easing_tick: easing('UpdateEasingTick'),
  easing_start: easing('UpdateStart'),
  'kira-play-typed': member('bevy_kira_audio', 'src/lib.rs', 'AudioSystemSet', 'PlayTypedChannels'),
};
