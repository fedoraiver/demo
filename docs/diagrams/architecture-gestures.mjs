// 每个触点独立保存；增减触点时重设基准，避免双指缩放退化为单指拖动。
export function createArchitectureGestures({ canvas, window, hasDiagram, getViewport, setViewport, activate, clampScale = value => Math.min(2.4, Math.max(.08, value)) }) {
  const pointers = new Map();
  let baseline = null, consumed = false;
  function rebase() {
    const points = [...pointers.values()].slice(0, 2), rect = canvas.getBoundingClientRect();
    if (!points.length) { baseline = null; return; }
    const [first, second = first] = points;
    baseline = { ...getViewport(), cx: (first.x + second.x) / 2 - rect.left, cy: (first.y + second.y) / 2 - rect.top,
      distance: Math.hypot(first.x - second.x, first.y - second.y), count: points.length };
  }
  function reset() {
    const ids = [...pointers.keys()];
    pointers.clear(); baseline = null; consumed = false; canvas.classList.remove('dragging');
    for (const id of ids) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function moved(point, event) {
    return Math.hypot(event.clientX - point.startX, event.clientY - point.startY) > 6;
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !hasDiagram() || pointers.has(event.pointerId)) return;
    const type = event.pointerType || 'mouse';
    if (pointers.size && [...pointers.values()][0].type !== type) return;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, type });
    if (pointers.size > 1) consumed = true;
    canvas.setPointerCapture(event.pointerId); rebase();
  });
  canvas.addEventListener('pointermove', event => {
    const point = pointers.get(event.pointerId);
    if (!point || !baseline) return;
    event.preventDefault();
    if (moved(point, event)) consumed = true;
    point.x = event.clientX; point.y = event.clientY;
    if (!consumed) return;
    const [first, second = first] = [...pointers.values()], rect = canvas.getBoundingClientRect();
    const cx = (first.x + second.x) / 2 - rect.left, cy = (first.y + second.y) / 2 - rect.top;
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    const scale = baseline.count > 1 && baseline.distance > 0
      ? clampScale(baseline.scale * distance / baseline.distance) : baseline.scale;
    setViewport({ scale, x: cx - (baseline.cx - baseline.x) * scale / baseline.scale,
      y: cy - (baseline.cy - baseline.y) * scale / baseline.scale });
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointerup', event => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    const tap = pointers.size === 1 && !consumed && !moved(point, event);
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (pointers.size) rebase(); else reset();
    if (tap) activate(event.clientX, event.clientY);
  });
  for (const name of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(name, event => {
    if (pointers.has(event.pointerId)) reset();
  });
  // 点击已在 pointerup 激活；阻止浏览器后续合成 click 再次选择连线。
  canvas.addEventListener('click', event => { if (event.detail > 0) { event.preventDefault(); event.stopPropagation(); } });
  window.addEventListener('blur', reset); window.addEventListener('pagehide', reset);
  return { reset };
}

export function architectureGestureAssets() {
  return { script: createArchitectureGestures.toString() };
}
