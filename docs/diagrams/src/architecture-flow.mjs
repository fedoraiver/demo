// 流动层独立于业务 SVG，沿原生路径显示方向提示。
export function architectureFlowDirections(path, window = path.ownerDocument.defaultView) {
  const style = window?.getComputedStyle?.(path);
  const marker = name => {
    const value = style?.getPropertyValue(name) || path.style.getPropertyValue(name) || path.getAttribute(name) || '';
    return /url\(/i.test(value);
  };
  const directions = [];
  if (marker('marker-end')) directions.push(1);
  if (marker('marker-start')) directions.push(-1);
  if (directions.length) return directions;
  if (path.hasAttribute('data-link-id') || path.hasAttribute('data-schedule-link-id')) {
    return [path.getAttribute('data-native-reverse') === 'true' ? -1 : 1];
  }
  const edge = path.closest('g.edge');
  if (!edge) return [];
  const length = path.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) return [];
  const start = path.getPointAtLength(0), end = path.getPointAtLength(length);
  const matrix = path.getCTM?.();
  for (const polygon of edge.querySelectorAll('polygon')) {
    const values = (polygon.getAttribute('points') || '').match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
    if (values.length < 6 || values.length % 2) continue;
    const native = polygon.getCTM?.();
    const transform = matrix && native ? matrix.inverse().multiply(native) : null;
    const points = [];
    for (let index = 0; index < values.length; index += 2) {
      const x = values[index], y = values[index + 1];
      points.push(transform ? { x: transform.a * x + transform.c * y + transform.e, y: transform.b * x + transform.d * y + transform.f } : { x, y });
    }
    const center = { x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
    const radius = Math.max(...points.map(point => Math.hypot(point.x - center.x, point.y - center.y)));
    const fromStart = Math.hypot(center.x - start.x, center.y - start.y);
    const fromEnd = Math.hypot(center.x - end.x, center.y - end.y);
    if (Math.min(fromStart, fromEnd) <= Math.max(4, radius * 3)) directions.push(fromStart < fromEnd ? -1 : 1);
  }
  return [...new Set(directions)];
}

export function createArchitectureFlow({ diagram, window = diagram.ownerDocument.defaultView, button, enabled = true }) {
  const document = diagram.ownerDocument;
  const namespace = 'http://www.w3.org/2000/svg';
  const reducedMotion = window?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let layer = null, source = null, resizeObserver = null, appearanceObserver = null;
  let disposed = false, channels = [], revision = 0;

  function nativeTransform(element) {
    const transforms = [];
    for (let item = element; item && item !== source; item = item.parentElement) {
      if (item.getAttribute('transform')) transforms.unshift(item.getAttribute('transform'));
    }
    return transforms.join(' ');
  }
  function labelMask() {
    const labels = new Set([...source.querySelectorAll('.edgeLabel'), ...source.querySelectorAll('.edge-label'), ...source.querySelectorAll('g.edge text')]);
    const boxes = [...labels].map(element => ({ element, box: element.getBBox() })).filter(({ box }) => box.width > 0 && box.height > 0);
    if (!boxes.length) return null;
    const bounds = (source.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
    const defs = document.createElementNS(namespace, 'defs'), mask = document.createElementNS(namespace, 'mask');
    const id = (source.getAttribute('id') || 'architecture') + '-flow-mask-' + ++revision;
    mask.setAttribute('id', id);
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
    const background = document.createElementNS(namespace, 'rect');
    for (const [index, name] of ['x', 'y', 'width', 'height'].entries()) {
      mask.setAttribute(name, String(bounds[index]));
      background.setAttribute(name, String(bounds[index]));
    }
    background.setAttribute('fill', 'white');
    mask.appendChild(background);
    for (const { element, box } of boxes) {
      const cover = document.createElementNS(namespace, 'rect');
      for (const name of ['x', 'y', 'width', 'height']) cover.setAttribute(name, String(box[name]));
      cover.setAttribute('transform', nativeTransform(element));
      cover.setAttribute('fill', 'black');
      mask.appendChild(cover);
    }
    defs.appendChild(mask);
    layer.appendChild(defs);
    return id;
  }

  function sync() {
    const paused = !enabled || Boolean(document.hidden) || Boolean(reducedMotion?.matches);
    if (layer) {
      layer.setAttribute('data-flow-paused', String(paused));
      layer.style.visibility = paused ? 'hidden' : 'visible';
    }
    if (button) {
      button.setAttribute('aria-pressed', String(enabled));
      button.title = reducedMotion?.matches ? '系统已减少动态效果，连线流动暂停' : enabled ? '暂停连线流动' : '开启连线流动';
    }
  }
  function syncSize() {
    if (!layer || !source) return;
    for (const name of ['width', 'height']) {
      const value = source.getAttribute(name);
      if (value !== null) layer.setAttribute(name, value);
      else layer.removeAttribute(name);
    }
    // 保留原生 pt/百分比单位，避免 computedStyle 的像素取整错开路径。
    for (const name of ['width', 'height', 'max-width', 'max-height']) {
      const value = source.style.getPropertyValue(name);
      if (value) layer.style.setProperty(name, value);
      else layer.style.removeProperty(name);
    }
  }
  function syncAppearance() {
    for (const { original, decoration } of channels) {
      const style = window?.getComputedStyle?.(original);
      const width = parseFloat(style?.getPropertyValue('stroke-width') || original.getAttribute('stroke-width') || '1.6');
      decoration.setAttribute('stroke-width', String(Math.max(.8, width * .75)));
      let opacity = .9 * Number(style?.getPropertyValue('stroke-opacity') || original.getAttribute('stroke-opacity') || 1);
      if (width <= 0 || style?.getPropertyValue('stroke') === 'none') opacity = 0;
      for (let item = original; item && item !== source.parentElement; item = item.parentElement) {
        const current = window?.getComputedStyle?.(item);
        const value = current?.getPropertyValue('opacity') || item.style.getPropertyValue('opacity') || '1';
        opacity *= Number(value);
        if (current?.getPropertyValue('display') === 'none' || current?.getPropertyValue('visibility') === 'hidden') opacity = 0;
      }
      decoration.setAttribute('opacity', String(opacity));
    }
  }
  function clear() {
    resizeObserver?.disconnect();
    appearanceObserver?.disconnect();
    resizeObserver = null;
    appearanceObserver = null;
    layer?.remove();
    layer = null;
    source = null;
    channels = [];
  }
  function refresh(svg) {
    clear();
    if (disposed) return 0;
    source = svg || diagram.querySelector('svg');
    if (!source || source.getAttribute('data-architecture-flow-overlay') !== null) { source = null; return 0; }
    layer = document.createElementNS(namespace, 'svg');
    layer.setAttribute('data-architecture-flow-overlay', 'true');
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('focusable', 'false');
    layer.style.setProperty('pointer-events', 'none');
    for (const name of ['viewBox', 'preserveAspectRatio', 'width', 'height', 'transform']) {
      const value = source.getAttribute(name);
      if (value !== null) layer.setAttribute(name, value);
    }
    const traces = document.createElementNS(namespace, 'g');
    // 原生标签背景本来遮住路径，装饰层保持同一遮挡范围。
    const mask = labelMask();
    if (mask) traces.setAttribute('mask', `url(#${mask})`);
    layer.appendChild(traces);
    for (const original of source.querySelectorAll('path')) {
      if (!original.getAttribute('d')) continue;
      if (!original.hasAttribute('data-link-id') && !original.hasAttribute('data-schedule-link-id') && !original.closest('g.edge')) continue;
      const directions = architectureFlowDirections(original, window);
      const transform = nativeTransform(original);
      for (const direction of directions) {
        const decoration = document.createElementNS(namespace, 'path');
        decoration.setAttribute('class', 'architecture-flow-channel');
        decoration.setAttribute('d', original.getAttribute('d'));
        decoration.setAttribute('data-flow-direction', direction === 1 ? 'forward' : 'reverse');
        decoration.setAttribute('fill', 'none');
        decoration.setAttribute('stroke', '#ffffff');
        decoration.setAttribute('pointer-events', 'none');
        if (transform) decoration.setAttribute('transform', transform);
        if (directions.length > 1 && direction === -1) decoration.style.setProperty('animation-delay', '-.4s');
        traces.appendChild(decoration);
        channels.push({ original, decoration });
      }
    }
    if (!channels.length) { clear(); return 0; }
    diagram.appendChild(layer);
    syncSize();
    syncAppearance();
    sync();
    if (window?.ResizeObserver) {
      resizeObserver = new window.ResizeObserver(syncSize);
      resizeObserver.observe(source);
    }
    if (window?.MutationObserver) {
      appearanceObserver = new window.MutationObserver(syncAppearance);
      appearanceObserver.observe(source, { attributes: true, subtree: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    return channels.length;
  }
  function setEnabled(value) { enabled = Boolean(value); sync(); return enabled; }
  function toggle() { setEnabled(!enabled); }
  function dispose() {
    if (disposed) return;
    clear(); disposed = true;
    document.removeEventListener('visibilitychange', sync);
    reducedMotion?.removeEventListener?.('change', sync);
    window?.removeEventListener?.('resize', syncSize);
    button?.removeEventListener('click', toggle);
  }
  document.addEventListener('visibilitychange', sync);
  reducedMotion?.addEventListener?.('change', sync);
  window?.addEventListener?.('resize', syncSize);
  button?.addEventListener('click', toggle);
  sync();
  return { refresh, clear, dispose, setEnabled, get enabled() { return enabled; },
    get running() { return Boolean(layer) && enabled && !document.hidden && !reducedMotion?.matches; },
    get channelCount() { return channels.length; } };
}

export function architectureFlowAssets() {
  return {
    style: `
[data-architecture-flow-overlay]{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.architecture-flow-channel{stroke-dasharray:3 13;stroke-linecap:round;animation:architecture-edge-flow 1.2s linear infinite;pointer-events:none}
.architecture-flow-channel[data-flow-direction="reverse"]{animation-direction:reverse}
[data-flow-paused="true"] .architecture-flow-channel{animation-play-state:paused}
@keyframes architecture-edge-flow{from{stroke-dashoffset:0}to{stroke-dashoffset:-16}}
@media(prefers-reduced-motion:reduce){[data-architecture-flow-overlay]{visibility:hidden!important}.architecture-flow-channel{animation-play-state:paused}}
`,
    markup: '<button type="button" data-flow-toggle aria-pressed="true" title="暂停连线流动">连线流动</button>',
    script: [architectureFlowDirections, createArchitectureFlow].map(fn => fn.toString()).join('\n'),
  };
}
