import { DENSE_OBJECT_RELATION_THRESHOLD, isDenseObjectView, relationRows } from './architecture-object-relations.mjs';

export function createArchitectureRelations({ document, registry, edgeStyles, onChoose, onList, onFull, onRemember }) {
  const panel = document.getElementById('object-relations');
  const search = document.getElementById('relation-search');
  const list = document.getElementById('relation-list');
  const count = document.getElementById('relation-count');
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let view = null, selected = null, query = '', revision = 0;

  function paint() {
    if (!view) return;
    const rows = relationRows(view, registry, query, edgeStyles);
    count.textContent = rows.length + ' / ' + view.links.length + ' 条关系';
    list.innerHTML = rows.length
      ? rows.map(row => '<button type="button" class="relation-result" data-relation="' + safe(row.id) + '" aria-pressed="' + (row.id === selected) + '"><span class="relation-endpoints">' + safe(row.fromName) + '<span aria-label="指向"> → </span>' + safe(row.toName) + '</span><small>' + safe(row.label) + '</small></button>').join('')
      : '<p class="relation-empty">没有匹配关系，请调整搜索词。</p>';
  }

  const snapshot = () => view ? { viewId: view.id, query, scrollTop: list.scrollTop } : null;
  search.addEventListener('input', () => {
    revision++;
    query = search.value;
    paint();
    list.scrollTop = 0;
    onRemember();
  });
  list.addEventListener('scroll', () => {
    revision++;
    onRemember();
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-relation]');
    if (button && button.closest('#relation-list') === list) onChoose(button.dataset.relation);
  });
  list.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      search.focus({ preventScroll: true });
      return;
    }
    const buttons = [...list.querySelectorAll('[data-relation]')];
    if (!buttons.length) return;
    event.preventDefault();
    const focused = buttons.indexOf(document.activeElement);
    const current = focused >= 0 ? focused : event.key === 'ArrowDown' ? -1 : 0;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index].focus({ preventScroll: true });
    buttons[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  document.getElementById('relation-overview').onclick = onList;
  document.getElementById('relation-full').onclick = onFull;

  return {
    snapshot,
    get revision() { return revision; },
    show(target, selection, saved) {
      const changed = view?.id !== target.id;
      const activeId = document.activeElement?.closest('[data-relation]')?.dataset.relation;
      view = target;
      selected = selection.objectRelation || null;
      if (saved?.viewId === target.id) query = saved.query || '';
      else if (changed) query = '';
      search.value = query;
      panel.hidden = false;
      panel.parentElement.classList.add('dense-relations');
      panel.parentElement.classList.toggle('relation-list-only', selection.objectMode !== 'all' && !target.links.some(link => link.id === selected));
      document.getElementById('relation-full').setAttribute('aria-pressed', String(selection.objectMode === 'all'));
      document.getElementById('relation-overview').setAttribute('aria-pressed', String(!selected && selection.objectMode !== 'all'));
      const scrollTop = saved?.viewId === target.id ? saved.scrollTop : changed ? 0 : list.scrollTop;
      paint();
      list.scrollTop = scrollTop || 0;
      if (!activeId && document.activeElement?.closest('#object-results')) search.focus({ preventScroll: true });
      if (activeId) {
        const previous = [...list.querySelectorAll('[data-relation]')].find(button => button.dataset.relation === activeId);
        (previous || search).focus({ preventScroll: true });
      }
      for (const [id, key] of [['relation-svg', 'svg'], ['relation-mermaid', 'mermaid']]) {
        const anchor = document.getElementById(id);
        const url = target.resources?.[key]?.url;
        anchor.hidden = !url;
        if (url) {
          anchor.setAttribute('href', url);
          anchor.setAttribute('download', '');
        }
      }
    },
    hide() {
      const restoreFocus = document.activeElement?.closest('#object-relations') === panel;
      panel.hidden = true;
      panel.parentElement.classList.remove('dense-relations', 'relation-list-only');
      if (restoreFocus) document.getElementById('canvas').focus({ preventScroll: true });
    },
  };
}

export function createLazyObjectRelationRenderer({ loadRuntime, registry, features, buildId, document }) {
  let renderer = null, controller = null, disposed = false;
  const cancel = () => {
    controller?.abort();
    controller = null;
    renderer?.cancel();
  };
  return {
    async render(fullView, relationId) {
      if (disposed) throw new Error('Object relation renderer has been disposed');
      cancel();
      const current = new AbortController();
      controller = current;
      if (!renderer) {
        const module = await loadRuntime({ signal: current.signal });
        if (current.signal.aborted) throw new DOMException('Relation rendering cancelled', 'AbortError');
        renderer = module.createObjectRelationRenderer({ registry, features, buildId, document, limit: 8 });
      }
      return renderer.render(fullView, relationId, { signal: current.signal });
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
      renderer?.dispose();
    },
  };
}

export function architectureRelationsAssets() {
  return {
    script: 'const DENSE_OBJECT_RELATION_THRESHOLD='+DENSE_OBJECT_RELATION_THRESHOLD+';\n'+[isDenseObjectView, relationRows, createArchitectureRelations, createLazyObjectRelationRenderer].map(fn => fn.toString()).join('\n'),
    markup: '<section id="object-relations" class="object-relations" aria-label="完整关系列表" hidden><div class="relation-actions"><button type="button" id="relation-overview">关系列表</button><button type="button" id="relation-full">完整图</button></div><input id="relation-search" type="search" placeholder="搜索端点、关系或条件" aria-label="搜索完整关系列表" aria-controls="relation-list"><p id="relation-count" role="status" aria-live="polite"></p><div id="relation-list" class="relation-list" tabindex="0"></div><div class="relation-downloads"><a id="relation-svg" hidden>下载完整 SVG</a><a id="relation-mermaid" hidden>下载完整 Mermaid</a></div></section>',
    style: '.object-relations{min-width:0;min-height:0;display:flex;flex-direction:column;padding:12px;border-right:1px solid var(--ui-border,#D8E0EB);background:var(--ui-surface,#fff);gap:8px}.object-relations[hidden]{display:none}.canvas-wrap.dense-relations{display:flex;flex-direction:column}.dense-relations .object-relations{flex:0 1 240px;max-height:35%;min-height:150px;border-right:0;border-bottom:1px solid var(--ui-border,#D8E0EB)}.dense-relations .canvas{min-width:0;min-height:180px}.relation-list-only .object-relations{max-height:none;flex:1}.relation-list-only .canvas{display:none}.relation-actions,.relation-downloads{display:flex;flex-wrap:wrap;gap:6px}.object-relations input{width:100%;min-width:0;padding:8px}.object-relations p{margin:0;color:var(--ui-muted,#5B6778);font-size:12px}.relation-list{overflow:auto;min-height:0;flex:1}.relation-result{display:block;text-align:left;width:100%;padding:10px;margin-bottom:6px;border:1px solid var(--ui-border,#D8E0EB);border-radius:6px;background:var(--ui-surface,#fff);color:var(--ui-text,#172033);overflow-wrap:anywhere;white-space:normal}.relation-result[aria-pressed="true"]{background:var(--ui-active,#EFF6FF);border-color:var(--ui-accent,#2563EB)}.relation-result small{display:block;margin-top:5px;color:var(--ui-muted,#5B6778);line-height:1.5}.relation-endpoints{font-size:13px;line-height:1.6}.relation-downloads a{font-size:12px}.relation-empty{padding:10px}@media(max-width:900px){.canvas-wrap.dense-relations{display:flex;height:auto;min-height:460px}.dense-relations .object-relations{max-height:300px;min-height:180px;border-right:0;border-bottom:1px solid #D8E0EB}.dense-relations .canvas{min-height:280px;flex:1}.canvas-wrap.relation-list-only{height:55svh;min-height:280px}.canvas-wrap.relation-list-only .object-relations{max-height:none;flex:1}}',
  };
}
