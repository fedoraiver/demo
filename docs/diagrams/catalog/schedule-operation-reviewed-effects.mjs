export const EFFECTS_SCHEDULE_BODY_OPERATIONS = {
  "bevy_anti_alias::contrast_adaptive_sharpening::init_cas_pipeline": [
    {
      "kind": "Resource",
      "type": "CasPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(CasPipeline"
    }
  ],
  "bevy_anti_alias::contrast_adaptive_sharpening::prepare_cas_pipelines": [
    {
      "kind": "Component",
      "type": "ViewCasPipeline",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ViewCasPipeline",
      "condition": "CasUniform 已被移除的实体。"
    },
    {
      "kind": "Component",
      "type": "ViewCasPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewCasPipeline(pipeline_id))",
      "condition": "新增锐化参数或去噪设置变化的视图，管线专用化成功后。"
    }
  ],
  "bevy_anti_alias::fxaa::init_fxaa_pipeline": [
    {
      "kind": "Resource",
      "type": "FxaaPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(FxaaPipeline"
    }
  ],
  "bevy_anti_alias::fxaa::prepare_fxaa_pipelines": [
    {
      "kind": "Component",
      "type": "CameraFxaaPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(CameraFxaaPipeline",
      "condition": "启用 FXAA 的已提取相机。"
    }
  ],
  "bevy_anti_alias::smaa::init_smaa_pipelines": [
    {
      "kind": "Resource",
      "type": "SmaaPipelines",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(SmaaPipelines"
    }
  ],
  "bevy_anti_alias::smaa::prepare_smaa_bind_groups": [
    {
      "kind": "Component",
      "type": "SmaaBindGroups",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(SmaaBindGroups",
      "condition": "面积和搜索 LUT 均已上传 GPU 的 SMAA 视图。"
    }
  ],
  "bevy_anti_alias::smaa::prepare_smaa_pipelines": [
    {
      "kind": "Component",
      "type": "ViewSmaaPipelines",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewSmaaPipelines",
      "condition": "启用 SMAA 的相机。"
    }
  ],
  "bevy_anti_alias::smaa::prepare_smaa_textures": [
    {
      "kind": "Component",
      "type": "SmaaTextures",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(SmaaTextures",
      "condition": "SMAA 相机具有物理目标尺寸。"
    }
  ],
  "bevy_anti_alias::smaa::prepare_smaa_uniforms": [
    {
      "kind": "Component",
      "type": "SmaaInfoUniformOffset",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(SmaaInfoUniformOffset",
      "condition": "带 Smaa 标记的已提取视图。"
    }
  ],
  "bevy_anti_alias::taa::extract_taa_settings": [
    {
      "kind": "Component",
      "type": "TemporalAntiAliasing",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity_commands.insert(taa_settings.clone())",
      "evidenceMatch": "Option<&mut TemporalAntiAliasing>",
      "condition": "主世界相机有 TAA 设置且处于活动状态。"
    },
    {
      "kind": "Component",
      "type": "TemporalAntiAliasing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<(",
      "condition": "相机没有 TAA 设置或已停用。"
    },
    {
      "kind": "Component",
      "type": "TemporalAntiAliasHistoryTextures",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<(",
      "condition": "相机没有 TAA 设置或已停用。"
    },
    {
      "kind": "Component",
      "type": "TemporalAntiAliasPipelineId",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<(",
      "condition": "相机没有 TAA 设置或已停用。"
    },
    {
      "kind": "Component",
      "type": "Camera",
      "operation": "read",
      "via": "world",
      "method": "query",
      "match": "main_world.query::<(RenderEntity, &Camera, Option<&mut TemporalAntiAliasing>)>()",
      "condition": "在主世界枚举三维相机。",
      "scope": "main"
    },
    {
      "kind": "Component",
      "type": "TemporalAntiAliasing",
      "operation": "mutable_access",
      "via": "world",
      "method": "query",
      "match": "main_world.query::<(RenderEntity, &Camera, Option<&mut TemporalAntiAliasing>)>()",
      "condition": "在主世界查询可选 TAA 设置并消费 reset 标志。",
      "scope": "main"
    }
  ],
  "bevy_anti_alias::taa::init_taa_pipeline": [
    {
      "kind": "Resource",
      "type": "TaaPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(TaaPipeline"
    }
  ],
  "bevy_anti_alias::taa::prepare_taa_history_textures": [
    {
      "kind": "Component",
      "type": "TemporalAntiAliasHistoryTextures",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(textures)",
      "evidenceMatch": "let textures = if frame_count.0.is_multiple_of(2) {\n                TemporalAntiAliasHistoryTextures {",
      "condition": "TAA 相机具有物理目标尺寸。"
    }
  ],
  "bevy_anti_alias::taa::prepare_taa_pipelines": [
    {
      "kind": "Component",
      "type": "TemporalAntiAliasPipelineId",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(TemporalAntiAliasPipelineId",
      "condition": "TAA 相机管线专用化成功后。"
    }
  ],
  "bevy_core_pipeline::blit::init_blit_pipeline": [
    {
      "kind": "Resource",
      "type": "BlitPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(BlitPipeline"
    }
  ],
  "bevy_core_pipeline::core_2d::prepare_core_2d_depth_textures": [
    {
      "kind": "Component",
      "type": "ViewDepthStencilTexture",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewDepthStencilTexture::new(",
      "condition": "具有二维渲染阶段及有效目标尺寸的相机。"
    }
  ],
  "bevy_core_pipeline::core_3d::prepare_core_3d_depth_textures": [
    {
      "kind": "Component",
      "type": "ViewDepthStencilTexture",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewDepthStencilTexture::new(",
      "condition": "具有有效目标尺寸的三维视图。"
    }
  ],
  "bevy_core_pipeline::core_3d::prepare_prepass_textures": [
    {
      "kind": "Component",
      "type": "ViewPrepassTextures",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ViewPrepassTextures",
      "condition": "视图既无常规预通道阶段，也无延迟预通道阶段。"
    },
    {
      "kind": "Component",
      "type": "ViewPrepassTextures",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewPrepassTextures",
      "condition": "存在预通道阶段且相机具有物理目标尺寸。"
    }
  ],
  "bevy_core_pipeline::deferred::copy_lighting_id::init_copy_deferred_lighting_id_pipeline": [
    {
      "kind": "Resource",
      "type": "CopyDeferredLightingIdPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(CopyDeferredLightingIdPipeline"
    }
  ],
  "bevy_core_pipeline::deferred::copy_lighting_id::prepare_deferred_lighting_id_textures": [
    {
      "kind": "Component",
      "type": "DeferredLightingIdDepthTexture",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(DeferredLightingIdDepthTexture",
      "condition": "启用 DeferredPrepass 且具有物理目标尺寸的视图。"
    }
  ],
  "bevy_core_pipeline::mip_generation::experimental::depth::create_downsample_depth_pipelines": [
    {
      "kind": "Resource",
      "type": "DownsampleDepthPipelines",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(downsample_depth_pipelines)",
      "evidenceMatch": "let mut downsample_depth_pipelines = DownsampleDepthPipelines {",
      "condition": "首次尝试且平台支持 GPU 剔除。"
    }
  ],
  "bevy_core_pipeline::mip_generation::experimental::depth::init_depth_pyramid_dummy_texture": [
    {
      "kind": "Resource",
      "type": "DepthPyramidDummyTexture",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(DepthPyramidDummyTexture"
    }
  ],
  "bevy_core_pipeline::mip_generation::experimental::depth::prepare_downsample_depth_view_bind_groups": [
    {
      "kind": "Component",
      "type": "ViewDownsampleDepthBindGroup",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewDownsampleDepthBindGroup",
      "condition": "主深度附件具有深度面，或视图具有遮挡剔除阴影深度输入。"
    }
  ],
  "bevy_core_pipeline::mip_generation::experimental::depth::prepare_view_depth_pyramids": [
    {
      "kind": "Component",
      "type": "ViewDepthPyramid",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ViewDepthPyramid, ViewDownsampleDepthBindGroup)>",
      "condition": "原有深度金字塔的视图已关闭遮挡剔除。"
    },
    {
      "kind": "Component",
      "type": "ViewDownsampleDepthBindGroup",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ViewDepthPyramid, ViewDownsampleDepthBindGroup)>",
      "condition": "原有深度金字塔的视图已关闭遮挡剔除。"
    },
    {
      "kind": "Component",
      "type": "ViewDepthPyramid",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewDepthPyramid::new(",
      "condition": "启用遮挡剔除且允许间接绘制的视图。"
    }
  ],
  "bevy_core_pipeline::oit::init_oit_buffers": [
    {
      "kind": "Resource",
      "type": "OitBuffers",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(OitBuffers"
    }
  ],
  "bevy_core_pipeline::oit::prepare_oit_buffers": [
    {
      "kind": "Component",
      "type": "OrderIndependentTransparencySettingsOffset",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(OrderIndependentTransparencySettingsOffset",
      "condition": "存在 OIT 相机且动态设置写入器可用。"
    }
  ],
  "bevy_core_pipeline::oit::resolve::prepare_oit_resolve_bind_group": [
    {
      "kind": "Resource",
      "type": "OitResolveBindGroup",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(OitResolveBindGroup",
      "condition": "视图、节点、链表头和计数器缓冲均可绑定。"
    }
  ],
  "bevy_core_pipeline::oit::resolve::queue_oit_resolve_pipeline": [
    {
      "kind": "Component",
      "type": "OitResolvePipelineId",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(OitResolvePipelineId(*id))",
      "condition": "视图的解析管线键未变时复用缓存标识。"
    },
    {
      "kind": "Component",
      "type": "OitResolvePipelineId",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(OitResolvePipelineId(pipeline_id))",
      "condition": "视图无匹配缓存时排队新解析管线。"
    }
  ],
  "bevy_core_pipeline::prepass::background_motion_vectors::init_background_motion_vectors_pipeline": [
    {
      "kind": "Resource",
      "type": "BackgroundMotionVectorsPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(BackgroundMotionVectorsPipeline"
    }
  ],
  "bevy_core_pipeline::prepass::background_motion_vectors::prepare_background_motion_vectors_bind_groups": [
    {
      "kind": "Component",
      "type": "BackgroundMotionVectorsBindGroup",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(BackgroundMotionVectorsBindGroup",
      "condition": "运动矢量预通道未禁止背景矢量，且当前和前帧视图参数均可绑定。"
    }
  ],
  "bevy_core_pipeline::prepass::background_motion_vectors::prepare_background_motion_vectors_pipelines": [
    {
      "kind": "Component",
      "type": "BackgroundMotionVectorsPipelineId",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(BackgroundMotionVectorsPipelineId",
      "condition": "启用运动矢量预通道且未禁止背景矢量的视图。"
    }
  ],
  "bevy_core_pipeline::schedule::handle_uncovered_swap_chains": [
    {
      "kind": "Resource",
      "type": "CameraWindows",
      "operation": "remove",
      "via": "world",
      "method": "remove_resource",
      "match": "world.remove_resource::<CameraWindows>()",
      "condition": "存在该资源时取走本帧相机覆盖窗口记录。"
    },
    {
      "kind": "Resource",
      "type": "ClearColor",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<ClearColor>()"
    },
    {
      "kind": "Resource",
      "type": "RenderDevice",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<RenderDevice>()"
    },
    {
      "kind": "Resource",
      "type": "RenderQueue",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<RenderQueue>()"
    },
    {
      "kind": "Component",
      "type": "ExtractedWindow",
      "operation": "read",
      "via": "world",
      "method": "query",
      "match": ".query::<(MainEntity, &ExtractedWindow)>()",
      "condition": "读取未被相机覆盖窗口的交换链视图。"
    }
  ],
  "bevy_core_pipeline::skybox::init_skybox_pipeline": [
    {
      "kind": "Resource",
      "type": "SkyboxPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(SkyboxPipeline::new(shader))"
    }
  ],
  "bevy_core_pipeline::skybox::prepare_skybox_bind_groups": [
    {
      "kind": "Component",
      "type": "SkyboxBindGroup",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(SkyboxBindGroup",
      "condition": "图像和视图／天空盒参数已就绪且天空盒图像校验通过。"
    },
    {
      "kind": "Component",
      "type": "SkyboxBindGroup",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<SkyboxBindGroup",
      "condition": "图像、参数或图像校验不满足天空盒绑定条件。"
    }
  ],
  "bevy_core_pipeline::skybox::prepare_skybox_pipelines": [
    {
      "kind": "Component",
      "type": "SkyboxPipelineId",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(SkyboxPipelineId",
      "condition": "带 Skybox 的已提取相机。"
    }
  ],
  "bevy_core_pipeline::tonemapping::init_tonemapping_pipeline": [
    {
      "kind": "Resource",
      "type": "TonemappingPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(TonemappingPipeline"
    }
  ],
  "bevy_core_pipeline::tonemapping::prepare_view_tonemapping_pipelines": [
    {
      "kind": "Component",
      "type": "ViewTonemappingPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewTonemappingPipeline"
    }
  ],
  "bevy_core_pipeline::upscaling::prepare_view_upscaling_pipelines": [
    {
      "kind": "Component",
      "type": "ViewUpscalingPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewUpscalingPipeline",
      "condition": "输出纹理格式有效且不存在管线或 Blit 键已改变，新管线可用后。"
    }
  ],
  "bevy_gizmos_render::extract_gizmo_data": [
    {
      "kind": "Component",
      "type": "LineGizmoUniform",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((",
      "condition": "配置组已启用且有网格句柄；GizmoMeshConfig 另受 bevy_pbr 或 bevy_sprite_render 特性条件限制。"
    },
    {
      "kind": "Component",
      "type": "bevy_gizmos::config::GizmoMeshConfig",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((",
      "condition": "配置组已启用且有网格句柄；GizmoMeshConfig 另受 bevy_pbr 或 bevy_sprite_render 特性条件限制。"
    },
    {
      "kind": "Component",
      "type": "bevy_extract::sync_world::MainEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((",
      "condition": "配置组已启用且有网格句柄；GizmoMeshConfig 另受 bevy_pbr 或 bevy_sprite_render 特性条件限制。"
    },
    {
      "kind": "Component",
      "type": "bevy_render::sync_world::TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((",
      "condition": "配置组已启用且有网格句柄；GizmoMeshConfig 另受 bevy_pbr 或 bevy_sprite_render 特性条件限制。"
    }
  ],
  "bevy_gizmos_render::init_line_gizmo_uniform_bind_group_layout": [
    {
      "kind": "Resource",
      "type": "LineGizmoUniformBindgroupLayout",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(LineGizmoUniformBindgroupLayout"
    }
  ],
  "bevy_gizmos_render::pipeline_2d::init_line_gizmo_pipelines": [
    {
      "kind": "Resource",
      "type": "LineGizmoPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(LineGizmoPipeline"
    },
    {
      "kind": "Resource",
      "type": "LineJointGizmoPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(LineJointGizmoPipeline"
    }
  ],
  "bevy_gizmos_render::pipeline_3d::init_line_gizmo_pipelines": [
    {
      "kind": "Resource",
      "type": "LineGizmoPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(LineGizmoPipeline"
    },
    {
      "kind": "Resource",
      "type": "LineJointGizmoPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(LineJointGizmoPipeline"
    }
  ],
  "bevy_gizmos_render::prepare_line_gizmo_bind_group": [
    {
      "kind": "Resource",
      "type": "LineGizmoUniformBindgroup",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(LineGizmoUniformBindgroup",
      "condition": "线条参数缓冲已经产生 GPU 绑定。"
    }
  ],
  "bevy_gizmos_render::transform_gizmo_render::spawn_gizmo_meshes": [
    {
      "kind": "Component",
      "type": "TransformGizmoRoot",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((TransformGizmoRoot, Transform::IDENTITY, Visibility::Hidden))",
      "condition": "创建初始隐藏的操作器根节点。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((TransformGizmoRoot, Transform::IDENTITY, Visibility::Hidden))",
      "condition": "创建初始隐藏的操作器根节点。"
    },
    {
      "kind": "Component",
      "type": "Visibility",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((TransformGizmoRoot, Transform::IDENTITY, Visibility::Hidden))",
      "condition": "创建初始隐藏的操作器根节点。"
    },
    {
      "kind": "Component",
      "type": "Mesh3d",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((\n                Mesh3d(mesh),",
      "condition": "局部 spawn_child 闭包被平移、旋转或缩放手柄构造分支调用。"
    },
    {
      "kind": "Component",
      "type": "MeshMaterial3d<StandardMaterial>",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((\n                Mesh3d(mesh),",
      "condition": "局部 spawn_child 闭包被平移、旋转或缩放手柄构造分支调用。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((\n                Mesh3d(mesh),",
      "condition": "局部 spawn_child 闭包被平移、旋转或缩放手柄构造分支调用。"
    },
    {
      "kind": "Component",
      "type": "TransformGizmoMeshMarker",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((\n                Mesh3d(mesh),",
      "condition": "局部 spawn_child 闭包被平移、旋转或缩放手柄构造分支调用。"
    },
    {
      "kind": "Component",
      "type": "Visibility",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((\n                Mesh3d(mesh),",
      "condition": "局部 spawn_child 闭包被平移、旋转或缩放手柄构造分支调用。"
    },
    {
      "kind": "Component",
      "type": "RenderLayers",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((\n                Mesh3d(mesh),",
      "condition": "局部 spawn_child 闭包被平移、旋转或缩放手柄构造分支调用。"
    },
    {
      "kind": "Component",
      "type": "ChildOf",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ChildOf(root_entity))",
      "condition": "局部 spawn_child 闭包创建手柄后。"
    },
    {
      "kind": "Component",
      "type": "Camera3d",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((\n        Camera3d::default(),",
      "condition": "创建操作器覆盖相机。"
    },
    {
      "kind": "Component",
      "type": "Camera",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((\n        Camera3d::default(),",
      "condition": "创建操作器覆盖相机。"
    },
    {
      "kind": "Component",
      "type": "GizmoOverlayCamera",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((\n        Camera3d::default(),",
      "condition": "创建操作器覆盖相机。"
    },
    {
      "kind": "Component",
      "type": "RenderLayers",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((\n        Camera3d::default(),",
      "condition": "创建操作器覆盖相机。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((\n        Camera3d::default(),",
      "condition": "创建操作器覆盖相机。"
    },
    {
      "kind": "Resource",
      "type": "TransformGizmoMaterials",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(mat_res)",
      "evidenceMatch": "let mat_res = TransformGizmoMaterials {"
    }
  ],
  "bevy_light::point_light::update_point_light_bounding_spheres": [
    {
      "kind": "Component",
      "type": "Sphere",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(Sphere",
      "condition": "PointLight 或全局变换发生变化的点光实体。"
    }
  ],
  "bevy_light::spot_light::update_spot_light_bounding_spheres": [
    {
      "kind": "Component",
      "type": "Sphere",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(Sphere",
      "condition": "SpotLight 或全局变换发生变化的聚光灯实体。"
    }
  ],
  "bevy_post_process::bloom::downsampling_pipeline::init_bloom_downsampling_pipeline": [
    {
      "kind": "Resource",
      "type": "BloomDownsamplingPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(BloomDownsamplingPipeline"
    }
  ],
  "bevy_post_process::bloom::downsampling_pipeline::prepare_downsampling_pipeline": [
    {
      "kind": "Component",
      "type": "BloomDownsamplingPipelineIds",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(BloomDownsamplingPipelineIds"
    }
  ],
  "bevy_post_process::bloom::prepare_bloom_bind_groups": [
    {
      "kind": "Component",
      "type": "BloomBindGroups",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(BloomBindGroups",
      "condition": "Bloom 纹理或参数缓冲身份与已有绑定组缓存不一致。"
    }
  ],
  "bevy_post_process::bloom::prepare_bloom_textures": [
    {
      "kind": "Component",
      "type": "BloomTexture",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(BloomTexture",
      "condition": "带 Bloom 的相机具有物理视口尺寸。"
    }
  ],
  "bevy_post_process::bloom::upsampling_pipeline::init_bloom_upscaling_pipeline": [
    {
      "kind": "Resource",
      "type": "BloomUpsamplingPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(BloomUpsamplingPipeline"
    }
  ],
  "bevy_post_process::bloom::upsampling_pipeline::prepare_upsampling_pipeline": [
    {
      "kind": "Component",
      "type": "UpsamplingPipelineIds",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(UpsamplingPipelineIds"
    }
  ],
  "bevy_post_process::dof::extract_depth_of_field_settings": [
    {
      "kind": "Component",
      "type": "DepthOfField",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<<DepthOfField as SyncComponent<RenderApp>>::Target>()",
      "condition": "平台支持景深但投影不是透视投影；移除的五元组由同文件 SyncComponent<RenderApp> for DepthOfField 的 Target 实现明确列出。",
      "proofs": [
        {
          "path": "src/dof/mod.rs",
          "line": 654,
          "dependency": {
            "name": "bevy_post_process",
            "version": "0.20.0"
          },
          "match": "impl SyncComponent<RenderApp> for DepthOfField {\n    type Target = (\n        DepthOfField,\n        DepthOfFieldUniform,\n        DepthOfFieldPipelines,\n        AuxiliaryDepthOfFieldTexture,\n        ViewDepthOfFieldBindGroupLayouts,\n    );\n}"
        }
      ]
    },
    {
      "kind": "Component",
      "type": "DepthOfFieldUniform",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<<DepthOfField as SyncComponent<RenderApp>>::Target>()",
      "condition": "平台支持景深但投影不是透视投影；移除的五元组由同文件 SyncComponent<RenderApp> for DepthOfField 的 Target 实现明确列出。",
      "proofs": [
        {
          "path": "src/dof/mod.rs",
          "line": 654,
          "dependency": {
            "name": "bevy_post_process",
            "version": "0.20.0"
          },
          "match": "impl SyncComponent<RenderApp> for DepthOfField {\n    type Target = (\n        DepthOfField,\n        DepthOfFieldUniform,\n        DepthOfFieldPipelines,\n        AuxiliaryDepthOfFieldTexture,\n        ViewDepthOfFieldBindGroupLayouts,\n    );\n}"
        }
      ]
    },
    {
      "kind": "Component",
      "type": "DepthOfFieldPipelines",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<<DepthOfField as SyncComponent<RenderApp>>::Target>()",
      "condition": "平台支持景深但投影不是透视投影；移除的五元组由同文件 SyncComponent<RenderApp> for DepthOfField 的 Target 实现明确列出。",
      "proofs": [
        {
          "path": "src/dof/mod.rs",
          "line": 654,
          "dependency": {
            "name": "bevy_post_process",
            "version": "0.20.0"
          },
          "match": "impl SyncComponent<RenderApp> for DepthOfField {\n    type Target = (\n        DepthOfField,\n        DepthOfFieldUniform,\n        DepthOfFieldPipelines,\n        AuxiliaryDepthOfFieldTexture,\n        ViewDepthOfFieldBindGroupLayouts,\n    );\n}"
        }
      ]
    },
    {
      "kind": "Component",
      "type": "AuxiliaryDepthOfFieldTexture",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<<DepthOfField as SyncComponent<RenderApp>>::Target>()",
      "condition": "平台支持景深但投影不是透视投影；移除的五元组由同文件 SyncComponent<RenderApp> for DepthOfField 的 Target 实现明确列出。",
      "proofs": [
        {
          "path": "src/dof/mod.rs",
          "line": 654,
          "dependency": {
            "name": "bevy_post_process",
            "version": "0.20.0"
          },
          "match": "impl SyncComponent<RenderApp> for DepthOfField {\n    type Target = (\n        DepthOfField,\n        DepthOfFieldUniform,\n        DepthOfFieldPipelines,\n        AuxiliaryDepthOfFieldTexture,\n        ViewDepthOfFieldBindGroupLayouts,\n    );\n}"
        }
      ]
    },
    {
      "kind": "Component",
      "type": "ViewDepthOfFieldBindGroupLayouts",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity_commands.remove::<<DepthOfField as SyncComponent<RenderApp>>::Target>()",
      "condition": "平台支持景深但投影不是透视投影；移除的五元组由同文件 SyncComponent<RenderApp> for DepthOfField 的 Target 实现明确列出。",
      "proofs": [
        {
          "path": "src/dof/mod.rs",
          "line": 654,
          "dependency": {
            "name": "bevy_post_process",
            "version": "0.20.0"
          },
          "match": "impl SyncComponent<RenderApp> for DepthOfField {\n    type Target = (\n        DepthOfField,\n        DepthOfFieldUniform,\n        DepthOfFieldPipelines,\n        AuxiliaryDepthOfFieldTexture,\n        ViewDepthOfFieldBindGroupLayouts,\n    );\n}"
        }
      ]
    },
    {
      "kind": "Component",
      "type": "DepthOfField",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity_commands.insert((\n            *depth_of_field,",
      "condition": "平台支持景深且相机使用透视投影。"
    },
    {
      "kind": "Component",
      "type": "DepthOfFieldUniform",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity_commands.insert((\n            *depth_of_field,",
      "condition": "平台支持景深且相机使用透视投影。"
    }
  ],
  "bevy_post_process::dof::init_dof_global_bind_group_layout": [
    {
      "kind": "Resource",
      "type": "DepthOfFieldGlobalBindGroupLayout",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(DepthOfFieldGlobalBindGroupLayout"
    }
  ],
  "bevy_post_process::dof::prepare_auxiliary_depth_of_field_textures": [
    {
      "kind": "Component",
      "type": "AuxiliaryDepthOfFieldTexture",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(AuxiliaryDepthOfFieldTexture",
      "condition": "景深模式为 Bokeh。"
    }
  ],
  "bevy_post_process::dof::prepare_depth_of_field_pipelines": [
    {
      "kind": "Component",
      "type": "DepthOfFieldPipelines",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(DepthOfFieldPipelines::Gaussian {",
      "condition": "景深模式为 Gaussian。"
    },
    {
      "kind": "Component",
      "type": "DepthOfFieldPipelines",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(DepthOfFieldPipelines::Bokeh {",
      "condition": "景深模式为 Bokeh。"
    }
  ],
  "bevy_post_process::dof::prepare_depth_of_field_view_bind_group_layouts": [
    {
      "kind": "Component",
      "type": "ViewDepthOfFieldBindGroupLayouts",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewDepthOfFieldBindGroupLayouts"
    }
  ],
  "bevy_post_process::effect_stack::init_post_processing_pipeline": [
    {
      "kind": "Resource",
      "type": "PostProcessingPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(PostProcessingPipeline"
    }
  ],
  "bevy_post_process::effect_stack::prepare_post_processing_pipelines": [
    {
      "kind": "Component",
      "type": "PostProcessingPipelineId",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(PostProcessingPipelineId"
    }
  ],
  "bevy_post_process::effect_stack::prepare_post_processing_uniforms": [
    {
      "kind": "Component",
      "type": "PostProcessingUniformBufferOffsets",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(PostProcessingUniformBufferOffsets",
      "condition": "视图至少带色差、暗角或镜头畸变其中一种设置。"
    }
  ],
  "bevy_post_process::motion_blur::pipeline::init_motion_blur_pipeline": [
    {
      "kind": "Resource",
      "type": "MotionBlurPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(MotionBlurPipeline::new("
    }
  ],
  "bevy_post_process::motion_blur::pipeline::prepare_motion_blur_pipelines": [
    {
      "kind": "Component",
      "type": "MotionBlurPipelineId",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(MotionBlurPipelineId",
      "condition": "带 MotionBlurUniform 的已提取相机。"
    }
  ],
  "bevy_post_process::msaa_writeback::prepare_msaa_writeback_pipelines": [
    {
      "kind": "Component",
      "type": "MsaaWritebackBlitPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(MsaaWritebackBlitPipeline",
      "condition": "MSAA 采样数大于一且配置或相机合成状态要求回写。"
    },
    {
      "kind": "Component",
      "type": "MsaaWritebackBlitPipeline",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<MsaaWritebackBlitPipeline",
      "condition": "未启用多采样，或根据设置及相机状态无需回写。"
    }
  ],
  "bevy_sprite_render::mesh2d::material::init_material_2d_pipeline": [
    {
      "kind": "Resource",
      "type": "Material2dPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(Material2dPipeline"
    }
  ],
  "bevy_sprite_render::mesh2d::material::initialize_material2d_shaders": [
    {
      "kind": "Resource",
      "type": "Material2dShaders<M>",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(Material2dShaders::<M>::with_shader_cache(shaders))"
    }
  ],
  "bevy_sprite_render::mesh2d::mesh::init_batched_instance_buffer": [
    {
      "kind": "Resource",
      "type": "BatchedInstanceBuffer<Mesh2dUniform>",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(BatchedInstanceBuffer::<Mesh2dUniform>::new("
    }
  ],
  "bevy_sprite_render::mesh2d::mesh::init_mesh_2d_pipeline": [
    {
      "kind": "Resource",
      "type": "Mesh2dPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(Mesh2dPipeline"
    }
  ],
  "bevy_sprite_render::mesh2d::mesh::prepare_mesh2d_view_bind_groups": [
    {
      "kind": "Component",
      "type": "Mesh2dViewBindGroup",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(Mesh2dViewBindGroup",
      "condition": "视图参数和全局参数缓冲均可绑定。"
    }
  ],
  "bevy_sprite_render::render::init_sprite_pipeline": [
    {
      "kind": "Resource",
      "type": "SpritePipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(SpritePipeline"
    }
  ],
  "bevy_sprite_render::render::prepare_sprite_view_bind_groups": [
    {
      "kind": "Component",
      "type": "SpriteViewBindGroup",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(SpriteViewBindGroup",
      "condition": "视图参数缓冲已可绑定。"
    }
  ],
  "bevy_sprite_render::text2d::extract_text2d_sprite": [
    {
      "kind": "Component",
      "type": "TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "            };\n            let render_entity = commands.spawn(TemporaryRenderEntity::default()).id();\n            let offset = run.bounds.center();",
      "condition": "可见二维文字的背景、阴影、字形或装饰分支需要新临时渲染实体时。"
    },
    {
      "kind": "Component",
      "type": "TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "                    .is_none_or(|info| info.atlas_info.texture != atlas_info.texture)\n                {\n                    let render_entity = commands.spawn(TemporaryRenderEntity::default()).id();\n                    extracted_sprites.sprites.push(ExtractedSprite {\n                        main_entity,",
      "condition": "可见二维文字的背景、阴影、字形或装饰分支需要新临时渲染实体时。"
    },
    {
      "kind": "Component",
      "type": "TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "                if has_strikethrough {\n                    let render_entity = commands.spawn(TemporaryRenderEntity::default()).id();\n                    let offset = run.strikethrough_position();",
      "condition": "可见二维文字的背景、阴影、字形或装饰分支需要新临时渲染实体时。"
    },
    {
      "kind": "Component",
      "type": "TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "                if has_underline {\n                    let render_entity = commands.spawn(TemporaryRenderEntity::default()).id();\n                    let offset = run.underline_position();",
      "condition": "可见二维文字的背景、阴影、字形或装饰分支需要新临时渲染实体时。"
    },
    {
      "kind": "Component",
      "type": "TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "            }) {\n                let render_entity = commands.spawn(TemporaryRenderEntity::default()).id();\n                extracted_sprites.sprites.push(ExtractedSprite {",
      "condition": "可见二维文字的背景、阴影、字形或装饰分支需要新临时渲染实体时。"
    },
    {
      "kind": "Component",
      "type": "TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "                    .to_linear();\n                let render_entity = commands.spawn(TemporaryRenderEntity::default()).id();\n                let offset = run.strikethrough_position();",
      "condition": "可见二维文字的背景、阴影、字形或装饰分支需要新临时渲染实体时。"
    },
    {
      "kind": "Component",
      "type": "TemporaryRenderEntity",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "                    .to_linear();\n                let render_entity = commands.spawn(TemporaryRenderEntity::default()).id();\n                let offset = run.underline_position();",
      "condition": "可见二维文字的背景、阴影、字形或装饰分支需要新临时渲染实体时。"
    }
  ],
  "bevy_ui_render::box_shadow::init_box_shadow_pipeline": [
    {
      "kind": "Resource",
      "type": "BoxShadowPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(BoxShadowPipeline"
    }
  ],
  "bevy_ui_render::extract_ui_camera_view": [
    {
      "kind": "Component",
      "type": "ExtractedView",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((extracted_view, ui_view_target_component))",
      "evidenceMatch": "let extracted_view = ExtractedView {",
      "condition": "相机可渲染且已有缓存 UI 子视图。"
    },
    {
      "kind": "Component",
      "type": "ExtractedView",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((extracted_view, ui_view_target_component))",
      "evidenceMatch": "let extracted_view = ExtractedView {",
      "condition": "相机可渲染且尚未创建缓存 UI 子视图。"
    },
    {
      "kind": "Component",
      "type": "UiViewTarget",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((extracted_view, ui_view_target_component))",
      "evidenceMatch": "let ui_view_target_component = UiViewTarget(render_entity)",
      "condition": "相机可渲染且已有缓存 UI 子视图。"
    },
    {
      "kind": "Component",
      "type": "UiViewTarget",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": ".spawn((extracted_view, ui_view_target_component))",
      "evidenceMatch": "let ui_view_target_component = UiViewTarget(render_entity)",
      "condition": "相机可渲染且尚未创建缓存 UI 子视图。"
    },
    {
      "kind": "Component",
      "type": "UiCameraView",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity_commands.insert(UiCameraView(ui_camera_view))",
      "condition": "相机活动且视口、目标尺寸、主通道格式有效。"
    },
    {
      "kind": "Component",
      "type": "UiAntiAlias",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity_commands.insert(*ui_anti_alias)",
      "evidenceMatch": "Option<&UiAntiAlias>",
      "condition": "相机可渲染并提供 UiAntiAlias 设置。"
    },
    {
      "kind": "Component",
      "type": "BoxShadowSamples",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity_commands.insert(*shadow_samples)",
      "evidenceMatch": "Option<&BoxShadowSamples>",
      "condition": "相机可渲染并提供 BoxShadowSamples 设置。"
    },
    {
      "kind": "Component",
      "type": "UiCameraView",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(UiCameraView, UiAntiAlias, BoxShadowSamples)>()",
      "condition": "相机不再可渲染时移除主相机上的 UI 关联及设置。"
    },
    {
      "kind": "Component",
      "type": "UiAntiAlias",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(UiCameraView, UiAntiAlias, BoxShadowSamples)>()",
      "condition": "相机不再可渲染时移除主相机上的 UI 关联及设置。"
    },
    {
      "kind": "Component",
      "type": "BoxShadowSamples",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(UiCameraView, UiAntiAlias, BoxShadowSamples)>()",
      "condition": "相机不再可渲染时移除主相机上的 UI 关联及设置。"
    }
  ],
  "bevy_ui_render::gradient::init_gradient_pipeline": [
    {
      "kind": "Resource",
      "type": "GradientPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(GradientPipeline"
    }
  ],
  "bevy_ui_render::image::update_texture_atlas_layout_components": [
    {
      "kind": "Component",
      "type": "ImageNodeTextureAtlasLayout",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ImageNodeTextureAtlasLayout",
      "condition": "ImageNode 变化且仍引用图集布局。"
    },
    {
      "kind": "Component",
      "type": "ImageNodeTextureAtlasLayout",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ImageNodeTextureAtlasLayout",
      "condition": "ImageNode 变化且已不再引用图集。"
    }
  ],
  "bevy_ui_render::pipeline::init_ui_pipeline": [
    {
      "kind": "Resource",
      "type": "UiPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(UiPipeline"
    }
  ],
  "bevy_ui_render::ui_texture_slice_pipeline::init_ui_texture_slice_pipeline": [
    {
      "kind": "Resource",
      "type": "UiTextureSlicePipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(UiTextureSlicePipeline"
    }
  ],
  "bevy_render::erased_render_asset::collect_erased_render_assets_to_reextract": [
    {
      "kind": "Resource",
      "type": "ErasedRenderAssetsToReExtract<A>",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(ErasedRenderAssetsToReExtract::<A> { ids })",
      "condition": "当前源资产类型存在需要重新提取的资产身份。"
    }
  ],
  "bevy_render::globals::extract_frame_count": [
    {
      "kind": "Resource",
      "type": "FrameCount",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(**frame_count)",
      "evidenceMatch": "Extract<Res<FrameCount>>"
    }
  ],
  "bevy_render::material_bind_groups::init_fallback_resources": [
    {
      "kind": "Resource",
      "type": "FallbackBindlessResources",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(FallbackBindlessResources"
    },
    {
      "kind": "Resource",
      "type": "FallbackBuffer",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(FallbackBuffer"
    }
  ],
  "bevy_render::mesh::prepare_mesh_metadata_fallback_buffer": [
    {
      "kind": "Resource",
      "type": "MeshMetadataFallbackBuffer",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(MeshMetadataFallbackBuffer"
    }
  ],
  "bevy_render::render_asset::collect_render_assets_to_reextract": [
    {
      "kind": "Resource",
      "type": "RenderAssetsToReExtract<A>",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(RenderAssetsToReExtract::<A> { ids })",
      "condition": "渲染资产表被排空后存在需重新提取的身份。"
    }
  ],
  "bevy_render::render_resource::sparse_buffer_vec::init_sparse_buffer_update_bind_groups": [
    {
      "kind": "Resource",
      "type": "SparseBufferUpdateBindGroups",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(SparseBufferUpdateBindGroups"
    }
  ],
  "bevy_render::render_resource::sparse_buffer_vec::init_sparse_buffer_update_pipelines": [
    {
      "kind": "Resource",
      "type": "SparseBufferUpdatePipelines",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(SparseBufferUpdatePipelines {\n            bind_group_layout: None,",
      "condition": "设备每阶段支持的存储缓冲数小于三，插入停用配置。"
    },
    {
      "kind": "Resource",
      "type": "SparseBufferUpdatePipelines",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(SparseBufferUpdatePipelines {\n        bind_group_layout: Some(bind_group_layout),",
      "condition": "设备每阶段至少支持三个存储缓冲，插入可用布局及着色器。"
    }
  ],
  "bevy_render::view::cleanup_view_targets_for_resize": [
    {
      "kind": "Component",
      "type": "ViewTarget",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ViewTarget",
      "condition": "相机输出窗口本帧尺寸或呈现模式变化。"
    }
  ],
  "bevy_render::view::prepare_view_targets": [
    {
      "kind": "Component",
      "type": "ViewTarget",
      "operation": "remove",
      "via": "commands",
      "method": "try_remove",
      "match": "            // If we don't have a target size, we can't create the main texture and have to bail\n            commands.entity(entity).try_remove::<ViewTarget>();\n            continue;",
      "condition": "相机没有物理目标尺寸。"
    },
    {
      "kind": "Component",
      "type": "ViewTarget",
      "operation": "remove",
      "via": "commands",
      "method": "try_remove",
      "match": "        if out_attachment.is_none() && !matches!(camera.clear_color, ClearColorConfig::None) {\n            commands.entity(entity).try_remove::<ViewTarget>();\n            continue;",
      "condition": "相机没有输出附件且清除配置不是 None。"
    },
    {
      "kind": "Component",
      "type": "ViewTarget",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ViewTarget",
      "condition": "相机具有目标尺寸且未命中无需渲染的退出条件。"
    }
  ],
  "bevy_render::view::prepare_view_uniforms": [
    {
      "kind": "Component",
      "type": "ViewUniformOffset",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(view_uniforms)",
      "evidenceMatch": "let view_uniforms = ViewUniformOffset {",
      "condition": "视图参数写入器可用且完成该视图参数写入。"
    }
  ],
  "bevy_render::view::window::screenshot::init_screenshot_to_screen_pipeline": [
    {
      "kind": "Resource",
      "type": "ScreenshotToScreenPipeline",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(ScreenshotToScreenPipeline"
    }
  ],
  "bevy_core_pipeline::core_3d::extract_camera_prepass_phase": [
    {
      "kind": "Component",
      "type": "DepthPrepass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "camera_commands.insert(DepthPrepass)",
      "condition": "主世界活动三维相机带有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "DepthPrepass",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "camera_commands.remove::<DepthPrepass>()",
      "condition": "主世界活动三维相机没有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "NormalPrepass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "camera_commands.insert(NormalPrepass)",
      "condition": "主世界活动三维相机带有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "NormalPrepass",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "camera_commands.remove::<NormalPrepass>()",
      "condition": "主世界活动三维相机没有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "MotionVectorPrepass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "camera_commands.insert(MotionVectorPrepass)",
      "condition": "主世界活动三维相机带有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "MotionVectorPrepass",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "camera_commands.remove::<MotionVectorPrepass>()",
      "condition": "主世界活动三维相机没有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "DeferredPrepass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "camera_commands.insert(DeferredPrepass)",
      "condition": "主世界活动三维相机带有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "DeferredPrepass",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "camera_commands.remove::<DeferredPrepass>()",
      "condition": "主世界活动三维相机没有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "DepthPrepassDoubleBuffer",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "camera_commands.insert(DepthPrepassDoubleBuffer)",
      "condition": "主世界活动三维相机带有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "DepthPrepassDoubleBuffer",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "camera_commands.remove::<DepthPrepassDoubleBuffer>()",
      "condition": "主世界活动三维相机没有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "DeferredPrepassDoubleBuffer",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "camera_commands.insert(DeferredPrepassDoubleBuffer)",
      "condition": "主世界活动三维相机带有对应预通道标记。"
    },
    {
      "kind": "Component",
      "type": "DeferredPrepassDoubleBuffer",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "camera_commands.remove::<DeferredPrepassDoubleBuffer>()",
      "condition": "主世界活动三维相机没有对应预通道标记。"
    }
  ],
  "bevy_render::uniform::prepare_uniform_components": [
    {
      "kind": "Component",
      "type": "DynamicUniformIndex<C>",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert_batch",
      "match": "commands.try_insert_batch(entities)",
      "evidenceMatch": "DynamicUniformIndex::<C> {",
      "condition": "组件参数写入器可用，每个组件值已写入并生成偏移索引。"
    }
  ],
  "bevy_core_pipeline::prepass::background_motion_vectors::cleanup_background_motion_vectors": [
    {
      "kind": "Component",
      "type": "BackgroundMotionVectorsPipelineId",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(",
      "condition": "视图不再启用运动矢量预通道，或已设置 NoBackgroundMotionVectors。"
    },
    {
      "kind": "Component",
      "type": "BackgroundMotionVectorsBindGroup",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(",
      "condition": "视图不再启用运动矢量预通道，或已设置 NoBackgroundMotionVectors。"
    }
  ],
  "bevy_core_pipeline::schedule::camera_driver": [
    {
      "kind": "Resource",
      "type": "SortedCameras",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<SortedCameras>()"
    },
    {
      "kind": "Resource",
      "type": "RenderDevice",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "    if diagnostics_enabled {\n        let device = world.resource::<RenderDevice>().clone();\n        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {",
      "condition": "启用渲染诊断时建立辅助视图时间区间。"
    },
    {
      "kind": "Resource",
      "type": "DiagnosticsRecorder",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "            .resource::<DiagnosticsRecorder>()\n            .begin_time_span(&mut encoder, \"auxiliary_views\".into());",
      "condition": "启用渲染诊断时开始或结束辅助视图时间区间。"
    },
    {
      "kind": "Resource",
      "type": "RenderDevice",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "    let end_time_span = |world: &mut World| {\n        let device = world.resource::<RenderDevice>().clone();\n        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {",
      "condition": "启用渲染诊断时建立辅助视图时间区间。"
    },
    {
      "kind": "Resource",
      "type": "DiagnosticsRecorder",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "            .resource::<DiagnosticsRecorder>()\n            .end_time_span(&mut encoder);",
      "condition": "启用渲染诊断时开始或结束辅助视图时间区间。"
    },
    {
      "kind": "Component",
      "type": "ExtractedCamera",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "world.get::<ExtractedCamera>",
      "condition": "对应根视图类别需要读取其调度标签时。"
    },
    {
      "kind": "Component",
      "type": "RootNonCameraView",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "world.get::<RootNonCameraView>",
      "condition": "对应根视图类别需要读取其调度标签时。"
    },
    {
      "kind": "Resource",
      "type": "CurrentView",
      "operation": "insert",
      "via": "world",
      "method": "insert_resource",
      "match": "world.insert_resource(CurrentView(view_entity))",
      "condition": "根视图允许执行调度时。"
    },
    {
      "kind": "Resource",
      "type": "CurrentView",
      "operation": "remove",
      "via": "world",
      "method": "remove_resource",
      "match": "world.remove_resource::<CurrentView>()",
      "condition": "全部根视图处理完毕后。"
    },
    {
      "kind": "Resource",
      "type": "CameraWindows",
      "operation": "insert",
      "via": "world",
      "method": "insert_resource",
      "match": "world.insert_resource(CameraWindows(camera_windows))",
      "condition": "全部根视图处理完毕后登记相机覆盖窗口集合。"
    },
    {
      "kind": "Resource",
      "type": "PendingCommandBuffers",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_mut",
      "match": "            .resource_mut::<PendingCommandBuffers>()\n            .push_encoder(encoder, \"camera_driver_span_begin\");",
      "condition": "渲染诊断启用，排入辅助视图时间区间的命令编码器。"
    },
    {
      "kind": "Resource",
      "type": "PendingCommandBuffers",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_mut",
      "match": "            .resource_mut::<PendingCommandBuffers>()\n            .push_encoder(encoder, \"camera_driver_span_end\");",
      "condition": "渲染诊断启用，排入辅助视图时间区间的命令编码器。"
    }
  ],
  "bevy_core_pipeline::skybox::extract_skybox": [
    {
      "kind": "Component",
      "type": "Skybox",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert_batch",
      "match": "commands.try_insert_batch(values)",
      "evidenceMatch": "values.push((entity, (skybox.clone(), uniforms)))",
      "condition": "主世界存在带 Skybox 的相机实体。"
    },
    {
      "kind": "Component",
      "type": "SkyboxUniforms",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert_batch",
      "match": "commands.try_insert_batch(values)",
      "evidenceMatch": "let uniforms = SkyboxUniforms {",
      "condition": "主世界存在带 Skybox 的相机实体。"
    }
  ],
  "bevy_core_pipeline::upscaling::clear_view_upscaling_pipelines": [
    {
      "kind": "Component",
      "type": "ViewUpscalingPipeline",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ViewUpscalingPipeline"
    }
  ],
  "bevy_light::cluster::add_light_probe_and_decal_aabbs": [
    {
      "kind": "Component",
      "type": "Aabb",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(Aabb",
      "condition": "带光照探针或分簇贴花标记且没有 Aabb 的实体。"
    }
  ],
  "bevy_light::probe::automatically_add_parallax_correction_components": [
    {
      "kind": "Component",
      "type": "ParallaxCorrection",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ParallaxCorrection::default())",
      "condition": "实体同时带 EnvironmentMapLight 与 LightProbe，且尚无 ParallaxCorrection。"
    }
  ],
  "bevy_render::camera::extract_cameras": [
    {
      "kind": "Component",
      "type": "ExtractedCamera",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "ExtractedView",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "ResolvedCompositingSpace",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "TemporalJitter",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "MipBias",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "RenderLayers",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "Projection",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "NoIndirectDrawing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "ViewUniformOffset",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "RenderVisibleEntities",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(ExtractedCameraComponents, RenderVisibleEntities)>()",
      "condition": "主世界相机已停用；ExtractedCameraComponents 为本体显式列出的九元组。"
    },
    {
      "kind": "Component",
      "type": "ExtractedCamera",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "ExtractedView",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "ResolvedCompositingSpace",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "TemporalJitter",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "MipBias",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "RenderLayers",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "Projection",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "NoIndirectDrawing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "ViewUniformOffset",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ExtractedCameraComponents>()",
      "condition": "物理目标尺寸任一维为零；目标组件由本体九元组别名明确列出。"
    },
    {
      "kind": "Component",
      "type": "ExtractedCamera",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert((\n                ExtractedCamera {",
      "condition": "活动相机具有有效非零物理视口及目标尺寸。"
    },
    {
      "kind": "Component",
      "type": "ResolvedCompositingSpace",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert((\n                ExtractedCamera {",
      "condition": "活动相机具有有效非零物理视口及目标尺寸。"
    },
    {
      "kind": "Component",
      "type": "ExtractedView",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert((\n                ExtractedCamera {",
      "condition": "活动相机具有有效非零物理视口及目标尺寸。"
    },
    {
      "kind": "Component",
      "type": "RenderExtractedVisibleEntities",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert((\n                ExtractedCamera {",
      "condition": "活动相机具有有效非零物理视口及目标尺寸。"
    },
    {
      "kind": "Component",
      "type": "Frustum",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert((\n                ExtractedCamera {",
      "condition": "活动相机具有有效非零物理视口及目标尺寸。"
    },
    {
      "kind": "Component",
      "type": "TemporalJitter",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert(temporal_jitter.clone())",
      "condition": "活动相机目标尺寸有效且提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "TemporalJitter",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.remove::<TemporalJitter>()",
      "condition": "活动相机目标尺寸有效但不提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "MipBias",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert(mip_bias.clone())",
      "condition": "活动相机目标尺寸有效且提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "MipBias",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.remove::<MipBias>()",
      "condition": "活动相机目标尺寸有效但不提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "RenderLayers",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert(render_layers.clone())",
      "condition": "活动相机目标尺寸有效且提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "RenderLayers",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.remove::<RenderLayers>()",
      "condition": "活动相机目标尺寸有效但不提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "Projection",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert(projection.clone())",
      "condition": "活动相机目标尺寸有效且提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "Projection",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.remove::<Projection>()",
      "condition": "活动相机目标尺寸有效但不提供对应可选设置。"
    },
    {
      "kind": "Component",
      "type": "NoIndirectDrawing",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert(NoIndirectDrawing)",
      "condition": "主世界相机禁止间接绘制，或设备不支持 GPU 剔除。"
    },
    {
      "kind": "Component",
      "type": "NoIndirectDrawing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.remove::<NoIndirectDrawing>()",
      "condition": "主世界相机允许间接绘制且设备支持 GPU 剔除。"
    }
  ],
  "bevy_render::globals::extract_time": [
    {
      "kind": "Resource",
      "type": "Time",
      "operation": "insert",
      "via": "commands",
      "method": "insert_resource",
      "match": "commands.insert_resource(**time)",
      "evidenceMatch": "Extract<Res<Time>>"
    }
  ],
  "bevy_render::gpu_readback::cleanup_readback_once": [
    {
      "kind": "Component",
      "type": "Readback",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(Readback, ReadbackOnce)>()",
      "condition": "带 ReadbackOnce 的实体在单次读取清理阶段处理。"
    },
    {
      "kind": "Component",
      "type": "ReadbackOnce",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(Readback, ReadbackOnce)>()",
      "condition": "带 ReadbackOnce 的实体在单次读取清理阶段处理。"
    }
  ],
  "bevy_render::init_gpu_resource": [
    {
      "kind": "Resource",
      "type": "R",
      "operation": "insert",
      "via": "world",
      "method": "insert_resource",
      "match": "world.insert_resource(res)",
      "evidenceMatch": "let res = R::from_world(world)"
    }
  ],
  "bevy_render::renderer::render_system": [
    {
      "kind": "Resource",
      "type": "RenderDevice",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<RenderDevice>()"
    },
    {
      "kind": "Resource",
      "type": "RenderQueue",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<RenderQueue>()"
    }
  ],
  "bevy_render::view::window::create_surfaces": [
    {
      "kind": "Component",
      "type": "SurfaceData",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(SurfaceData",
      "condition": "提取窗口尚无 SurfaceData，且表面创建及配置成功。"
    }
  ],
  "bevy_render::view::window::extract_windows": [
    {
      "kind": "Component",
      "type": "PrimaryWindow",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(PrimaryWindow)",
      "condition": "主世界窗口带 PrimaryWindow 标记。"
    },
    {
      "kind": "Component",
      "type": "ExtractedWindow",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                ExtractedWindow {",
      "condition": "渲染窗口实体尚无 ExtractedWindow。"
    },
    {
      "kind": "Component",
      "type": "RawHandleWrapper",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                ExtractedWindow {",
      "condition": "渲染窗口实体尚无 ExtractedWindow。"
    },
    {
      "kind": "Component",
      "type": "ExtractedWindow",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "        if let Ok(render_entity) = mapper.get(closing_window.window) {\n            commands\n                .entity(render_entity.entity())\n                .remove::<(ExtractedWindow, RawHandleWrapper, SurfaceData)>();\n        }\n    }\n    for removed_window in removed.read() {",
      "condition": "收到窗口关闭消息且主渲染实体映射存在。"
    },
    {
      "kind": "Component",
      "type": "RawHandleWrapper",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "        if let Ok(render_entity) = mapper.get(closing_window.window) {\n            commands\n                .entity(render_entity.entity())\n                .remove::<(ExtractedWindow, RawHandleWrapper, SurfaceData)>();\n        }\n    }\n    for removed_window in removed.read() {",
      "condition": "收到窗口关闭消息且主渲染实体映射存在。"
    },
    {
      "kind": "Component",
      "type": "SurfaceData",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "        if let Ok(render_entity) = mapper.get(closing_window.window) {\n            commands\n                .entity(render_entity.entity())\n                .remove::<(ExtractedWindow, RawHandleWrapper, SurfaceData)>();\n        }\n    }\n    for removed_window in removed.read() {",
      "condition": "收到窗口关闭消息且主渲染实体映射存在。"
    },
    {
      "kind": "Component",
      "type": "ExtractedWindow",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "        if let Ok(render_entity) = mapper.get(removed_window) {\n            commands\n                .entity(render_entity.entity())\n                .remove::<(ExtractedWindow, RawHandleWrapper, SurfaceData)>();\n        }\n    }\n    for removed_window in removed_primary.read() {",
      "condition": "主世界窗口 RawHandleWrapper 被移除且渲染实体映射存在。"
    },
    {
      "kind": "Component",
      "type": "RawHandleWrapper",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "        if let Ok(render_entity) = mapper.get(removed_window) {\n            commands\n                .entity(render_entity.entity())\n                .remove::<(ExtractedWindow, RawHandleWrapper, SurfaceData)>();\n        }\n    }\n    for removed_window in removed_primary.read() {",
      "condition": "主世界窗口 RawHandleWrapper 被移除且渲染实体映射存在。"
    },
    {
      "kind": "Component",
      "type": "SurfaceData",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "        if let Ok(render_entity) = mapper.get(removed_window) {\n            commands\n                .entity(render_entity.entity())\n                .remove::<(ExtractedWindow, RawHandleWrapper, SurfaceData)>();\n        }\n    }\n    for removed_window in removed_primary.read() {",
      "condition": "主世界窗口 RawHandleWrapper 被移除且渲染实体映射存在。"
    },
    {
      "kind": "Component",
      "type": "PrimaryWindow",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<PrimaryWindow",
      "condition": "主世界 PrimaryWindow 标记被移除且渲染实体映射存在。"
    }
  ],
  "bevy_render::view::window::screenshot::extract_screenshots": [
    {
      "kind": "Component",
      "type": "Capturing",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(Capturing)",
      "condition": "截图目标可标准化且本帧未重复。",
      "scope": "main"
    }
  ],
  "bevy_render::view::window::screenshot::trigger_screenshots": [
    {
      "kind": "Component",
      "type": "Captured",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(Captured)",
      "condition": "截图通道接收到完成的实体和图像。"
    },
    {
      "kind": "EntityEvent",
      "type": "ScreenshotCaptured",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(ScreenshotCaptured { image, entity })",
      "condition": "截图通道接收到完成的实体和图像。"
    }
  ],
  "bevy_sprite_render::sprite_mesh::add_material": [
    {
      "kind": "Component",
      "type": "MeshMaterial2d<SpriteMeshMaterial>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(MeshMaterial2d(handle))",
      "evidenceMatch": "materials: ResMut<Assets<SpriteMeshMaterial>>",
      "condition": "精灵或锚点等发生变化，且外部 SpriteMaterialCount 未声明非零材质数量。"
    }
  ],
  "bevy_sprite_render::sprite_mesh::add_mesh": [
    {
      "kind": "Component",
      "type": "Mesh2d",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(Mesh2d(quad.clone()))",
      "condition": "刚添加 Sprite 的实体。"
    }
  ],
  "bevy_sprite::calculate_bounds_2d": [
    {
      "kind": "Component",
      "type": "Aabb",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": "        {\n            commands.entity(entity).try_insert(aabb);\n        }",
      "condition": "新二维网格没有包围盒且允许自动剔除，网格资产已可返回 Aabb。",
      "proofs": [
        {
          "path": "src/primitives.rs",
          "line": 16,
          "dependency": {
            "name": "bevy_camera",
            "version": "0.20.0"
          },
          "match": "fn get_aabb(&self) -> Option<Aabb>;"
        }
      ]
    },
    {
      "kind": "Component",
      "type": "Aabb",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": "        };\n        commands.entity(entity).try_insert(aabb);\n    }",
      "evidenceMatch": "let aabb = Aabb {",
      "condition": "新精灵没有包围盒且允许自动剔除，尺寸可解析。"
    }
  ],
  "bevy_sprite::text2d::calculate_bounds_text2d": [
    {
      "kind": "Component",
      "type": "Aabb",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": "commands.entity(entity).try_insert(new_aabb)",
      "evidenceMatch": "let new_aabb = Aabb::from_min_max",
      "condition": "二维文字布局变化且尚无 Aabb。"
    }
  ],
  "bevy_ui_render::box_shadow::prepare_shadows": [
    {
      "kind": "Component",
      "type": "UiShadowsBatch",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert_batch",
      "match": "commands.try_insert_batch(batches)",
      "evidenceMatch": "UiShadowsBatch {",
      "condition": "视图参数缓冲可绑定且已生成非空裁剪几何。"
    }
  ],
  "bevy_ui_render::clear_batches": [
    {
      "kind": "Component",
      "type": "UiBatch",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<UiBatch"
    }
  ],
  "bevy_ui_render::gradient::prepare_gradient": [
    {
      "kind": "Component",
      "type": "GradientBatch",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert_batch",
      "match": "commands.try_insert_batch(batches)",
      "evidenceMatch": "GradientBatch {",
      "condition": "视图参数可绑定且渐变段生成有效裁剪几何。"
    }
  ],
  "bevy_ui_render::prepare_uinodes": [
    {
      "kind": "Component",
      "type": "UiBatch",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert_batch",
      "match": "commands.try_insert_batch(batches)",
      "evidenceMatch": "let new_batch = UiBatch {",
      "condition": "视图参数可绑定，图像就绪且已生成 UI 批几何。"
    }
  ],
  "bevy_ui_render::ui_texture_slice_pipeline::prepare_ui_slices": [
    {
      "kind": "Component",
      "type": "UiTextureSlicerBatch",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert_batch",
      "match": "commands.try_insert_batch(batches)",
      "evidenceMatch": "let new_batch = UiTextureSlicerBatch {",
      "condition": "视图参数可绑定且切片图像就绪、裁剪后有几何。"
    }
  ],
  "bevy_core_pipeline::core_3d::main_transparent_pass_3d_node::main_transparent_pass_3d": [
    {
      "kind": "Resource",
      "type": "PipelineCache",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<PipelineCache>()",
      "condition": "开启顺序无关透明后检查解析管线就绪状态。"
    }
  ],
  "bevy_sprite_render::mesh2d::material::specialize_material2d_meshes": [
    {
      "kind": "Resource",
      "type": "SpecializedMaterial2dPipelineCache",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_mut",
      "match": "            world.resource_mut::<SpecializedMaterial2dPipelineCache>();",
      "condition": "专用化任务成功后更新缓存，或结束时清理失效视图。"
    },
    {
      "kind": "Resource",
      "type": "SpecializedMaterial2dPipelineCache",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_mut",
      "match": "        .resource_mut::<SpecializedMaterial2dPipelineCache>()\n        .retain(|view, _| all_views.contains(view));",
      "condition": "专用化任务成功后更新缓存，或结束时清理失效视图。"
    }
  ],
  "bevy_light::check_dir_light_mesh_visibility": [
    {
      "kind": "Component",
      "type": "ViewVisibility",
      "operation": "mutable_access",
      "via": "world",
      "method": "query",
      "match": "world.query::<&mut ViewVisibility>()",
      "condition": "延迟命令处理本轮确认可见的阴影投射实体。"
    }
  ],
  "bevy_sprite::picking_backend::sprite_picking": [
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerHits>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "pointer_hits_writer.write(PointerHits::new(pointer, picks, order as f32));",
      "evidenceMatch": "mut pointer_hits_writer: MessageWriter<PointerHits>",
      "condition": "正交相机启用且满足拾取标记要求、指针位于匹配目标与视口内时，为该射线发布按相机顺序标记的精灵命中列表；列表可为空。"
    }
  ]
};

export const EFFECTS_SCHEDULE_BODY_GAPS = {
  "bevy_ui_render::extract_ui_camera_view": [
    "本体会销毁不再可渲染或已移除相机的缓存 UI 子视图实体；目标为缓存 Entity，未将实体销毁展开为对未知当前组件集合的静态移除关系。"
  ],
  "bevy_ui_render::extract_uinode_changes": [
    "本体局部 process_changed_entity 会销毁发生变化 UI 节点的旧渲染实体；这些实体由动态表持有，未把销毁推广成对任意组件类型的移除关系。"
  ],
  "bevy_ui_render::ui_texture_slice_pipeline::extract_ui_texture_slices": [
    "本体销毁旧切片或移除节点对应的动态渲染 Entity，重建时使用 spawn_empty；没有显式附加可唯一定位的 ECS 组件，不把 ExtractedUiTextureSlice 容器条目冒充组件。"
  ],
  "bevy_render::init_gpu_resource": [
    "R::from_world(world) 的构造 helper 可依赖具体 R 访问世界；这里只登记明确的 R 资源插入，不从泛型 helper 推导其他副作用。"
  ],
  "bevy_render::renderer::render_system": [
    "本体调用截图提交、GPU 回读提交与截图收集 helper；未把 helper 内部操作自动归属于此系统的直接关系。"
  ],
  "bevy_render::view::window::screenshot::clear_screenshots": [
    "commands.despawn_all::<With<Captured>>() 按 Captured 标记筛选并销毁实体，不等价于只移除 Captured 组件；未伪造为组件删除操作。"
  ],
  "bevy_render::view::window::screenshot::extract_screenshots": [
    "本体通过主世界 SystemState 的 Commands 销毁重复目标的截图实体；实体可能附有其他组件，未把销毁扩展为未知组件删除关系。"
  ],
  "bevy_ui_render::box_shadow::extract_shadows": [
    "提取的盒阴影保存在资源表，渲染 Entity 通过 spawn_empty 建立；旧动态实体会销毁，没有显式组件目标，不把 ExtractedBoxShadow 资源表元素冒充 ECS 组件。"
  ],
  "bevy_ui_render::gradient::extract_gradients": [
    "渐变提取用 spawn_empty 建立绘制 Entity 并销毁旧动态 Entity；ExtractedGradient 保存在资源表而非实体组件，因此未伪造组件输出或删除。"
  ],
  "bevy_core_pipeline::schedule::camera_driver": [
    "本体 world.query_filtered::<Entity, With<RootNonCameraView>>() 仅按存在标记枚举辅助视图；未将该存在过滤推断为对标记字段数据的读取。"
  ]
};
