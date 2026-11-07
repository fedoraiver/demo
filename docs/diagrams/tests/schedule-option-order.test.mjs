import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { orderScheduleOptions, renderArchitectureViewer } from '../src/architecture-viewer.mjs';
import { testDocument } from './test-dom.mjs';

const mainLabels = [
  'Main', 'PreStartup', 'Startup', 'PostStartup', 'First', 'PreUpdate',
  'StateTransition', 'OnExit(MainMenu)', 'OnTransition { exited: MainMenu, entered: Running }', 'OnEnter(Running)',
  'RunFixedMainLoop', 'FixedMain', 'FixedFirst', 'FixedPreUpdate', 'FixedUpdate',
  'FixedPostUpdate', 'PhysicsSchedule', 'SubstepSchedule', 'FixedLast',
  'Update', 'SpawnScene', 'PostUpdate', 'EguiPrimaryContextPass', 'Last',
];
const renderLabels = ['RenderStartup', 'ExtractSchedule', 'RenderRecovery', 'First', 'Render', 'RenderGraph', 'Core2d', 'Core3d'];

function scheduleViews(labels, application = 'main') {
  return labels.map((scheduleLabel, index) => ({ id: `${application}-${scheduleLabel}`, aspect: 'schedule', application, scheduleLabel, systemCount: index + 1 }));
}

function pickerOptions(views) {
  const html = renderArchitectureViewer({ model: { features: [] }, registry: {}, views, features: [], guideSamples: {} });
  return testDocument(html).getElementById('view-select').querySelectorAll('option');
}

function optionText(view, depth) {
  return `${depth ? '\u00a0\u00a0'.repeat(depth) + '↳ ' : ''}${view.scheduleLabel} · ${view.systemCount} systems`;
}

test('schedule picker orders the complete main call hierarchy before unconfirmed schedules', () => {
  const views = scheduleViews([...mainLabels, 'Render', 'Custom'].reverse());
  assert.deepEqual(orderScheduleOptions(views, 'main').map(view => view.scheduleLabel), [...mainLabels, 'Custom', 'Render']);
});

test('schedule picker orders render phases and keeps same-name schedules isolated by application', () => {
  const views = [
    ...scheduleViews([...renderLabels, 'Custom'].reverse(), 'RenderApp'),
    ...scheduleViews(['First'], 'RenderExtractApp'),
    ...scheduleViews(['Update', 'First']),
    ...scheduleViews(['Update', 'First', 'ExtractSchedule'], 'OtherApp'),
  ];
  assert.deepEqual(orderScheduleOptions(views, 'RenderApp').map(view => view.scheduleLabel), [...renderLabels, 'Custom']);
  assert.deepEqual(orderScheduleOptions(views, 'RenderExtractApp').map(view => view.id), ['RenderExtractApp-First']);
  assert.deepEqual(orderScheduleOptions(views, 'main').map(view => view.id), ['main-First', 'main-Update']);
  assert.deepEqual(orderScheduleOptions(views, 'OtherApp').map(view => view.scheduleLabel), ['ExtractSchedule', 'First', 'Update']);
  assert.deepEqual(orderScheduleOptions(views, 'MissingApp'), []);
});

test('state callback families use exit-transition-enter order and sort each family by label then identity', () => {
  const callbacks = [
    'OnEnter(Running)', 'OnTransition { exited: Paused, entered: Running }', 'OnExit(Running)',
    'OnEnter(MainMenu)', 'OnTransition { exited: MainMenu, entered: Running }', 'OnExit(MainMenu)',
  ];
  const views = scheduleViews(['Update', ...callbacks, 'StateTransition', 'PreUpdate']);
  views.push({ ...views.find(view => view.scheduleLabel === 'OnEnter(MainMenu)'), id: 'duplicate-a' });
  assert.deepEqual(orderScheduleOptions(views, 'main').map(view => view.id), [
    'main-PreUpdate', 'main-StateTransition',
    'main-OnExit(MainMenu)', 'main-OnExit(Running)',
    'main-OnTransition { exited: MainMenu, entered: Running }', 'main-OnTransition { exited: Paused, entered: Running }',
    'duplicate-a', 'main-OnEnter(MainMenu)', 'main-OnEnter(Running)', 'main-Update',
  ]);
});

test('schedule ordering preserves the input array, view contents and original object references', () => {
  const views = scheduleViews(['Custom', ...mainLabels].reverse());
  const original = structuredClone(views);
  views.forEach(Object.freeze);
  Object.freeze(views);
  const ordered = orderScheduleOptions(views, 'main');
  assert.notEqual(ordered, views);
  assert.deepEqual(views, original);
  for (const view of ordered) assert.equal(view, views.find(candidate => candidate.id === view.id));
});

test('rendered schedule options show the main and render call depths exactly once per view', () => {
  const mainDepths = [0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 2, 3, 3, 3, 3, 4, 5, 3, 1, 1, 1, 2, 1];
  const renderDepths = [0, 0, 0, 1, 1, 2, 3, 3];
  const mainViews = scheduleViews(mainLabels);
  const renderViews = scheduleViews(renderLabels, 'RenderApp');
  const options = pickerOptions([...mainViews].reverse().concat([...renderViews].reverse()));
  const expectedViews = [...mainViews, ...renderViews];
  const expectedDepths = [...mainDepths, ...renderDepths];
  assert.deepEqual(options.map(option => option.value), expectedViews.map(view => view.id));
  assert.deepEqual(options.map(option => option.textContent), expectedViews.map((view, index) => optionText(view, expectedDepths[index])));
  assert.equal(new Set(options.map(option => option.value)).size, expectedViews.length);
});

test('rendered schedule depths count only ancestors present in the same application', () => {
  const mainViews = scheduleViews(['Main', 'SubstepSchedule', 'EguiPrimaryContextPass', 'OnEnter(Running)']);
  const renderViews = scheduleViews(['Core3d', 'RenderRecovery', 'RenderGraph'], 'RenderApp');
  const otherViews = scheduleViews(['PostUpdate', 'StateTransition', 'PhysicsSchedule'], 'OtherApp');
  const options = pickerOptions([...mainViews, ...renderViews, ...otherViews]);
  const expected = [
    ...mainViews.map((view, index) => [view, index === 0 ? 0 : 1]),
    [renderViews[0], 2], [renderViews[1], 0], [renderViews[2], 1],
    ...otherViews.map(view => [view, 0]),
  ];
  for (const [view, depth] of expected) assert.equal(options.find(option => option.value === view.id).textContent, optionText(view, depth));
});

test('schedule option hints describe initialization, conditional callbacks, cameras and unconfirmed positions', () => {
  const views = [
    ...scheduleViews(['StateTransition', 'OnExit(MainMenu)', 'OnTransition { exited: MainMenu, entered: Running }', 'OnEnter(Running)', 'Custom', 'Render']),
    ...scheduleViews(['Core2d', 'Core3d'], 'RenderApp'),
    ...scheduleViews(['First'], 'RenderExtractApp'),
  ];
  const options = pickerOptions(views);
  for (const option of options) {
    const label = views.find(view => view.id === option.value).scheduleLabel;
    const expected = label === 'StateTransition' ? ['首次启动', 'PreStartup']
      : label.startsWith('On') ? ['条件']
      : label.startsWith('Core') ? ['相机', '顺序'] : ['调用位置未确认'];
    for (const attribute of ['title', 'aria-label']) {
      const hint = option.getAttribute(attribute);
      assert.ok(hint, `${option.value} has ${attribute}`);
      for (const fragment of expected) assert.ok(hint.includes(fragment), `${option.value} ${attribute} includes ${fragment}`);
    }
  }
});

test('schedule option rendering escapes identities, application names and conditional schedule labels', () => {
  const view = {
    id: 'state-"<&>', aspect: 'schedule', application: 'main',
    scheduleLabel: 'OnEnter("<&>")', systemCount: 3,
  };
  const unknown = { ...view, id: 'other-"<&>', application: 'Other"<&>', scheduleLabel: 'Custom"<&>' };
  const options = pickerOptions([view, unknown]);
  assert.equal(options.length, 2);
  assert.deepEqual(options.map(option => option.value), [view.id, unknown.id]);
  assert.deepEqual(options.map(option => option.textContent), [optionText(view, 0), optionText(unknown, 0)]);
  assert.equal(options[1].parentElement.getAttribute('label'), `${unknown.application} Schedule`);
  assert.ok(options[0].getAttribute('aria-label').includes(view.scheduleLabel));
  assert.ok(options[1].getAttribute('aria-label').includes(unknown.scheduleLabel));
});
