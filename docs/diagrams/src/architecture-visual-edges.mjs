// 显示边汇总同向同语义事实，成员关系及原始端点继续保存在 links 中。
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

function parameterContexts(link, registry) {
  const records = [registry[link.from], registry[link.to]];
  const callable = records.find(record => record?.callableIds?.length === 1);
  const data = records.find(record => record !== callable);
  const fallback = {
    callableId: callable?.callableIds[0],
    typeInstanceId: data?.typeInstanceId ?? data?.id ?? (callable === registry[link.from] ? link.to : link.from),
    scope: link.scope,
    storage: link.storage,
  };
  const observations = link.parameterAccesses?.length ? link.parameterAccesses : [fallback];
  const proofs = observations.map(access => ({
    callableId: access.callableId,
    typeInstanceId: access.typeInstanceId,
    storage: access.storage,
    scope: access.scope,
    directRoot: access.directRoot,
    world: access.world,
    worldId: access.worldId,
    conditions: access.conditions,
    deferred: access.deferred,
    registration: registrationContext(registry[access.registeredOwner] ?? callable),
  }));
  const context = {
    endpointContexts: [registrationContext(registry[link.from]), registrationContext(registry[link.to])]
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
    scope: link.scope,
    world: link.world,
    worldId: link.worldId,
    conditions: link.conditions,
    deferred: link.deferred,
    guardSources: (link.sourceEntries || []).filter(source => source.guardKind),
  };
  return proofs.map(proof => ({ ...context, proof }));
}

function reverseCompatibilityKey(group, registry) {
  if (!['read', 'mutable_access'].includes(group.semantic)
    || !group.links.every(link => link.evidence === 'parameter' || link.parameterAccesses?.length)) return;
  const link = group.links[0];
  // 槽位可不同，全部来源的存储、注册、World、条件和延迟上下文必须集合相等。
  const contexts = [...new Set(group.links.flatMap(member => parameterContexts(member, registry)).map(keyOf))].sort();
  return keyOf([[endpoint(link, 'from'), endpoint(link, 'to')].sort(), contexts]);
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
    const key = keyOf([endpoint(link, 'from'), endpoint(link, 'to'), semantic]);
    if (!grouped.has(key)) grouped.set(key, { links: [], semantic });
    grouped.get(key).links.push(link);
  }
  const directional = [...grouped.values()].sort((a, b) => a.links.map(link => link.id).sort()[0].localeCompare(b.links.map(link => link.id).sort()[0]));
  const candidates = new Map();
  for (const group of directional) {
    group.reverseKey = reverseCompatibilityKey(group, registry);
    if (!group.reverseKey) continue;
    if (!candidates.has(group.reverseKey)) candidates.set(group.reverseKey, []);
    candidates.get(group.reverseKey).push(group);
  }
  const consumed = new Set();
  const result = [];
  for (const group of directional) {
    if (consumed.has(group)) continue;
    const link = group.links[0];
    let backward;
    if (group.reverseKey) {
      const family = candidates.get(group.reverseKey);
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
