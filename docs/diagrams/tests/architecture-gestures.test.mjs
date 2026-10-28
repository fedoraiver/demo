import assert from 'node:assert/strict';
import test from 'node:test';
import { createArchitectureGestures } from '../src/architecture-gestures.mjs';
import { testDocument } from './test-dom.mjs';

function fixture({ viewport = { scale: 1, x: 0, y: 0 }, left = 0, top = 0, diagram = true, clampScale, withActivation = true } = {}) {
  const document = testDocument('<div id="canvas"><span id="target"></span></div>');
  const canvas = document.getElementById('canvas'), listeners = new Map(), updates = [], activations = [];
  let current = { ...viewport };
  canvas.getBoundingClientRect = () => ({ left, top, width: 600, height: 400 });
  const window = { addEventListener(name, listener) { listeners.set(name, listener); } };
  const controller = createArchitectureGestures({ canvas, window, hasDiagram: () => diagram,
    getViewport: () => ({ ...current }), setViewport: next => { current = { ...next }; updates.push(current); }, clampScale,
    ...(withActivation ? { activate: (x, y) => activations.push([x, y]) } : {}) });
  const pointer = (name, id, x, y, extra = {}) => canvas.dispatch(name, {
    button: 0, pointerType: 'touch', pointerId: id, clientX: x + left, clientY: y + top, ...extra,
  });
  return { document, canvas, updates, activations, controller, pointer,
    get viewport() { return current; }, signal: name => listeners.get(name)() };
}

function close(actual, expected) {
  for (const key of ['scale', 'x', 'y']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} != ${expected[key]}`);
}

function pair(page, first = [100, 100], second = [200, 100]) {
  page.pointer('pointerdown', 1, ...first); page.pointer('pointerdown', 2, ...second);
  assert.equal(page.canvas.hasPointerCapture(1), true);
  assert.equal(page.canvas.hasPointerCapture(2), true);
}

test('left mouse clicks activate their release position while dragging preserves its original scale', () => {
  const page = fixture({ viewport: { scale: .6, x: 30, y: -10 }, left: 70, top: 90 });
  const down = page.pointer('pointerdown', 7, 40, 60, { pointerType: 'mouse' });
  assert.equal(down.defaultPrevented, true); assert.equal(page.document.activeElement, page.canvas);
  assert.deepEqual(page.activations, []);
  page.pointer('pointerup', 7, 40, 60, { pointerType: 'mouse' });
  assert.deepEqual(page.activations, [[110, 150]]);
  close(page.viewport, { scale: .6, x: 30, y: -10 });
  assert.equal(page.updates.length, 0); assert.equal(page.canvas.hasPointerCapture(7), false);
  page.pointer('pointerdown', 8, 40, 60, { pointerType: 'mouse' });
  page.pointer('pointermove', 8, 70, 105, { pointerType: 'mouse' });
  close(page.viewport, { scale: .6, x: 60, y: 35 });
  assert.equal(page.canvas.classList.contains('dragging'), true);
  page.pointer('pointerup', 8, 70, 105, { pointerType: 'mouse' });
  assert.deepEqual(page.activations, [[110, 150]]);
  assert.equal(page.canvas.hasPointerCapture(8), false); assert.equal(page.canvas.classList.contains('dragging'), false);
});

test('mouse activation includes the six-pixel boundary and defaults a missing pointer type to mouse', () => {
  const page = fixture();
  page.pointer('pointerdown', 1, 10, 20, { pointerType: undefined });
  page.pointer('pointerup', 1, 16, 20, { pointerType: undefined });
  assert.deepEqual(page.activations, [[16, 20]]);
  assert.equal(page.updates.length, 0);
});

test('a consumed mouse drag never activates even after returning to its start or skipping move events', () => {
  const page = fixture();
  page.pointer('pointerdown', 1, 20, 30, { pointerType: 'mouse' });
  page.pointer('pointermove', 1, 27, 30, { pointerType: 'mouse' });
  page.pointer('pointermove', 1, 20, 30, { pointerType: 'mouse' });
  page.pointer('pointerup', 1, 20, 30, { pointerType: 'mouse' });
  page.pointer('pointerdown', 2, 40, 50, { pointerType: 'mouse' });
  page.pointer('pointerup', 2, 47, 50, { pointerType: 'mouse' });
  assert.deepEqual(page.activations, []);
  assert.equal(page.updates.length, 2, 'release does not apply movement that was never observed');
});

test('touch and pen taps do not activate selection', () => {
  const page = fixture();
  for (const [pointerId, pointerType] of [[1, 'touch'], [2, 'pen']]) {
    page.pointer('pointerdown', pointerId, 20, 30, { pointerType });
    page.pointer('pointerup', pointerId, 20, 30, { pointerType });
  }
  assert.deepEqual(page.activations, []); assert.equal(page.updates.length, 0);
});

test('multiple accepted pointers consume a stationary mouse gesture through its final release', () => {
  const page = fixture();
  page.pointer('pointerdown', 1, 20, 30, { pointerType: 'mouse' });
  page.pointer('pointerdown', 2, 20, 30, { pointerType: 'mouse' });
  page.pointer('pointerup', 1, 20, 30, { pointerType: 'mouse' });
  page.pointer('pointerup', 2, 20, 30, { pointerType: 'mouse' });
  assert.deepEqual(page.activations, []); assert.equal(page.updates.length, 0);
});

test('mouse clicks remain valid when no activation callback is supplied', () => {
  const page = fixture({ withActivation: false });
  page.pointer('pointerdown', 1, 20, 30, { pointerType: 'mouse' });
  assert.doesNotThrow(() => page.pointer('pointerup', 1, 20, 30, { pointerType: 'mouse' }));
  assert.equal(page.canvas.hasPointerCapture(1), false); assert.equal(page.updates.length, 0);
});

test('touch movement waits for the drag threshold and releasing never changes the viewport', () => {
  const page = fixture();
  page.pointer('pointerdown', 1, 10, 10); page.pointer('pointermove', 1, 13, 14);
  assert.equal(page.updates.length, 0);
  page.pointer('pointerup', 1, 13, 14); close(page.viewport, { scale: 1, x: 0, y: 0 });
  assert.equal(page.document.activeElement, page.canvas); assert.equal(page.canvas.hasPointerCapture(1), false);
  page.pointer('pointerdown', 2, 20, 20); page.pointer('pointermove', 2, 25, 25);
  page.pointer('pointermove', 2, 20, 20); page.pointer('pointerup', 2, 20, 20);
  assert.equal(page.updates.length, 2, 'returning to the original point keeps the drag active');
  close(page.viewport, { scale: 1, x: 0, y: 0 });
  page.pointer('pointerdown', 3, 20, 20); page.pointer('pointerup', 3, 50, 50);
  assert.equal(page.updates.length, 2, 'pointerup does not apply an unobserved movement');
  assert.equal(page.canvas.hasPointerCapture(3), false);
});

test('pinch preserves the graph point under the midpoint with a nonzero canvas origin', () => {
  const page = fixture({ viewport: { scale: .5, x: 25, y: -20 }, left: 120, top: 250 });
  pair(page);
  page.pointer('pointermove', 1, 50, 100); page.pointer('pointermove', 2, 250, 100);
  close(page.viewport, { scale: 1, x: -100, y: -140 });
  assert.equal((150 - page.viewport.x) / page.viewport.scale, 250);
  assert.equal((100 - page.viewport.y) / page.viewport.scale, 240);
  page.pointer('pointermove', 1, 70, 130); page.pointer('pointermove', 2, 270, 130);
  close(page.viewport, { scale: 1, x: -80, y: -110 });
  assert.equal((170 - page.viewport.x) / page.viewport.scale, 250);
  assert.equal((130 - page.viewport.y) / page.viewport.scale, 240);
  page.pointer('pointerup', 1, 70, 130); page.pointer('pointerup', 2, 270, 130);
  assert.equal(page.canvas.hasPointerCapture(1), false); assert.equal(page.canvas.hasPointerCapture(2), false);
});

test('equal-distance two-finger movement translates the graph without changing scale', () => {
  const page = fixture({ viewport: { scale: .8, x: -45, y: 15 }, left: 35, top: 80 });
  pair(page);
  page.pointer('pointermove', 1, 125, 140); page.pointer('pointermove', 2, 225, 140);
  close(page.viewport, { scale: .8, x: -20, y: 55 });
});

for (const [label, firstX, secondX, expectedScale] of [['maximum', -350, 650, 2.4], ['minimum', 149.5, 150.5, .08]]) {
  test(`pinch ${label} clamp retains its midpoint anchor and finite viewport`, () => {
    const page = fixture({ viewport: { scale: .5, x: 25, y: -20 }, left: 10, top: 30 });
    pair(page);
    page.pointer('pointermove', 1, firstX, 100); page.pointer('pointermove', 2, secondX, 100);
    close(page.viewport, { scale: expectedScale, x: 150 - 250 * expectedScale, y: 100 - 240 * expectedScale });
    assert.ok(Object.values(page.viewport).every(Number.isFinite));
  });
}

test('coincident initial touches remain finite and their midpoint can still translate', () => {
  const page = fixture({ viewport: { scale: .7, x: 12, y: -5 } });
  pair(page, [100, 100], [100, 100]);
  page.pointer('pointermove', 2, 140, 120);
  close(page.viewport, { scale: .7, x: 32, y: 5 });
});

test('a caller-supplied lower limit keeps tiny Schedule pinch gestures anchored', () => {
  const page = fixture({ viewport: { scale: .002, x: 25, y: -20 }, clampScale: value => Math.min(2.4, Math.max(.0005, value)) });
  pair(page);
  page.pointer('pointermove', 1, 125, 100); page.pointer('pointermove', 2, 175, 100);
  close(page.viewport, { scale: .001, x: 87.5, y: 40 });
  page.pointer('pointermove', 1, 149.5, 100); page.pointer('pointermove', 2, 150.5, 100);
  close(page.viewport, { scale: .0005, x: 118.75, y: 70 });
  assert.equal((150 - page.viewport.x) / page.viewport.scale, (150 - 25) / .002);
});

test('two fingers become a single drag without a jump and a later touch tap stays inert', () => {
  const page = fixture(); pair(page);
  page.pointer('pointermove', 2, 300, 100); close(page.viewport, { scale: 2, x: -100, y: -100 });
  page.pointer('pointerup', 1, 100, 100);
  close(page.viewport, { scale: 2, x: -100, y: -100 });
  assert.equal(page.canvas.hasPointerCapture(1), false); assert.equal(page.canvas.hasPointerCapture(2), true);
  page.pointer('pointermove', 2, 300, 100); close(page.viewport, { scale: 2, x: -100, y: -100 });
  page.pointer('pointermove', 2, 320, 125); close(page.viewport, { scale: 2, x: -80, y: -75 });
  page.pointer('pointerup', 2, 320, 125); assert.equal(page.canvas.hasPointerCapture(2), false);
  const updates = page.updates.length;
  page.pointer('pointerdown', 3, 50, 50); page.pointer('pointerup', 3, 50, 50);
  assert.equal(page.updates.length, updates); close(page.viewport, { scale: 2, x: -80, y: -75 });
});

test('a stationary two-finger gesture leaves the viewport unchanged regardless of release order', () => {
  for (const order of [[1, 2], [2, 1]]) {
    const page = fixture(); pair(page);
    for (const id of order) page.pointer('pointerup', id, id === 1 ? 100 : 200, 100);
    assert.equal(page.updates.length, 0); close(page.viewport, { scale: 1, x: 0, y: 0 });
  }
});

test('capture loss caused by releasing one finger does not cancel the surviving gesture', () => {
  const page = fixture(), release = page.canvas.releasePointerCapture.bind(page.canvas);
  page.canvas.releasePointerCapture = id => { release(id); page.pointer('lostpointercapture', id, 0, 0); };
  pair(page); page.pointer('pointermove', 2, 250, 100);
  const before = { ...page.viewport };
  page.pointer('pointerup', 1, 100, 100);
  assert.equal(page.canvas.hasPointerCapture(2), true); close(page.viewport, before);
  page.pointer('pointermove', 2, 275, 130);
  close(page.viewport, { scale: before.scale, x: before.x + 25, y: before.y + 30 });
  page.pointer('pointerup', 2, 275, 130); assert.equal(page.canvas.hasPointerCapture(2), false);
});

test('third-finger insertion and promotion preserve the viewport and release all captures', () => {
  const page = fixture({ viewport: { scale: .5, x: 15, y: -20 } }); pair(page);
  const initial = { ...page.viewport };
  page.pointer('pointerdown', 3, 400, 300); close(page.viewport, initial);
  page.pointer('pointermove', 3, 420, 340); close(page.viewport, initial);
  page.pointer('pointerup', 1, 100, 100); close(page.viewport, initial);
  page.pointer('pointermove', 2, 200, 100); close(page.viewport, initial);
  page.pointer('pointermove', 2, 210, 120); page.pointer('pointermove', 3, 430, 360);
  close(page.viewport, { scale: .5, x: 25, y: 0 });
  page.pointer('pointerup', 3, 430, 360); page.pointer('pointerup', 2, 210, 120);
  assert.equal(page.canvas.hasPointerCapture(1), false); assert.equal(page.canvas.hasPointerCapture(2), false); assert.equal(page.canvas.hasPointerCapture(3), false);
});

test('unrelated IDs, duplicate pointerdown and a different pointer type cannot take over a gesture', () => {
  const page = fixture(); page.pointer('pointerdown', 1, 20, 20);
  page.pointer('pointerdown', 1, 500, 500);
  const ignored = page.pointer('pointerdown', 3, 100, 100, { pointerType: 'mouse' });
  assert.equal(ignored.defaultPrevented, false); assert.equal(page.canvas.hasPointerCapture(3), false);
  for (const name of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) page.pointer(name, 99, 400, 400);
  assert.equal(page.canvas.hasPointerCapture(1), true); assert.equal(page.updates.length, 0);
  page.pointer('pointermove', 1, 35, 45); close(page.viewport, { scale: 1, x: 15, y: 25 });
  page.pointer('pointerup', 1, 35, 45); assert.equal(page.canvas.hasPointerCapture(1), false);
});

test('empty diagrams and nonprimary buttons never capture or alter the view', () => {
  for (const [options, button] of [[{ diagram: false }, 0], [{}, 1], [{}, 2]]) {
    const page = fixture(options);
    const down = page.pointer('pointerdown', 4, 10, 10, { pointerType: 'mouse', button });
    page.pointer('pointermove', 4, 50, 50); page.pointer('pointerup', 4, 50, 50);
    assert.equal(down.defaultPrevented, false); assert.equal(page.canvas.hasPointerCapture(4), false);
    assert.equal(page.updates.length, 0); close(page.viewport, { scale: 1, x: 0, y: 0 });
    assert.deepEqual(page.activations, []);
  }
});

for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'pagehide', 'reset']) {
  test(`${reason} cancels pending mouse selection and permits a later click`, () => {
    const page = fixture();
    page.pointer('pointerdown', 1, 20, 30, { pointerType: 'mouse' });
    if (reason === 'reset') page.controller.reset();
    else if (reason === 'blur' || reason === 'pagehide') page.signal(reason);
    else {
      if (reason === 'lostpointercapture') page.canvas.releasePointerCapture(1);
      page.pointer(reason, 1, 20, 30, { pointerType: 'mouse' });
    }
    page.pointer('pointerup', 1, 20, 30, { pointerType: 'mouse' });
    assert.deepEqual(page.activations, []); assert.equal(page.canvas.hasPointerCapture(1), false);
    page.pointer('pointerdown', 2, 40, 50, { pointerType: 'mouse' });
    page.pointer('pointerup', 2, 40, 50, { pointerType: 'mouse' });
    assert.deepEqual(page.activations, [[40, 50]]);
  });
  test(`${reason} clears every captured touch and permits a fresh drag`, () => {
    const page = fixture(); pair(page); page.pointer('pointermove', 2, 250, 130);
    const before = { ...page.viewport };
    if (reason === 'reset') page.controller.reset();
    else if (reason === 'blur' || reason === 'pagehide') page.signal(reason);
    else {
      if (reason === 'lostpointercapture') page.canvas.releasePointerCapture(1);
      page.pointer(reason, 1, 100, 100);
    }
    assert.equal(page.canvas.hasPointerCapture(1), false); assert.equal(page.canvas.hasPointerCapture(2), false);
    assert.equal(page.canvas.classList.contains('dragging'), false);
    page.pointer('pointermove', 2, 500, 500); page.pointer('pointerup', 2, 500, 500);
    close(page.viewport, before);
    page.pointer('pointerdown', 8, 40, 50); page.pointer('pointermove', 8, 60, 80); page.pointer('pointerup', 8, 60, 80);
    close(page.viewport, { ...before, x: before.x + 20, y: before.y + 30 });
    assert.equal(page.canvas.hasPointerCapture(8), false);
  });
}

test('mouse activates once before synthetic clicks while touch taps stay inert and keyboard controls remain reachable', () => {
  const page = fixture(), received = [];
  page.document.addEventListener('click', event => received.push(event.detail));
  const target = page.document.getElementById('target');
  for (const [pointerId, pointerType, detail] of [[1, 'mouse', 1], [2, 'touch', 2]]) {
    page.pointer('pointerdown', pointerId, 20, 30, { pointerType });
    page.pointer('pointerup', pointerId, 20, 30, { pointerType });
    const event = target.dispatch('click', { detail });
    assert.equal(event.defaultPrevented, true); assert.equal(event.propagationStopped, true);
  }
  const keyboard = target.dispatch('click', { detail: 0 });
  assert.equal(keyboard.defaultPrevented, false); assert.deepEqual(received, [0]);
  assert.deepEqual(page.activations, [[20, 30]]);
});

test('right-click menu events pass through the gesture layer without capture or transformation', () => {
  const page = fixture(), received = [];
  page.document.addEventListener('contextmenu', event => received.push(event.target.id));
  const event = page.document.getElementById('target').dispatch('contextmenu', { button: 2 });
  assert.equal(event.defaultPrevented, false); assert.notEqual(event.propagationStopped, true);
  assert.deepEqual(received, ['target']); assert.equal(page.updates.length, 0);
  assert.deepEqual(page.activations, []);
});
