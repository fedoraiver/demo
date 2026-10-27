import assert from 'node:assert/strict';
import test from 'node:test';
import { createArchitectureSplitter } from './architecture-splitter.mjs';
import { testDocument } from './test-dom.mjs';

function fixture(innerWidth = 1440, available = 1200, enabled = () => true) {
  const document = testDocument('<section id="workspace"><div id="canvas"></div><div id="separator" role="separator" aria-orientation="vertical"></div></section>');
  const workspace = document.getElementById('workspace'), canvas = document.getElementById('canvas'), separator = document.getElementById('separator');
  const window = { innerWidth }, transform = { scale: .8, x: 20 }, changes = [];
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Panel size must not use storage'); } });
  workspace.clientWidth = available;
  Object.defineProperty(canvas, 'clientWidth', { get: () => workspace.clientWidth - 38 - Number.parseFloat(workspace.style['--details-width'] || 286) });
  const center = () => (canvas.clientWidth / 2 - transform.x) / transform.scale;
  const controller = createArchitectureSplitter({ workspace, canvas, separator, window, enabled, onResize: delta => { transform.x += delta / 2; changes.push(delta); } });
  return { workspace, canvas, separator, window, controller, transform, center, changes, width: () => Number.parseFloat(workspace.style['--details-width']) };
}

test('pointer dragging uses capture, clamps width and preserves the world center and zoom', () => {
  const page = fixture(), center = page.center();
  assert.equal(page.width(), 286);
  page.separator.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 1000 });
  assert.equal(page.separator.hasPointerCapture(1), true);
  page.separator.dispatch('pointermove', { pointerId: 2, clientX: 0 });
  assert.equal(page.width(), 286);
  page.separator.dispatch('pointermove', { pointerId: 1, clientX: 800 });
  assert.equal(page.width(), 486);
  assert.equal(page.center(), center);
  assert.equal(page.transform.scale, .8);
  page.separator.dispatch('pointermove', { pointerId: 1, clientX: -1000 });
  assert.equal(page.width(), 720);
  page.separator.dispatch('pointermove', { pointerId: 1, clientX: 2000 });
  assert.equal(page.width(), 240);
  page.separator.dispatch('pointerup', { pointerId: 1 });
  assert.equal(page.separator.hasPointerCapture(1), false);
  assert.equal(page.workspace.classList.contains('resizing'), false);
  page.separator.dispatch('pointermove', { pointerId: 1, clientX: 800 });
  assert.equal(page.width(), 240);
});

test('Schedule mode disables resizing, cancels capture and retains the object panel width', () => {
  let enabled = true;
  const page = fixture(1440, 1200, () => enabled);
  page.separator.dispatch('keydown', { key: 'ArrowLeft' });assert.equal(page.width(), 302);
  page.separator.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 600 });
  enabled = false;page.controller.refresh();
  assert.equal(page.separator.hidden, true);assert.equal(page.separator.hasPointerCapture(7), false);
  page.separator.dispatch('keydown', { key: 'End' });page.separator.dispatch('pointerdown', { button: 0, pointerId: 8, clientX: 500 });page.separator.dispatch('pointermove', { pointerId: 8, clientX: 0 });
  assert.equal(page.width(), 302);assert.equal(page.separator.getAttribute('aria-disabled'), 'true');
  enabled = true;page.controller.refresh();assert.equal(page.separator.hidden, false);assert.equal(page.width(), 302);
});

test('touch cancellation and capture loss end resizing without a canvas gesture', () => {
  for (const event of ['pointercancel', 'lostpointercapture']) {
    const page = fixture();
    page.separator.dispatch('pointerdown', { button: 0, pointerId: 8, pointerType: 'touch', clientX: 700 });
    page.separator.dispatch('pointermove', { pointerId: 8, clientX: 650 });
    assert.equal(page.width(), 336);
    page.separator.dispatch(event, { pointerId: 8 });
    assert.equal(page.workspace.classList.contains('resizing'), false);
    page.separator.dispatch('pointermove', { pointerId: 8, clientX: 500 });
    assert.equal(page.width(), 336);
  }
});

test('keyboard sizing exposes accurate limits and reserves at least 360px for the canvas', () => {
  const page = fixture(1000, 800);
  page.separator.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(page.width(), 302);
  page.separator.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(page.width(), 286);
  page.separator.dispatch('keydown', { key: 'End' });
  assert.equal(page.width(), 402);
  assert.equal(page.canvas.clientWidth, 360);
  assert.equal(page.separator.getAttribute('aria-valuemax'), '402');
  assert.equal(page.separator.getAttribute('aria-valuenow'), '402');
  page.separator.dispatch('keydown', { key: 'Home' });
  assert.equal(page.width(), 240);
  assert.equal(page.separator.getAttribute('aria-valuemin'), '240');
});

test('the mobile layout disables sizing, and the desktop session retains its chosen width', () => {
  const page = fixture();
  page.separator.dispatch('keydown', { key: 'ArrowLeft' });
  page.controller.refresh();
  assert.equal(page.width(), 302);
  page.window.innerWidth = 900; page.controller.refresh();
  assert.equal(page.separator.hidden, true);
  page.separator.dispatch('keydown', { key: 'End' });
  page.separator.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 600 });
  page.separator.dispatch('pointermove', { pointerId: 1, clientX: 300 });
  assert.equal(page.width(), 302);
  page.window.innerWidth = 901; page.controller.refresh();
  assert.equal(page.separator.hidden, false);
  assert.equal(page.width(), 302);
  assert.equal(fixture().width(), 286);
});

test('window size limits clamp the chosen width and interrupt a mobile transition drag', () => {
  const page = fixture();
  page.separator.dispatch('keydown', { key: 'End' });
  page.workspace.clientWidth = 800; page.controller.refresh();
  assert.equal(page.width(), 402);
  page.separator.dispatch('pointerdown', { button: 0, pointerId: 3, clientX: 600 });
  page.window.innerWidth = 900; page.controller.refresh();
  assert.equal(page.separator.hasPointerCapture(3), false);
  assert.equal(page.workspace.classList.contains('resizing'), false);
});
