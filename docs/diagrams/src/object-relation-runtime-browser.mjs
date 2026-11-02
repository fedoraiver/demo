// 按需编译单条真实关系；业务身份与原生 DOM 编译身份分开，异步结果只提交最新选择。
import mermaid from 'mermaid';
import { renderGraphView } from './architecture-renderer-core.mjs';
import { normalizeMermaidSvg, nativeLabelMismatches, compileRoutedView } from './mermaid-core.mjs';
import { checkMermaidGeometry } from './diagram-geometry.mjs';
import { validateArchitectureSvg } from './architecture-asset-loader.mjs';
import { projectObjectRelation, objectRelationRenderKey } from './architecture-object-relations.mjs';

let nativeSequence = 0;
const nativeNamespace = globalThis.crypto?.randomUUID?.().replaceAll('-', '') || Math.random().toString(36).slice(2);
let nativeQueue = Promise.resolve();
const abortError = () => new DOMException('Object relation rendering cancelled', 'AbortError');

/** Mermaid 依赖原生 DOM 测量；临时容器参与布局，但不进入画布或键盘导航。 */
async function compileNativeInDocument(view, { document = globalThis.document, engine = mermaid, signal, isCurrent = () => true } = {}) {
  if (signal?.aborted || !isCurrent()) throw abortError();
  if (!document?.body) throw new Error('Object relation rendering requires a document');
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.setAttribute('data-object-relation-compiler', '');
  container.style.cssText = 'position:fixed;left:-100000px;top:0;width:1600px;visibility:hidden;pointer-events:none;';
  document.body.appendChild(container);
  try {
    engine.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true,
      maxTextSize: Math.max(200000, view.mermaid.length), maxEdges: Math.max(500, view.links.length) });
    const { svg } = await engine.render(view.id, view.mermaid, container);
    if (signal?.aborted || !isCurrent()) throw abortError();
    return svg;
  } finally {
    container.remove();
  }
}

/** 多个查看器实例共用 Mermaid 的全局配置，初始化和原生测量必须一起串行。 */
export function compileObjectRelationNative(view, options = {}) {
  const result = nativeQueue.then(() => compileNativeInDocument(view, options));
  nativeQueue = result.catch(() => {});
  return result;
}
/** 单实例串行编译并缓存最近八个成功结果；取消只影响尚未提交的结果。 */
export function createObjectRelationRenderer({ registry, features = [], buildId = '', document = globalThis.document,
  limit = 8, compileNative = compileObjectRelationNative, normalize = normalizeMermaidSvg, route = compileRoutedView,
  checkGeometry = checkMermaidGeometry, checkLabels = nativeLabelMismatches,
  validateSvg = validateArchitectureSvg, DOMParser = globalThis.DOMParser } = {}) {
  if (!registry || typeof registry !== 'object') throw new Error('Object relation registry is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new Error('Invalid object relation cache limit');
  const cache = new Map();
  let generation = 0, pending = null, active = null, draining = false, disposed = false, pinned = null;
  const current = request => !disposed && !request.settled && request.generation === generation && !request.signal?.aborted;
  function finish(request, value, error) {
    if (request.settled) return;
    request.settled = true;
    request.signal?.removeEventListener('abort', request.cancel);
    if (error) request.reject(error); else request.resolve(value);
  }
  function cancel() {
    generation++;
    if (pending) { finish(pending, null, abortError()); pending = null; }
    if (active) finish(active, null, abortError());
  }
  function keep(key, value) {
    cache.delete(key); cache.set(key, value); pinned = key;
    while (cache.size > limit) {
      const oldest = [...cache.keys()].find(candidate => candidate !== pinned);
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  async function compile(request) {
    const graph = projectObjectRelation(request.fullView, request.relationId);
    // 使用唯一 DOM ID，避免 Mermaid 的全局选择器命中仍显示在画布中的旧图。
    const nativeRenderId = 'object-relation-native-' + nativeNamespace + '-' + (++nativeSequence);
    const definition = renderGraphView({ id: nativeRenderId, aspect: 'object', label: request.fullView.label,
      summary: request.fullView.summary || '当前对象的一条直接关系。', objectId: request.fullView.objectId,
      centerNodeId: graph.centerNodeId }, graph, registry, features);
    async function candidate(view) {
      if (!current(request)) throw abortError();
      const svg = await compileNative(view, { document, signal: request.signal, isCurrent: () => current(request) });
      if (!current(request)) throw abortError();
      const normalized = normalize(view, svg, registry);
      validateSvg(normalized.svg, { DOMParser });
      return normalized;
    }
    // 与静态对象图共用原生候选、轮廓/路径/箭头和完整文字检查，禁止修补编译后的几何。
    const result = await route(definition, registry, candidate);
    if (!current(request)) throw abortError();
    const missing = checkLabels(result);
    if (missing.length) throw new Error('Object relation labels are incomplete: ' + missing.join(', '));
    checkGeometry(result.svg, result);
    validateSvg(result.svg, { DOMParser });
    const focused = { ...result, id: request.fullView.id, nativeRenderId, presentation: 'relation',
      relationId: request.relationId, renderKey: request.key };
    checkGeometry(focused.svg, focused);
    return Object.freeze(focused);
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending) {
        const request = pending; pending = null; active = request;
        try {
          if (!current(request)) throw abortError();
          const value = await compile(request);
          if (!current(request)) throw abortError();
          keep(request.key, value); finish(request, value);
        } catch (error) {
          finish(request, null, current(request) ? error : abortError());
        } finally {
          if (active === request) active = null;
        }
      }
    } finally {
      draining = false;
    }
  }
  return {
    render(fullView, relationId, { signal } = {}) {
      if (disposed) return Promise.reject(new Error('Object relation renderer has been disposed'));
      cancel();
      if (signal?.aborted) return Promise.reject(abortError());
      const key = objectRelationRenderKey(buildId, fullView.id, relationId);
      if (cache.has(key)) {
        const value = cache.get(key), expected = generation;
        return Promise.resolve().then(() => {
          if (disposed || expected !== generation || signal?.aborted) throw abortError();
          keep(key, value); return value;
        });
      }
      return new Promise((resolve, reject) => {
        const request = { fullView, relationId, signal, key, generation, resolve, reject, settled: false };
        request.cancel = () => {
          if (request.generation === generation) cancel(); else finish(request, null, abortError());
        };
        signal?.addEventListener('abort', request.cancel, { once: true });
        pending = request;
        void drain();
      });
    },
    cancel,
    dispose() { if (disposed) return; disposed = true; cancel(); cache.clear(); pinned = null; },
  };
}
