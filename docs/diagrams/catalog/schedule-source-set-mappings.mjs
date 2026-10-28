// 同名或空集合按原始快照、配置源码与原生层级明确定位；不按 Debug 短标题猜测。
export const REVIEWED_SCHEDULE_SETS = Object.freeze([
  {
    "application": "main",
    "scheduleLabel": "FixedPostUpdate",
    "graphName": "clusternode_Set(SystemSetKey(3v1))",
    "dotSha256": "44aabd824aa1b3e3a70789700f42d000f0b17da414d0c59a5381616bb7fa30c4",
    "label": "Propagate",
    "fullName": "bevy_transform::plugins::TransformSystems::Propagate"
  },
  {
    "application": "main",
    "scheduleLabel": "FixedPostUpdate",
    "graphName": "clusternode_Set(SystemSetKey(7v1))",
    "dotSha256": "44aabd824aa1b3e3a70789700f42d000f0b17da414d0c59a5381616bb7fa30c4",
    "label": "Last",
    "fullName": "avian3d::schedule::PhysicsSystems::Last"
  },
  {
    "application": "main",
    "scheduleLabel": "FixedUpdate",
    "graphName": "clusternode_Set(SystemSetKey(2v1))",
    "dotSha256": "777b26bc364d8debc18e09e80e497a198348793e4e7eb1cc58296ac5b4c06fb3",
    "label": "Facing",
    "fullName": "demo::game_flow::FixedGameplaySystems::Facing"
  },
  {
    "application": "main",
    "scheduleLabel": "PhysicsSchedule",
    "graphName": "clusternode_Set(SystemSetKey(32v1))",
    "dotSha256": "ac8d8a4a6eee654d05c3ecec137084805542302577f3340db2fa78e30972c99e",
    "label": "First",
    "fullName": "avian3d::collision::broad_phase::BroadPhaseSystems::First"
  },
  {
    "application": "main",
    "scheduleLabel": "PhysicsSchedule",
    "graphName": "clusternode_Set(SystemSetKey(34v1))",
    "dotSha256": "ac8d8a4a6eee654d05c3ecec137084805542302577f3340db2fa78e30972c99e",
    "label": "Last",
    "fullName": "avian3d::collision::broad_phase::BroadPhaseSystems::Last"
  },
  {
    "application": "main",
    "scheduleLabel": "PhysicsSchedule",
    "graphName": "clusternode_Set(SystemSetKey(36v1))",
    "dotSha256": "ac8d8a4a6eee654d05c3ecec137084805542302577f3340db2fa78e30972c99e",
    "label": "First",
    "fullName": "avian3d::collision::narrow_phase::NarrowPhaseSystems::First"
  },
  {
    "application": "main",
    "scheduleLabel": "PhysicsSchedule",
    "graphName": "clusternode_Set(SystemSetKey(38v1))",
    "dotSha256": "ac8d8a4a6eee654d05c3ecec137084805542302577f3340db2fa78e30972c99e",
    "label": "Last",
    "fullName": "avian3d::collision::narrow_phase::NarrowPhaseSystems::Last"
  },
  {
    "application": "main",
    "scheduleLabel": "PhysicsSchedule",
    "graphName": "clusternode_Set(SystemSetKey(7v1))",
    "dotSha256": "ac8d8a4a6eee654d05c3ecec137084805542302577f3340db2fa78e30972c99e",
    "label": "Last",
    "fullName": "avian3d::schedule::PhysicsStepSystems::Last"
  },
  {
    "application": "main",
    "scheduleLabel": "PostUpdate",
    "graphName": "clusternode_Set(SystemSetKey(89v1))",
    "dotSha256": "be0cd117e44aeef2f7cd0869225066e4c03278535975e0fa9d614feec8e6afa1",
    "label": "Propagate",
    "fullName": "bevy_ui::UiSystems::Propagate"
  },
  {
    "application": "main",
    "scheduleLabel": "PreStartup",
    "graphName": "clusternode_Set(SystemSetKey(4v1))",
    "dotSha256": "08ac0710f34f67d26cbcfea604851c504cfff16d032c4c7b9ab70c3847a54041",
    "label": "InitContexts",
    "fullName": "bevy_egui::EguiStartupSet::InitContexts"
  },
  {
    "application": "main",
    "scheduleLabel": "PreUpdate",
    "graphName": "clusternode_Set(SystemSetKey(65v1))",
    "dotSha256": "e3ab6ad39236d1128b95441088268fc820c64e8f40ce76ae9abac9d7190bbacc",
    "label": "Last",
    "fullName": "bevy_picking::PickingSystems::Last"
  },
  {
    "application": "main",
    "scheduleLabel": "PreUpdate",
    "graphName": "clusternode_Set(SystemSetKey(72v1))",
    "dotSha256": "e3ab6ad39236d1128b95441088268fc820c64e8f40ce76ae9abac9d7190bbacc",
    "label": "Update",
    "fullName": "bevy_enhanced_input::EnhancedInputSystems::Update"
  },
  {
    "application": "main",
    "scheduleLabel": "Render",
    "graphName": "clusternode_Set(SystemSetKey(2v1))",
    "dotSha256": "62785424cea95b65bf370eb460951efd20cf7f5396358380291af72ba102eb3b",
    "label": "Prepare",
    "fullName": "bevy_render::RenderSystems::Prepare"
  },
  {
    "application": "main",
    "scheduleLabel": "RunFixedMainLoop",
    "graphName": "clusternode_Set(SystemSetKey(15v1))",
    "dotSha256": "b9397dfdc6499932e0b2d50fd0d55bb014c0fc0920e5f63a4baaff262f9f9f8f",
    "label": "Facing",
    "fullName": "demo::game_flow::PresentationSystems::Facing"
  },
  {
    "application": "RenderApp",
    "scheduleLabel": "Core2d",
    "graphName": "clusternode_Set(SystemSetKey(1v1))",
    "dotSha256": "580bd6b2068e441c769f231250cbdac29a44a033add59aa9df6df3566582d8e9",
    "label": "Prepass",
    "fullName": "bevy_core_pipeline::schedule::Core2dSystems::Prepass"
  },
  {
    "application": "RenderApp",
    "scheduleLabel": "Core2d",
    "graphName": "clusternode_Set(SystemSetKey(3v1))",
    "dotSha256": "580bd6b2068e441c769f231250cbdac29a44a033add59aa9df6df3566582d8e9",
    "label": "EarlyPostProcess",
    "fullName": "bevy_core_pipeline::schedule::Core2dSystems::EarlyPostProcess"
  },
  {
    "application": "RenderApp",
    "scheduleLabel": "Core2d",
    "graphName": "clusternode_Set(SystemSetKey(4v1))",
    "dotSha256": "580bd6b2068e441c769f231250cbdac29a44a033add59aa9df6df3566582d8e9",
    "label": "PostProcess",
    "fullName": "bevy_core_pipeline::schedule::Core2dSystems::PostProcess"
  },
  {
    "application": "RenderApp",
    "scheduleLabel": "ExtractSchedule",
    "graphName": "clusternode_Set(SystemSetKey(19v1))",
    "dotSha256": "3a393a4bf67f11ffe06e5f3c00b837c23ea8418e46d79f25e4b58719744158e1",
    "label": "AssetExtractionSystems",
    "fullName": "bevy_render::render_asset::AssetExtractionSystems"
  },
  {
    "application": "RenderApp",
    "scheduleLabel": "ExtractSchedule",
    "graphName": "clusternode_Set(SystemSetKey(140v1))",
    "dotSha256": "3a393a4bf67f11ffe06e5f3c00b837c23ea8418e46d79f25e4b58719744158e1",
    "label": "AssetExtractionSystems",
    "fullName": "bevy_render::erased_render_asset::AssetExtractionSystems"
  },
  {
    "application": "RenderApp",
    "scheduleLabel": "RenderGraph",
    "graphName": "clusternode_Set(SystemSetKey(2v1))",
    "dotSha256": "9c04e4b1186a9c9709bf15d8b1819b0a39a9c4c8f34ad87b272bbca3c944dc99",
    "label": "Render",
    "fullName": "bevy_render::renderer::RenderGraphSystems::Render"
  }
]);
