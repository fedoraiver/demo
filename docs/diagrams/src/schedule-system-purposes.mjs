import { REVIEWED_SCHEDULE_PURPOSES } from '../catalog/schedule-source-reviewed.mjs';
import { EXTRA_SCHEDULE_PURPOSES } from '../catalog/schedule-source-reviewed-extra.mjs';
import { RENDER_SCHEDULE_SYSTEM_PURPOSES } from '../catalog/schedule-system-reviewed-render.mjs';
import { RENDER_CORE_SCHEDULE_SYSTEM_PURPOSES } from '../catalog/schedule-system-reviewed-render-core.mjs';
import { EFFECTS_SCHEDULE_SYSTEM_PURPOSES } from '../catalog/schedule-system-reviewed-effects.mjs';
import { PHYSICS_UI_SCHEDULE_SYSTEM_PURPOSES } from '../catalog/schedule-system-reviewed-physics-ui.mjs';
import { CORE_SCHEDULE_SYSTEM_PURPOSES } from '../catalog/schedule-system-reviewed-core.mjs';

export const SCHEDULE_SYSTEM_PURPOSE_VERSION = 1;

export function mergeScheduleSystemPurposes(...maps) {
  const result = new Map();
  for (const map of maps) for (const [key, raw] of Object.entries(map)) {
    if (result.has(key)) throw new Error('Duplicate reviewed Schedule system purpose: ' + key);
    const purpose = typeof raw === 'string' ? { summary: raw, description: raw } : raw;
    if (!key.includes('::') || !purpose?.summary?.trim() || !purpose?.description?.trim()) throw new Error('Incomplete reviewed Schedule system purpose: ' + key);
    if (/\[native code\]|\bundefined\b/.test(purpose.summary + purpose.description)) throw new Error('Corrupt reviewed Schedule system purpose: ' + key);
    result.set(key, { summary: purpose.summary, description: purpose.description });
  }
  return result;
}

export const REVIEWED_SCHEDULE_SYSTEM_PURPOSES = mergeScheduleSystemPurposes(
  REVIEWED_SCHEDULE_PURPOSES, EXTRA_SCHEDULE_PURPOSES,
  RENDER_SCHEDULE_SYSTEM_PURPOSES, RENDER_CORE_SCHEDULE_SYSTEM_PURPOSES, EFFECTS_SCHEDULE_SYSTEM_PURPOSES,
  PHYSICS_UI_SCHEDULE_SYSTEM_PURPOSES, CORE_SCHEDULE_SYSTEM_PURPOSES,
);

export function reviewedScheduleSystemPurpose(fullDeclarationName) {
  return REVIEWED_SCHEDULE_SYSTEM_PURPOSES.get(fullDeclarationName) || null;
}
