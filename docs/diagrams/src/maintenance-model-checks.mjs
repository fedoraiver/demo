// 预编译语义约束：身份、投影、关系与已审核源码角色；不读取或接受旧产物。
import { isDeepStrictEqual } from 'node:util';

const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const sorted = values => [...new Set(values)].sort();
const hasRole = (record, role) => (record.sourceEntries || []).some(source => source.role === role);
const compact = text => String(text || '').replace(/\s+/g, '').replaceAll('::<', '<');
const declarationKey = source => source && JSON.stringify([source.dependency?.name || 'project', source.dependency?.version || '', source.path, source.line]);
const fullType = text => compact(text).replace(/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*::/, '');

export function validatePreparedArchitecture({ model, registry, components, objects, views, sourceAudit }) {
  const projections = new Map(), equivalentTypes = new Map();
  for (const entity of model.entities || []) for (const component of entity.components || []) {
    requireCondition(!projections.has(component.id), 'Duplicate component projection: ' + component.id);
    projections.set(component.id, { component, owner: entity.canonical_entity || `entity-${entity.id}` });
  }
  for (const type of components.types) {
    requireCondition(type.identityVerified, 'Unverified full component type identity: ' + type.id);
    const expected = [...projections].filter(([id]) => components.typeByProjectionId[id] === type.id);
    requireCondition(expected.length > 0 && isDeepStrictEqual(sorted(type.projectionIds), sorted(expected.map(([id]) => id))), 'Component projection set mismatch: ' + type.id);
    requireCondition(isDeepStrictEqual(sorted(type.ownerEntityIds), sorted(expected.map(([, projection]) => projection.owner))), 'Component owner projection mismatch: ' + type.id);
    requireCondition(type.projectionIds.includes(type.componentNodeId), 'Invalid canonical component projection: ' + type.id);
    const definition = declarationKey(type.definition_source);
    if (definition) {
      const key = definition + '|' + fullType(type.rustType), previous = equivalentTypes.get(key);
      requireCondition(!previous || previous === type.id, 'Equivalent full component type has split canonical identities: ' + (previous || '') + ' / ' + type.id);
      equivalentTypes.set(key, type.id);
    }
    for (const id of type.projectionIds) {
      const record = registry[id], projection = projections.get(id);
      requireCondition(projection && registry[projection.owner], 'Dangling component owner: ' + id);
      requireCondition(record?.kind === 'Component' && record.componentTypeId === type.id && record.componentNodeId === type.componentNodeId
        && isDeepStrictEqual(record.projectionIds, type.projectionIds) && isDeepStrictEqual(record.ownerEntityIds, type.ownerEntityIds)
        && record.componentRustType === type.rustType, 'Component canonical projection metadata mismatch: ' + id);
      if (projection.component.rust_type) requireCondition(fullType(projection.component.rust_type) === fullType(type.rustType), 'Component generic identity mismatch: ' + id);
      requireCondition(hasRole(record, 'definition'), 'Missing component definition role: ' + id);
      // 状态清理标记把所属实体与清理状态连接起来；每个具体投影均须有独立装配和销毁证据。
      if (record.definition_source?.dependency?.name === 'bevy_state' && /^(?:DespawnOnEnter|DespawnOnExit)(?:<|$)/.test(fullType(type.rustType))) {
        requireCondition(/^DespawnOn(?:Enter|Exit)<.+>$/.test(fullType(type.rustType)), 'Missing full state-scoped generic identity: ' + id);
        for (const role of ['create', 'destroy']) requireCondition(hasRole(record, role), 'Missing state-scoped component lifecycle role ' + role + ': ' + id);
      }
    }
  }
  for (const [id] of projections) requireCondition(components.typeById[components.typeByProjectionId[id]], 'Missing component type mapping: ' + id);
  for (const system of model.systems || []) {
    requireCondition(registry[system.id], 'Missing system registration identity: ' + system.id);
    for (const field of ['reads', 'writes']) for (const id of system[field] || []) requireCondition(registry[id], 'Dangling system access: ' + system.id + ' / ' + id);
    if (['System', 'Observer'].includes(system.kind) && system.source?.path?.startsWith('src/') && !system.source.dependency && !registry[system.id].definition_source?.dependency && /^[A-Za-z_]\w*$/.test(system.name)) {
      const source = system.definition_source || system.source;
      const resolved = registry[system.id].sourceEntries?.filter(entry => entry.role === 'definition' && !entry.dependency && entry.path === source.path);
      requireCondition(resolved?.length === 1 && resolved[0].line === source.line, 'Declared function definition is stale or mismatched: ' + system.id);
      if (sourceAudit?.context) {
        const file = sourceAudit.context.read(source);
        const declaration = file.code.split('\n')[source.line - 1] || '';
        requireCondition(new RegExp('\\bfn\\s+' + system.name + '\\b').test(declaration), 'Declared function identity mismatch: ' + system.id);
      }
    }
  }
  for (const observer of model.observers || []) requireCondition(registry[observer.system], 'Dangling Observer registration: ' + observer.system);
  for (const record of Object.values(registry)) {
    for (const id of [...(record.memberIds || []), ...(record.registrationIds || [])]) requireCondition(registry[id], 'Dangling member registration: ' + record.id + ' / ' + id);
    const roles = record.kind === 'Plugin' ? ['definition', 'build', 'install'] : record.kind === 'Observer' && !record.scheduleEvidence ? ['definition', 'registration'] : [];
    for (const role of roles) requireCondition(hasRole(record, role) || record.sourceGaps?.length, 'Missing required source role ' + role + ': ' + record.id);
  }
  const linkIds = new Set();
  for (const link of objects.links || []) {
    requireCondition(!linkIds.has(link.id), 'Duplicate object relationship identity: ' + link.id); linkIds.add(link.id);
    requireCondition(registry[link.from] && registry[link.to], 'Dangling object relationship: ' + link.id);
    for (const id of link.projectionIds || []) requireCondition(projections.has(id), 'Dangling relationship projection: ' + link.id + ' / ' + id);
    for (const id of link.registrationIds || []) requireCondition(registry[id], 'Dangling relationship registration: ' + link.id + ' / ' + id);
  }
  for (const id of model.required_nodes || []) requireCondition(registry[id] && views.some(view => view.nodes.some(node => node.id === id) || view.projectionIds?.includes(id)), 'Required architecture node missing: ' + id);
  return { projections: projections.size, componentTypes: components.types.length, relationships: linkIds.size };
}
