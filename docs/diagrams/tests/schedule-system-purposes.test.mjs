import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeScheduleSystemPurposes, reviewedScheduleSystemPurpose } from '../src/schedule-system-purposes.mjs';

test('system purposes merge reviewed strings and short-summary objects without short-name lookup', () => {
  const purposes = mergeScheduleSystemPurposes({ 'a::run': '执行已核实的主循环。' }, { 'b::run': { summary: '推进本帧输入。', description: '读取设备状态，计算动作并发布本帧事件。' } });
  assert.deepEqual(purposes.get('a::run'), { summary: '执行已核实的主循环。', description: '执行已核实的主循环。' });
  assert.equal(purposes.get('b::run').summary, '推进本帧输入。');
  assert.equal(reviewedScheduleSystemPurpose('unreviewed::run'), null);
});

test('reviewer duplicate keys, incomplete purposes and polluted text fail', () => {
  assert.throws(() => mergeScheduleSystemPurposes({ 'a::run': '推进输入。' }, { 'a::run': '推进输入。' }), /Duplicate/);
  assert.throws(() => mergeScheduleSystemPurposes({ 'a::run': { description: '没有摘要。' } }), /Incomplete/);
  assert.throws(() => mergeScheduleSystemPurposes({ run: '短名不能作为身份。' }), /Incomplete/);
  assert.throws(() => mergeScheduleSystemPurposes({ 'a::run': 'function Object() { [native code] }' }), /Corrupt/);
});

test('reviewed generic families retain their semantic purpose independent of instance suffixes', () => {
  const actual = reviewedScheduleSystemPurpose('bevy_state::state::transitions::run_transition');
  assert.match(actual.summary, /旧状态到新状态/);
  assert.match(actual.description, /exited.*entered/);
  assert.match(actual.description, /不由此阶段设置状态资源/);
});
