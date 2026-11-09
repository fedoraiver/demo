// 显示边只归组可验证的访问事实，成员关系及原始端点继续保存在 links 中。
import { displayLabelOf, edgeLabelDetailsOf, edgeSemanticOf } from './architecture-style.mjs';

export function relationKind(link) {
  return link.factKind ?? link.operation ?? link.kind;
}

export function isVisibleRelation(link) {
  return relationKind(link) !== 'modify';
}

export function visualEdgesOf(view) {
  return view.visualEdgeGroups ?? view.links ?? [];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

const keyOf = value => JSON.stringify(stable(value));
const endpoint = (link, side) => link[side === 'from' ? 'displayFrom' : 'displayTo'] ?? link[side];

function registrationContext(record = {}) {
  return {
    registrationScope: record.registrationScope,
    registrations: (record.registrations || []).map(registration => stable(registration)).sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
    worldAccessScope: record.worldAccessScope,
    world: record.world,
    worldId: record.worldId,
    runConditions: record.runConditions,
    conditions: record.conditions,
  };
}

function parameterContext(link, registry, pairing = false) {
  const records = [registry[link.from], registry[link.to]];
  const callable = records.find(record => record?.callableIds?.length === 1);
  const data = records.find(record => record !== callable);
  const fallback = {
    callableId: callable?.callableIds[0],
    typeInstanceId: data?.typeInstanceId ?? data?.id ?? (callable === registry[link.from] ? link.to : link.from),
    parameter: link.parameter ?? (link.sourceEntries || []).filter(source => source.role === 'parameter')
      .map(source => [source.path, source.line, source.column ?? 1]),
    scope: link.scope,
    storage: link.storage,
  };
  const observations = link.parameterAccesses?.length ? link.parameterAccesses : [fallback];
  const proofs = observations.map(access => ({
    callableId: access.callableId,
    typeInstanceId: access.typeInstanceId,
    ...(!pairing ? { parameter: access.parameter } : {}),
    storage: access.storage,
    scope: access.scope,
    directRoot: access.directRoot,
    world: access.world,
    worldId: access.worldId,
    conditions: access.conditions,
    deferred: access.deferred,
    registration: registrationContext(registry[access.registeredOwner] ?? callable),
  }));
  const uniqueProofs = [...new Map(proofs.map(proof => [keyOf(proof), proof])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, proof]) => proof);
  return {
    proofs: uniqueProofs,
    fromContext: registrationContext(registry[link.from]),
    toContext: registrationContext(registry[link.to]),
    scope: link.scope,
    world: link.world,
    worldId: link.worldId,
    conditions: link.conditions,
    deferred: link.deferred,
    guardSources: (link.sourceEntries || []).filter(source => source.guardKind),
  };
}

function accessContext(link, registry, pairing = false) {
  const context = parameterContext(link, registry, pairing);
  if (pairing) {
    const contexts = [context.fromContext, context.toContext].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    delete context.fromContext;
    delete context.toContext;
    context.endpointContexts = contexts;
  }
  return keyOf(context);
}

function makeGroup(links, registry, backward = []) {
  const forwardIds = links.map(link => link.id).sort();
  const backwardIds = backward.map(link => link.id).sort();
  const ids = [...forwardIds, ...backwardIds].sort();
  const first = links.find(link => link.id === forwardIds[0]);
  const edgeSemantic = backward.length ? 'read_write' : edgeSemanticOf(first, registry);
  const details = [...new Set([...links, ...backward]
    .map(link => edgeLabelDetailsOf(link, edgeSemanticOf(link, registry))).filter(Boolean))].sort();
  return {
    id: 'visual-edge-' + ids[0],
    from: endpoint(first, 'from'),
    to: endpoint(first, 'to'),
    forwardIds,
    backwardIds,
    edgeSemantic,
    displayLabel: displayLabelOf(first, edgeSemantic, registry, details.join(' / ')),
  };
}

export function createVisualEdgeGroups(links, registry) {
  const ids = new Set();
  const grouped = new Map();
  for (const link of links) {
    if (!isVisibleRelation(link)) throw new Error('Hidden assignment relation in visual edge input: ' + link.id);
    if (typeof link.id !== 'string' || !link.id || ids.has(link.id)) throw new Error('Missing or duplicate visual relation identity: ' + link.id);
    ids.add(link.id);
    const semantic = edgeSemanticOf(link, registry);
    const parameterAccess = (link.evidence === 'parameter' || link.parameterAccesses?.length)
      && ['read', 'mutable_access'].includes(semantic);
    const key = parameterAccess
      ? keyOf([endpoint(link, 'from'), endpoint(link, 'to'), semantic, accessContext(link, registry)])
      : keyOf(['relation', link.id]);
    if (!grouped.has(key)) grouped.set(key, { links: [], parameterAccess, semantic });
    grouped.get(key).links.push(link);
  }
  const directional = [...grouped.values()].sort((a, b) => a.links.map(link => link.id).sort()[0].localeCompare(b.links.map(link => link.id).sort()[0]));
  const candidates = new Map();
  for (const group of directional.filter(group => group.parameterAccess)) {
    const link = group.links[0];
    const pair = [endpoint(link, 'from'), endpoint(link, 'to')].sort();
    const key = keyOf([pair, accessContext(link, registry, true)]);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(group);
  }
  const consumed = new Set();
  const result = [];
  for (const group of directional) {
    if (consumed.has(group)) continue;
    const link = group.links[0];
    let backward;
    if (group.parameterAccess) {
      const key = keyOf([[endpoint(link, 'from'), endpoint(link, 'to')].sort(), accessContext(link, registry, true)]);
      const family = candidates.get(key);
      if (family.length === 2 && family[0].semantic !== family[1].semantic) {
        const other = family.find(candidate => candidate !== group);
        const reverse = other.links[0];
        if (endpoint(link, 'from') !== endpoint(link, 'to')
          && endpoint(link, 'from') === endpoint(reverse, 'to') && endpoint(link, 'to') === endpoint(reverse, 'from')) backward = other;
      }
    }
    consumed.add(group);
    if (backward) consumed.add(backward);
    result.push(makeGroup(group.links, registry, backward?.links));
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
