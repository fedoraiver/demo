// 基础设施浏览入口与导出命名共用目录；infrastructure 保留为 Bevy 的兼容入口。
export const INFRASTRUCTURE_FEATURES = Object.freeze([
  Object.freeze({ id: 'infrastructure', label: 'Bevy 引擎', identifier: 'Bevy', overviewNode: 'plugin-DefaultPlugins', viewPrefix: 'infrastructure' }),
  Object.freeze({ id: 'avian', label: 'Avian', identifier: 'Avian / Transform Interpolation', overviewNode: 'plugin-physics-0', viewPrefix: 'third-party-avian', section: 'third_party' }),
  Object.freeze({ id: 'enhanced_input', label: 'Enhanced Input', identifier: 'Enhanced Input', overviewNode: 'plugin-EnhancedInputPlugin', viewPrefix: 'third-party-enhanced-input', section: 'third_party' }),
  Object.freeze({ id: 'kira', label: 'Kira', identifier: 'Kira', overviewNode: 'plugin-kira', viewPrefix: 'third-party-kira', section: 'third_party' }),
  Object.freeze({ id: 'egui', label: 'Egui / Inspector', identifier: 'Egui / World Inspector', overviewNode: 'plugin-inspector-0', viewPrefix: 'third-party-egui', section: 'third_party' }),
]);

export const infrastructureFeature = id => INFRASTRUCTURE_FEATURES.find(feature => feature.id === id);

export function architectureViewId(feature, aspect) {
  return `${infrastructureFeature(feature)?.viewPrefix ?? `plugin-${feature}`}-${aspect}`;
}
