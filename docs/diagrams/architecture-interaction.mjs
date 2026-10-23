import { SELECTION_STYLE, selectedFillColor } from './architecture-style.mjs';

// 直接更新 Mermaid 的真实轮廓，避免原生 inline !important 压过选择样式。
export function createArchitectureInteraction({ diagram, nodeStyles, selectionStyle = SELECTION_STYLE }) {
  const originals = new WeakMap();
  let active = new Set(), scale = 1, filterId = 0;
  const namespace = 'http://www.w3.org/2000/svg';
  const property = (element, name) => ({ value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) });
  function restoreProperty(element, name, original) {
    if (original.value) element.style.setProperty(name, original.value, original.priority);
    else element.style.removeProperty(name);
  }
  function hasFill(value, opacity) {
    if (Number(opacity) === 0 || /^(?:none|transparent)$/i.test(value)) return false;
    if (/^#[\da-f]{3}0$/i.test(value) || /^#[\da-f]{6}00$/i.test(value)) return false;
    const color = /^(?:rgba?|hsla?)\((.*)\)$/i.exec(value), channels = color?.[1].split(/[\s,/]+/).filter(Boolean);
    return !(channels?.length === 4 && parseFloat(channels[3]) === 0);
  }
  function nativeOutlineRoot(node, parts) {
    const roots = new Set(parts.map(part => {
      while (part.parentElement && part.parentElement !== node) part = part.parentElement;
      return part;
    }));
    if (roots.size !== 1) throw new Error('Architecture node must have one native outline root');
    const root = [...roots][0];
    if (root.parentElement !== node || root.matches('.label') || root.tagName.toLowerCase() === 'text' || root.querySelector('.label') || root.querySelector('text')) throw new Error('Architecture native outline must exclude labels and text');
    return root;
  }
  function remember(target, parts, semantic, outline = target) {
    let state = originals.get(target);
    if (state) return state;
    const computed = outline.ownerDocument.defaultView?.getComputedStyle(outline);
    state = {
      target, outline, box: outline.getBBox(), filter: property(outline, 'filter'),
      effectiveFilter: computed?.filter || outline.style.getPropertyValue('filter') || outline.getAttribute('filter') || 'none',
      parts: parts.map(part => {
        const computed = part.ownerDocument.defaultView?.getComputedStyle(part), width = property(part, 'stroke-width'), fill = property(part, 'fill');
        return { part, width, fill,
          baseWidth: parseFloat(width.value || computed?.strokeWidth || part.getAttribute('stroke-width') || semantic?.width || 1),
          filled: hasFill(computed?.fill || fill.value || part.getAttribute('fill') || 'black', computed?.fillOpacity || part.style.getPropertyValue('fill-opacity') || part.getAttribute('fill-opacity') || 1),
          selectedFill: selectedFillColor(semantic?.stroke || computed?.stroke || part.style.getPropertyValue('stroke') || part.getAttribute('stroke'), selectionStyle.fillStrokeRatio),
        };
      }), ring: null,
    };
    originals.set(target, state);
    return state;
  }
  function createRing(state) {
    const svg = state.target.closest('svg'), document = state.target.ownerDocument;
    let defs = [...svg.children].find(child => child.tagName.toLowerCase() === 'defs');
    if (!defs) { defs = document.createElementNS(namespace, 'defs'); svg.appendChild(defs); }
    function element(name, attributes, parent) {
      const item = document.createElementNS(namespace, name);
      for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
      parent.appendChild(item); return item;
    }
    const id = `${svg.getAttribute('id') || 'architecture'}-selection-${++filterId}`;
    const filter = element('filter', { id, 'data-selection-filter': 'true', filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, defs);
    const outer = element('feMorphology', { in: 'SourceAlpha', operator: 'dilate', result: 'outer' }, filter);
    const inner = element('feMorphology', { in: 'SourceAlpha', operator: 'dilate', result: 'inner' }, filter);
    element('feComposite', { in: 'outer', in2: 'inner', operator: 'out', result: 'ring' }, filter);
    element('feFlood', { 'flood-color': selectionStyle.ringColor, 'flood-opacity': selectionStyle.ringOpacity, result: 'color' }, filter);
    element('feComposite', { in: 'color', in2: 'ring', operator: 'in', result: 'colored-ring' }, filter);
    const merge = element('feMerge', {}, filter);
    element('feMergeNode', { in: 'colored-ring' }, merge); element('feMergeNode', { in: 'SourceGraphic' }, merge);
    state.ring = { filter, outer, inner };
    state.outline.style.setProperty('filter', `${state.effectiveFilter === 'none' ? '' : state.effectiveFilter + ' '}url(#${id})`, 'important');
  }
  function update(state) {
    let widest = 0;
    for (const original of state.parts) {
      const width = original.baseWidth + selectionStyle.strokeExtraPx / scale;
      original.part.style.setProperty('stroke-width', `${width}px`, 'important');
      if (original.filled && original.selectedFill) original.part.style.setProperty('fill', original.selectedFill, 'important');
      widest = Math.max(widest, width);
    }
    if (!state.ring) createRing(state);
    const { filter, outer, inner } = state.ring;
    outer.setAttribute('radius', String((selectionStyle.ringGapPx + selectionStyle.ringWidthPx) / scale));
    inner.setAttribute('radius', String(selectionStyle.ringGapPx / scale));
    // 滤镜与原生描边都在局部坐标中；按屏幕外扩量计算范围，不依赖固定百分比。
    const padding = widest / 2 + (selectionStyle.ringGapPx + selectionStyle.ringWidthPx + selectionStyle.filterPaddingPx) / scale;
    for (const [name, value] of Object.entries({ x: state.box.x - padding, y: state.box.y - padding, width: state.box.width + 2 * padding, height: state.box.height + 2 * padding })) filter.setAttribute(name, String(value));
  }
  function restore(state) {
    for (const original of state.parts) {
      restoreProperty(original.part, 'stroke-width', original.width);
      restoreProperty(original.part, 'fill', original.fill);
    }
    restoreProperty(state.outline, 'filter', state.filter);
    state.ring?.filter.remove(); state.ring = null;
  }
  function paint({ selectedNodes = new Set(), dimNodes = new Set(), selectedSchedules = new Set(), focusedEdges = new Set(), dimEdges = new Set() } = {}) {
    const next = new Set();
    for (const node of diagram.querySelectorAll('[data-id]')) {
      const selected = selectedNodes.has(node.dataset.id);
      node.classList.toggle('selected', selected); node.classList.toggle('dim', dimNodes.has(node.dataset.id));
      node.setAttribute('aria-pressed', String(selected));
      if (selected) {
        const instance = node.dataset.instance || node.dataset.id;
        const parts = [...node.querySelectorAll('[data-shape-part]')].filter(part => part.dataset.shapePart === instance && part.closest('[data-id]') === node);
        next.add(remember(node, parts, nodeStyles[node.dataset.visualType], nativeOutlineRoot(node, parts)));
      }
    }
    for (const group of diagram.querySelectorAll('[data-schedule-id]')) {
      const selected = selectedSchedules.has(group.dataset.scheduleId);
      group.classList.toggle('selected', selected);
      // 嵌套 Schedule 的系统也在后代中，滤镜和填充仅作用于本组直属容器。
      if (selected) for (const part of group.children) if (part.tagName.toLowerCase() === 'rect') next.add(remember(part, [part]));
    }
    for (const state of active) if (!next.has(state)) restore(state);
    active = next;
    for (const state of active) update(state);
    for (const edge of diagram.querySelectorAll('.edge')) {
      const id = edge.dataset.linkId ?? edge.dataset.scheduleLinkId;
      edge.classList.toggle('focused', focusedEdges.has(id)); edge.classList.toggle('dim', dimEdges.has(id));
    }
  }
  function setScale(value) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Architecture scale must be a positive finite number');
    if (value === scale) return;
    scale = value;
    const svg = diagram.tagName.toLowerCase() === 'svg' ? diagram : diagram.querySelector('svg');
    for (const state of active) {
      if (state.target.closest('svg') !== svg) { restore(state); active.delete(state); }
      else update(state);
    }
  }
  return { paint, setScale };
}

export function architectureInteractionAssets() {
  return { script: `const SELECTION_STYLE=${JSON.stringify(SELECTION_STYLE)};\n${selectedFillColor.toString()}\n${createArchitectureInteraction.toString()}` };
}
