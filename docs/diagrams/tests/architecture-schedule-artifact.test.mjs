import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createArchitectureViewer } from '../src/architecture-viewer.mjs';
import { createArchitectureNavigation } from '../src/architecture-navigation.mjs';
import { createArchitectureInteraction } from '../src/architecture-interaction.mjs';
import { createArchitectureGestures } from '../src/architecture-gestures.mjs';
import { createArchitectureSearch } from '../src/architecture-search.mjs';
import { createArchitectureSplitter } from '../src/architecture-splitter.mjs';
import { selectedFillColor } from '../src/architecture-style.mjs';
import { readArchitectureData } from '../src/architecture-artifacts.mjs';
import { pathsForRepository, artifactFile } from '../src/paths.mjs';
import { testDocument } from './test-dom.mjs';

test('all exported Schedule cards paint and restore their own real Graphviz outlines on a left mouse click', t => {
  const paths = pathsForRepository(), html = fs.readFileSync(paths.pagesDirectory + '/ecs-architecture.html', 'utf8');
  const data = readArchitectureData(paths.repositoryRoot);
  const document = testDocument(html.slice(0, html.indexOf('<script id="architecture-data"')));
  const get = id => document.getElementById(id), canvas = get('canvas'), location = new URL('file:///D:/demo/docs/diagrams/ecs-architecture.html');
  const frames = [], history = { state: null, length: 1,
    replaceState(state, _, url) { this.state = state; location.href = new URL(url, location).href; },
    pushState(state, _, url) { this.state = state; this.length++; location.href = new URL(url, location).href; } };
  const window = { innerWidth: 1440, innerHeight: 900, addEventListener() {} };
  canvas.clientWidth = 980; canvas.clientHeight = 680;
  const app = createArchitectureViewer({ data, document, location, history, window,
    requestAnimationFrame: callback => frames.push(callback), sourceEditor: { refreshLinks() {}, withWorkspace: url => url },
    navigation: createArchitectureNavigation(data.model.features, data.views.filter(view => view.aspect === 'schedule')),
    createInteraction: createArchitectureInteraction, createSplitter: createArchitectureSplitter, createGestures: createArchitectureGestures, createObjectSearch: createArchitectureSearch });
  const flush = () => { while (frames.length) frames.splice(0).forEach(callback => callback()); };
  const snapshot = shape => ['fill', 'stroke-width', 'filter'].map(name => [shape.style.getPropertyValue(name), shape.style.getPropertyPriority(name)]);
  let checked = 0, titles = 0, wrapped = 0;
  flush();
  for (const entry of data.scheduleInteractions.views) {
    app.navigate({ schedule: entry.viewId, node: null }); flush();
    const view = app.view, original = fs.readFileSync(artifactFile(paths, view), 'utf8');
    assert.equal(view.svg, original);
    assert.equal(get('details').hidden, false);
    assert.equal(get('details-resizer').hidden, false);
    assert.deepEqual(get('details').querySelectorAll('[data-guide-schedule-kind]').map(element => element.dataset.guideScheduleKind), view.legendKinds);
    const subjects = get('diagram').querySelectorAll('[data-schedule-node]').filter(element => element.dataset.scheduleTitle === undefined);
    for (const binding of entry.bindings) {
      const subject = subjects.find(element => element.dataset.scheduleNode === binding.id);
      assert.ok(subject, binding.id);
      // 按已绑定主体判断归属，独立于生产代码的包装层遍历实现。
      const shapes = subject.querySelectorAll('*').filter(element => ['path', 'polygon', 'rect', 'circle', 'ellipse', 'polyline', 'line'].includes(element.tagName)
        && element.closest('[data-schedule-node]') === subject);
      assert.equal(shapes.length, 1, binding.id + ' original native outline');
      if (shapes[0].parentElement?.tagName === 'a' && shapes[0].parentElement.parentElement?.tagName === 'g') wrapped++;
      const originals = shapes.map(snapshot), count = history.length, transform = get('diagram').style.transform;
      const title = get('diagram').querySelectorAll('[data-schedule-title]').find(element => element.dataset.scheduleTitle === binding.id);
      const masks = title ? title.querySelectorAll('polygon').filter(part => part.getAttribute('stroke') === 'none') : [];
      const maskOriginals = masks.map(snapshot), titleOriginal = title?.getAttribute('style');
      const textOriginals = title ? title.querySelectorAll('text').map(element => element.getAttribute('style')) : [];
      const nested = subject.querySelectorAll('[data-schedule-node]').flatMap(element => element.querySelectorAll('path,polygon,rect'));
      const nestedOriginals = nested.map(snapshot);
      if (binding.kind === 'set') { assert.ok(title, binding.id + ' foreground title'); assert.equal(title.dataset.clusterId, subject.getAttribute('id')); assert.equal(masks.length, 1); }
      for (const target of [subject.querySelector('text') || shapes[0], ...(title ? [title.querySelector('text') || title] : [])]) {
        document.elementFromPoint = (x, y) => { assert.equal(x, 120); assert.equal(y, 130); return target; };
        target.dispatch('pointerdown', { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 120, clientY: 130 });
        canvas.dispatch('pointerup', { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 120, clientY: 130 });
        target.dispatch('click', { detail: 1 }); flush();
        assert.equal(location.searchParams.get('scheduleNode'), binding.id);
        assert.equal(history.length, count, 'selection replaces history');
        assert.equal(get('details').hidden, false);
        assert.equal(get('diagram').style.transform, transform, 'selection does not resize the canvas');
        for (const shape of shapes) {
          assert.equal(shape.style.getPropertyValue('fill'), selectedFillColor(shape.getAttribute('stroke'), data.styles.selection.fillStrokeRatio));
          assert.ok(parseFloat(shape.style.getPropertyValue('stroke-width')) > Number(shape.getAttribute('stroke-width') || 1));
          assert.match(shape.style.getPropertyValue('filter'), /url\(#.+-selection-\d+\)/);
          assert.equal(shape.style.getPropertyPriority('fill'), 'important');
        }
        assert.equal(get('diagram').querySelectorAll('[data-selection-filter]').length, shapes.length);
        for (const [index, mask] of masks.entries()) {
          assert.equal(mask.style.getPropertyValue('fill'), shapes[0].style.getPropertyValue('fill'), binding.id + ' title and border selected fill');
          assert.equal(mask.style.getPropertyPriority('fill'), 'important');
          assert.deepEqual(snapshot(mask).slice(1), maskOriginals[index].slice(1), 'title mask has no selection stroke or filter');
        }
        assert.deepEqual(nested.map(snapshot), nestedOriginals, 'nested objects retain their styles');
        if (title) {
          assert.equal(title.getAttribute('style'), titleOriginal);
          assert.deepEqual(title.querySelectorAll('text').map(element => element.getAttribute('style')), textOriginals);
          get('zoom-out').click(); flush();
          for (const mask of masks) assert.equal(mask.style.getPropertyValue('fill'), shapes[0].style.getPropertyValue('fill'));
          get('fit').click(); flush();
        }
        for (const text of get('diagram').querySelectorAll('text')) assert.equal(text.style.getPropertyValue('filter'), '');
        assert.equal(target.dispatch('contextmenu').defaultPrevented, false);
        assert.equal(target.dispatch('keydown', { key: 'ContextMenu' }).defaultPrevented, false);
        assert.equal(target.dispatch('keydown', { key: 'F10', shiftKey: true }).defaultPrevented, false);
        assert.equal(location.searchParams.get('scheduleNode'), binding.id);
        if (title) { assert.equal(title.getAttribute('tabindex'), null); assert.equal(title.classList.contains('selected'), false); }
        get('clear-selection').click(); flush();
        assert.deepEqual(shapes.map(snapshot), originals);
        assert.deepEqual(masks.map(snapshot), maskOriginals);
        assert.deepEqual(nested.map(snapshot), nestedOriginals);
        assert.equal(get('diagram').querySelectorAll('[data-selection-filter]').length, 0);
        assert.equal(get('details').hidden, false);
        assert.equal(get('details-resizer').hidden, false);
        assert.equal(Boolean(get('details').querySelector('.guide')), true);
        assert.equal(Boolean(get('details').querySelector('svg[data-diagram-engine="graphviz"]')), true);
        assert.equal(get('diagram').style.transform, transform, 'clearing only replaces sidebar content');
      }
      checked++; if (title) titles++;
    }
    assert.equal(app.view.svg, original);
    assert.equal(fs.readFileSync(artifactFile(paths, view), 'utf8'), original);
  }
  assert.equal(data.scheduleInteractions.views.length, data.views.filter(view => view.aspect === 'schedule').length);
  assert.equal(checked, data.scheduleInteractions.views.reduce((count, entry) => count + entry.bindings.length, 0));
  assert.ok(wrapped > 0, 'real Graphviz wrappers are exercised');
  assert.equal(titles, data.scheduleInteractions.views.reduce((count, entry) => count + entry.bindings.filter(binding => binding.kind === 'set').length, 0));
  t.diagnostic(JSON.stringify({ schedules: data.scheduleInteractions.views.length, bindings: checked, titles, wrapped }));
});
