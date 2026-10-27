import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { instance } from '@viz-js/viz';
import { buildSchedulePluginGroups } from './schedule-plugins.mjs';
import { parseScheduleGraph, scheduleNodeKind } from './schedule-graph.mjs';

const features = [
  { id: 'audio', plugin: 'GameAudioPlugin', label: '音频' },
  { id: 'game_flow', plugin: 'GameFlowPlugin', label: '流程' },
  { id: 'session_log', plugin: 'SessionLogPlugin', label: '日志' },
];
const system = (tooltip, index = 0, attributes = {}) => ({ name: 'system-' + index, attributes: { tooltip, ...attributes } });
const view = nodes => ({ id: 'schedule-one', aspect: 'schedule', scheduleGraph: { nodes, edges: [], subgraphs: [] } });
const build = nodes => buildSchedulePluginGroups({ model: { features }, views: [view(nodes)] });
const memberships = result => Object.fromEntries(result.views[0].schedulePluginGroups.map(group => [group.id, group.systemNames]));

test('project Plugins retain source order and include Plugins without registered systems', () => {
  const result = build([system('demo::game_flow::pause'), system('demo::audio::mix')]);
  assert.deepEqual(result.catalog, features.map(feature => ({ id: 'plugin-' + feature.plugin, label: feature.plugin,
    description: feature.label + ' · demo::' + feature.id })));
  assert.deepEqual(result.views[0].schedulePluginGroups.map(group => group.id), ['plugin-GameAudioPlugin', 'plugin-GameFlowPlugin']);
});

test('outer crate wins over project and dependency generic parameters', () => {
  const name = 'bevy_kira_audio::output::play<demo::audio::Track, avian3d::Body>';
  const result = build([system(name)]);
  assert.deepEqual(memberships(result), { 'crate:bevy_kira_audio': [name] });
  assert.deepEqual(result.catalog.at(-1), { id: 'crate:bevy_kira_audio', label: 'bevy_kira_audio', description: '依赖系统来源' });
});

test('qualified trait methods use trait source rather than the receiver or generic parameter', () => {
  const names = [
    '<demo::game_flow::AppState as bevy_state::state::StateSet>::register<demo::audio::Track>::{{closure}}',
    '<avian3d::Diagnostics as avian3d::PhysicsDiagnostics>::reset',
    '<bevy_ecs::Type<demo::audio::Track>>::method',
  ];
  assert.deepEqual(memberships(build(names.map((name, index) => system(name, index)))), {
    'crate:avian3d': [names[1]], 'crate:bevy_ecs': [names[2]], 'crate:bevy_state': [names[0]],
  });
});

test('Pipe sources are recursive and ignore commas nested in generic, tuple, array and function types', () => {
  const name = 'Pipe(demo::audio::mix<(a::A, b::B), [c::C; 2], fn() -> d::D, { (1, 2) }>, Pipe(bevy_state::last<demo::game_flow::State>, avian3d::step))';
  assert.deepEqual(memberships(build([system(name)])), {
    'plugin-GameAudioPlugin': [name], 'crate:avian3d': [name], 'crate:bevy_state': [name],
  });
});

test('same-source Pipe stages count the registered system once in that group', () => {
  const name = 'Pipe(bevy_state::first, bevy_state::second)';
  assert.deepEqual(build([system(name)]).views[0].schedulePluginGroups, [{ id: 'crate:bevy_state', systemNames: [name], systemCount: 1 }]);
});

test('unknown Pipe stages remain cancellable through the unclassified group', () => {
  const name = 'Pipe(bevy_state::first, unnamed-system)';
  assert.deepEqual(memberships(build([system(name)])), { 'crate:bevy_state': [name], 'source:unclassified': [name] });
});

test('tuple parameters, unknown project features and malformed names remain unclassified', () => {
  const names = ['(bevy_ecs::Res<bevy_enhanced_input::Bindings>, demo::audio::Track)', 'demo::unknown::system',
    'unnamed', 'Pipe(a::one, b::two, c::three)', 'Pipe(a::one<broken, b::two)', '<a::Type as b::Trait', '<a::Type>missing-method'];
  const result = build(names.map((name, index) => system(name, index)));
  assert.deepEqual(memberships(result), { 'source:unclassified': names });
  assert.deepEqual(result.catalog.at(-1), { id: 'source:unclassified', label: '未归类', description: '导出名称未提供可识别的系统来源' });
});

test('group system names are deduplicated while markers and native context endpoints are omitted', () => {
  const names = ['z_crate::system', 'a_crate::system'];
  const result = build([system(names[0]), system(names[0], 1), system(names[1], 2), system('other::marker', 3, { style: 'filled,invis' }),
    { name: 'context', attributes: { label: 'ApplyDeferred' } }]);
  assert.deepEqual(result.catalog.slice(features.length).map(group => group.id), ['crate:a_crate', 'crate:z_crate']);
  assert.deepEqual(memberships(result), { 'crate:a_crate': [names[1]], 'crate:z_crate': [names[0]] });
  assert.deepEqual(result.views[0].schedulePluginGroups.map(group => group.systemCount), [1, 2]);
});

test('empty catalog is valid and input views, raw graphs and object views remain unchanged', () => {
  assert.deepEqual(buildSchedulePluginGroups({ model: {}, views: [] }), { catalog: [], views: [] });
  const schedule = view([system('demo::audio::mix')]), object = { aspect: 'object', id: 'object-one' };
  const input = { model: { features }, views: [schedule, object] }, before = structuredClone(input);
  const result = buildSchedulePluginGroups(input);
  assert.deepEqual(input, before);
  assert.equal(result.views[0].scheduleGraph, schedule.scheduleGraph);
  assert.equal(result.views[1], object);
  assert.deepEqual(buildSchedulePluginGroups({ model: {}, views: [view([])] }).views[0].schedulePluginGroups, []);
});

test('all real Schedule systems have a source group without modifying any raw graph', async () => {
  const viz = await instance(), directory = new URL('./', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('debugdump-manifest.json', directory), 'utf8'));
  const model = JSON.parse(fs.readFileSync(new URL('ecs-data.json', directory), 'utf8'));
  const views = manifest.schedules.map(schedule => ({ id: schedule.id, aspect: 'schedule',
    scheduleGraph: parseScheduleGraph(viz, fs.readFileSync(new URL(schedule.filename, directory), 'utf8')) }));
  const before = JSON.stringify(views), result = buildSchedulePluginGroups({ model, views });
  assert.equal(JSON.stringify(views), before);
  assert.equal(result.views.length, 34);
  assert.equal(result.catalog.length, 54);
  let count = 0, unknown = 0, project = 0;
  for (const current of result.views) {
    const names = new Set(current.schedulePluginGroups.flatMap(group => group.systemNames));
    const systems = current.scheduleGraph.nodes.filter(node => scheduleNodeKind(node) === 'system');
    assert.deepEqual(names, new Set(systems.map(node => node.attributes.tooltip)));
    count += systems.length;
    unknown += current.schedulePluginGroups.find(group => group.id === 'source:unclassified')?.systemNames.length || 0;
    project += current.schedulePluginGroups.filter(group => group.id.startsWith('plugin-')).reduce((sum, group) => sum + group.systemNames.length, 0);
  }
  assert.equal(count, 1235);
  assert.equal(unknown, 3);
  assert.equal(project, 82);
});
