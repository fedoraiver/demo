import { RENDER_SCHEDULE_SET_PURPOSES } from '../catalog/schedule-set-reviewed-render.mjs';
import { CORE_SCHEDULE_SET_PURPOSES } from '../catalog/schedule-set-reviewed-core.mjs';

export const SCHEDULE_SET_PURPOSE_VERSION = 1;
export function mergeScheduleSetPurposes(...maps) {
  const result = new Map();
  for (const map of maps) for (const [key, purpose] of Object.entries(map)) {
    if (result.has(key)) throw new Error('Duplicate reviewed Schedule set purpose: ' + key);
    if (!key.includes('::') || !purpose?.summary?.trim() || !purpose?.description?.trim()) throw new Error('Incomplete reviewed Schedule set purpose: ' + key);
    result.set(key, purpose);
  }
  return result;
}
export const REVIEWED_SCHEDULE_SET_PURPOSES = mergeScheduleSetPurposes(RENDER_SCHEDULE_SET_PURPOSES, CORE_SCHEDULE_SET_PURPOSES);

export function reviewedScheduleSetPurpose(fullName, { strict = true } = {}) {
  const purpose = REVIEWED_SCHEDULE_SET_PURPOSES.get(fullName);
  if (purpose) return purpose;
  if (strict) throw new Error('Schedule set purpose has not been reviewed: ' + fullName);
  return { summary: '集合用途待核实：' + fullName, description: '仅确认集合声明 ' + fullName + '；其阶段职责尚未审阅。', sourceGap: '集合用途尚未审阅；此回退仅可用于合成源码测试，不可用于正式产物。' };
}
