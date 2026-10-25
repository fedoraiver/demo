import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { APP_SCHEDULE_GROUPS, APP_SCHEDULE_LINKS, buildAppSchedule } from './architecture-app-schedule.mjs';
import { buildArchitectureModel } from './architecture-model.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { renderOverview } from './architecture-renderer.mjs';
import { checkAppSchedule, checkMermaidStyles } from './check-ecs.mjs';

const model = JSON.parse(fs.readFileSync(new URL('./ecs-data.json', import.meta.url), 'utf8'));
const architecture = buildArchitectureModel(model);
const app = buildAppSchedule(model, architecture.registry);
const group = id => app.groups.find(candidate => candidate.id === id);
const phase = (from, to) => app.phaseLinks.find(link => link.from === from && link.to === to);

test('App schedule covers every catalog system and observer plus systems declared outside the systems collection', () => {
  const ids = new Set(app.graph.nodes.map(node => node.id));
  assert.equal(ids.size, app.graph.nodes.length);
  for (const system of model.systems) assert(ids.has(system.id), system.id);
  assert(ids.has('native-scrollbar-layout'));
  assert(app.graph.nodes.every(node => node.role === 'internal'));
  assert(app.graph.links.every(link => ids.has(link.from) && ids.has(link.to)));
  assert.equal(app.groups.flatMap(entry => entry.nodes).length, ids.size);
  assert.deepEqual(new Set(app.groups.flatMap(entry => entry.nodes.map(node => node.id))), ids);
});

test('App schedule preserves the union of local scheduling relations with their original IDs and endpoints', () => {
  const expected = new Map();
  for (const feature of [...architecture.features, ...INFRASTRUCTURE_FEATURES]) {
    for (const link of architecture.graphFor(feature.id, 'systems').links) expected.set(link.id, link);
  }
  const byId = (a, b) => a.id.localeCompare(b.id);
  assert.deepEqual(app.graph.links.toSorted(byId), [...expected.values()].toSorted(byId));
  assert(app.graph.links.every(link => ['order', 'registration'].includes(link.kind)));
  assert.equal(new Set(app.graph.links.map(link => link.id)).size, app.graph.links.length);
});

test('App phases include the full startup, frame and fixed-step schedule skeleton even without catalog systems', () => {
  for (const id of ['Startup.StateTransition', 'PreStartup', 'Startup', 'PostStartup', 'First', 'PreUpdate', 'StateTransition',
    'RunFixedMainLoop.BeforeFixedMainLoop', 'FixedFirst', 'FixedPreUpdate', 'FixedUpdate', 'FixedPostUpdate', 'FixedLast',
    'RunFixedMainLoop.AfterFixedMainLoop', 'Update', 'SpawnScene', 'PostUpdate', 'Last']) {
    assert(group(id), id);
  }
  for (const id of ['Startup.StateTransition', 'PreStartup', 'PostStartup', 'RunFixedMainLoop.BeforeFixedMainLoop', 'FixedPreUpdate', 'Last']) {
    assert.equal(group(id).nodes.length, 0, id);
    assert(group(id).notes.length, id);
  }
  assert.equal(group('Startup.StateTransition').schedule, 'StateTransition');
  assert.equal(group('StateTransition').label, 'StateTransition');
  const groupIds = new Set(app.groups.map(entry => entry.id));
  assert(app.phaseLinks.every(link => groupIds.has(link.from) && groupIds.has(link.to)));
  assert.equal(new Set(app.phaseLinks.map(link => link.id)).size, app.phaseLinks.length);
});

test('startup initialization is distinct from the recurring state transition and has one first-frame handoff', () => {
  for (const [from, to] of [['Startup.StateTransition', 'PreStartup'], ['PreStartup', 'Startup'], ['Startup', 'PostStartup'], ['PostStartup', 'First']]) {
    assert.equal(phase(from, to)?.edgeSemantic, 'schedule', `${from} → ${to}`);
  }
  assert.match(phase('PostStartup', 'First').displayLabel, /首次/);
  assert(phase('First', 'PreUpdate'));
  assert(phase('PreUpdate', 'StateTransition'));
  assert(!phase('StateTransition', 'PreStartup'));
  assert(!phase('First', 'Startup'));
  assert(group('Startup.StateTransition').notes.some(note => note.includes('不复制系统卡片')));
});

test('fixed schedules form a conditional loop body with a valid zero-step path to presentation', () => {
  const before = 'RunFixedMainLoop.BeforeFixedMainLoop', after = 'RunFixedMainLoop.AfterFixedMainLoop';
  assert.match(phase(before, after).displayLabel, /零步/);
  assert.equal(phase(before, 'FixedFirst').edgeSemantic, 'nested');
  assert.match(phase(before, 'FixedFirst').displayLabel, /有固定步/);
  for (const [from, to] of [['FixedFirst', 'FixedPreUpdate'], ['FixedPreUpdate', 'FixedUpdate'], ['FixedUpdate', 'FixedPostUpdate'], ['FixedPostUpdate', 'FixedLast']]) {
    assert.equal(phase(from, to)?.edgeSemantic, 'schedule', `${from} → ${to}`);
  }
  assert.equal(phase('FixedLast', after).edgeSemantic, 'nested');
  assert.match(phase('FixedLast', after).displayLabel, /全部固定步结束/);
  assert(group('FixedLast').notes.some(note => note.includes('下一个完整 FixedMain')));
  assert(group(after).notes.some(note => note.includes('零固定步也执行')));
  assert(phase('StateTransition', before));
  assert(phase(after, 'Update'));
  assert(!phase('StateTransition', 'FixedFirst'));
});

test('Egui pass nesting and external render, platform and observer execution do not become a false main chain', () => {
  assert.equal(phase('PostUpdate', 'EguiPrimaryContextPass').edgeSemantic, 'nested');
  assert.equal(group('EguiPrimaryContextPass').parent, 'PostUpdate');
  assert(phase('PostUpdate', 'Last'));
  assert(!phase('EguiPrimaryContextPass', 'Last'));
  for (const id of ['RenderApp', 'NativePlatformEvents', 'EventTriggered']) {
    assert.equal(group(id).track, 'external', id);
    assert(!app.phaseLinks.some(link => link.from === id || link.to === id), id);
  }
  const observers = model.systems.filter(system => architecture.registry[system.id].kind === 'Observer').map(system => system.id);
  assert.deepEqual(new Set(group('EventTriggered').nodes.map(node => node.id)), new Set(observers));
  assert(group('EventTriggered').notes.some(note => note.includes('没有固定 Schedule')));
});

test('runtime cards retain all registrations without duplicating inactive headless startup or initialization entries', () => {
  const spawn = architecture.registry.startup_spawn;
  assert(spawn.registrations.some(registration => registration.scope === 'headless-test' && registration.schedule === 'Startup'));
  assert.equal(app.graph.nodes.filter(node => node.id === spawn.id).length, 1);
  assert(group('StateTransition').nodes.some(node => node.id === spawn.id));
  assert(!group('Startup').nodes.some(node => node.id === spawn.id));
  assert(architecture.registry.transform_propagate.registrations.some(registration => registration.schedule === 'PostStartup'));
  assert.equal(app.graph.nodes.filter(node => node.id === 'transform_propagate').length, 1);
  assert(group('PostUpdate').nodes.some(node => node.id === 'transform_propagate'));
  for (const id of ['facing_fixed', 'facing_update', 'held_fixed', 'held_update', 'grounded_fixed', 'grounded_after']) {
    assert.equal(app.graph.nodes.filter(node => node.id === id).length, 1, id);
  }
});

test('App scheduling keeps input records unchanged and returns isolated mutable result lists', () => {
  const beforeModel = structuredClone(model), beforeRegistry = structuredClone(architecture.registry);
  const local = buildAppSchedule(model, architecture.registry);
  local.groups[0].notes.push('result-only note');
  local.phaseLinks[0].notes.push('result-only note');
  assert(!APP_SCHEDULE_GROUPS[0].notes.includes('result-only note'));
  assert(!APP_SCHEDULE_LINKS[0].notes.includes('result-only note'));
  assert.deepEqual(model, beforeModel);
  assert.deepEqual(architecture.registry, beforeRegistry);
});

test('App scheduling rejects an unreviewed phase instead of silently placing it in an unrelated stage', () => {
  const changed = structuredClone(model);
  changed.systems.find(system => system.id === 'startup_config').schedule_group = 'UnreviewedPhase';
  const changedArchitecture = buildArchitectureModel(changed);
  assert.throws(() => buildAppSchedule(changed, changedArchitecture.registry), /缺少阶段：UnreviewedPhase/);
});

test('overview renders the full App schedule with native layout anchors outside the business registry', () => {
  const view = renderOverview(model, architecture.registry, architecture.features);
  assert.equal(view.id, 'overview');
  assert.equal(view.layout, 'app-schedule');
  assert.match(view.label, /App.*系统调度/);
  assert.deepEqual(view.nodes.map(node => node.id), app.graph.nodes.map(node => node.id));
  assert(view.nodes.every(node => node.role === 'internal'));
  assert(!view.nodes.some(node => node.id.startsWith('plugin-')));
  assert(!view.nodes.some(node => node.id.startsWith('phase_anchor_')));
  assert.equal((view.mermaid.match(/^  phase_anchor_sg\d+@\{ shape: anchor,/gm) || []).length, app.groups.filter(entry => !entry.nodes.length).length);
  assert.equal((view.mermaid.match(/^  n\d+@\{/gm) || []).length, app.graph.nodes.length);
  assert.equal((view.mermaid.match(/^  n\d+ e\d+@/gm) || []).length, app.graph.links.length);
  assert.deepEqual(view.scheduleLinks.map(({ mermaidId, ...link }) => link), app.phaseLinks);
  assert(view.scheduleGroups.every(entry => entry.nodes.every(id => architecture.registry[id])));
});

test('App delivery validation rejects a missing system, a lost dependency and an altered fixed-loop path', () => {
  const original = renderOverview(model, architecture.registry, architecture.features);
  assert.doesNotThrow(() => checkAppSchedule(original, model, architecture.registry));
  const missing = structuredClone(original);
  missing.nodes = missing.nodes.filter(node => node.id !== 'native-scrollbar-layout');
  assert.throws(() => checkAppSchedule(missing, model, architecture.registry), /node coverage/);
  const dependency = structuredClone(original); dependency.links.pop();
  assert.throws(() => checkAppSchedule(dependency, model, architecture.registry), /dependency coverage/);
  const phase = structuredClone(original);
  phase.scheduleGroups.find(group => group.id === 'FixedUpdate').nodes.reverse();
  assert.throws(() => checkAppSchedule(phase, model, architecture.registry), /phase or registration/);
  const loop = structuredClone(original);
  loop.scheduleLinks = loop.scheduleLinks.filter(link => link.id !== 'app-fixed-empty-path');
  assert.throws(() => checkAppSchedule(loop, model, architecture.registry), /execution path/);
});

test('native empty Schedule anchors remain transparent in the delivered SVG', () => {
  const html = fs.readFileSync(new URL('./ecs-architecture.html', import.meta.url), 'utf8');
  const data = JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const view = data.views.find(view => view.id === 'overview');
  assert.doesNotThrow(() => checkMermaidStyles(view, data.registry));
  const anchorStyle = /class="anchor" style="opacity:0"/;
  assert.match(view.svg, anchorStyle);
  const visible = { ...view, svg: view.svg.replace(anchorStyle, 'class="anchor" style="opacity:1"') };
  assert.throws(() => checkMermaidStyles(visible, data.registry), /Visible empty Schedule layout anchor/);
});
