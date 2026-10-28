import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScheduleSetPurposes, reviewedScheduleSetPurpose } from '../src/schedule-set-purposes.mjs';

test('named set purposes use exact declaration and variant identities', () => {
  const layout = reviewedScheduleSetPurpose('bevy_ui::UiSystems::Layout');
  const stack = reviewedScheduleSetPurpose('bevy_ui::UiSystems::Stack');
  assert.match(layout.description, /尺寸、位置和布局/);
  assert.match(stack.description, /UiStack/);
  assert.notEqual(layout.description, stack.description);
  assert.throws(() => reviewedScheduleSetPurpose('other::UiSystems::Layout'), /has not been reviewed/);
});

test('stage boundaries and ambiguity markers describe their actual contracts', () => {
  const first = reviewedScheduleSetPurpose('avian3d::collision::narrow_phase::NarrowPhaseSystems::First');
  assert.match(first.description, /默认无成员/);
  const marker = reviewedScheduleSetPurpose('bevy_ui::AmbiguousWithText');
  assert.match(marker.description, /允许歧义/);
  assert.match(marker.description, /不建立额外执行依赖/);
});

test('missing set purposes fail in production and remain explicit gaps in synthetic fixtures', () => {
  assert.throws(() => reviewedScheduleSetPurpose('fixture::Unknown'), /has not been reviewed/);
  assert.match(reviewedScheduleSetPurpose('fixture::Unknown', { strict: false }).sourceGap, /不可用于正式产物/);
});

test('duplicate or incomplete named set review records fail', () => {
  const map = { 'a::Set::Stage': { summary: '阶段用途。', description: '完成已核实的阶段处理。' } };
  assert.throws(() => mergeScheduleSetPurposes(map, map), /Duplicate/);
  assert.throws(() => mergeScheduleSetPurposes({ 'a::Set': { summary: '没有说明。' } }), /Incomplete/);
});
