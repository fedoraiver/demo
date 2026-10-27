import assert from 'node:assert/strict';
import test from 'node:test';
import { instance } from '@viz-js/viz';
import { DOMParser } from '@xmldom/xmldom';
import { viewerThemeStyle } from './viewer-theme.mjs';
import { SCHEDULE_THEME } from './schedule-theme.mjs';
import { parseScheduleGraph, scheduleGraphInput } from './schedule-graph.mjs';

test('the rendered Schedule background matches the canvas theme', async () => {
  const canvasColor = viewerThemeStyle.match(/--ui-bg:([^;]+)/)[1].toUpperCase();
  const viz = await instance();
  const model = parseScheduleGraph(viz, 'digraph { a[label="world_inspector_ui",tooltip="demo::world_inspector_ui"]; }');
  const svg = viz.renderString(scheduleGraphInput(model, SCHEDULE_THEME), { engine: 'dot', format: 'svg' });
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const graph = [...document.getElementsByTagName('g')].find(group => group.getAttribute('class') === 'graph');
  const background = [...graph.childNodes].find(node => node.localName === 'polygon');
  assert.equal(background.getAttribute('fill').toUpperCase(), canvasColor);
});
