// Node 与浏览器共用校验及标题绘制层次，保留 Graphviz 的原生坐标、字体、节点和路径。
const allowedElements = new Set(['svg', 'g', 'title', 'desc', 'a', 'text', 'tspan', 'polygon', 'polyline', 'path', 'rect', 'circle', 'ellipse', 'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop']);
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

function foregroundClusterTitles(svg, id) {
  const clusters = [...svg.getElementsByTagName('g')].filter(element => element.getAttribute('class') === 'cluster');
  for (const [index, cluster] of clusters.entries()) {
    const elements = [...cluster.getElementsByTagName('*')].filter(element => {
      for (let parent = element.parentNode; parent !== cluster; parent = parent.parentNode) {
        if (['cluster', 'node', 'edge'].includes(parent.getAttribute('class'))) return false;
      }
      return true;
    });
    const backgrounds = elements.filter(element => element.localName === 'polygon' && element.getAttribute('stroke') === 'none');
    const texts = elements.filter(element => element.localName === 'text');
    if (!backgrounds.length || !texts.length) continue;
    requireCondition(backgrounds.length === 1, 'Unsupported Graphviz cluster title background');
    const layer = cluster.cloneNode(false), clusterId = cluster.getAttribute('id') || 'cluster-' + index;
    layer.setAttribute('id', id + '-cluster-title-' + index);
    layer.setAttribute('class', 'schedule-cluster-title');
    layer.setAttribute('data-cluster-id', clusterId);
    layer.setAttribute('data-cluster-name', [...cluster.childNodes].find(element => element.localName === 'title')?.textContent || '');
    const wrappers = new Map([[cluster, layer]]);
    const wrapperFor = original => {
      if (wrappers.has(original)) return wrappers.get(original);
      const wrapper = original.cloneNode(false);
      if (wrapper.hasAttribute('id')) wrapper.setAttribute('id', id + '-cluster-title-' + index + '-' + wrapper.getAttribute('id'));
      wrapperFor(original.parentNode).appendChild(wrapper);
      wrappers.set(original, wrapper);
      return wrapper;
    };
    // Graphviz 先画集合标题、后画边；原生 TABLE 背景及文字提到末层，避免依赖边划过标题。
    // 克隆原包装保留 a 的 tooltip 与同一 transform 链，只重挂原图元，不重算任何几何属性。
    for (const element of elements.filter(element => backgrounds.includes(element) || texts.includes(element))) wrapperFor(element.parentNode).appendChild(element);
    cluster.parentNode.appendChild(layer);
  }
}

export function normalizeScheduleSvg(text, id, dom = globalThis) {
  requireCondition(typeof text === 'string' && !/<!ENTITY/i.test(text), 'Invalid Graphviz SVG content');
  requireCondition(/^[A-Za-z][\w-]*$/.test(id), 'Invalid Graphviz SVG identity');
  const errors = [];
  const document = new dom.DOMParser({ onError: (level, message) => errors.push(level + ': ' + message) }).parseFromString(text, 'image/svg+xml');
  const svg = document.documentElement;
  requireCondition(!errors.length && !document.getElementsByTagName('parsererror').length && svg?.localName === 'svg'
    && svg.namespaceURI === 'http://www.w3.org/2000/svg', 'Invalid Graphviz SVG: ' + id);
  const bounds = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  requireCondition(bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0, 'Invalid Graphviz viewBox: ' + id);
  for (const element of [svg, ...svg.getElementsByTagName('*')]) {
    requireCondition(allowedElements.has(element.localName) && element.namespaceURI === svg.namespaceURI, 'Unexpected Graphviz SVG element: ' + element.localName);
    for (const attribute of [...element.attributes]) {
      requireCondition(!/^on/i.test(attribute.name), 'Unexpected Graphviz SVG attribute: ' + attribute.name);
      if (['href', 'xlink:href'].includes(attribute.name)) requireCondition(/^#[\w.-]+$/.test(attribute.value), 'Unexpected Graphviz SVG attribute: ' + attribute.name);
      requireCondition(attribute.name !== 'style', 'Unexpected Graphviz SVG style');
      for (const match of attribute.value.matchAll(/url\s*\(([^)]*)\)/gi)) {
        requireCondition(/^#[\w.-]+$/.test(match[1].trim().replace(/^(['"])(.*)\1$/, '$2')), 'Unexpected Graphviz SVG URL');
      }
    }
  }
  svg.setAttribute('id', id);
  svg.setAttribute('width', String(bounds[2]));
  svg.setAttribute('height', String(bounds[3]));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', id);
  svg.setAttribute('data-diagram-engine', 'graphviz');
  foregroundClusterTitles(svg, id);
  return { svg: new dom.XMLSerializer().serializeToString(svg), width: bounds[2], height: bounds[3] };
}
