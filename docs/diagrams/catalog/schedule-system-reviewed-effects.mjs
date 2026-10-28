export const EFFECTS_SCHEDULE_SYSTEM_PURPOSES = {
  "bevy_anti_alias::contrast_adaptive_sharpening::init_cas_pipeline": {
    summary: "建立 CAS 锐化的纹理、参数布局和管线变体资源。",
    description: "创建颜色纹理、过滤采样器及 CasUniform 的绑定布局，加载锐化着色器并结合全屏顶点着色器构造 CasPipeline，通过命令插入渲染资源。",
  },
  "bevy_anti_alias::contrast_adaptive_sharpening::prepare_cas_pipelines": {
    summary: "按去噪与目标格式准备视图锐化管线。",
    description: "移除已失去 CasUniform 的视图管线，对新增锐化参数或去噪设置变化的视图专用化 CAS 管线并写入 ViewCasPipeline；专用化失败时返回错误。",
  },
  "bevy_anti_alias::fxaa::init_fxaa_pipeline": {
    summary: "建立 FXAA 的纹理采样布局和着色器资源。",
    description: "创建颜色纹理与过滤采样器绑定布局、线性采样器，加载 FXAA 片元着色器并与全屏顶点着色器组成 FxaaPipeline 资源。",
  },
  "bevy_anti_alias::fxaa::prepare_fxaa_pipelines": {
    summary: "按相机边缘阈值与目标格式准备 FXAA 管线。",
    description: "遍历已提取相机，跳过停用 FXAA 的视图，按两个边缘灵敏度阈值和目标格式专用化管线，并为相机保存 CameraFxaaPipeline。",
  },
  "bevy_anti_alias::smaa::init_smaa_pipelines": {
    summary: "建立 SMAA 三个阶段的布局和着色器资源。",
    description: "加载 SMAA 着色器，构建共享颜色与参数布局，以及边缘检测、混合权重计算和邻域混合各自的纹理采样布局，插入三阶段管线资源。",
  },
  "bevy_anti_alias::smaa::prepare_smaa_bind_groups": {
    summary: "为视图绑定 SMAA 中间纹理与查找表。",
    description: "在面积及搜索 LUT 的 GPU 图像均就绪后，为启用 SMAA 的视图创建采样器及三个阶段的绑定组；LUT 尚未加载时整轮返回。",
  },
  "bevy_anti_alias::smaa::prepare_smaa_pipelines": {
    summary: "按质量预设准备视图的三条 SMAA 管线。",
    description: "对启用 SMAA 的相机分别专用化边缘检测、混合权重和邻域混合管线，最后一阶段同时考虑目标格式，将三个缓存标识写入 ViewSmaaPipelines。",
  },
  "bevy_anti_alias::smaa::prepare_smaa_textures": {
    summary: "为 SMAA 分配边缘、模板和混合权重纹理。",
    description: "根据相机物理目标尺寸，从纹理缓存取得 RG 边缘纹理、8 位模板和 RGBA 混合纹理并附到视图；没有目标尺寸的相机跳过。",
  },
  "bevy_anti_alias::smaa::prepare_smaa_uniforms": {
    summary: "上传各 SMAA 视图的尺寸及倒数参数。",
    description: "清空本轮 SMAA 参数集合，写入各视图宽高及倒数，保存每个视图的动态参数偏移，再把统一参数缓冲上传 GPU。",
  },
  "bevy_anti_alias::taa::extract_taa_settings": {
    summary: "提取有效相机的 TAA 设置并消费历史重置信号。",
    description: "把活动相机的 TemporalAntiAliasing 复制到渲染实体，同时清除主世界 reset 标志；没有设置或已停用的相机移除 TAA 设置、历史纹理和管线组件。",
  },
  "bevy_anti_alias::taa::init_taa_pipeline": {
    summary: "建立 TAA 的当前帧、历史帧和预通道输入布局。",
    description: "创建最近邻及线性采样器，定义颜色、历史、运动矢量和深度绑定，加载 TAA 着色器并构造全屏管线变体资源。",
  },
  "bevy_anti_alias::taa::prepare_taa_history_textures": {
    summary: "按帧奇偶为 TAA 轮换读写历史纹理。",
    description: "根据视图目标尺寸和格式取得两张历史颜色纹理，按 FrameCount 奇偶交换 read 与 write，附到启用 TAA 的相机；无物理目标尺寸时跳过。",
  },
  "bevy_anti_alias::taa::prepare_taa_jitter": {
    summary: "为 TAA 相机逐帧设置 Halton 投影抖动。",
    description: "按帧数循环选择八个 Halton 偏移，更新同时具备 TAA、三维相机、深度及运动矢量预通道的 TemporalJitter。",
  },
  "bevy_anti_alias::taa::prepare_taa_pipelines": {
    summary: "准备 TAA 当前状态及下一帧恢复用管线。",
    description: "按目标格式、HDR 状态和历史重置标志专用化 TAA 管线并保存标识；重置帧还预先准备非重置变体，专用化错误向调用方返回。",
  },
  "bevy_anti_alias::taa::temporal_anti_alias": {
    summary: "混合当前颜色与历史帧并更新 TAA 历史目标。",
    description: "在 MSAA 关闭且管线、深度和运动矢量均可用时，绑定当前颜色和历史纹理执行全屏时域抗锯齿，同时写入后处理颜色及下一历史纹理；条件不满足时跳过。",
  },
  "bevy_core_pipeline::blit::init_blit_pipeline": {
    summary: "建立全屏颜色复制与缩放的 Blit 资源。",
    description: "创建非过滤纹理与采样器布局，加载 Blit 片元着色器并保留全屏顶点着色器，通过命令插入 BlitPipeline。",
  },
  "bevy_core_pipeline::core_2d::extract_core_2d_camera_phases": {
    summary: "为活动二维相机准备渲染阶段并清理失效视图。",
    description: "读取主世界活动 Camera2d，为其主子视图准备透明、不透明及 AlphaMask 二维阶段，移除本轮未出现相机的旧阶段。",
  },
  "bevy_core_pipeline::core_2d::main_opaque_pass_2d_node::main_opaque_pass_2d": {
    summary: "绘制二维不透明和 AlphaMask 阶段。",
    description: "取得视图颜色与深度附件后创建二维主通道，应用相机视口，依次渲染不透明及 AlphaMask 项；阶段缺失时返回，绘制错误记录日志。",
  },
  "bevy_core_pipeline::core_2d::main_transparent_pass_2d_node::main_transparent_pass_2d": {
    summary: "使用已有深度绘制二维透明阶段。",
    description: "透明阶段存在且非空时创建主透明通道，沿用深度附件与相机视口绘制排序后的透明项；WebGL 自定义视口后追加空通道复位视口状态。",
  },
  "bevy_core_pipeline::core_2d::prepare_core_2d_depth_textures": {
    summary: "为有效二维视图准备共享目标深度纹理。",
    description: "在二维主阶段和物理目标尺寸有效时，按渲染目标复用深度纹理，使用相机 MSAA 采样数和二维深度格式，为视图插入深度附件。",
  },
  "bevy_core_pipeline::core_3d::configure_occlusion_culling_view_targets": {
    summary: "让遮挡剔除相机的深度纹理可被采样。",
    description: "对启用遮挡剔除、深度预通道且允许间接绘制的三维相机，给深度纹理用途加入 TEXTURE_BINDING，供后续深度金字塔读取。",
  },
  "bevy_core_pipeline::core_3d::extract_camera_prepass_phase": {
    summary: "同步三维相机的预通道标记与渲染阶段。",
    description: "为活动 Camera3d 按深度、法线、运动矢量及延迟预通道配置创建或移除对应阶段，同步双缓冲标记并根据间接绘制能力选择 GPU 预处理模式，清理本轮失效视图。",
  },
  "bevy_core_pipeline::core_3d::extract_core_3d_camera_phases": {
    summary: "为活动三维相机准备主渲染阶段。",
    description: "为每个活动 Camera3d 建立不透明、AlphaMask 和透明三维阶段，按平台支持及间接绘制开关设置 GPU 预处理模式，并移除失效视图的阶段。",
  },
  "bevy_core_pipeline::core_3d::main_opaque_pass_3d_node::main_opaque_pass_3d": {
    summary: "绘制三维不透明、AlphaMask 与天空盒。",
    description: "使用视图颜色和深度附件及相机视口渲染不透明和 AlphaMask 阶段，天空盒管线与绑定可用时追加全屏天空盒；阶段缺失时跳过，阶段绘制错误记录日志。",
  },
  "bevy_core_pipeline::core_3d::main_transparent_pass_3d_node::main_transparent_pass_3d": {
    summary: "绘制三维透明物体并保护 OIT 链表状态。",
    description: "透明阶段非空时沿用视图颜色、深度及视口绘制排序项；启用顺序无关透明时须等待其解析管线就绪，避免提前写入未能清理的链表计数器。WebGL 自定义视口后复位视口状态。",
  },
  "bevy_core_pipeline::core_3d::prepare_core_3d_depth_textures": {
    summary: "按共享目标准备三维深度纹理与清除方式。",
    description: "合并同一相机目标所需的深度纹理用途，深度预通道额外要求 COPY_SRC；按目标及 MSAA 采样数复用纹理，并为各视图保存相机指定的深度清除或加载方式。",
  },
  "bevy_core_pipeline::core_3d::prepare_prepass_textures": {
    summary: "按三维预通道配置分配各类输出纹理。",
    description: "依据视图标记取得深度、法线、运动矢量、延迟 G-buffer 与光照通道标识纹理，按目标复用并按帧轮换双缓冲；运动矢量存储绑定受设备能力及单采样限制，无预通道阶段时移除旧纹理。",
  },
  "bevy_core_pipeline::deferred::copy_lighting_id::copy_deferred_lighting_id": {
    summary: "把延迟光照通道标识复制到深度目标。",
    description: "在复制管线和光照标识预通道纹理可用时，绑定标识纹理并执行全屏绘制，将标识写入清零后的 DeferredLightingIdDepthTexture，供后续延迟光照使用。",
  },
  "bevy_core_pipeline::deferred::copy_lighting_id::init_copy_deferred_lighting_id_pipeline": {
    summary: "建立延迟光照标识到深度的复制管线。",
    description: "创建无符号整数纹理布局，加载复制着色器并配置始终通过、允许深度写入的全屏管线，将布局和缓存管线标识保存为资源。",
  },
  "bevy_core_pipeline::deferred::copy_lighting_id::prepare_deferred_lighting_id_textures": {
    summary: "为延迟预通道相机分配光照标识深度纹理。",
    description: "按启用 DeferredPrepass 的相机物理目标尺寸从纹理缓存取得单采样标识深度纹理，设置渲染附件与复制来源用途并附到视图；无目标尺寸时跳过。",
  },
  "bevy_core_pipeline::deferred::node::early_deferred_prepass": {
    summary: "执行早期延迟预通道并保存深度结果。",
    description: "渲染三维不透明及 AlphaMask 延迟阶段，按已启用附件输出法线、运动矢量、G-buffer 和光照通道标识，再将视图深度复制到预通道深度纹理；缺少阶段时跳过。",
  },
  "bevy_core_pipeline::deferred::node::late_deferred_prepass": {
    summary: "为遮挡剔除执行晚期延迟预通道。",
    description: "仅在启用遮挡剔除且允许间接绘制时运行延迟阶段，写入已有预通道附件并同步深度纹理，补绘晚期可见物体；未满足条件时直接返回。",
  },
  "bevy_core_pipeline::mip_generation::experimental::depth::create_downsample_depth_pipelines": {
    summary: "在支持 GPU 剔除时一次性建立深度降采样管线。",
    description: "只尝试初始化一次，为普通及多采样深度创建共享布局、采样器和首轮／第二轮计算管线变体；平台不支持 GPU 剔除时记录原因并保留未创建状态。",
  },
  "bevy_core_pipeline::mip_generation::experimental::depth::early_downsample_depth": {
    summary: "生成供本帧晚期遮挡测试使用的深度金字塔。",
    description: "早期预通道后对主视图深度及启用遮挡剔除的阴影视图运行最小值降采样，生成层级 Z 缓冲供晚期网格包围盒测试；降采样管线资源不可用时跳过。",
  },
  "bevy_core_pipeline::mip_generation::experimental::depth::init_depth_pyramid_dummy_texture": {
    summary: "创建深度金字塔的占位纹理资源。",
    description: "通过渲染设备创建深度金字塔辅助占位纹理及纹理视图，封装为 DepthPyramidDummyTexture，供深度金字塔资源构造时使用。",
  },
  "bevy_core_pipeline::mip_generation::experimental::depth::late_downsample_depth": {
    summary: "更新供下一帧早期遮挡测试使用的深度金字塔。",
    description: "主渲染阶段结束后，对主视图和启用遮挡剔除的阴影视图深度执行最小值降采样，为下一帧早期网格预处理提供层级 Z 缓冲；管线资源缺失时跳过。",
  },
  "bevy_core_pipeline::mip_generation::experimental::depth::prepare_downsample_depth_view_bind_groups": {
    summary: "将主视图或阴影深度绑定到降采样管线。",
    description: "为带深度金字塔的视图选择主深度附件或遮挡剔除阴影深度，按是否多采样选布局并生成 ViewDownsampleDepthBindGroup；深度附件没有深度面或输入缺失时跳过。",
  },
  "bevy_core_pipeline::mip_generation::experimental::depth::prepare_view_depth_pyramids": {
    summary: "为遮挡剔除视图维护深度金字塔。",
    description: "为启用遮挡剔除且允许间接绘制的视图按视口尺寸创建深度金字塔；关闭遮挡剔除后移除旧金字塔及降采样绑定组。",
  },
  "bevy_core_pipeline::mip_generation::prepare_mip_generator_pipelines": {
    summary: "为本帧 mip 生成任务准备并复用 GPU 资源。",
    description: "遍历已登记图像任务，为首次出现的已上传图像创建两阶段降采样绑定组、常量缓冲和专用化管线，按设备选择布局组合方式；格式不支持时记录错误，并清除本帧未使用任务的缓存。",
  },
  "bevy_core_pipeline::mip_generation::reset_mip_generation_jobs": {
    summary: "清空上一帧登记的 mip 生成任务。",
    description: "清除 MipGenerationJobs 中的全部任务，为新帧重新登记待生成 mip 的图像做准备。",
  },
  "bevy_core_pipeline::oit::configure_camera_depth_usages": {
    summary: "允许 OIT 相机采样自己的深度纹理。",
    description: "对 Camera3d 发生变化且带顺序无关透明设置的相机，将深度纹理用途加入 TEXTURE_BINDING，使 OIT 着色器能够读取深度。",
  },
  "bevy_core_pipeline::oit::init_oit_buffers": {
    summary: "创建可立即绑定的 OIT 初始缓冲。",
    description: "分配最小节点、像素链表头及原子计数器缓冲，上传容量参数并建立动态设置缓冲，插入 OitBuffers 资源以保证后续绑定具有有效初始存储。",
  },
  "bevy_core_pipeline::oit::prepare_oit_buffers": {
    summary: "调整共享 OIT 存储并上传逐相机设置。",
    description: "依据查询到的相机目标尺寸和平均每像素片元数调整链表头与节点缓冲，上传节点容量及各相机设置并保存动态偏移；没有 OIT 相机时释放为最小缓冲。",
  },
  "bevy_core_pipeline::oit::resolve::prepare_oit_resolve_bind_group": {
    summary: "为 OIT 解析阶段绑定视图和片元链表。",
    description: "在视图参数、节点、链表头及原子计数器均已有 GPU 绑定时创建解析绑定组并保存资源，输入尚未分配时不创建绑定。",
  },
  "bevy_core_pipeline::oit::resolve::queue_oit_resolve_pipeline": {
    summary: "按 OIT 相机设置缓存透明解析管线。",
    description: "以目标格式、最大排序片元数及深度预通道开关生成专用化键，复用未变视图的缓存管线，否则排队新管线并附到相机；清理已消失视图的本地缓存。",
  },
  "bevy_core_pipeline::prepass::background_motion_vectors::init_background_motion_vectors_pipeline": {
    summary: "建立背景运动矢量的全屏管线资源。",
    description: "创建当前视图与前一帧视图参数的动态绑定布局，加载背景运动矢量着色器并保存全屏顶点着色器，插入 BackgroundMotionVectorsPipeline。",
  },
  "bevy_core_pipeline::prepass::background_motion_vectors::prepare_background_motion_vectors_bind_groups": {
    summary: "为背景运动矢量绑定前后两帧视图参数。",
    description: "对启用运动矢量预通道且未禁止背景矢量的视图，在当前和前帧参数缓冲可用后生成绑定组，并附到各视图供背景运动绘制读取。",
  },
  "bevy_core_pipeline::prepass::background_motion_vectors::prepare_background_motion_vectors_pipelines": {
    summary: "按采样数和法线预通道准备背景运动管线。",
    description: "对允许背景运动矢量的预通道视图，依据 MSAA 采样数及法线预通道开关专用化 BackgroundMotionVectorsPipeline，并保存逐视图缓存标识。",
  },
  "bevy_core_pipeline::schedule::handle_uncovered_swap_chains": {
    summary: "清除本帧没有相机覆盖的窗口交换链。",
    description: "消费 CameraWindows 记录，找出没有相机输出但存在交换链纹理的窗口，用全局 ClearColor 创建清除通道并直接提交 GPU 队列，避免窗口保留旧画面。",
  },
  "bevy_core_pipeline::schedule::submit_pending_command_buffers": {
    summary: "将排队完成的渲染命令缓冲提交到 GPU。",
    description: "从 PendingCommandBuffers 取出已完成命令缓冲，仅在迭代器非空时提交 RenderQueue；启用追踪时记录本次提交的缓冲数量。",
  },
  "bevy_core_pipeline::skybox::init_skybox_pipeline": {
    summary: "加载天空盒着色器并建立管线资源。",
    description: "加载嵌入的 skybox.wesl，以该着色器构造 SkyboxPipeline，并通过命令插入渲染世界。",
  },
  "bevy_core_pipeline::skybox::prepare_skybox_bind_groups": {
    summary: "为有效天空盒图像建立视图绑定组。",
    description: "在天空盒图像、视图参数及天空盒参数均就绪且图像校验通过时，绑定图像、采样器和参数并保存动态偏移；任一条件不满足则移除旧绑定组。",
  },
  "bevy_core_pipeline::skybox::prepare_skybox_pipelines": {
    summary: "按目标格式与采样数准备天空盒管线。",
    description: "为带 Skybox 的渲染相机，以颜色目标格式、MSAA 采样数及三维深度格式专用化天空盒管线，将缓存标识附到相机。",
  },
  "bevy_core_pipeline::tonemapping::check_tonemapping_none": {
    summary: "警告关闭色调映射后仍配置无效效果的相机。",
    description: "检查相关设置发生变化的相机，若 Tonemapping 为 None 却开启去色带抖动或采用非默认颜色分级，则记录这些设置不会生效的警告。",
  },
  "bevy_core_pipeline::tonemapping::init_tonemapping_pipeline": {
    summary: "建立色调映射的颜色、视图与 LUT 输入布局。",
    description: "创建视图参数、非过滤 HDR 颜色及 LUT 的绑定布局和采样器，加载色调映射片元着色器，与全屏顶点着色器共同组成 TonemappingPipeline。",
  },
  "bevy_core_pipeline::tonemapping::prepare_view_tonemapping_pipelines": {
    summary: "按视图实际颜色分级需求专用化色调映射。",
    description: "依据色相、白平衡和分区颜色分级是否非默认设置裁剪着色器分支，并结合目标格式、色调映射模式及去色带抖动生成视图管线标识。",
  },
  "bevy_core_pipeline::upscaling::prepare_view_upscaling_pipelines": {
    summary: "按相机合成方式准备输出缩放管线。",
    description: "根据输出格式、合成色彩空间和相机混合设置构造 Blit 管线键；未显式配置混合时首个相机替换、后续相机采用 Alpha 混合，键变化后等待新管线可用并更新视图组件。",
  },
  "bevy_gizmos_render::extract_gizmo_data": {
    summary: "把启用的即时 Gizmo 数据提取为渲染实体。",
    description: "按配置组取得有效 Gizmo 网格句柄，复制线宽、深度偏移、接头和虚线参数，生成临时渲染实体及网格配置；未启用或无句柄的组跳过，并对非正虚线比例发出一次警告。",
  },
  "bevy_gizmos_render::init_line_gizmo_uniform_bind_group_layout": {
    summary: "建立 Gizmo 线条动态参数的 GPU 布局。",
    description: "创建顶点与片元阶段共同使用的 LineGizmoUniform 动态参数绑定布局，将其保存为 LineGizmoUniformBindgroupLayout 资源。",
  },
  "bevy_gizmos_render::pipeline_2d::init_line_gizmo_pipelines": {
    summary: "建立二维 Gizmo 线段和接头管线。",
    description: "复用 Mesh2dPipeline 与 Gizmo 参数布局，分别加载线段和接头着色器，插入二维 LineGizmoPipeline 及 LineJointGizmoPipeline 资源。",
  },
  "bevy_gizmos_render::pipeline_2d::queue_line_and_joint_gizmos_2d": {
    summary: "将二维 Gizmo 线段与接头加入透明阶段。",
    description: "按视图采样数、目标格式、渲染层及线条样式选择管线，把有效线段列表、线条带和接头加入二维透明阶段；无 GPU 网格、层不相交或顶点不足的部分跳过。",
  },
  "bevy_gizmos_render::pipeline_3d::init_line_gizmo_pipelines": {
    summary: "建立三维 Gizmo 线条深度管线和接头资源。",
    description: "加载三维线段及接头着色器，复用网格管线与参数布局，创建使用三维深度格式、反向深度比较的线条变体资源，并建立接头管线。",
  },
  "bevy_gizmos_render::pipeline_3d::queue_line_gizmos_3d": {
    summary: "将三维 Gizmo 线列表和线条带加入透明阶段。",
    description: "对具备视图键的三维阶段，按渲染层、透视线宽与样式专用化管线，将已有 GPU 顶点的线列表和线条带作为置顶项加入透明阶段；管线专用化错误向调用方返回。",
  },
  "bevy_gizmos_render::pipeline_3d::queue_line_joint_gizmos_3d": {
    summary: "将三维 Gizmo 折线接头加入透明阶段。",
    description: "在视图及 Gizmo 渲染层相交、折线至少三个顶点且启用接头时，按视图键、透视线宽和接头形状选择管线，并把接头绘制作为置顶透明项排队。",
  },
  "bevy_gizmos_render::prepare_line_gizmo_bind_group": {
    summary: "为 Gizmo 绘制绑定已上传的线条参数。",
    description: "LineGizmoUniform 缓冲存在 GPU 绑定时，以共享布局创建 LineGizmoUniformBindgroup 资源；参数尚未上传时直接返回。",
  },
  "bevy_gizmos_render::transform_gizmo_render::spawn_gizmo_meshes": {
    summary: "创建变换操作器各轴网格、材质和覆盖相机。",
    description: "预先建立箭杆、箭头、旋转环和缩放方块，为三轴及视图轴创建独立无光照材质，将三种模式网格挂到隐藏根节点，并生成仅绘制 Gizmo 层的后置三维相机及颜色资源。",
  },
  "bevy_gizmos_render::transform_gizmo_render::update_gizmo_meshes": {
    summary: "将变换操作器对齐焦点并更新模式与高亮。",
    description: "按焦点位置、操作空间和相机距离设置根变换，同步覆盖相机位姿及视口；只显示当前模式的手柄，按悬停或拖动轴更新材质颜色，缺少焦点或可用相机时隐藏根节点。",
  },
  "bevy_gizmos::aabb::draw_all_aabbs": {
    summary: "绘制未单独标记实体的可见 AABB 调试线框。",
    description: "遍历没有 ShowAabbGizmo 的包围盒实体，按视图可见性跳过不可见对象，使用组默认色或由实体生成的颜色，将局部 AABB 经全局变换绘制为三维线框。",
  },
  "bevy_gizmos::frustum::draw_all_frustum_gizmos": {
    summary: "绘制未单独标记实体的视锥调试图形。",
    description: "对没有 ShowFrustumGizmo 的 Frustum，使用配置组默认颜色或按实体分配的颜色，调用共享视锥绘制逻辑输出 Gizmo 线条。",
  },
  "bevy_gizmos::frustum::draw_frustum_gizmos": {
    summary: "绘制带标记实体的视锥调试图形。",
    description: "遍历 ShowFrustumGizmo 与 Frustum，优先使用实体指定颜色，其次组默认色，最后按实体分配颜色，调用共享逻辑绘制视锥。",
  },
  "bevy_gizmos::skinned_mesh_bounds::draw_all_skinned_mesh_bounds": {
    summary: "绘制未单独标记的动态蒙皮网格包围区域。",
    description: "对带 DynamicSkinnedMeshBounds 且未配置独立显示标记的网格，读取骨骼全局变换、网格及逆绑定姿势，调用共享绘制逻辑按组默认色显示蒙皮包围区域。",
  },
  "bevy_gizmos::skinned_mesh_bounds::draw_skinned_mesh_bounds": {
    summary: "绘制带独立显示标记的动态蒙皮包围区域。",
    description: "为带 ShowSkinnedMeshBoundsGizmo 的动态蒙皮网格读取骨骼变换和逆绑定姿势，优先采用实体颜色覆盖组颜色，通过共享逻辑绘制对应包围区域。",
  },
  "bevy_gizmos::update_gizmo_meshes": {
    summary: "把配置组即时线条缓冲转交 Gizmo 资产。",
    description: "将线列表及线条带的位置、颜色从 GizmoStorage 移入已有或新建 GizmoAsset，更新配置组句柄并清空已移走的缓冲；没有线条时将该组句柄设为空。",
  },
  "bevy_light::atmosphere::extract_chromatic_phase_textures": {
    summary: "将已加载色度相函数纹理转换为散射曲线。",
    description: "监听图像依赖加载完成事件，对被散射介质引用的非空 Rgba32Float 图像读取一维线性色彩样本，在 [-1,1] 上构造曲线并替换相关项的 ChromaticTexture；格式或样本无效时跳过。",
  },
  "bevy_light::cascade::build_directional_light_cascades": {
    summary: "为投射阴影的方向光构建逐相机级联。",
    description: "收集活动相机的投影和位姿，依据级联边界、重叠比例及阴影贴图尺寸计算每层投影；光空间仅采用灯光旋转以维持数值稳定，将结果按相机写入 Cascades。",
  },
  "bevy_light::check_dir_light_mesh_visibility": {
    summary: "计算方向光各相机级联可见的投影网格。",
    description: "按继承可见性、渲染层、可见距离及级联视锥筛选允许投射阴影的 Mesh3d，忽略近裁面以保留相机前方阴影投射物，合并排序并行结果并延迟标记视图可见；不处理 NoCpuCulling 实体。",
  },
  "bevy_light::check_point_light_mesh_visibility": {
    summary: "计算点光与聚光灯阴影可见的网格。",
    description: "对可见灯光去重，按继承可见性、渲染层、阴影 LOD 距离及光照范围筛选投影网格，再按点光六面视锥或聚光视锥收集排序结果并标记视图可见；不处理 NoCpuCulling 实体。",
  },
  "bevy_light::cluster::assign::assign_objects_to_clusters": {
    summary: "将灯光、探针及贴花分配到视图分簇。",
    description: "依据视图投影、屏幕尺寸和分簇配置建立簇尺寸及深度切片；CPU 模式按可见性、渲染层与包围区域分配点光、聚光、矩形光、探针和贴花，受平台存储能力及数量上限约束，并保存下一帧自适应统计。",
  },
  "bevy_light::directional_light::update_directional_light_frusta": {
    summary: "从方向光级联投影更新阴影视锥。",
    description: "对可见且启用阴影贴图的 DirectionalLight，将各相机每层级联的 clip_from_world 转换为视锥，整体替换 CascadesFrusta，供阴影网格剔除使用。",
  },
  "bevy_light::directional_light::validate_shadow_map_size": {
    summary: "将方向光阴影贴图尺寸纠正为二的幂。",
    description: "DirectionalLightShadowMap 变化且尺寸不是二的幂时，将其增至下一个二的幂并记录警告。",
  },
  "bevy_light::gizmos::draw_all_lights": {
    summary: "按配置颜色模式绘制全部灯光调试图形。",
    description: "为没有 ShowLightGizmo 的点光、聚光、方向光和矩形光调用各自绘制逻辑，颜色可统一指定、按实体区分、跟随灯光或按灯光类别选择。",
  },
  "bevy_light::point_light::update_point_light_bounding_spheres": {
    summary: "按点光位置和范围更新剔除包围球。",
    description: "点光设置或全局变换变化时，将光源世界坐标及 PointLight.range 写入 Sphere 组件，供视锥可见性判断使用。",
  },
  "bevy_light::point_light::update_point_light_frusta": {
    summary: "更新可见点光的六面阴影视锥。",
    description: "在变换、点光设置或可见性变化后，为启用阴影且可见的点光生成六个九十度投影视锥，采用光源位置、近裁距离和范围，忽略缩放与旋转以保持立方体轴向投影。",
  },
  "bevy_light::spot_light::update_spot_light_bounding_spheres": {
    summary: "按聚光灯位置和范围更新剔除包围球。",
    description: "聚光设置或全局变换变化时，将光源世界位置与 SpotLight.range 写入 Sphere 组件，为后续视锥剔除提供包围范围。",
  },
  "bevy_light::spot_light::update_spot_light_frusta": {
    summary: "更新可见聚光灯的阴影视锥。",
    description: "在变换、聚光设置或可见性变化后，对启用阴影且可见的聚光灯，按世界位姿、外角、阴影近裁距离及范围重新计算视锥；忽略缩放避免改变光照范围。",
  },
  "bevy_post_process::bloom::downsampling_pipeline::init_bloom_downsampling_pipeline": {
    summary: "建立 Bloom 降采样的纹理与参数管线。",
    description: "定义输入纹理、过滤采样器及动态 BloomUniforms 的布局，创建边缘夹取线性采样器，加载 Bloom 着色器并保存全屏顶点着色器形成降采样资源。",
  },
  "bevy_post_process::bloom::downsampling_pipeline::prepare_downsampling_pipeline": {
    summary: "按预过滤和缩放设置准备 Bloom 降采样变体。",
    description: "为每个 Bloom 视图依据阈值是否启用预过滤、缩放是否统一，分别准备首次和后续降采样管线，将两个缓存标识附到视图。",
  },
  "bevy_post_process::bloom::prepare_bloom_bind_groups": {
    summary: "为 Bloom 各 mip 层准备降采样与升采样绑定。",
    description: "以 Bloom 纹理和参数缓冲身份检查已有缓存，输入未变时复用；否则为逐级降采样和反向升采样创建各层纹理、采样器及参数绑定组并保存到视图。",
  },
  "bevy_post_process::bloom::prepare_bloom_textures": {
    summary: "按视口比例分配 Bloom 多级纹理。",
    description: "根据物理视口和最大 mip 尺寸计算保持纵横比的非零目标尺寸及 mip 数，创建可采样渲染纹理；普通后端用单张多级纹理，WebGL 后端分别分配各层纹理。",
  },
  "bevy_post_process::bloom::upsampling_pipeline::init_bloom_upscaling_pipeline": {
    summary: "建立 Bloom 升采样的纹理和参数布局。",
    description: "创建输入纹理、过滤采样器及动态 BloomUniforms 布局，加载 Bloom 片元着色器并保留全屏顶点着色器，插入升采样管线资源。",
  },
  "bevy_post_process::bloom::upsampling_pipeline::prepare_upsampling_pipeline": {
    summary: "为 Bloom 中间合成和最终目标准备升采样管线。",
    description: "按 Bloom 合成模式分别以 Bloom 纹理格式和视图目标格式专用化升采样管线，保存中间与最终两条缓存标识。",
  },
  "bevy_post_process::dof::configure_depth_of_field_view_targets": {
    summary: "允许景深相机采样自己的深度纹理。",
    description: "遍历带 DepthOfField 的三维相机，将深度纹理用途加入 TEXTURE_BINDING，使景深着色器能够读取场景深度。",
  },
  "bevy_post_process::dof::depth_of_field": {
    summary: "以两阶段全屏通道执行景深模糊。",
    description: "按 Gaussian 或 Bokeh 管线读取颜色、深度及景深参数，依次写入后处理目标；Bokeh 额外管理双输出和双输入辅助纹理，缺少深度面、管线或参数时跳过，辅助纹理缺失时警告。",
  },
  "bevy_post_process::dof::extract_depth_of_field_settings": {
    summary: "把透视相机景深设置转换为 GPU 参数。",
    description: "平台支持深度纹理时，从主世界提取景深设置，按传感器高度与透视视场角计算焦距及弥散圆缩放并写入渲染实体；非透视投影移除提取目标，不支持平台记录停用信息。",
  },
  "bevy_post_process::dof::init_dof_global_bind_group_layout": {
    summary: "建立景深共享参数布局和线性采样器。",
    description: "为动态 DepthOfFieldUniform 及过滤颜色采样器创建片元布局，分配线性采样器并保存 DepthOfFieldGlobalBindGroupLayout，供所有景深视图共用。",
  },
  "bevy_post_process::dof::prepare_auxiliary_depth_of_field_textures": {
    summary: "为 Bokeh 景深分配第二颜色输出。",
    description: "仅对 Bokeh 模式取得与主视图纹理尺寸、采样数及格式一致的辅助纹理，设置渲染附件和采样用途，并将其附到视图供两阶段景深使用。",
  },
  "bevy_post_process::dof::prepare_depth_of_field_global_bind_group": {
    summary: "把景深参数与采样器绑定为共享 GPU 输入。",
    description: "景深参数缓冲已上传后，以全局布局创建参数和颜色采样器绑定组，写入 DepthOfFieldGlobalBindGroup；缓冲尚无绑定时返回。",
  },
  "bevy_post_process::dof::prepare_depth_of_field_pipelines": {
    summary: "按景深模式和视图格式准备两阶段管线。",
    description: "结合视图绑定布局、全局布局、目标格式及 MSAA 状态，为 Gaussian 创建水平与垂直管线，为 Bokeh 创建第一和第二通道管线，将缓存标识写入视图。",
  },
  "bevy_post_process::dof::prepare_depth_of_field_view_bind_group_layouts": {
    summary: "为景深视图创建单输入与 Bokeh 双输入布局。",
    description: "按 MSAA 选择普通或多采样深度输入，并绑定视图参数和当前颜色；Bokeh 模式额外创建包含辅助颜色纹理的双输入布局，将两种布局附到视图。",
  },
  "bevy_post_process::effect_stack::init_post_processing_pipeline": {
    summary: "建立色差、暗角和镜头畸变的共用后处理资源。",
    description: "定义源颜色、色差 LUT、过滤采样器及三类动态效果参数的绑定布局，创建线性采样器并加载通用后处理着色器，形成 PostProcessingPipeline。",
  },
  "bevy_post_process::effect_stack::prepare_post_processing_pipelines": {
    summary: "按视图颜色格式准备内置后处理管线。",
    description: "为查询到的已提取视图及带色差、暗角或镜头畸变的视图，以目标颜色格式专用化共用后处理管线，并保存 PostProcessingPipelineId。",
  },
  "bevy_post_process::effect_stack::prepare_post_processing_uniforms": {
    summary: "收集并上传逐视图色差、暗角和畸变参数。",
    description: "清空三类参数缓冲，按每个效果视图写入设置或对应默认值，对暗角半径、圆度及畸变缩放等做必要边界限制，保存各类动态偏移并上传 GPU。",
  },
  "bevy_post_process::motion_blur::pipeline::init_motion_blur_pipeline": {
    summary: "加载运动模糊着色器并构造管线资源。",
    description: "取得全屏顶点着色器，加载嵌入的 motion_blur.wesl，并通过渲染设备构造和插入 MotionBlurPipeline。",
  },
  "bevy_post_process::motion_blur::pipeline::prepare_motion_blur_pipelines": {
    summary: "按颜色格式与采样数准备运动模糊管线。",
    description: "为带 MotionBlurUniform 的已提取相机，依据视图目标格式和 MSAA 采样数专用化运动模糊管线，将缓存标识附到相机。",
  },
  "bevy_post_process::motion_blur::prepare_view_depth_texture_usages_for_motion_blur": {
    summary: "让运动模糊相机的深度纹理可被采样。",
    description: "对带 MotionBlurUniform 的三维相机，把深度纹理用途加入 TEXTURE_BINDING，供运动模糊着色器读取深度。",
  },
  "bevy_post_process::msaa_writeback::prepare_msaa_writeback_pipelines": {
    summary: "为需要保留已有颜色的多采样相机准备回写管线。",
    description: "按主纹理识别首个写入相机，结合 MSAA 回写开关、清除方式及是否后续全屏合成决定是否回写；需要时创建对应采样数和格式的 Blit 管线，否则移除旧回写组件。",
  },
  "bevy_sprite_render::mesh2d::material::add_material2d_bind_group_allocator": {
    summary: "为二维材质类型注册 GPU 绑定组分配器。",
    description: "通过渲染设备在 MaterialBindGroupAllocators 中添加材质类型 M 的分配器，供该二维材质后续绑定组分配和管理使用。",
  },
  "bevy_sprite_render::mesh2d::material::check_entities_needing_specialization": {
    summary: "收集二维网格材质需重建或移除专用化的实体。",
    description: "并行收集 Mesh2d、材质组件或其资产变化的实体，同时记录移除网格或材质组件的实体，写入本帧 EntitiesNeedingSpecialization；同帧移除再添加由后续先删后建逻辑处理。",
  },
  "bevy_sprite_render::mesh2d::material::extract_entities_needs_specialization": {
    summary: "把二维材质变化实体标为渲染专用化脏项。",
    description: "读取主世界 EntitiesNeedingSpecialization.changed，将主实体身份加入渲染世界 DirtySpecializations.changed_renderables，交给后续管线专用化处理。",
  },
  "bevy_sprite_render::mesh2d::material::extract_entities_that_need_specializations_removed": {
    summary: "把二维材质移除实体登记到专用化清理表。",
    description: "读取主世界 EntitiesNeedingSpecialization.removed，把对应主实体加入渲染世界 DirtySpecializations.removed_renderables，以清理失效管线专用化。",
  },
  "bevy_sprite_render::mesh2d::material::extract_mesh_materials_2d": {
    summary: "同步可见二维网格使用的材质资产身份。",
    description: "材质或视图可见性变化时向 RenderMaterial2dInstances 添加可见实体材质、移除不可见实体材质；组件移除后仅清理仍属当前材质类型的记录，避免同帧更换材质类型误删新记录。",
  },
  "bevy_sprite_render::mesh2d::material::init_material_2d_pipeline": {
    summary: "以二维网格基础管线建立材质管线资源。",
    description: "克隆 Mesh2dPipeline 作为 Material2dPipeline 的基础网格管线，通过命令将资源插入渲染世界，供二维材质专用化复用。",
  },
  "bevy_sprite_render::mesh2d::material::initialize_material2d_shaders": {
    summary: "解析二维材质的自定义顶点与片元着色器。",
    description: "调用材质类型的两类着色器声明，保留现有句柄或通过 AssetServer 加载路径，默认着色器不另建条目，将已指定着色器及缓存保存为 Material2dShaders。",
  },
  "bevy_sprite_render::mesh2d::material::mark_2d_meshes_as_changed_if_their_materials_changed": {
    summary: "让材质变化触发二维网格重新提取。",
    description: "当二维材质组件或资产变化时标记 Mesh2d 为 changed；移除材质组件但网格仍存在时同样标记，确保后续网格提取刷新材质绑定信息。",
  },
  "bevy_sprite_render::mesh2d::material::prepare_pending_mesh_material2d_queues": {
    summary: "轮换二维材质待就绪队列并清理失效视图。",
    description: "为每个已提取视图将当前帧与前帧待处理队列切换到新帧状态，记录活跃视图集合并移除已不存在视图的队列。",
  },
  "bevy_sprite_render::mesh2d::material::queue_material2d_meshes": {
    summary: "按透明模式更新二维网格渲染批次。",
    description: "先从保留阶段移除不可见或失去网格材质的实体，再处理新可见、脏专用化及待就绪实体；材质未准备时留到后续重试，已就绪时按 Opaque、Mask 或透明模式加入对应阶段，并按网格批处理能力及深度偏移生成批次信息。",
  },
  "bevy_sprite_render::mesh2d::material::specialize_material2d_meshes": {
    summary: "为可见二维网格重建失效的材质专用化。",
    description: "按视图和实体脏标记清除旧缓存，组合视图键、网格布局和材质属性收集专用化任务，更新材质绑定索引并生成管线缓存；网格或材质未准备时进入待处理队列，失败记录错误，最后清理失效视图缓存。",
  },
  "bevy_sprite_render::mesh2d::mesh::check_views_need_specialization": {
    summary: "检测二维视图管线配置变化并标记重建。",
    description: "根据采样数、目标格式、合成空间及 SDR 相机的着色器内色调映射和抖动设置生成视图键；与缓存不同时更新 ViewKeyCache，并将该视图加入 DirtySpecializations。",
  },
  "bevy_sprite_render::mesh2d::mesh::extract_2d_meshes": {
    summary: "增量同步二维网格变换和渲染实例信息。",
    description: "处理上帧待重提取实体，以及可见性、全局变换、网格、标签或自动批处理标记的变化，结合材质绑定更新 RenderMesh2dInstances；移除标记时重新提取，Mesh2d 真正移除且本帧未重新加入时清理实例。",
  },
  "bevy_sprite_render::mesh2d::mesh::init_batched_instance_buffer": {
    summary: "依据设备限制建立二维网格实例批缓冲。",
    description: "以渲染设备限制创建 BatchedInstanceBuffer<Mesh2dUniform> 并插入资源，供后续二维网格实例参数批处理和上传使用。",
  },
  "bevy_sprite_render::mesh2d::mesh::init_mesh_2d_pipeline": {
    summary: "建立二维网格的视图、实例及元数据输入布局。",
    description: "创建视图参数、全局参数和色调映射 LUT 布局，以及二维实例和网格元数据布局；按设备存储缓冲能力选择元数据存储方式，保存批大小并加载 mesh2d 着色器。",
  },
  "bevy_sprite_render::mesh2d::mesh::load_mesh2d_bindings": {
    summary: "按运行设备能力加载二维网格绑定着色器。",
    description: "依据实例批大小及存储缓冲支持设置 bindings.wesl 的预处理常量，加载后保留嵌入着色器句柄，使 GPU 参数布局与设备实际能力一致。",
  },
  "bevy_sprite_render::mesh2d::mesh::prepare_mesh2d_bind_group": {
    summary: "按网格元数据分配块建立二维网格绑定组。",
    description: "二维实例缓冲已上传后，遍历 MeshAllocator 元数据分配块，将实例数据和对应元数据缓冲绑定；缺少分配块缓冲时使用回退缓冲，并按块身份保存绑定组。",
  },
  "bevy_sprite_render::mesh2d::mesh::prepare_mesh2d_view_bind_groups": {
    summary: "为二维相机绑定视图、全局参数与色调 LUT。",
    description: "视图和全局参数缓冲可用后，按各 Camera2d 的色调映射模式选取 LUT 或回退图像，生成 Mesh2dViewBindGroup 并附到对应已提取视图。",
  },
  "bevy_sprite_render::render::extract_sprite_events": {
    summary: "把主世界图像资产事件复制给精灵渲染。",
    description: "清空 SpriteAssetEvents 的上一帧图像记录，读取主世界 Image 资产消息并逐项复制，供精灵准备阶段失效图像绑定缓存。",
  },
  "bevy_sprite_render::render::init_sprite_pipeline": {
    summary: "建立精灵视图和图像材质管线资源。",
    description: "定义视图参数与色调映射 LUT 布局，以及可过滤图像和采样器布局，加载 sprite.wesl 后插入 SpritePipeline。",
  },
  "bevy_sprite_render::render::prepare_sprite_image_bind_groups": {
    summary: "合并连续同图像精灵并上传实例与索引数据。",
    description: "依据图像修改或移除事件清除旧绑定，按透明阶段绘制顺序把连续且图像相同的精灵合为批次；为整图或切片计算变换、颜色与 UV，更新批范围并上传实例及矩形索引缓冲，遇其他绘制项则断开批次。",
  },
  "bevy_sprite_render::render::prepare_sprite_view_bind_groups": {
    summary: "为精灵视图绑定参数和色调映射 LUT。",
    description: "视图参数缓冲就绪后，为各已提取视图按 Tonemapping 选择 LUT 或回退图像，创建并附加 SpriteViewBindGroup。",
  },
  "bevy_sprite_render::text2d::extract_text2d_sprite": {
    summary: "把可见二维文字及装饰提取为精灵切片。",
    description: "按文字布局缩放、锚点和全局变换生成背景、字形、阴影、删除线及下划线精灵，按字形图集和文本段颜色合并连续切片，并创建临时渲染实体；不可见文字跳过。",
  },
  "bevy_sprite_render::tilemap_chunk::update_tilemap_chunk_indices": {
    summary: "将变化的瓦片块索引打包写入材质图像。",
    description: "校验瓦片数据长度与块尺寸一致后，把各瓦片转换为 PackedTileData 并覆盖材质引用图像的 CPU 字节，同时触发材质变化；长度错误或材质、图像、图像数据缺失时警告并跳过。",
  },
  "bevy_ui_render::box_shadow::init_box_shadow_pipeline": {
    summary: "建立 UI 盒阴影的视图布局和着色器资源。",
    description: "创建供顶点与片元阶段读取动态 ViewUniform 的布局，加载 box_shadow.wesl，并通过命令插入 BoxShadowPipeline。",
  },
  "bevy_ui_render::debug_overlay::extract_debug_overlay": {
    summary: "为变化的 UI 节点提取调试轮廓。",
    description: "结合全局与逐节点调试配置，为边框盒、内边距盒、内容盒以及滚动条槽和滑块生成轮廓渲染节点，置于普通 UI 上方；按设置决定是否显示隐藏或被裁剪部分，并支持指定或按实体分配颜色。",
  },
  "bevy_ui_render::extract_inline_images": {
    summary: "把文字行内图像提取为 UI 绘制项。",
    description: "对变化且可见的非空文字节点，读取布局中的 InlineBox 矩形与 InlineImage，按内容盒位置转换到 UI 世界坐标，保留颜色、翻转、裁剪及层次，跳过透明或空图像。",
  },
  "bevy_ui_render::extract_text_decorations": {
    summary: "提取 UI 文字背景、删除线和下划线。",
    description: "按文字段的布局几何与颜色，为变化的可见文字生成背景矩形及两类装饰线，装饰色可覆盖文字色；结合可编辑文字滚动偏移和裁剪，将各绘制项加入对应相机和层次。",
  },
  "bevy_ui_render::extract_text_sections": {
    summary: "按图集提取 UI 字形并处理选中文字颜色。",
    description: "对变化的可见文字，按文本段取得颜色并生成字形位置及图集矩形，彩色字形保留白色乘色，选中字形可用光标样式覆盖颜色；应用编辑滚动和裁剪，并按连续图集分组为渲染节点。",
  },
  "bevy_ui_render::extract_text_shadows": {
    summary: "提取 UI 文字及装饰线的偏移阴影。",
    description: "为变化的可见文字按 TextShadow 偏移、颜色和节点缩放生成字形阴影，按文本段及图集分组，并为删除线和下划线生成同色阴影；沿用编辑滚动位置和文字裁剪。",
  },
  "bevy_ui_render::extract_ui_camera_view": {
    summary: "为活动二维或三维相机维护独立 UI 视图。",
    description: "以左上角为原点建立视口正交投影，复用或创建 UI 子视图和透明阶段，双向关联主相机并复制抗锯齿及阴影采样设置；相机无效、停用或移除后销毁关联视图并清理阶段，兼容同帧移除重加。",
  },
  "bevy_ui_render::extract_uinode_background_colors": {
    summary: "提取 UI 节点背景与外侧填充色。",
    description: "对变化且可见、非空的节点，分别为非透明 BackgroundColor 和 OuterColor 创建普通及反向矩形绘制项，保留边框半径、全局变换、裁剪和背景层次；背景与外色均透明时跳过。",
  },
  "bevy_ui_render::extract_uinode_borders": {
    summary: "提取 UI 各边颜色边框与外轮廓。",
    description: "对变化的可见节点，将同色边合并到一次边框绘制，保留计算后的宽度和圆角；外轮廓宽度为正且颜色可见时另建四边轮廓项，隐藏布局和透明边跳过。",
  },
  "bevy_ui_render::extract_uinode_changes": {
    summary: "使变化或移除的 UI 数据失效并清理旧渲染实体。",
    description: "收集布局、层次、变换、颜色、图像、文字及编辑状态等变化与移除事件，删除对应旧绘制实体并标记待重新提取；文本段或行内框变化同时追溯文字祖先，调试全局选项变化时重建全部节点。",
  },
  "bevy_ui_render::extract_uinode_images": {
    summary: "按节点视觉盒与图集区域提取普通 UI 图像。",
    description: "选择内容、内边距或边框视觉盒，按 Auto 模式保持图像比例，结合图集和局部矩形计算采样区域及缩放，收缩并限制圆角后生成绘制项；切片模式、透明、不可见或无有效尺寸的图像交由其他路径或跳过。",
  },
  "bevy_ui_render::extract_viewport_nodes": {
    summary: "把视口节点所引用相机的输出图像嵌入 UI。",
    description: "对变化的可见非空 ViewportNode，解析其相机的图像渲染目标，按节点尺寸、边框圆角、变换、裁剪及层次生成白色乘色图像项；未指定相机或相机未输出到图像时跳过。",
  },
  "bevy_ui_render::gradient::init_gradient_pipeline": {
    summary: "建立 UI 渐变的视图布局和着色器资源。",
    description: "创建顶点与片元阶段共用的动态 ViewUniform 布局，加载 gradient.wesl 并将其与布局保存为 GradientPipeline 资源。",
  },
  "bevy_ui_render::image::mark_images_as_changed_if_their_assets_changed": {
    summary: "使图像或图集资产变化触发 UI 图像更新。",
    description: "当 ImageNode 引用的图像资产或 ImageNodeTextureAtlasLayout 引用的图集布局资产发生变化时，显式标记图像组件及存在的图集布局组件为 changed，供后续布局和渲染提取识别。",
  },
  "bevy_ui_render::image::update_texture_atlas_layout_components": {
    summary: "同步 UI 图像所引用的图集布局组件。",
    description: "ImageNode 变化时，若包含 texture_atlas 则复制其布局句柄到 ImageNodeTextureAtlasLayout；取消图集后移除该组件，让资产变化追踪随实际引用更新。",
  },
  "bevy_ui_render::pipeline::init_ui_pipeline": {
    summary: "建立 UI 图形的视图、图像和采样器布局。",
    description: "创建动态 ViewUniform 布局与可过滤二维图像、采样器布局，加载 ui.wesl，组合为 UiPipeline 并插入渲染资源。",
  },
  "bevy_ui_render::text::extract_preedit_underlines": {
    summary: "把输入法预编辑下划线提取为 UI 矩形。",
    description: "对变化的可编辑文字，读取预编辑下划线布局矩形，应用内容盒位置、编辑视口偏移及文字裁剪，使用文字颜色生成对应绘制项；不可见、空节点或无下划线时跳过。",
  },
  "bevy_ui_render::text::extract_text_cursor": {
    summary: "提取文字光标和带圆角的选区背景。",
    description: "对变化的可见文字，按焦点及读写模式选择选区颜色，调整相邻行交接处的选区圆角，并依据光标可见状态生成光标矩形；静态文字不生成选区或光标，保留编辑滚动和裁剪。",
  },
  "bevy_ui_render::ui_texture_slice_pipeline::extract_ui_texture_slices": {
    summary: "增量提取九宫格或平铺 UI 图像切片。",
    description: "布局、图像或裁剪变化时销毁旧切片，按视觉盒、图集区域、翻转、缩放及模式创建新的切片描述并关联相机；不可见或不再采用切片模式时不再生成，组件真正移除后清理残余渲染实体。",
  },
  "bevy_ui_render::ui_texture_slice_pipeline::init_ui_texture_slice_pipeline": {
    summary: "建立 UI 图像切片的视图和纹理管线资源。",
    description: "创建动态视图参数布局及可过滤图像、采样器布局，加载 ui_texture_slice.wesl 后保存 UiTextureSlicePipeline。",
  },
  "bevy_ui_render::ui_texture_slice_pipeline::prepare_ui_slices": {
    summary: "为 UI 切片生成裁剪几何并合并图像批次。",
    description: "图像修改或移除时失效绑定缓存，按透明 UI 顺序将兼容图像切片合批，计算九宫格边界或平铺重复参数及图集翻转，裁剪四边形后生成顶点索引并上传 GPU，再把批范围附到渲染实体。",
  },
  "bevy_ui_render::ui_texture_slice_pipeline::queue_ui_slices": {
    summary: "将 UI 图像切片排入对应相机透明阶段。",
    description: "为各切片找到主相机的 UI 子视图和透明阶段，按目标颜色格式专用化切片管线，以节点堆叠顺序加图像偏移生成排序键并加入临时绘制项；缺少相机或阶段时跳过。",
  },
};
