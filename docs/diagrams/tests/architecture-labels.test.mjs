import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { architectureDisplayName, shortArchitecturePaths } from '../src/architecture-labels.mjs';

test('callable titles retain only the function or method and the nearest closure context', () => {
  const cases = [
    ['demo::settings::frame_pacing::log_simulation_timestep', 'log_simulation_timestep'],
    ['bevy_asset::Assets<path::T>::asset_events_condition', 'asset_events_condition'],
    ['demo::function<bevy::Assets<path::T>, other::U>', 'function'],
    ['demo::function::<bevy::Assets<path::T>>', 'function'],
    ['<demo::Type as dep::Trait>::method::<dep::T>', 'method'],
    ['demo::function<fn() -> dep::Type>::method', 'method'],
    ['demo::register<dep::Type>::{{closure}}', 'register::{{closure}}'],
    ['demo::register::{{closure}}::{{closure}}', 'register::{{closure}}::{{closure}}'],
    ['demo::register::{closure#0}', 'register::{closure#0}'],
    ['plain_function', 'plain_function'],
    ['r#mod::r#type::<dep::T>', 'r#type'],
  ];
  for (const kind of ['System', 'Observer', 'Registration helper']) for (const [name, expected] of cases) {
    assert.equal(architectureDisplayName(name, { kind }), expected, `${kind}: ${name}`);
  }
});

test('type titles recursively shorten paths and retain Rust display structure and literals', () => {
  const cases = [
    ['bevy_asset::Assets<bevy_sprite_render::tilemap_chunk::tilemap_chunk_material::TilemapChunkMaterial>', 'Assets<TilemapChunkMaterial>'],
    ['demo::Outer<dep::Inner<core::option::Option<dep::T>>, dep::U>', 'Outer<Inner<Option<T>>, U>'],
    ["&'a mut demo::Outer<(&'b dep::T, [dep::U; 4])>", "&'a mut Outer<(&'b T, [U; 4])>"],
    ['(*const dep::T, *mut dep::U, [dep::T; 3], (dep::V,))', '(*const T, *mut U, [T; 3], (V,))'],
    ['<demo::Type<dep::T> as dep::Trait<dep::U>>::Item<dep::V>', '<Type<T> as Trait<U>>::Item<V>'],
    ['demo::Outer<dep::Inner<dep::T>>::Associated', 'Outer<Inner<T>>::Associated'],
    ['demo::Text<"dep::literal & \\"quoted\\"", dep::T>', 'Text<"dep::literal & \\"quoted\\"", T>'],
    ['demo::数据<dep::状态>', '数据<状态>'],
  ];
  for (const [name, expected] of cases) assert.equal(architectureDisplayName(name, { kind: 'Resource' }), expected, name);
});

test('SystemSet Debug wrappers and callable sets preserve their display structure', () => {
  for (const [name, expected] of [
    ['ExitSchedules(PhantomData<demo::game_flow::AppState>)', 'ExitSchedules(PhantomData<AppState>)'],
    ['demo::Set { state: demo::AppState, inner: dep::Wrapper<dep::T> }', 'Set { state: AppState, inner: Wrapper<T> }'],
    ['SystemTypeSet:bevy_pbr::light_probe::generate::generate_environment_map_light<dep::T>', 'SystemTypeSet:generate_environment_map_light'],
    ['SystemTypeSet:demo::register::{{closure}}', 'SystemTypeSet:register::{{closure}}'],
    ['AnonymousSet(0)', 'AnonymousSet(0)'],
  ]) assert.equal(architectureDisplayName(name, { kind: 'SystemSet' }), expected, name);
});

test('anonymous group closures use their nearest function without shortening structural group members', () => {
  const name = 'bevy_egui::input_system_is_enabled<<bevy_egui::EguiPlugin as bevy_app::plugin::Plugin>::build::{{closure}}>::{{closure}}';
  assert.equal(architectureDisplayName(name, { kind: 'System group' }), 'input_system_is_enabled::{{closure}}');
  assert.equal(architectureDisplayName('demo::Group<(dep::First, dep::Second)>', { kind: 'System group' }), 'Group<(First, Second)>');
});

test('runtime parameter-tuple system names retain their structure when no function leaf exists', () => {
  const name = "(bevy_ecs::system::system_param::Local<'_, alloc::vec::Vec<bevy_enhanced_input::binding::Binding>>, bevy_enhanced_input::context::time::ContextTime<'_>, bevy_enhanced_input::context::input_reader::InputReader<'_, '_>, bevy_ecs::change_detection::params::Res<'_, bevy_enhanced_input::context::instance::ContextInstances<bevy_app::main_schedule::PreUpdate>>, bevy_ecs::system::query::Query<'_, '_, bevy_ecs::world::entity_access::filtered::FilteredEntityMut<'_, '_>>, bevy_ecs::system::query::Query<'_, '_, (bevy_ecs::entity::Entity, &bevy_ecs::name::Name, &bevy_enhanced_input::action::ActionSettings, core::option::Option<&bevy_enhanced_input::binding::relationship::Bindings>, core::option::Option<&bevy_enhanced_input::modifier::fns::ModifierFns>, core::option::Option<&bevy_enhanced_input::condition::fns::ConditionFns>, &mut bevy_enhanced_input::action::mock::ActionMock), bevy_ecs::query::filter::Without<bevy_enhanced_input::context::ExternallyMocked>>, bevy_ecs::system::query::Query<'_, '_, (&mut bevy_enhanced_input::action::value::ActionValue, &mut bevy_enhanced_input::action::TriggerState, &mut bevy_enhanced_input::action::events::ActionEvents, &mut bevy_enhanced_input::action::ActionTime)>, bevy_ecs::system::query::Query<'_, '_, (bevy_ecs::entity::Entity, &bevy_enhanced_input::binding::Binding, &mut bevy_enhanced_input::binding::FirstActivation, core::option::Option<&bevy_enhanced_input::modifier::fns::ModifierFns>, core::option::Option<&bevy_enhanced_input::condition::fns::ConditionFns>), bevy_ecs::query::filter::Without<bevy_enhanced_input::action::ActionSettings>>, bevy_ecs::system::query::Query<'_, '_, bevy_ecs::world::entity_access::filtered::FilteredEntityMut<'_, '_>>)";
  const expected = "(Local<'_, Vec<Binding>>, ContextTime<'_>, InputReader<'_, '_>, Res<'_, ContextInstances<PreUpdate>>, Query<'_, '_, FilteredEntityMut<'_, '_>>, Query<'_, '_, (Entity, &Name, &ActionSettings, Option<&Bindings>, Option<&ModifierFns>, Option<&ConditionFns>, &mut ActionMock), Without<ExternallyMocked>>, Query<'_, '_, (&mut ActionValue, &mut TriggerState, &mut ActionEvents, &mut ActionTime)>, Query<'_, '_, (Entity, &Binding, &mut FirstActivation, Option<&ModifierFns>, Option<&ConditionFns>), Without<ActionSettings>>, Query<'_, '_, FilteredEntityMut<'_, '_>>)";
  assert.equal(architectureDisplayName(name, { kind: 'System' }), expected);
});

test('natural language and Entity or Local responsibility names remain verbatim', () => {
  for (const name of ['角色业务根实体', 'Local movement state', '说明 demo::Type 的用途', '说明：demo::Type', 'keeps demo::Type alive', 'View/Projection', 'already_short']) {
    for (const kind of ['System', 'Resource']) assert.equal(architectureDisplayName(name, { kind }), name);
  }
  for (const kind of ['Entity', 'Local']) assert.equal(architectureDisplayName('demo::Role<dep::T>', { kind }), 'demo::Role<dep::T>');
  assert.equal(shortArchitecturePaths('In multiple sets, demo::State, Other(PhantomData<dep::T>)'), 'In multiple sets, State, Other(PhantomData<T>)');
});

test('the same label helper bundles and executes without Node dependencies', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/architecture-labels.mjs', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'esm' });
  const browser = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  assert.equal(browser.architectureDisplayName('demo::Assets<dep::T>', { kind: 'Resource' }), 'Assets<T>');
  assert.equal(browser.architectureDisplayName('demo::system<dep::T>', { kind: 'System' }), 'system');
});
