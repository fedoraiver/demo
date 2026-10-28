// 规范类别表达对象身份；来源、排版分组和源码证据不能替代其类别。
const kind = (visualType, sourcePolicyKind) => Object.freeze({ visualType, sourcePolicyKind });

export const NODE_KINDS = Object.freeze({
  System: kind('system', 'system'),
  Observer: kind('observer', 'observer'),
  Entity: kind('entity', 'entity'),
  Component: kind('component', 'component'),
  Resource: kind('resource', 'resource'),
  Local: kind('local', 'local'),
  NonSend: kind('non_send', 'non_send'),
  Message: kind('message', 'message'),
  'Messages<T>': kind('message_buffer', 'message_buffer'),
  EntityEvent: kind('event', 'event'),
  SystemSet: kind('system_set', 'system_set'),
  SystemParam: kind('system_param', 'system_param'),
  QueryData: kind('query_data', 'query_data'),
  'Scheduling constraint': kind('scheduling_constraint', 'scheduling_constraint'),
  'Shared data contract': kind('shared_data_contract', 'shared_data_contract'),
  Synchronization: kind('sync', 'sync'),
  'System group': kind('system_group', 'system_group'),
  'Observer group': kind('observer_group', 'observer_group'),
  'Engine flow': kind('engine_flow', 'engine_flow'),
  Plugin: kind('plugin', 'plugin'),
  PluginGroup: kind('plugin_group', 'plugin_group'),
  App: kind('app', 'app'),
  'Registration helper': kind('registration_helper', 'registration_helper'),
  'External I/O': kind('external_io', 'external_io'),
  'Platform API': kind('platform_api', 'platform_api'),
  'Platform event': kind('platform_event', 'platform_event'),
  Note: kind('note', 'note'),
  'Lifecycle note': kind('lifecycle_note', 'lifecycle_note'),
  'BSN layout': kind('bsn_layout', 'bsn_layout'),
  'Operation result': kind('operation_result', 'operation_result'),
  // 关系只作为连线及其详情存在，不因此生成额外业务卡片。
  Relationship: kind(null, 'relationship'),
  'Entity reference': kind(null, 'entity_reference'),
});

const aliases = new Map([
  ...Object.keys(NODE_KINDS).map(value => [value.toLowerCase(), value]),
  ['engine system', 'System'], ['engine observers', 'Observer group'],
  ['engine systemset', 'SystemSet'], ['engine system set', 'SystemSet'],
  ['sync', 'Synchronization'], ['scheduling contract', 'Scheduling constraint'],
  ['native platform bridge', 'Platform API'], ['native platform event', 'Platform event'],
  ['component write', 'Operation result'], ['data write', 'Operation result'],
]);

export function nodeKindOf(record) {
  const input = typeof record === 'string' ? record : record?.kind;
  const canonical = aliases.get(String(input ?? '').trim().toLowerCase());
  if (!canonical) throw new Error(`Unknown architecture node kind: ${input} (${record?.id || record?.name || 'unnamed'})`);
  return canonical;
}
