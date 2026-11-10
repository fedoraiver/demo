// ControlsCharacter 的一跳形状保留回调静态来源与跨 Schedule 的读访问、插入证据。
export function createControlsCharacterAccessFixture() {
  const component = { id: 'controls', name: 'first_person::ControlsCharacter', kind: 'Component', feature: 'first_person',
    typeInstanceId: 'controls-type', sourceEntries: [], sourceGaps: [] };
  const model = { objects: [component], relations: [], features: [{ id: 'first_person', label: '第一人称' }] };
  function addOwner(id, name, kind, extra = {}) {
    const owner = { id, name, kind, feature: 'first_person', callableIds: ['callable-' + name], sourceEntries: [], sourceGaps: [], ...extra };
    model.objects.push(owner);
    return owner;
  }
  function addRead(owner) {
    model.relations.push({ id: 'read-' + owner.id, from: component.id, to: owner.id, kind: 'read', evidence: 'parameter', scope: 'current',
      parameterAccesses: [{ callableId: owner.callableIds[0], typeInstanceId: component.typeInstanceId, parameter: 'controllers.data.0',
        storage: 'Component', scope: 'current', directRoot: true, registeredOwner: owner.id }], sourceEntries: [] });
  }
  for (const name of ['request_interaction', 'record_movement', 'request_jump', 'clear_completed_movement', 'clear_cancelled_movement']) {
    for (let index = 0; index < 3; index++) addRead(addOwner(`${name}-${index}`, name, 'Observer', { registrationScope: 'static-callsite' }));
  }
  for (const name of ['sync_character_visibility', 'sync_mouse_capture']) addRead(addOwner(name, name, 'System', {
    registrations: [{ application: 'main', schedule: 'Update', scope: 'runtime' }],
  }));
  for (const [schedule, runConditions] of [['RunFixedMainLoop', []], ['FixedUpdate', ['demo::game_flow::gameplay_running']]]) {
    addRead(addOwner('facing-' + schedule, 'sync_character_facing', 'System', {
      registrations: [{ application: 'main', schedule, scope: 'runtime' }], worldAccessScope: 'finite', runConditions,
    }));
  }
  for (const [schedule, runConditions] of [['OnExit(MainMenu)', []], ['Startup', ['!resource_exists<State<AppState>>']]]) {
    const owner = addOwner('spawn-' + schedule, 'spawn_session', 'System', {
      registrations: [{ application: 'main', schedule, scope: 'runtime' }], worldAccessScope: 'finite', runConditions,
    });
    model.relations.push({ id: 'insert-' + owner.id, from: owner.id, to: component.id, kind: 'insert', evidence: 'body',
      bodyOperations: [{ operationId: 'attach-controller', callableId: 'callable-attach-controller', registeredOwner: owner.id,
        deferred: true, scope: 'current', conditions: [], callChainScope: 'representative-static-path',
        callChain: [{ path: 'src/scene_assembly/mod.rs', line: 87, column: 22, role: 'call' }] }],
      sourceEntries: [{ path: 'src/first_person/actions.rs', line: 39, column: 22, role: 'operation' }], sourceGaps: [] });
  }
  return { model, center: component.id };
}
