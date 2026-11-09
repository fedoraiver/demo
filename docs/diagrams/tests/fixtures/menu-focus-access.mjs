// MenuFocus 的参数访问形状保留五个回调的三份静态证据及八个独立系统。
export function createMenuFocusAccessFixture() {
  const focus = { id: 'focus', name: 'MenuFocus', kind: 'Resource', feature: 'ui', sourceEntries: [], sourceGaps: [] };
  const model = { objects: [focus], relations: [], features: [{ id: 'ui', label: '界面' }] };
  const callbacks = ['left', 'right', 'confirm', 'previous', 'next'];
  for (const [index, name] of callbacks.entries()) {
    for (let registration = 0; registration < 3; registration++) {
      const id = `observer-${name}-${registration}`;
      model.objects.push({ id, name, kind: 'Observer', feature: 'ui', registrationScope: 'static-callsite',
        callableIds: ['callable-' + name], sourceEntries: [{ path: 'src/navigation.rs', line: registration + 1, role: 'registration' }], sourceGaps: [] });
      const read = index < 3;
      model.relations.push({ id: 'access-' + id, from: read ? 'focus' : id, to: read ? id : 'focus',
        kind: read ? 'read' : 'mutable_access', evidence: 'parameter', scope: 'current',
        sourceEntries: [{ path: 'src/navigation.rs', line: 20 + index, column: 5, role: 'parameter' }] });
      if (!read) model.relations.push({ id: 'modify-' + id, from: id, to: 'focus', kind: 'modify', evidence: 'body' });
    }
  }
  for (let index = 0; index < 8; index++) {
    const id = 'system-' + index, read = index >= 5;
    model.objects.push({ id, name: id, kind: 'System', feature: 'ui', callableIds: ['callable-' + id],
      registrations: [{ application: 'main', schedule: 'Update', scope: 'runtime' }], sourceEntries: [], sourceGaps: [] });
    model.relations.push({ id: 'access-' + id, from: read ? 'focus' : id, to: read ? id : 'focus',
      kind: read ? 'read' : 'mutable_access', evidence: 'parameter', scope: 'current', parameter: '1', sourceEntries: [] });
    if (!read) model.relations.push({ id: 'modify-' + id, from: id, to: 'focus', kind: 'modify', evidence: 'body' });
  }
  return { model, center: focus.id, callbacks };
}
