// 仅索引对象自身身份，避免源码、参数访问和注册说明把相关对象混入名称搜索。
export function createArchitectureSearch({ objects, registry }) {
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const compact = value => value.trim().replace(/\s*::\s*/g, '::').replace(/\s*([<>,])\s*/g, '$1').replace(/\s+/g, ' ');
  const normalize = value => compact(value).toLowerCase();
  const words = value => value.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const identity = value => ({ text: normalize(value), words: new Set(words(value)) });
  const entries = objects.map(object => {
    const record = registry[object.id] || {}, name = typeof record.name === 'string' ? record.name : '';
    return { id: object.id, kind: object.kind || record.kind, name: identity(name), sortName: name,
      types: [record.componentRustType, record.scheduleFullName].filter(value => typeof value === 'string' && value.trim()).map(identity) };
  });
  const kinds = [...new Set(entries.map(entry => entry.kind))].sort(compare);

  function parseQuery(value) {
    let query = value.trim(), resource = false;
    const prefix = /^(?:ResMut|Res)(?=$|\s|<)/i.exec(query);
    if (prefix) {
      resource = true; query = query.slice(prefix[0].length).trim();
      if (query.startsWith('<')) {
        let depth = 0, end = -1;
        for (let index = 0; index < query.length; index++) {
          if (query[index] === '<') depth++;
          if (query[index] === '>' && --depth === 0) { end = index; break; }
        }
        // 外层访问包装不属于类型身份；输入尚未闭合时保留内部泛型原文。
        if (end === query.length - 1) query = query.slice(1, -1);
        else if (end < 0 && depth > 0) query = query.slice(1);
        else query = '';
      }
    }
    const text = normalize(query), terms = compact(query).split(/\s+/).filter(Boolean).map(term => /[<>]/.test(term)
      ? { literal: normalize(term) } : { words: words(term) });
    return { text, terms, resource };
  }

  const matches = (field, terms, tokenOnly = false) => terms.every(term => term.literal
    ? field.text.includes(term.literal)
    : term.words.length > 0 && term.words.every(word => tokenOnly ? field.words.has(word) : field.text.includes(word)));

  function score(entry, query) {
    if (normalize(entry.id) === query.text || entry.name.text === query.text || entry.types.some(type => type.text === query.text)) return 0;
    if (entry.name.text.startsWith(query.text)) return 1;
    if (matches(entry.name, query.terms, true)) return 2;
    if (matches(entry.name, query.terms)) return 3;
    if (entry.types.some(type => matches(type, query.terms))) return 4;
    return null;
  }

  function search(value, selectedKinds = []) {
    const query = parseQuery(value), selected = new Set(selectedKinds);
    if (!query.text || !query.terms.length) return [];
    return entries.filter(entry => (!selected.size || selected.has(entry.kind)) && (!query.resource || entry.kind === 'Resource'))
      .map(entry => ({ entry, rank: score(entry, query) })).filter(hit => hit.rank !== null)
      .sort((left, right) => left.rank - right.rank || compare(left.entry.name.text, right.entry.name.text)
        || compare(left.entry.sortName, right.entry.sortName) || compare(left.entry.id, right.entry.id))
      .map(hit => hit.entry.id);
  }

  return { kinds, search };
}

export function architectureSearchAssets() {
  return { script: createArchitectureSearch.toString() };
}
