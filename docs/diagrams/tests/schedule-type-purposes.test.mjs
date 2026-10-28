import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleTypePurposeResolver, mergeScheduleTypePurposes } from '../src/schedule-type-purposes.mjs';

const purpose = (summary, description = summary) => ({ summary, description });

test('type purposes require complete canonical identities and reject duplicate reviewer keys', () => {
  assert.throws(() => mergeScheduleTypePurposes({ 'a::Thing': purpose('保存甲状态。') }, { 'a::Thing': purpose('保存甲状态。') }), /Duplicate/);
  assert.throws(() => mergeScheduleTypePurposes({ 'a::Thing': { summary: '只有摘要' } }), /Incomplete/);
  const resolver = createScheduleTypePurposeResolver({ reviewedMaps: [{ 'a::Thing': purpose('保存甲状态。') }] });
  assert.throws(() => resolver.describe({ fullName: 'b::Thing', kind: 'Resource' }, { declaration: { fullName: 'b::Thing' } }), /has not been reviewed/);
  assert.equal(resolver.describe({ fullName: 'a::Thing', kind: 'Resource' }, { declaration: { fullName: 'a::Thing' } }).display_summary, '保存甲状态。');
});

test('generic instances retain reviewed family meaning and exact arguments', () => {
  const resolver = createScheduleTypePurposeResolver({ reviewedMaps: [{ 'a::Store': purpose('保存指定资产。') }] });
  const result = resolver.describe({ fullName: 'a::Store<b::Mesh>', kind: 'Resource' }, { declaration: { fullName: 'a::Store' } });
  assert.match(result.description, /保存指定资产/);
  assert.match(result.description, /b::Mesh/);
  assert.deepEqual(result.fields, ['本实例类型参数：b::Mesh']);
});

test('message buffers describe concrete payload and known asset lifecycle', () => {
  const resolver = createScheduleTypePurposeResolver();
  const result = resolver.describe({ fullName: 'bevy_ecs::message::messages::Messages<bevy_asset::event::AssetEvent<bevy_image::image::Image>>', kind: 'Messages<T>' }, { declaration: { fullName: 'bevy_ecs::message::messages::Messages' } });
  assert.equal(result.display_summary, '保存 AssetEvent<Image> 消息。');
  assert.match(result.description, /新增、修改、移除、未使用和依赖加载完成/);
  assert.match(result.description, /bevy_image::image::Image/);
});

test('Local purposes are per parameter and never borrowed from another nested slot', () => {
  const resolver = createScheduleTypePurposeResolver({ reviewedMaps: [], localPurposes: {
    'a::run|pair.0': purpose('记录是否已经接收帧时间。'),
    'a::run|pair.1': purpose('记录是否已经发出缺失警告。'),
    'a::run|1': purpose('另一个独立参数。'),
  } });
  const describe = slot => resolver.describe({ fullName: 'core::primitive::bool', kind: 'Local', parameterKey: slot }, { parameterDeclaration: { fullName: 'a::run' }, systemFullName: 'a::run' });
  assert.match(describe('pair.0').description, /帧时间/);
  assert.match(describe('pair.1').description, /警告/);
  assert.throws(() => describe('other.1'), /has not been reviewed/);
});

test('derived Local slot normalization uses an explicit declaration-relative path', () => {
  const resolver = createScheduleTypePurposeResolver({ reviewedMaps: [], localPurposes: { 'a::InputReader|gamepad_device': purpose('记住当前选择的手柄设备。') } });
  const result = resolver.describe({ fullName: 'a::GamepadDevice', kind: 'Local', parameterKey: 'reader.gamepad_device' }, { parameterDeclaration: { fullName: 'a::InputReader' }, declarationParameterKey: 'gamepad_device' });
  assert.match(result.description, /手柄设备/);
  assert.ok(result.fields.includes('独立 Local 参数槽：reader.gamepad_device'));
});

test('source documentation and fields remain reviewable alongside Chinese purposes', () => {
  const resolver = createScheduleTypePurposeResolver({ reviewedMaps: [{ 'a::State': purpose('保存活动模式。') }] });
  const text = 'enum State {\n    /// Visible mode\n    Active,\n    Inactive,\n}';
  const declaration = { fullName: 'a::State', kind: 'enum', file: { text }, offset: 0, bodyStart: text.indexOf('{'), end: text.lastIndexOf('}'), attributes: '/// Current mode\n#[derive(Reflect)]' };
  const result = resolver.describe({ fullName: 'a::State', kind: 'Resource' }, { declaration });
  assert.ok(result.fields.some(field => field.includes('Current mode')));
  assert.ok(result.fields.some(field => field.includes('Visible mode') && field.includes('Inactive')));
});

test('unknown fixture purposes are explicit gaps only under the opt-in non-production mode', () => {
  assert.throws(() => createScheduleTypePurposeResolver({ reviewedMaps: [] }).describe({ fullName: 'fixture::Opaque', kind: 'SystemParam' }), /has not been reviewed/);
  const result = createScheduleTypePurposeResolver({ reviewedMaps: [], strict: false }).describe({ fullName: 'fixture::Opaque', kind: 'SystemParam' });
  assert.match(result.sourceGaps[0], /^用途缺口/);
  assert.match(result.description, /尚未审阅/);
  assert.throws(() => createScheduleTypePurposeResolver().describe({ fullName: 'bevy::ecs::system::lifetimeless::Read<fixture::Unknown>', kind: 'QueryData' }), /has not been reviewed/);
});
