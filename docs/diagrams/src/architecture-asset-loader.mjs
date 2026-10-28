export async function readArchitectureResource(resource, { baseUrl = globalThis.location?.href, fetch: fetcher = globalThis.fetch, crypto = globalThis.crypto, signal, json = false } = {}) {
  if (!resource || typeof resource.url !== 'string' || !/^[a-f0-9]{64}$/i.test(resource.sha256 || '')) throw new Error('Invalid architecture resource descriptor');
  const base = new URL(baseUrl), url = new URL(resource.url, base);
  if (!['http:', 'https:'].includes(base.protocol) || url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Architecture resources require the local HTTP server');
  if (!crypto?.subtle || typeof fetcher !== 'function') throw new Error('Architecture resource loading is unavailable');
  const response = await fetcher(url.href, { signal, cache: 'no-cache', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Architecture resource request failed: ' + response.status);
  const bytes = await response.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
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
    if (css && /@import|expression\s*\(|javascript\s*:|data\s*:/i.test(value)) throw new Error('Unexpected architecture SVG content');
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

export function createArchitectureAssetLoader({ baseUrl = globalThis.location?.href, fetch: fetcher = globalThis.fetch, crypto = globalThis.crypto, DOMParser = globalThis.DOMParser, limit = 8, timeoutMs = 15000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid architecture cache limit');
  const cache = new Map(), pending = new Map();
  let pinned = null, recent = null, disposed = false;
  const abortError = () => new DOMException('Architecture loading cancelled', 'AbortError');
  const keyFor = ref => JSON.stringify([ref.id, ref.resources?.data, ref.resources?.svg]);
  const trim = () => { while (cache.size > limit) { const item = [...cache].find(([, value]) => value.id !== pinned); if (!item) break; cache.delete(item[0]); } };
  const keep = (key, value) => { cache.delete(key); cache.set(key, value); trim(); };
  function subscribe(entry, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    const token = {}; entry.users.add(token);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => { if (done) return; done = true; signal?.removeEventListener('abort', cancel); entry.users.delete(token); fn(value); };
      const cancel = () => { finish(reject, abortError()); if (!entry.users.size && pending.get(entry.key) === entry) { pending.delete(entry.key); entry.controller.abort(abortError()); } };
      signal?.addEventListener('abort', cancel, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }
  return {
    loadView(ref, { signal } = {}) {
      if (disposed) return Promise.reject(new Error('Architecture loader has been disposed'));
      if (signal?.aborted) return Promise.reject(abortError());
      const key = keyFor(ref);
      if (cache.has(key)) { const value = cache.get(key); keep(key, value); return Promise.resolve(value); }
      let entry = pending.get(key);
      if (!entry) {
        entry = { key, controller: new AbortController(), users: new Set() }; pending.set(key, entry);
        const timer = setTimeout(() => entry.controller.abort(new Error('Architecture loading timed out')), timeoutMs);
        const options = { baseUrl, fetch: fetcher, crypto, signal: entry.controller.signal };
        entry.promise = Promise.all([readArchitectureResource(ref.resources?.data, { ...options, json: true }), !ref.resources?.svg ? null : readArchitectureResource(ref.resources?.svg, options)]).then(([metadata, svg]) => {
          if (entry.controller.signal.aborted) throw entry.controller.signal.reason || abortError();
          for (const field of ['id','aspect','engine','objectId','application','scheduleLabel','filename','width','height']) if (ref[field] !== undefined && metadata[field] !== ref[field]) throw new Error('Architecture view metadata mismatch: ' + field);
          if (!Array.isArray(metadata.nodes) || !Array.isArray(metadata.links) || !Array.isArray(metadata.sections)) throw new Error('Invalid architecture view metadata');
          if (svg !== null) { validateArchitectureSvg(svg, { DOMParser }); const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement; if (root.getAttribute('id') !== ref.id || root.getAttribute('data-diagram-engine') !== ref.engine) throw new Error('Architecture SVG identity mismatch'); }
          const value = Object.freeze({ ...metadata, svg }); recent = { key, value }; keep(key, value); return value;
        }).catch(error => { throw entry.controller.signal.aborted ? entry.controller.signal.reason || error : error; }).finally(() => { clearTimeout(timer); if (pending.get(key) === entry) pending.delete(key); });
      }
      return subscribe(entry, signal);
    },
    pin(id) { pinned = id; if (recent?.value.id === id) { keep(recent.key, recent.value); recent = null; } trim(); },
    dispose() { disposed = true; for (const entry of pending.values()) entry.controller.abort(abortError()); pending.clear(); cache.clear(); recent = null; },
  };
}

export function assetLoaderAssets() {
  return { script: [readArchitectureResource, validateArchitectureSvg, createArchitectureAssetLoader].map(fn => fn.toString()).join('\n') };
}
