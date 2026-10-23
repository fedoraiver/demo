export function createArchitectureEntities({ compile, cacheLimit = 8 }) {
  const cache = new Map(), pending = new Map();
  let queue = Promise.resolve();
  function normalize(base, value) {
    const groups = base.entityGroups || [];
    const requested = new Set(value === 'all' ? groups.map(group => group.entity) : Array.isArray(value) ? value : typeof value === 'string' && value !== 'collapsed' ? [value] : []);
    return groups.filter(group => requested.has(group.entity)).map(group => group.entity);
  }
  const key = (base, ids) => JSON.stringify([base.id, normalize(base, ids)]);
  function seeded(base, ids) {
    if (!base.entityViews?.collapsed) return base;
    ids = normalize(base, ids);
    if (!ids.length) return base.entityViews.collapsed;
    if (ids.length === base.entityGroups.length) return base;
    if (ids.length === 1) return base.entityViews[ids[0]];
    return null;
  }
  function get(base, ids) {
    const seed = seeded(base, ids);
    if (seed) return seed;
    const id = key(base, ids), result = cache.get(id);
    if (result) { cache.delete(id); cache.set(id, result); }
    return result;
  }
  function resolve(base, value) {
    const ids = normalize(base, value), ready = get(base, ids);
    if (ready) return ready;
    const id = key(base, ids);
    if (pending.has(id)) return pending.get(id);
    const task = queue.then(() => compile(base, ids)).then(result => {
      cache.set(id, result);
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      return result;
    });
    pending.set(id, task);
    task.then(() => pending.delete(id), () => pending.delete(id));
    queue = task.catch(() => {});
    return task;
  }
  return { normalize, key, get, resolve };
}

export const architectureEntityAssets = () => ({ script: createArchitectureEntities.toString() });
