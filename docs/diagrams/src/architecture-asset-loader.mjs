export async function readArchitectureResource(resource, { baseUrl = globalThis.location?.href, fetch: fetcher = globalThis.fetch, crypto = globalThis.crypto, signal, json = false } = {}) {
  if (!resource || typeof resource.url !== 'string' || !/^[a-f0-9]{64}$/i.test(resource.sha256 || '')) throw new Error('Invalid architecture resource descriptor');
  const base = new URL(baseUrl), url = new URL(resource.url, base);
  if (!['http:', 'https:'].includes(base.protocol) || url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Architecture resources require a same-origin HTTP or HTTPS server');
  if (!crypto?.subtle || typeof fetcher !== 'function') throw new Error('Architecture resource loading is unavailable');
  if (resource.bytes !== undefined && (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0)) throw new Error('Invalid architecture resource size');
  const response = await fetcher(url.href, { signal, cache: 'no-cache', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error('Architecture resource request failed: ' + response.status);
  const bytes = await response.arrayBuffer();
  if (resource.bytes !== undefined && bytes.byteLength !== resource.bytes) throw new Error('Architecture resource size mismatch: ' + resource.url);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== resource.sha256.toLowerCase()) throw new Error('Architecture resource hash mismatch: ' + resource.url);
  if (signal?.aborted) throw signal.reason || new DOMException('Architecture loading cancelled', 'AbortError');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return json ? JSON.parse(text) : text;
}

export function validateArchitectureSvg(text, { DOMParser = globalThis.DOMParser } = {}) {
  if (typeof text !== 'string' || /<!ENTITY|<!DOCTYPE|<\?xml-stylesheet/i.test(text)) throw new Error('Invalid architecture SVG content');
  const document = new DOMParser().parseFromString(text, 'image/svg+xml'), root = document.documentElement;
  if (root?.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || document.getElementsByTagName('parsererror').length) throw new Error('Invalid architecture SVG document');
  const svgTags = new Set(['svg','g','title','desc','a','text','tspan','polygon','polyline','path','rect','circle','ellipse','defs','clipPath','linearGradient','radialGradient','stop','style','marker','foreignObject','filter','feMorphology','feComposite','feFlood','feMerge','feMergeNode','feGaussianBlur','feOffset','feColorMatrix','feBlend','feDropShadow']);
  const htmlTags = new Set(['div','span','p','br','b','strong','i','em','code']);
  const safeUrls = (value, css = false) => {
    // 协议必须从独立 token 开始；Mermaid 选择器的 ID 可包含 query_data 等后缀。
    if (css && /@import|expression\s*\(|(?<![\p{L}\p{N}_#.-])(?:javascript|data)\s*:/iu.test(value)) throw new Error('Unexpected architecture SVG content');
    for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) if (!/^#[\w:.-]+$/.test(match[1].trim().replace(/^(['"])(.*)\1$/, '$2'))) throw new Error('Unexpected architecture SVG URL');
  };
  const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error('Invalid architecture SVG bounds');
  for (const element of [root, ...root.getElementsByTagName('*')]) {
    const allowed = element.namespaceURI === root.namespaceURI ? svgTags.has(element.localName) : element.namespaceURI === 'http://www.w3.org/1999/xhtml' && htmlTags.has(element.localName);
    if (!allowed) throw new Error('Unexpected architecture SVG element: ' + element.localName);
    if (element.localName === 'style') safeUrls(element.textContent, true);
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || ['src','srcset'].includes(attribute.name)) throw new Error('Unexpected architecture SVG attribute: ' + attribute.name);
      if (['href','xlink:href'].includes(attribute.name) && !/^#[\w:.-]+$/.test(attribute.value)) throw new Error('Unexpected architecture SVG link');
      safeUrls(attribute.value, attribute.name === 'style');
    }
  }
  return text;
}

export function createArchitectureAssetLoader({ baseUrl = globalThis.location?.href, fetch: fetcher = globalThis.fetch, crypto = globalThis.crypto, DOMParser = globalThis.DOMParser, limit = 8, timeoutMs = 15000,
  importModule = url => import(url), URL: Url = globalThis.URL, Blob: BlobType = globalThis.Blob } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid architecture cache limit');
  const cache = new Map(), pending = new Map(), modules = new Map(), modulePending = new Map();
  let pinned = null, recent = null, disposed = false;
  const abortError = () => new DOMException('Architecture loading cancelled', 'AbortError');
  const keyFor = (ref, includeSvg) => JSON.stringify([ref.id, ref.resources?.data, includeSvg ? ref.resources?.svg : null, ref.relationCount, ref.visualEdgeCount]);
  const trim = () => { while (cache.size > limit) { const item = [...cache].find(([, value]) => value.id !== pinned); if (!item) break; cache.delete(item[0]); } };
  const keep = (key, value) => { cache.delete(key); cache.set(key, value); trim(); };
  function subscribe(entry, signal, pendingStore = pending) {
    if (signal?.aborted) return Promise.reject(abortError());
    const token = {}; entry.users.add(token);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => { if (done) return; done = true; signal?.removeEventListener('abort', cancel); entry.users.delete(token); fn(value); };
      const cancel = () => { finish(reject, abortError()); if (!entry.users.size && pendingStore.get(entry.key) === entry) { pendingStore.delete(entry.key); entry.controller.abort(abortError()); } };
      signal?.addEventListener('abort', cancel, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  return {
    loadView(ref, { signal, includeSvg = true } = {}) {
      if (disposed) return Promise.reject(new Error('Architecture loader has been disposed'));
      if (signal?.aborted) return Promise.reject(abortError());
      const key = keyFor(ref, includeSvg);
      if (cache.has(key)) { const value = cache.get(key); keep(key, value); return Promise.resolve(value); }
      let entry = pending.get(key);
      if (!entry) {
        entry = { key, controller: new AbortController(), users: new Set() }; pending.set(key, entry);
        const timer = setTimeout(() => entry.controller.abort(new Error('Architecture loading timed out')), timeoutMs);
        const options = { baseUrl, fetch: fetcher, crypto, signal: entry.controller.signal };
        entry.promise = Promise.all([readArchitectureResource(ref.resources?.data, { ...options, json: true }), !includeSvg || !ref.resources?.svg ? null : readArchitectureResource(ref.resources?.svg, options)]).then(([metadata, svg]) => {
          if (entry.controller.signal.aborted) throw entry.controller.signal.reason || abortError();
          for (const field of ['id','aspect','engine','objectId','application','scheduleLabel','filename','width','height']) if (ref[field] !== undefined && metadata[field] !== ref[field]) throw new Error('Architecture view metadata mismatch: ' + field);
          if (!Array.isArray(metadata.nodes) || !Array.isArray(metadata.links) || !Array.isArray(metadata.sections)) throw new Error('Invalid architecture view metadata');
          if (ref.relationCount !== undefined && (!Number.isSafeInteger(ref.relationCount) || ref.relationCount < 0 || metadata.links.length !== ref.relationCount)) throw new Error('Architecture view relation count mismatch');
          if (ref.visualEdgeCount !== undefined && (!Number.isSafeInteger(ref.visualEdgeCount) || ref.visualEdgeCount < 0
            || !Array.isArray(metadata.visualEdgeGroups) || metadata.visualEdgeGroups.length !== ref.visualEdgeCount)) throw new Error('Architecture visual edge count mismatch');
          if (svg !== null) { validateArchitectureSvg(svg, { DOMParser }); const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement; if (root.getAttribute('id') !== ref.id || root.getAttribute('data-diagram-engine') !== ref.engine) throw new Error('Architecture SVG identity mismatch'); }
          const value = Object.freeze({ ...metadata, svg }); recent = { key, value }; keep(key, value); return value;
        }).catch(error => { throw entry.controller.signal.aborted ? entry.controller.signal.reason || error : error; }).finally(() => { clearTimeout(timer); if (pending.get(key) === entry) pending.delete(key); });
      }
      return subscribe(entry, signal);
    },
    loadModule(resource, { signal } = {}) {
      if (disposed) return Promise.reject(new Error('Architecture loader has been disposed'));
      if (signal?.aborted) return Promise.reject(abortError());
      const key = JSON.stringify(resource);
      if (modules.has(key)) return Promise.resolve(modules.get(key));
      let entry = modulePending.get(key);
      if (!entry) {
        entry = { key, controller: new AbortController(), users: new Set() }; modulePending.set(key, entry);
        const timer = setTimeout(() => entry.controller.abort(new Error('Architecture loading timed out')), timeoutMs);
        entry.promise = readArchitectureResource(resource, { baseUrl, fetch: fetcher, crypto, signal: entry.controller.signal }).then(async source => {
          if (entry.controller.signal.aborted) throw entry.controller.signal.reason || abortError();
          const url = Url.createObjectURL(new BlobType([source], { type: 'text/javascript' }));
          try {
            const module = await new Promise((resolve, reject) => {
              const cancel = () => reject(entry.controller.signal.reason || abortError());
              entry.controller.signal.addEventListener('abort', cancel, { once: true });
              Promise.resolve().then(() => importModule(url)).then(resolve, reject).finally(() => entry.controller.signal.removeEventListener('abort', cancel));
            });
            if (disposed || entry.controller.signal.aborted) throw entry.controller.signal.reason || abortError();
            modules.set(key, module); return module;
          } finally { Url.revokeObjectURL(url); }
        }).catch(error => { throw entry.controller.signal.aborted ? entry.controller.signal.reason || error : error; }).finally(() => {
          clearTimeout(timer); if (modulePending.get(key) === entry) modulePending.delete(key);
        });
      }
      return subscribe(entry, signal, modulePending);
    },
    pin(id) { pinned = id; if (recent?.value.id === id) { keep(recent.key, recent.value); recent = null; } trim(); },
    dispose() { disposed = true; for (const entry of [...pending.values(), ...modulePending.values()]) entry.controller.abort(abortError()); pending.clear(); modulePending.clear(); cache.clear(); modules.clear(); recent = null; },
  };
}

export function assetLoaderAssets() {
  return { script: [readArchitectureResource, validateArchitectureSvg, createArchitectureAssetLoader].map(fn => fn.toString()).join('\n') };
}
