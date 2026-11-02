// 浏览分组只选择编译器声明，不改变对象身份、实际装配或调度目录。
export const INFRASTRUCTURE_FEATURES = Object.freeze([
  Object.freeze({ id: 'infrastructure', label: 'Bevy 引擎', identifier: 'Bevy', viewPrefix: 'infrastructure' }),
  Object.freeze({ id: 'avian', label: 'Avian', identifier: 'Avian / Transform Interpolation', viewPrefix: 'third-party-avian', section: 'third_party' }),
  Object.freeze({ id: 'enhanced_input', label: 'Enhanced Input', identifier: 'Enhanced Input', viewPrefix: 'third-party-enhanced-input', section: 'third_party' }),
  Object.freeze({ id: 'kira', label: 'Kira', identifier: 'Kira', viewPrefix: 'third-party-kira', section: 'third_party' }),
  Object.freeze({ id: 'egui', label: 'Egui / Inspector', identifier: 'Egui / World Inspector', viewPrefix: 'third-party-egui', section: 'third_party' }),
]);

export const infrastructureFeature = id => INFRASTRUCTURE_FEATURES.find(feature => feature.id === id);

const entryDeclarations = new Map([
  ['infrastructure', [['bevy_internal', 'bevy_internal::default_plugins::DefaultPlugins', 'PluginGroup']]],
  ['avian', [['avian3d', 'avian3d::PhysicsPlugins', 'PluginGroup']]],
  ['enhanced_input', [['bevy_enhanced_input', 'bevy_enhanced_input::EnhancedInputPlugin', 'Plugin']]],
  ['kira', [['bevy_kira_audio', 'bevy_kira_audio::AudioPlugin', 'Plugin']]],
  ['egui', [['bevy_egui', 'bevy_egui::EguiPlugin', 'Plugin'], ['bevy_inspector_egui', 'bevy_inspector_egui::quick::WorldInspectorPlugin', 'Plugin', 'bevy-inspector-egui']]],
]);

export function projectInfrastructureFeatures(registry, { requireComplete = false } = {}) {
  return INFRASTRUCTURE_FEATURES.flatMap(feature => {
    const objectIds = entryDeclarations.get(feature.id).flatMap(([crateName, defPath, role, packageName = crateName]) => {
      const candidates = Object.values(registry).filter(object => object.kind === role && object.typeIdentity?.crateName === crateName
        && object.typeIdentity.defPath === defPath && object.typeIdentity.package?.name === packageName
        && Array.isArray(object.typeIdentity.roles) && object.typeIdentity.roles.includes(role));
      if (candidates.length > 1) throw new Error('Ambiguous infrastructure Plugin declaration: ' + defPath);
      if (!candidates.length && requireComplete) throw new Error('Missing infrastructure Plugin declaration: ' + defPath);
      return candidates.map(object => object.id);
    });
    return objectIds.length ? [{ ...feature, overviewNode: objectIds[0], objectIds }] : [];
  });
}

export function projectPluginMenu(features, registry, infrastructureFeatures = projectInfrastructureFeatures(registry)) {
  const project = features.filter(feature => feature.id !== 'application' && !feature.id.startsWith('crate:')).map(feature => {
    const object = registry[feature.overviewNode];
    if (!(object?.typeIdentity?.crateName === 'demo' && ['Plugin', 'PluginGroup'].includes(object.kind)
      && Array.isArray(object.typeIdentity.roles) && object.typeIdentity.roles.includes(object.kind))) throw new Error('Invalid project Plugin feature: ' + feature.id);
    return feature;
  });
  const infrastructure = infrastructureFeatures.flatMap(feature => feature.objectIds.map(overviewNode => ({ ...feature, overviewNode })));
  return { project, infrastructure };
}

export function architectureViewId(feature, aspect) {
  return `${infrastructureFeature(feature)?.viewPrefix ?? `plugin-${feature}`}-${aspect}`;
}
