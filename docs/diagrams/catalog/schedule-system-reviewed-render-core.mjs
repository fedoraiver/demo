export const RENDER_CORE_SCHEDULE_SYSTEM_PURPOSES = {
  "bevy_render::batching::gpu_preprocessing::batch_and_prepare_binned_render_phase": {
    summary: "为分桶渲染阶段建立 GPU 预处理批次。",
    description: "先为不可批与普通批实例分配输出槽、预处理任务及可选间接绘制参数，再为多重间接绘制的分桶生成批集合和参数范围；保留 CPU 初始化任务在 GPU 解包任务之前的顺序，并为遮挡剔除预留晚期任务空间。",
  },
  "bevy_render::batching::gpu_preprocessing::batch_and_prepare_sorted_render_phase": {
    summary: "按已有绘制顺序合并 GPU 预处理阶段批次。",
    description: "逐项比较排序阶段的批集合键与网格键，连续兼容项合批，差异项结束批或批集合；按直接或间接绘制分配实例输出与参数索引，生成预处理任务并回写批范围，缺少本管线输入的项跳过且断开批次。",
  },
  "bevy_render::batching::gpu_preprocessing::clear_indirect_parameters_buffers": {
    summary: "清空各渲染阶段上一轮间接绘制参数。",
    description: "遍历 IndirectParametersBuffers 中所有阶段的缓冲集合，调用其 clear，为本帧重新生成间接绘制参数及相关记录准备可复用存储。",
  },
  "bevy_render::batching::gpu_preprocessing::clear_scene_unpacking_buffers": {
    summary: "清空新帧场景解包的两类元数据。",
    description: "清除 SceneUnpackingBuffers 中分桶解包和参数分配元数据，准备接收新帧的 GPU 场景解包任务。",
  },
  "bevy_render::batching::gpu_preprocessing::collect_buffers_for_phase": {
    summary: "把并行准备的逐阶段缓冲汇入全局表。",
    description: "以阶段类型身份把实例批缓冲和间接参数缓冲移入全局资源，将全局表中上一轮缓冲清空后换回逐阶段资源复用分配，使各阶段批处理可独立并行运行。",
  },
  "bevy_render::batching::gpu_preprocessing::delete_old_work_item_buffers": {
    summary: "释放已消失视图的 GPU 预处理任务缓冲。",
    description: "在视图提取完成后收集现存 RetainedViewEntity，对每个阶段的 work_item_buffers 仅保留仍存在视图的条目，避免删除视图的工作缓冲持续占用。",
  },
  "bevy_render::batching::gpu_preprocessing::prepare_indirect_parameters_build_jobs": {
    summary: "按视图阶段的批范围登记间接参数构建任务。",
    description: "清空旧任务与元数据，分别遍历各阶段索引及非索引批范围，生成动态参数任务，并按视图和阶段保存任务偏移及批数量，供后续计算着色器构建间接绘制参数。",
  },
  "bevy_render::batching::gpu_preprocessing::write_batched_instance_buffers": {
    summary: "上传实例输入、预处理任务并准备稀疏更新。",
    description: "通过任务池并行写入当前及前帧实例输入、各阶段输出缓冲、直接或间接工作项、遮挡剔除晚期任务和场景解包元数据；随后为当前输入缓冲登记所需稀疏 GPU 更新任务与绑定。",
  },
  "bevy_render::batching::gpu_preprocessing::write_binned_instance_buffers": {
    summary: "上传多重绘制分桶并生成 GPU 解包任务。",
    description: "仅处理多重间接批集合，以代表实体关联批集合位置和参数范围，上传网格实例、分桶元数据与扇出缓冲，登记解包及参数分配元数据并按索引类型排队任务；清理该阶段已失效视图的解包缓冲。",
  },
  "bevy_render::batching::gpu_preprocessing::write_indirect_parameters_buffers": {
    summary: "并行准备间接绘制参数和上传批集合元数据。",
    description: "为所有阶段分别处理索引与非索引路径，在任务池内为 GPU 生成的绘制参数分配缓冲，并将 CPU 元数据和批集合内容写入对应 GPU 缓冲。",
  },
  "bevy_render::batching::gpu_preprocessing::write_indirect_parameters_build_jobs": {
    summary: "上传间接参数构建任务的动态参数缓冲。",
    description: "将 IndirectParametersBuildJobs 已收集的任务动态参数写入渲染设备和队列，供构建间接绘制参数的计算阶段按偏移读取。",
  },
  "bevy_render::batching::no_gpu_preprocessing::write_batched_instance_buffer": {
    summary: "上传 CPU 已合批的实例参数缓冲。",
    description: "在不使用 GPU 预处理的批处理路径中，把 BatchedInstanceBuffer 中准备好的实例数据写入渲染设备与队列。",
  },
  "bevy_render::camera::clear_dirty_specializations": {
    summary: "清空新帧材质专用化的变化记录。",
    description: "清除 DirtySpecializations 的变化实体、移除实体及脏视图集合，为本帧重新登记需要更新的渲染管线专用化准备记录。",
  },
  "bevy_render::camera::clear_dirty_wireframe_specializations": {
    summary: "清空新帧线框专用化的变化记录。",
    description: "清除 DirtyWireframeSpecializations 中变化实体、移除实体及脏视图集合，避免上一帧线框重建标记继续参与本帧处理。",
  },
  "bevy_render::camera::expire_specializations_for_views": {
    summary: "移除已失效视图的材质专用化脏标记。",
    description: "收集当前 ExtractedView 的 RetainedViewEntity，仅在 DirtySpecializations.views 中保留仍存在的视图身份。",
  },
  "bevy_render::camera::expire_wireframe_specializations_for_views": {
    summary: "移除已失效视图的线框专用化脏标记。",
    description: "依据当前已提取视图的稳定身份，过滤 DirtyWireframeSpecializations.views 中不再存在的视图，避免线框专用化处理已删除视图。",
  },
  "bevy_render::erased_render_asset::collect_erased_render_assets_to_reextract": {
    summary: "按源材质类型排空擦除资产并请求重新提取。",
    description: "从共享 ErasedRenderAssets 中只移除 SourceAsset 类型匹配的条目，保留其他源类型资产；清空该类待准备队列，将已移出资产身份登记到重新提取资源。",
  },
  "bevy_render::erased_render_asset::extract_erased_render_asset": {
    summary: "提取变化及设备恢复后失效的擦除渲染资产。",
    description: "读取主世界资产事件并合并重新提取请求，按渲染用途移动仅供渲染世界的资产或克隆共享资产；Unused 事件清理候选并登记移除，主世界 Removed 不直接撤销渲染资产，最后应用缓存系统状态的命令。",
  },
  "bevy_render::erased_render_asset::prepare_erased_assets": {
    summary: "在上传预算内准备擦除资产并管理重试卸载。",
    description: "先重试上一帧等待资产，再卸载已不使用资产并处理本帧提取结果；更新资产先移除旧渲染版本，预算耗尽或依赖未就绪时推迟，绑定组构造错误记录日志，成功准备后计入字节预算。",
  },
  "bevy_render::globals::extract_frame_count": {
    summary: "将主世界帧计数同步到渲染世界。",
    description: "读取提取参数中的 FrameCount，并以当前值插入渲染世界资源，让渲染侧全局参数和按帧效果使用相同帧号。",
  },
  "bevy_render::globals::prepare_globals_buffer": {
    summary: "更新并上传着色器全局时间与帧号。",
    description: "将循环包装后的累计秒数、当前时间步长和 FrameCount 写入 GlobalsBuffer，再将参数上传 GPU，供共享着色器读取。",
  },
  "bevy_render::material_bind_groups::init_fallback_resources": {
    summary: "创建材质绑定的采样器及缓冲回退资源。",
    description: "分配过滤、最近邻非过滤和始终通过的比较采样器，并建立可复制、存储或参数绑定的一字节回退缓冲，分别保存为 FallbackBindlessResources 和 FallbackBuffer。",
  },
  "bevy_render::material_bind_groups::prepare_material_bind_groups": {
    summary: "重建本帧变化材质所需的 GPU 绑定组。",
    description: "遍历各材质绑定组分配器，结合管线布局、图像和采样器回退资源、已准备着色器缓冲及其变化记录，调用分配器准备或重建相应材质绑定组。",
  },
  "bevy_render::material_bind_groups::write_material_bind_group_buffers": {
    summary: "上传材质分配器管理的无绑定缓冲内容。",
    description: "遍历 MaterialBindGroupAllocators，将各分配器管理的参数和索引等缓冲写入 GPU；当前非 bindless 分配器不管理此类缓冲，因此只对 bindless 路径生效。",
  },
  "bevy_render::mesh::allocator::allocate_and_free_meshes": {
    summary: "为新增变化网格分配 GPU 存储并释放旧分配。",
    description: "先清空上帧分配块增长导致的迁移记录，再释放已移除或修改网格的旧存储，依据分配设置、顶点布局及本帧提取结果重新分配和写入网格数据。",
  },
  "bevy_render::mesh::prepare_mesh_metadata_fallback_buffer": {
    summary: "取得回退网格所在的元数据 GPU 缓冲。",
    description: "用 MeshMetadataFallbackMesh 的资产身份和元数据元素类别查找分配块，取出该块缓冲并保存 MeshMetadataFallbackBuffer；要求回退网格此前已完成分配。",
  },
  "bevy_render::render_asset::collect_render_assets_to_reextract": {
    summary: "排空渲染资产并登记设备恢复后的重新提取。",
    description: "从 RenderAssets 取走全部现存资产身份，同时清空等待准备队列；存在资产时插入 RenderAssetsToReExtract，交由后续提取过程重建渲染资源。",
  },
  "bevy_render::render_asset::extract_render_asset_bytes_per_frame": {
    summary: "同步主世界设定的每帧渲染资产上传上限。",
    description: "从 RenderAssetBytesPerFrame 提取 max_bytes，更新渲染世界 RenderAssetBytesPerFrameLimiter 的预算上限，供资产准备阶段限流。",
  },
  "bevy_render::render_asset::reset_render_asset_bytes_per_frame": {
    summary: "重置新帧渲染资产上传的已用预算。",
    description: "调用 RenderAssetBytesPerFrameLimiter.reset，清除本轮上传计量，使新的渲染帧可按配置上限继续准备资产。",
  },
  "bevy_render::render_phase::sort_phase_system": {
    summary: "按各视图重新计算并排序阶段绘制项。",
    description: "对当前已提取视图找到相应 SortedRenderPhase，先按视图重算排序键再执行该阶段类型的排序；缺少阶段的视图跳过。",
  },
  "bevy_render::render_resource::pipeline_cache::PipelineCache::process_pipeline_queue_system": {
    summary: "推进排队中的渲染、计算和网格管线创建。",
    description: "将新管线加入缓存并处理等待状态：启动创建、检查异步结果或在着色器尚未加载时重试；成功结果转为可用缓存，不可恢复的着色器处理或模块创建错误记录日志并停止重试。",
  },
  "bevy_render::render_resource::sparse_buffer_vec::clear_sparse_buffer_jobs": {
    summary: "清空新帧的稀疏缓冲更新任务。",
    description: "清除 SparseBufferUpdateJobs 中上一轮更新任务，供后续准备阶段重新登记本帧需要局部写入的 GPU 缓冲范围。",
  },
  "bevy_render::render_resource::sparse_buffer_vec::init_sparse_buffer_update_bind_groups": {
    summary: "准备稀疏更新管线标识与弱键绑定缓存。",
    description: "存在稀疏更新着色器时专用化对应计算管线，并插入空的弱键绑定组表及可选管线标识；平台停用此功能时保留空管线状态。",
  },
  "bevy_render::render_resource::sparse_buffer_vec::init_sparse_buffer_update_pipelines": {
    summary: "按设备存储绑定能力建立稀疏更新计算资源。",
    description: "设备每阶段至少支持三个存储缓冲时，创建目标、源、索引及元数据参数布局并加载更新着色器；能力不足则记录信息并插入无布局、无着色器的停用资源。",
  },
  "bevy_render::render_resource::sparse_buffer_vec::update_sparse_buffers": {
    summary: "用计算通道把变化元素写入稀疏 GPU 缓冲。",
    description: "渲染图开始阶段在任务及计算管线就绪后创建通道，逐任务寻找对应绑定组并按其元素数量派发工作组，执行按索引的局部缓冲更新；无任务、无管线或无对应绑定时跳过。",
  },
  "bevy_render::storage::clear_changed_shader_buffers": {
    summary: "清空新帧着色器缓冲的变化记录。",
    description: "清除 RenderChangedShaderBuffers，为本帧重新提取和准备着色器存储缓冲变化做准备，防止重复触发旧变化对应的材质绑定更新。",
  },
  "bevy_render::texture::texture_cache::update_texture_cache_system": {
    summary: "淘汰纹理缓存中长期未使用的纹理。",
    description: "推进各纹理的未使用帧数并复位本帧占用标记，删除未使用计数达到三的纹理及空描述项，让近期纹理可在新帧继续复用。",
  },
  "bevy_render::uniform::prepare_uniform_components": {
    summary: "将组件值批量上传为动态着色器参数。",
    description: "为查询到的组件数量取得动态参数写入器，逐实体写入组件值并记录对应偏移，再批量附加 DynamicUniformIndex；没有可用写入器时返回。",
  },
  "bevy_render::view::cleanup_view_targets_for_resize": {
    summary: "在窗口尺寸或呈现模式变化时撤销旧视图目标。",
    description: "查找输出到窗口的已提取相机，若对应窗口本帧尺寸或 present mode 变化，则移除 ViewTarget，让后续准备阶段按新窗口状态重新建立目标。",
  },
  "bevy_render::view::clear_view_attachments": {
    summary: "清空上一帧的视图输出附件表。",
    description: "清除 ViewTargetAttachments 中缓存的 OutputColorAttachment 映射，供本帧重新取得窗口、图像或手动纹理视图。",
  },
  "bevy_render::view::composition::resolve_composition_spaces": {
    summary: "协调共享纹理相机的合成色彩空间。",
    description: "按主纹理及相机顺序汇总空间请求并写回 ResolvedCompositingSpace；全部请求线性时直接归一化，冲突堆栈、非二维相机或 Oklab 缺少有符号存储时回退并警告，共享目标空间不一致时提示混合问题。",
  },
  "bevy_render::view::prepare_view_attachments": {
    summary: "按相机输出目标准备可共享的颜色附件。",
    description: "跳过无目标或输出模式为 Skip 的相机，对每个尚未登记的标准化目标取得窗口、GPU 图像或手动纹理视图及格式，构造 OutputColorAttachment 并按目标保存；输入未就绪时跳过。",
  },
  "bevy_render::view::prepare_view_targets": {
    summary: "为视图维护主颜色双缓冲及可选多采样目标。",
    description: "按相机目标、格式、用途及 MSAA 复用主颜色 A/B 纹理，将清除色转换到实际合成空间并关联输出附件；共享主纹理跨帧复用原子切换状态，无有效尺寸或无需输出的清除相机移除 ViewTarget。",
  },
  "bevy_render::view::prepare_view_uniforms": {
    summary: "生成视图投影、抖动、裁剪及 LOD 的 GPU 参数。",
    description: "为各视图计算带抖动与无抖动矩阵、逆矩阵、视锥平面、主通道分辨率、曝光和颜色分级，并写入帧号及 mip 偏置；依据相机或阴影视图来源选择 LOD 参考位置，上传后附加逐视图参数偏移。",
  },
  "bevy_render::view::visibility::collect_visible_cpu_culled_entities": {
    summary: "汇总相机与阴影子视图的 CPU 剔除可见实体。",
    description: "按可见性类别合并现有和提取表类别，为新帧准备结果，将提取实体按主世界身份排序后更新普通视图及各阴影子视图的可见实体表；这里只处理 CPU 剔除路径，GPU 剔除由其他系统补充。",
  },
  "bevy_render::view::visibility::range::extract_visibility_ranges": {
    summary: "在可见距离变化后重建渲染侧范围表。",
    description: "检测主世界 VisibilityRange 的变化或移除事件，有变化时清空渲染表并重新收集全部实体范围，再按脏状态重建 GPU 参数内容；没有变化时保持原表。",
  },
  "bevy_render::view::visibility::range::write_render_visibility_ranges": {
    summary: "按设备绑定要求上传可见距离范围表。",
    description: "仅在范围缓冲为脏时写入，参数缓冲路径将元素数补齐或截断为固定上限，存储缓冲路径确保至少一个占位元素以便分配，上传后清除脏标记。",
  },
  "bevy_render::view::window::screenshot::init_screenshot_to_screen_pipeline": {
    summary: "建立把截图纹理复制到屏幕的管线资源。",
    description: "创建片元阶段读取非过滤浮点二维纹理的布局，加载截图着色器 screenshot.wesl，并保存 ScreenshotToScreenPipeline 供截图输出回屏幕时使用。",
  },
};
