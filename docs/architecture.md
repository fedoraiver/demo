# 当前原型架构

本文描述当前代码的组织与数据流。玩法目标见[游戏设计](game-design.md)，开发要求见[开发规范](development.md)，操作与配置见 [README](../README.md)。物流到货、岛内配送、收件人和任务系统尚未实现。

## 模块职责

| 模块 | 当前职责 |
| --- | --- |
| [main.rs](../src/main.rs) | 组装英文菜单、游戏与检查器插件，先准备会话日志，再加载设置；指定固定 60 Hz 模拟和窗口策略，退出后记录结果并刷新日志。 |
| [window_policy/mod.rs](../src/window_policy/mod.rs)、[macos.rs](../src/window_policy/macos.rs)、[windows.rs](../src/window_policy/windows.rs) | 统一主窗口初始尺寸与最小尺寸，以主线程原生适配约束 16:9 拖拽、工作区及最大化；管理安装与窗口退出清理。 |
| [app_flow.rs](../src/app_flow.rs) | 管理主菜单／游戏状态与运行／暂停子状态，清理玩法输入并暂停或恢复时间；暂停保留玩法实体。 |
| [ui/mod.rs](../src/ui/mod.rs) | 定义菜单页面、返回来源、焦点、设置分类与语义请求，注册 UI 插件和更新顺序。 |
| [ui/navigation.rs](../src/ui/navigation.rs) | Enhanced Input 处理菜单键盘与手柄动作，Bevy UI 处理鼠标命中；统一消费请求、切换页面及保存和应用设置，并根据实际焦点变化与接受结果发出菜单音效消息。 |
| [ui/screens.rs](../src/ui/screens.rs)、[ui/widgets.rs](../src/ui/widgets.rs)、[ui/theme.rs](../src/ui/theme.rs) | 用 BSN 声明页面与控件树，复用字体、颜色和间距；系统更新焦点、设置说明与滚动位置。 |
| [ui/volume.rs](../src/ui/volume.rs) | 用 BSN 声明音量行，局部捕获滑条鼠标拖动并发出统一设置请求，更新已有百分比与轨道填充。 |
| [ui/backdrop.rs](../src/ui/backdrop.rs) | 主菜单的独立 GLB 展示舞台、相机与光照；启动快递员展示动画，记录资产加载失败。 |
| [input.rs](../src/input.rs) | 注册 `bevy_enhanced_input`、`GameplayContext` 和玩法／调试动作；创建键盘控制者，按动作的 `context` 路由角色意图。 |
| [camera.rs](../src/camera.rs) | 管理相机控制关联、视角模式、环绕状态和鼠标捕获；处理观察与视角切换动作，固定步同步角色朝向，物理插值后逐帧同步朝向、持握目标、环绕镜头、建筑遮挡需求、建筑淡化和人物可见性。 |
| [camera_obstruction.rs](../src/camera_obstruction.rs) | 按本帧环绕镜头检测建筑外壳遮挡，汇总 `OccludedBuildings`；只更新透明需求，不写相机 `Transform` 或改变距离、方向。 |
| [camera_fade.rs](../src/camera_fade.rs) | 按建筑实例管理外壳材质副本、淡化过渡和无遮挡恢复；多相机需求取并集，清理失效关联与退出场景后的缓存。 |
| [gameplay.rs](../src/gameplay.rs) | 定义玩家身份、角色与快递组件、持有关系和原型参数；固定步查询接地、施加移动力、跳跃冲量与持握力并执行拿放，固定步和逐帧共用持握目标同步。 |
| [physics.rs](../src/physics.rs) | 注册 Avian3D 物理插件、重力和碰撞层，构建角色与箱体物理组件，并记录接触开始和结束日志。 |
| [art_assets.rs](../src/art_assets.rs) | 通过 `ArtAssetsPlugin` 加载海岛、主角、普通纸箱、易碎纸箱与木箱五份 GLB；`ArtAssets` 保存强句柄，`ArtLoadState` 单独保存加载状态，记录加载完成及失败。 |
| [scene.rs](../src/scene.rs) | `PrototypeScenePlugin` 使用 Rust 内嵌 BSN `scene` 函数装配场景；处理地图实例就绪、展示实体替换和结构碰撞生成，资源及碰撞准备完成后生成动态角色、物品、控制者和相机。 |
| [character_animation.rs](../src/character_animation.rs) | `CharacterAnimationPlugin` 为主角 GLB 绑定命名动画，根据局部真实速度、接地与持有关系连续混合 16 个动作，统一脚步相位、跳跃阶段、视觉接地补偿与关联清理。 |
| [island_recovery.rs](../src/island_recovery.rs) | `IslandRecoveryPlugin` 根据物理位置检测落水，使用实体的 `SpawnPoint` 恢复玩家与可搬物品，解除持握并清理运动状态。 |
| [settings.rs](../src/settings.rs) | 加载、校验、编辑草稿和保存玩家设置，失败时保留原文件；在时间更新之前限制渲染循环频率。 |
| [startup_log.rs](../src/startup_log.rs) | 通过 `StartupLogPlugin` 集中注册四项启动日志，只读玩法配置与固定时间步，并记录姿态同步约定和检查器启用信息。 |
| [session_log.rs](../src/session_log.rs) | 创建独立会话文件，管理文件与控制台后台输出，记录会话生命周期和 panic 上下文，并负责排空、刷新与关闭线程。 |
| [audio_events.rs](../src/audio_events.rs) | 注册反馈消息，观察真实落地碰撞与持续持握误差；独立于声音设备，供最小物理测试复用。 |
| [audio.rs](../src/audio.rs) | 以嵌入的音频清单预加载 Kira 资产，通过 UI/SFX 通道播放；选择草稿或已应用音量，同步实例增益，处理静音、冷却、并发、失败日志和退出停止。 |

依赖声明和锁定版本分别见 [Cargo.toml](../Cargo.toml) 和 [Cargo.lock](../Cargo.lock)。

## 菜单与会话生命周期

`AppState` 只有 `MainMenu` 与 `InGame`。`PlayState` 是仅在 `InGame` 存在的 `Running / Paused` 子状态。`PrototypeScenePlugin` 在 `OnEnter(AppState::InGame)` 生成光照和加载相机，重置本次场景准备状态；`Update` 仅在 `gameplay_running` 时推进地图装配、碰撞准备和动态实体生成。地图根、独立业务根、控制者、相机和灯光使用 `DespawnOnExit(AppState::InGame)`，退出会话时清理；NPC、碰撞与视觉子树沿地图根或业务根的 `ChildOf` 一同销毁。全局 `ArtAssets` 强句柄与 `ArtLoadState` 跨会话保留，重新开始复用已加载资产并建立新的地图实例。暂停不退出 `InGame`，因此不重新生成角色、箱体或持有关系，也不推进尚未完成的场景装配。

`MenuState` 保存 `Main / Hidden / Settings / Help / Pause` 页面、设置分类、返回页面与提示文本；`MenuFocus` 独立保存可操作按钮序号，`MenuInputSource` 区分鼠标与键盘／手柄导航来源。设置和帮助只切换页面，返回主菜单来源时仍在主菜单，返回暂停来源时仍暂停。`SettingsDraft` 是独立草稿，切换分类保留草稿和音量预览。`Back / Esc` 丢弃未应用修改并恢复最近成功应用的音量；`Restore Defaults` 只恢复全部草稿并预览默认音量。`Apply` 先校验并保存，成功才替换 `GameSettings`，失败保留已应用设置、原文件、草稿及临时音量预览，返回后回滚预览。

菜单控制者的 `MenuContext` 使用较高优先级与 `require_reset`，接收方向键、Enter、Esc 和手柄菜单按键。鼠标经 Bevy UI `Interaction` 发出相同 `UiRequest`。集中处理系统每帧消费一项语义请求，避免同帧两种输入重复触发；连续滑条采样合并，同帧返回优先于旧采样，最终数值与释放反馈一起处理。键盘动作在 `PreUpdate` 的 `EnhancedInputSystems::Apply` 后处理，`StateTransition` 随后执行；`Update` 先重建页面并应用旧树销毁，再读取鼠标点击，避免旧页面的 `Back` 穿透新页面。鼠标请求交给下一次 `PreUpdate` 消费。窗口光标位置用于判断真实鼠标移动，静止光标造成的新 `Hovered` 不抢走键盘焦点；音量滑条额外在局部范围读取底层左键与物理光标位置，以表达 Enhanced Input 菜单动作无法表达的轨道绝对坐标。命中沿用 `Interaction`，滑条不经普通按钮路径重复发请求，释放、失焦、光标离开窗口或页面销毁时结束捕获。

按钮样式由当前输入来源决定：鼠标模式只高亮实际悬停或按下的按钮，离开后恢复纸色；键盘／手柄实际导航时显示 `MenuFocus`。鼠标真实移动即切回鼠标模式，包括移到空白区域，因此离开按钮不会留下导航高亮。`Apply` 与当前设置分类不另设常驻黄色样式；帮助编号的黄色装饰节点不参与按钮交互。

进入暂停时 `suspend_input` 清空角色意图、停用 `GameplayContext`、释放鼠标，并暂停 `Time<Virtual>` 与 `Time<Physics>`。物理增量立即归零，避免 Avian 使用前一步的非零增量再模拟一次。玩法系统、相机姿态同步、遮挡检测、建筑淡化过渡、主角动画状态更新与落水恢复受 `gameplay_running` 条件限制，镜头姿态与淡化程度保留；失效相机、目标和建筑的生命周期清理不因暂停停用。菜单渲染与输入仍可处理。恢复运行时重新启用时间，相机在下一次输入准备时恢复捕获并跳过自由光标位移。主菜单保持虚拟时间运行以播放展示动画，物理时间仍暂停。无窗口测试未安装应用状态时，`gameplay_running` 允许必要的独立玩法系统执行。

`Continue`、`Multiplayer` 和未实现设置项只声明灰色 `Coming Soon` 展示节点，不包含 `Button`、`MenuButton` 或业务动作，因而不会进入鼠标行为或键盘焦点列表。当前可用项与完整占位清单以 [README](../README.md#菜单与占位功能) 为准。

## BSN 页面与菜单展示资产

UI 控件与主菜单舞台使用 Bevy 0.19 的 `bsn!`、`bsn_list!` 和返回 `impl Scene` 的辅助函数声明。页面结构与组件数据由 BSN 创建，交互、焦点、设置应用和跨实体行为仍由 ECS 系统负责。`rebuild_page` 仅在页面、设置分类、返回来源或窗口宽高变化时清理旧 `MenuRoot` 并生成新树；焦点变化只更新按钮颜色与说明。设置草稿和保存提示变化时，系统原位更新已有数值与提示文字，不重建页面。音量行的 `VolumeSlider / VolumeValue / VolumeFill` 继续保存设置键，由音量系统原位更新百分比、静音提示和轨道填充，保留拖动实体。主菜单、暂停与帮助使用按宽高缩放的固定内容区，不包含 `MenuScroll` 和滚轮 Observer，也不参与焦点滚入。帮助在支持的 16:9 尺寸下完整呈现三列说明卡片、正文、键位和返回按钮。

设置页外层为固定布局，左侧分类、右侧底部 `Restore Defaults / Apply / Back` 与页面页脚不进入滚动层级。仅右侧纸色面板通过 `settings_scroll_frame` 装配 `MenuScroll` 与面板右侧滚动条，`SETTINGS` 标题、当前分类项目、说明和保存提示属于滚动内容。滚轮只由此内容区或其滚动条处理，焦点滚入只作用于该区域内的控件；固定区域的滚轮与焦点不会移动整页。

调整设置字段、`Restore Defaults` 与 `Apply` 均保留 `MenuRoot`、滚动区域、滚动条及按钮实体，数值和成功／失败提示原位刷新，因此不会因草稿变化将 `ScrollPosition` 复位或替换焦点控件。内容刷新后若滚动范围缩小，只将偏移夹取到新的有效范围；范围未缩小时保持原偏移。离开后重新进入设置或切换分类会生成新页面，并按新页面初始化滚动与焦点状态。

滚动条采用 Bevy 原生 `Scrollbar / ScrollbarThumb`；`DefaultPlugins` 中的 `ScrollbarPlugin` 负责比例滑块、拖动、轨道点击分页和指针状态。滚轮、焦点滚入与滚动条共同更新内容区的 `ScrollPosition`，将偏移限制在有效范围；轨道和滑块不加入 `MenuButton` 导航列表。BSN 树生成后绑定同层的滚动目标，`PostUpdate` 的 UI 布局完成后按实际面板内容与视口尺寸决定显隐：默认隐藏，内容溢出时显示，无溢出时隐藏并将偏移归零。面板右侧空间始终预留，避免显隐改变内容折行而抖动；显隐变化写入 `Settings scrollbar visibility changed` 调试日志。页面树销毁后原生控件按实体生命周期清理指针状态；空间指针交互使用 Bevy UI 事件，菜单键盘／手柄动作仍走 Enhanced Input。

主窗口尺寸策略由 `WindowPolicyPlugin` 管理。Windows 与 macOS 初始隐藏窗口，`PreUpdate` 的安装系统通过 `NonSendMarker` 在窗口线程读取 Bevy 0.19 的线程局部 `WINIT_WINDOWS`，确认真实主窗口存在，成功安装后才显示。只在短借用中取得窗口身份快照，不在调用原生 API 时持有后端表借用，避免同步窗口通知重入。原生守护对象放在非 Send 资源中；窗口实体或后端窗口退出时清理，安装失败显示固定窗口并记录英文错误。仅有 `Window` ECS 数据的无窗口测试不会触发原生 API。具体窗口能力与边界见 [README](../README.md#菜单与占位功能)。

macOS 在真实 `NSWindow` 上设置 `contentAspectRatio`，按扣除标题栏后的工作区更新内容最小／最大尺寸，并禁止系统全屏与全屏平铺，保留 Winit 原有代理。普通拖拽由 AppKit 应用尺寸前约束；Zoom 或桌面平铺等系统请求若绕过该属性，则只在实际尺寸违反比例或边界时补充校准并记录原因。Windows 使用 `SetWindowSubclass` 在 `WM_SIZING`、`WM_WINDOWPOSCHANGING` 应用请求前约束客户区，保留 `DefSubclassProc` 子类链；最大化转换为工作区内最大的普通 16:9 窗口，DPI 消息保持 Winit 正常处理。窗口管理不能用玩家动作表达，因此此适配只处理窗口消息，键鼠业务输入仍走现有 Enhanced Input 与 Bevy UI。Windows 物理客户区使用 `(16k, 9k)`，几何计算与锚点回归共用 [geometry.rs](../src/window_policy/geometry.rs)；普通拖拽不靠每帧事后回弹校正。

自动宽度的 `Text` 节点保留文本的自然测量，避免短文字在可收缩布局中被压成零宽。键帽、帧率值、音量百分比与 `Muted`、按钮标题和帮助编号都使用这一规则；容器按实际布局需要设置尺寸与折行约束。BSN 组件检查不能代替最终字体与排版的用户目测，重点检查短标签和数字是否完整可见。

文字零宽与鼠标离开后高亮残留的原因及预防要求统一见 [UI 布局与高亮规范](development.md#ui-布局与高亮规范)，对应的字体测量、悬停循环和输入来源回归见 [文字布局与高亮回归](testing.md#文字布局与高亮回归)。

主菜单的 `MenuBackdrop` 使用 `DespawnOnExit(AppState::MainMenu)` 管理相机、光照和真实美术模型。它由独立快递员、快递站、地形、海水、植物与包裹 GLB 组成；设置和帮助沿用这个舞台，暂停沿用当前玩法相机。菜单相机标记 `IsDefaultUiCamera` 与 `PrimaryEguiContext`，进入游戏时随舞台销毁，玩法相机接管界面。

模型通过 `WorldAssetRoot` 加载原有 `#Scene0`；快递员 `WorldInstanceReady` 后查找骨架中的 `AnimationPlayer` 并等待父 GLB 和命名片段可用后，循环播放按名称绑定的 `Carry_Idle`。展示包裹是独立模型附件，没有角色控制器、Avian 刚体或玩法持有关系。菜单舞台与使用 `assets/maps/courier_island.glb` 的可游玩海岛分别装配；菜单模型不参与玩法碰撞或配送业务。字体资源与资产准备约定见 [README](../README.md#美术与字体准备)。

保存设置前校验与序列化完整 `GameSettings`，然后在根 `tmp/settings-save/` 写入唯一临时文件、同步并关闭句柄，再用 `rename` 替换目标文件。替换失败时保留原文件并清理临时产物；临时文件与设置及会话日志各自管理。菜单步进范围不收紧 JSON 的原有有效范围，打开设置保留有效自定义值，实际调整相应字段后才进入菜单范围。

`GameSettings.audio` 与 `SettingsDraft.audio` 使用 `AudioSettings`，总音量、SFX 和 UI 均为 `u8` 的 `0..100` 百分比。缺少节或字段以默认 `100` 补齐；非法值拒绝整个设置文件，加载回退默认且不覆写原文件。方向按钮及 Enhanced Input 左右动作步进 `5%`，滑条将局部横坐标换算为 `1%` 精度的整数并夹到边界。`SetVolume` 只更新草稿，`FinishVolumeEdit` 在释放且最终值改变时汇总确认音和变化日志；`TestSfx` 只发送现有拾取素材的 `SoundRequest`，不触发玩法。

## 世界检查器

`main` 在默认插件之后依次注册 `EguiPlugin` 和 `WorldInspectorPlugin::run_if(gameplay_running)`，检查器只在游戏运行时显示，主菜单与暂停时隐藏。它复用主窗口与当前相机，在 `EguiPrimaryContextPass` 中展示实体、资源和资产。插件自身的独占世界访问用于通用反射检查，项目不另建世界扫描或数据镜像。`StartupLogPlugin` 在启动时通过统一日志记录 `World inspector enabled`，表示插件已注册，并不表示启动主菜单显示检查器。

鼠标仍被游戏捕获时，`filter_captured_egui_input` 在 Egui 收集输入后、开始本帧之前过滤面板交互，补齐 Egui 内部残留按键的释放并清除拖拽和文本焦点。这样隐藏光标即使位于面板上也不会误编辑字段或中断玩家输入。F3 的 `ReleasePointerAction` 由相机 Observer 释放光标以操作检查器，游戏仍保持运行；Esc 通过菜单动作进入暂停。

玩法组件、`PrototypeConfig` 和相机状态注册 Bevy 反射元数据，让检查器直接访问 ECS 数据。`HeldBy`／`HoldingItems` 不开放反射修改，反向索引继续由 Bevy 的关系钩子维护；鼠标捕获状态不开放反射编辑。检查器编辑仅影响内存中的本次会话。

## 实体与状态归属

- **控制者实体**保存 `PlayerId`、`GameplayContext`、设备绑定、`ControlsCharacter` 和 `ControlsCamera`。`PlayerId` 表达业务身份，两个控制组件使用运行时 `Entity` 指向角色与相机。
- **角色业务实体**保存 `Character`、`CharacterIntent`、`CharacterMotion`、`SpawnPoint`、动态 `RigidBody`、胶囊 `Collider` 和 Avian 运动组件。移动能力与控制设备分离；物理位置与速度由 Avian 管理，`Transform` 用于插值呈现，角色根位置对应脚底。锁定刚体旋转避免碰撞后倾倒，水平朝向仍由视角系统控制。
- **快递业务实体**保存 `Parcel`、`Pickable`、`CarryGrip`、`SpawnPoint`、动态 `RigidBody`、方盒 `Collider` 和 Avian 运动组件，被持有时增加 `HeldBy` 与 `HeldTarget`。纸箱与木箱根位置对应模型中心，碰撞体按实际尺寸与轴心对齐；拾取系统按 `Pickable` 能力过滤，不依赖名称或模型。
- **相机实体**保存 `OrbitCamera`、`MouseLookState`、`CameraOcclusion`、`Camera3d` 和 `Transform`。`OrbitCamera` 保存目标、`CameraPerspective` 视角模式、共享水平角、各模式的俯仰角和固定跟随参数；跟随系统把位置与朝向写入 `Transform`，建筑遮挡检测复用相同的跟随计算，不反向修改姿态。`CameraOcclusion` 只保存上一帧建筑需求集合以记录离散日志，不保存实际距离或距离恢复状态。
- **建筑外壳查询实体**用 `CameraShell` 关联所属建筑实例；额外碰撞体只供建筑遮挡查询，不参与角色、箱体的接触与玩法射线查询。`OccludedBuildings` 保存本帧有效第三人称相机的建筑需求并集，淡化状态与材质副本按实例管理，不改动 GLB 的共享原始材质。
- **共享资源**包括 `PrototypeConfig`、`GameSettings`、`SettingsDraft`、`SettingsFile`、菜单状态与焦点、`ArtAssets` 与 `ArtLoadState`；限帧计时和连续数据日志采样使用各系统的 `Local`。

场景创建 `PlayerId(1)` 对应的一名键盘控制者、一名角色、普通纸箱与易碎纸箱各一件、三件木箱和一台相机。地图中的调度员、Pizza 店员、Music 店员和居民保留为展示角色，不加入玩家控制和配送业务。数据结构支持按控制者路由，不代表已经实现多人、联机或分屏。

地面来自完整海岛的实际几何，不再生成旧的 `200 × 1 × 200` 地面盒或测试墙。内陆顶面为 `Y = 0`，岸坡逐渐下降至海面以下；海水没有支撑碰撞，落水恢复由 `IslandRecoveryPlugin` 单独处理。

人物模型和木箱模型分别通过 `ChildOf` 挂在业务实体下。人物视觉子实体带有 `CharacterVisual` 标记，第一人称只隐藏当前相机目标的人物视觉，不隐藏角色业务实体或木箱。玩法查询操作业务实体，视觉网格和材质留在子实体，替换美术不必改变移动或拾取流程。持有关系与视觉父子关系相互独立。

## 美术加载与 BSN 场景装配

运行资源来自 `assets/maps/courier_island.glb`，以及 `assets/models/characters/chr_courier.glb`、`assets/models/props/prop_parcel_standard.glb`、`prop_parcel_fragile.glb` 和 `prop_crate.glb`。制作源与预览保留在 [art/](../art/)，运行时不依赖 Blender。模型使用米制、glTF 的 Y-up 坐标；角色朝本地 `-Z`，根位于脚底，纸箱和木箱的原点位于中心。

`ArtAssetsPlugin` 在插件构建时初始化 `ArtAssets`，其 `FromWorld` 发起五份 GLB 的异步加载；强句柄覆盖模型生命周期。`ArtLoadState` 独立保存 `Loading`、`Ready`、`Failed` 状态，`Update` 检查模型及递归依赖是否完成或失败，主菜单期间也可完成加载。`Startup` 记录加载请求；`PrototypeScenePlugin` 在进入游戏时建立光照和加载相机，运行且 `ArtLoadState::Ready` 后使用 Rust 内嵌的 BSN `scene` 函数装配地图与实体组合，地图实例的 `WorldInstanceReady` 到达后再处理已展开的模型层级。导出的 `source_asset` 元数据仅用于装配阶段识别美术实例，之后的玩法查询使用业务组件，不把名称或美术元数据作为玩家身份。

地图 GLB 已包含静态持箱主角、易碎纸箱和三只木箱。装配流程移除这些展示实例及其子层级，并用独立 GLB 重建业务实体，避免同一位置出现重复模型或重复碰撞。四名 NPC 保留；柜台、货架纸箱和商店摆件继续作为固定装饰，没有 `Pickable`。资产场景就绪、所需模型就绪和实际碰撞生成都完成后，才创建玩家与可搬物品，避免先掉入尚未准备的地形。

静态碰撞从地形、建筑、码头、固定道具和棕榈树干的结构网格提取顶点与三角形，应用节点的实际变换后合并生成。建筑保持开放前厅与入口，不能用覆盖整栋模型的包围盒封住通道。海水、草和棕榈叶片不生成碰撞；台阶显示保留原始网格，原步阶不参与碰撞。三个商铺与两栋住宅的五组入口台阶按包围体生成不可见斜坡，并与各自实际地板边界配对：斜坡顶面接到室内地板高度，向地板内延伸 `0.05 m`，消除台阶与地板间的门槛落差和间隙。物理组件位于静态业务根或碰撞实体，模型视觉层级不重复添加刚体。

建筑外壳的查询几何与上述完整玩法碰撞分开装配，每栋建筑只有一份合并外壳查询碰撞体，保留建筑归属并标记 `CameraShell`。室内、地板、未知部件及非建筑结构不增加相机查询几何；原有 `World` 碰撞仍完整保留。额外外壳查询碰撞体属于 `CameraQuery` 层，碰撞掩码为 `LayerMask::NONE`，避免增加角色／箱体接触，同时从接地、拾取视线等玩法空间查询中显式排除。原有玩法碰撞形状、碰撞层和拿放规则保持原有职责。未知建筑部件保留不透明，不因名称相似或属于同一 GLB 就自动当作外壳。

玩家出生点为 `(-1.8, 0.03, 3.5)`；普通纸箱和易碎纸箱初始位置分别为 `(-1.8, 0.33, 2.2)`、`(-0.6, 0.33, 2.2)`。三只木箱保留地图实例各自的水平旋转与相对三角布局，原始位置整体平移 `(0.8, 0.165, -2.06)`，避开展示位置与墙体、柜台的穿透。调整后的业务根位于物流总站柜台与货架之间，分别为 `(-11.4, 1.065, -2.76)`、`(-11.3, 1.065, -3.76)`、`(-10.1, 1.065, -3.56)`；箱底比 `Y = 0.72` 的室内地板高 `0.02`。出生姿态保存在各实体的 `SpawnPoint`，后续恢复不从视觉节点或文件重新推断。

`assets/` 属于运行交付资源，须保留在版本控制和发布包中；`art/` 的制作源管理方式保持原有约定。资源加载失败记录相关路径和原始错误，未就绪时不生成玩家；资源加载与场景装配验证方法见 [验证指南](testing.md#海岛资源与无窗口验证)。

## 输入与相机数据流

`PlayerInputPlugin` 使用 `bevy_enhanced_input` 注册 `MoveAction`、`LookAction`、`JumpAction`、`InteractAction`、`TogglePerspectiveAction` 和调试用的 `ReleasePointerAction`。设备绑定位于控制者的 `GameplayContext`，Observer 从事件的 `context` 查到对应控制目标，再写入目标状态。

移动、跳跃和交互沿下面的路径进入固定模拟：

```text
设备绑定 → Enhanced Input 动作 → 控制者 → CharacterIntent → FixedUpdate
```

`CharacterIntent.movement` 保存持续有效的移动轴，动作完成或取消时归零。跳跃和交互使用 `Press` 与 `require_reset` 产生单次请求，Observer 将相应的 `pending` 置为 `true`，固定步通过 `std::mem::take` 消费并清除。没有固定步的渲染帧不会丢失请求；消费前的同类请求会合并为一次布尔请求，当前没有动作队列。

观察动作直接更新相机持续状态，视角切换动作先写入相机上的单次请求，再于本帧动作应用完成后消费：

```text
鼠标位移 / I 键 → 观察 / 视角切换动作 → ControlsCamera → OrbitCamera
                                      ├→ 固定步角色水平朝向
                                      └→ RunFixedMainLoop 物理插值 → 角色朝向 → HeldTarget → 相机 Transform → 人物 Visibility
                                                  → PostUpdate 视觉子实体 GlobalTransform
```

`on_camera_look` 根据灵敏度和 Y 轴设置换算角度，不另存 `CameraLookIntent`，也不乘帧时间或固定步时间。默认第三人称以固定环绕距离为目标，实际显示距离受环境阻挡限制，俯仰限制在 `5°..80°`；初始镜头相对脚底偏移为 `(0, 6, 8)`，观察中心位于脚底上方 `0.8`。第一人称镜头位于脚底上方 `1.65`，首次俯仰角为 `0°`，之后限制在 `-85°..85°`。两种模式共享水平角并分别保存俯仰角，人物朝向和移动只使用水平角。

`TogglePerspectiveAction` 默认绑定 I，使用 `Press` 与 `require_reset` 保证每次按下只切换一次，长按不重复。`request_perspective_toggle` Observer 验证窗口聚焦、控制关联和目标有效后，将请求保存到 `OrbitCamera.toggle_requested_by`；`apply_perspective_toggle` 在 `PreUpdate` 的 `EnhancedInputSystems::Apply` 之后消费请求并切换同一台相机的模式。因此同帧鼠标位移先作用于原模式，切换后恢复目标模式记住的俯仰角，不依赖动作遍历顺序；首次进入第一人称仍为平视。切换在本帧完成，不修改鼠标捕获、角色位置或玩法请求。F3 释放光标后，未操作检查器时仍可切换视角；失焦或暂停时忽略切换。

`sync_character_visibility` 在镜头更新后按有效控制关联和模式更新角色视觉子实体的 `Visibility`：仅第一人称隐藏对应的 `CharacterVisual`，切回第三人称时恢复；第三人称不因遮挡或镜头位置自动隐藏自身模型。相机或控制者丢失、关联不再有效时也恢复人物显示，避免模型停留在隐藏状态。

鼠标捕获是窗口生命周期处理：`sync_mouse_capture` 直接读取用于及时释放光标的 Esc、`MouseButtonInput` 和 `WindowFocused`，并结合应用状态、控制关联与目标是否存在更新 `MouseLookState` 和光标设置。Esc 的业务暂停只经菜单 Enhanced Input 路径执行，底层读取不再触发另一套暂停行为。捕获同步在底层 `InputSystems` 与 `EguiPreUpdateSet::BeginPass` 之后、`EnhancedInputSystems::Prepare` 之前执行。默认主 Egui 上下文使用多遍 UI 调度，本帧界面在 `PostUpdate` 处理；输入同步读取最近一次 UI 的拖拽、文本焦点和检查器菜单状态，并用当前窗口物理光标位置命中已有面板布局，避免同帧移入面板并点击时重新捕获鼠标。捕获恢复当帧跳过观察位移，避免自由光标阶段的位移造成镜头跳转。

操作检查器时通过 `ContextActivity<GameplayContext>` 停用输入上下文，而不清空全局底层键盘资源；延迟命令在动作准备前应用。停用触发动作完成或取消，已有移动意图归零，单次动作继续遵循 `require_reset` 的松键要求。F3 释放后未操作检查器时保留原有键盘控制，包括 I 切换视角；主菜单和暂停强制停用玩法输入，点击菜单背景不能重新捕获鼠标。

### 第三人称遮挡与建筑淡化

第三人称先由本帧插值后的角色 `Transform`、当前 yaw／pitch 和原有固定跟随参数更新环绕镜头，理想位置就是实际固定跟随位置。`camera_obstruction` 的 `detect_building_occlusion` 复用本帧跟随计算，沿镜头到角色身体多个采样点以及实际持物根 `Transform` 进行小球扫掠查询；扫掠宽度避免木板细缝造成中心射线漏检，不能用 `HeldTarget` 代替因惯性或碰撞偏离目标的真实包裹位置。镜头附近另做外壳球体重叠检测，覆盖镜头接近墙面或近裁剪面落入外壳的情况，也只请求淡化，不调整镜头。单相机需求先取各采样点与重叠检测的并集，多台有效第三人称相机再取建筑需求并集；任一相机仍需要同一建筑时，另一相机离开不能提前恢复它。这一数据边界不代表已经实现多人或分屏。

识别为 `CameraShell` 的墙面、屋顶等外壳按建筑实例淡化，而非让同一原始材质的所有建筑一起变化。`camera_fade` 保存原始材质句柄，为实例建立独立副本，约 `0.15 s` 内把外壳不透明度降到原 alpha 的 `20%`；原本半透明的材质也按比例降低，不能变得更不透明。最后一台相机解除遮挡且连续 `0.25 s` 无需求后，约 `0.35 s` 恢复原材质句柄。相同建筑与原始材质复用一份副本，正常恢复后保留缓存，直到实例、网格或材质关联消失；外部系统替换句柄时不覆盖它的新绑定。柜台、货架、NPC、包裹与未知部件不被当作外壳淡化。效果只改变视觉，不改变角色、包裹与建筑的真实碰撞，也不开放隔墙拾取。

建筑遮挡系统只决定外壳是否需要淡化，不写相机 `Transform`，不缩短环绕距离、不自动绕行，也不对镜头落入墙面的情况执行位置避让或隐藏自身人物模型。地形、树干、码头和其他非建筑物保持正常外观，不进入透明需求。当前能力边界是建筑外壳半透明，未包含镜头碰撞与非建筑遮挡消除；自身模型可见性仅遵循第一／第三人称模式。

`OrbitCamera` 具有有效角色目标且仍为第三人称就参与建筑遮挡检测，与现有跟随镜头一致；控制者解绑但镜头仍呈现时不提前恢复建筑。切换第一人称、相机或目标失效时清除对应第三人称需求；没有有效第三人称相机时立即恢复外观，其他相机仍有效时按其需求和恢复宽限处理。场景销毁时释放材质副本与失效缓存。暂停不推进检测与淡化计时，但销毁和失效目标清理仍执行，避免返回主菜单或再次开局继承旧场景状态。组件与调度结果使用无窗口回归检查，真实透明叠层、室内可读性和固定环绕镜头观感由用户按 [镜头遮挡验收](testing.md#第三人称遮挡与建筑淡化验收) 确认。

## 调度与模拟边界

| 阶段 | 数据变换与执行依赖 |
| --- | --- |
| 插件构建 | 初始化 `ArtAssets`，由 `FromWorld` 发起五份 GLB 加载；初始化独立的 `ArtLoadState`。 |
| `Startup` | 记录加载请求并创建菜单输入控制者；`StartupLogPlugin` 注册玩法配置、固定时间步、姿态同步约定与检查器启用日志。启动日志不依赖已生成玩法实体。 |
| `First` | `limit_frame_rate.before(TimeSystems)` 在引擎更新时钟前补足帧间剩余时间。 |
| `PreUpdate` | 更新鼠标捕获和菜单上下文，Enhanced Input 评估动作并通过 Observer 更新意图、观察角度或切换请求；动作应用后消费菜单请求及视角切换请求。 |
| `StateTransition` | 紧随 `PreUpdate`；主菜单入口生成展示舞台，游戏入口准备海岛会话的光照和加载相机，暂停入口清意图并冻结时间，退出状态清理对应实体。 |
| `FixedFirst` | 落水恢复的插值清理在 `TransformEasingSystems::Reset` 之后、`UpdateStart` 之前执行；只移除上次恢复临时添加的暂停组件，让本固定步从恢复后的位置重新采样。 |
| `FixedUpdate` | `recover_from_water` 明确在 `sync_character_facing` 与 `GameplaySystems::Simulate` 之前执行；恢复出生姿态后，本步先按当前相机水平角同步角色朝向，再进入模拟。恢复解除关系的延迟命令在模拟前可见。随后更新重力与接地状态、施加移动力和跳跃冲量、执行交互、同步持握目标并施加持握力。相关系统通过显式顺序共享同一步状态。 |
| `FixedPostUpdate` | Avian 的 `PhysicsPlugins` 执行固定物理步，积分速度与位姿并求解接触和碰撞；`PhysicsSystems::Writeback` 之后再次更新接地并采样实际速度。真实支撑接触的落地音效收集在 `PhysicsSystems::StepSimulation` 之后执行。 |
| `FixedLast` | Avian 记录本固定步的插值端点，供渲染帧呈现使用。 |
| `RunFixedMainLoop` 固定循环之后 | `CameraControlPlugin` 的显示同步链在 `TransformEasingSystems::Ease` 之后、`UpdateEasingTick` 之前执行；使用本帧插值位置，依次同步角色朝向、`HeldTarget`、环绕镜头、建筑遮挡需求、建筑淡化和人物可见性。 |
| `Update` | 检查美术加载状态；游戏运行且 `ArtLoadState::Ready` 后按装配地图、准备结构碰撞、生成业务实体的链路推进。主角动作读取固定模拟后的实际速度与持有关系。UI 仅按页面、分类、返回来源或视口变化重建 BSN 树并应用延迟命令，草稿数值与提示原位更新，再读取鼠标命中，最后更新样式、说明与滚动；音效播放在 UI 样式之后消费请求。 |
| `PostUpdate` | Bevy 的变换传播根据业务根实体 `Transform` 更新模型子实体的 `GlobalTransform`，可见性传播应用人物视觉状态，供渲染使用；Egui 仅在游戏运行时绘制检查器。 |

相机与玩法的固定步顺序由显式依赖表达；跨阶段数据流依赖 Bevy 默认主调度，`PreUpdate` 结束时应用动作命令，完成状态转换后进入固定循环。玩法模拟和相机姿态同步只在 `Running` 执行。一次渲染帧可以没有固定步，也可以有多个固定步，因此输入 Observer 不直接积分角色位置。

角色朝向与持握目标同步保留在 `FixedUpdate`。物理持握施力直接读取持有者的 Avian `Position` 与最新水平朝向计算模拟目标，`HeldTarget` 仅用于呈现检查和检查器，不作为物理解算的位置来源，避免把插值状态反馈进模拟。角色使用 `TranslationInterpolation`，木箱使用 `TransformInterpolation`；固定循环后的显示链在插值完成后再次同步目标、镜头、遮挡与淡化状态和人物可见性，使没有固定步的帧也能使用本帧视角与呈现位置。该链不直接搬动箱体、不施力或消费请求，不额外推进模拟时间。`PostUpdate` 再传播实际业务根实体的呈现姿态，保证木箱视觉子实体与箱体根一致。

`GameplayPlugin` 注册 `DemoPhysicsPlugin`，后者安装 Avian 默认固定调度的 `PhysicsPlugins`。项目不再手动积分角色位移或把角色高度夹到 `ground_y`：Avian 统一处理重力、速度积分与碰撞。接地通过脚底球体 shape cast 和地面法线判断，探测按角色的真实碰撞层过滤支撑物，持握箱不会作为角色支撑面；跳跃请求只在接地时施加一次向上冲量，侧面碰墙不能充当地面。移动轴先限制长度再转换为水平目标速度，通过力加速或减速，空中操控力度低于接地时；碰撞与外力可以改变实际速度，斜向输入不会提高目标速度。

角色使用 `SweptCcd::NON_LINEAR.with_velocity_threshold(8.0, 0.1)`，保留非线性扫掠算法，只在相对线速度达到 `8 m/s` 或相对角速度达到 `0.1 rad/s` 时触发。真实海岛的无窗口对照已将物流站入口和室内驻足的主要 CPU 开销定位到旧默认配置的零速度门槛：静止接触也反复扫掠密集建筑三角网格。默认目标移动速度 `4.5 m/s` 与跳跃初速度 `5 m/s` 的合速度低于线速度门槛，普通运动由已有推测接触覆盖；高速运动或外部冲量仍触发 CCD。当前依赖的 `LINEAR` 算法在非零水平 yaw 的高速薄墙回归中不能正确阻挡，不能以胶囊轴对称为由替换。

纸箱和木箱的 CCD 配置不变，继续使用默认 `NON_LINEAR` 和零速度门槛，保留动态接触与旋转扫掠。角色碰撞形状、旋转约束或运动速度变化后，应重新评估速度门槛并运行高速与普通接触回归。性能回归和用户实机验收方法见 [海岛资源与无窗口验证](testing.md#海岛资源与无窗口验证)。

当前默认参数为目标速度 `4.5 m/s`、接地加速度 `30 m/s²`、松键制动加速度 `45 m/s²`、空中加速度 `6 m/s²`、重力 `9.81 m/s²`、跳跃速度 `5 m/s`、角色质量 `75 kg`，胶囊高度 `1.9 m`、半径 `0.32 m`。箱体质量为 `3 kg`；持握使用 `3 Hz`、阻尼比 `1` 的弹簧阻尼力，最大拉力为 `450 N`。这些参数在 `PrototypeConfig` 中定义，重力每个固定步同步到物理资源；检查器编辑只影响当前会话。

渲染循环上限和固定 60 Hz 模拟分别管理。限帧系统只等待剩余间隔，超时后从实际帧起点重新计时；`WinitSettings::continuous()` 避免窗口失焦时额外套用默认更新频率。窗口使用 `AutoNoVsync`，但平台可能回退。当前已启用物理运动插值、刚体碰撞及第三人称建筑外壳淡化，尚无镜头碰撞、滚轮缩放、自动绕行镜头或通用自动跨越台阶的角色控制规则；海岛入口通过场景中的斜坡碰撞支持通行。

### 持箱转向错位的经验

自由视角曾出现持箱转动鼠标时木箱抖动或虚影。旧实现让 `Fire<LookAction>` 每帧更新环绕角，`Update` 据此更新镜头，而人物朝向和持箱姿态仅在 60 Hz 的 `FixedUpdate` 更新。渲染为 120 FPS 时，部分帧没有固定步，镜头使用本帧角度，人物和箱子仍使用上一固定步的角度；固定步再次执行后箱子才追上，导致画面中的相对姿态交替滞后。

原测试在鼠标输入后的 `app.update()` 返回时，没有立即检查姿态，而是先主动补跑一次固定步。补跑使人物与箱子追上镜头，掩盖了真实渲染帧已经发生的错位。回归测试必须检查每个实际帧末的状态，具体方法见[避免测试掩盖帧间错位](testing.md#避免测试掩盖帧间错位)。

当时的修复保留固定步的模拟顺序，同时在 `Update` 明确建立“人物水平朝向 → 持物姿态 → 相机”的同步链，再由 `PostUpdate` 传播视觉子实体的世界变换。该链只同步当前角度对应的姿态，移动、重力和拿放仍由固定步执行；放下后的物体因已移除 `HeldBy`，不会继续跟随。

用户已通过实际游玩反馈确认，持箱转动视角的虚影消失。反馈仅确认这一现象，未单独提供 60／120 FPS 或完整验收清单的执行结果。后续增加手持工具、武器或其他随角色转向的附件时，也应核对本帧的角度来源、附件姿态和相机是否一致；通用约束见[固定模拟与逐帧显示的一致性](development.md#固定模拟与逐帧显示的一致性)。

接入 Avian 后，物理持握允许箱体因惯性和碰撞暂时偏离目标。当前回归检查持握目标是否在本帧同步、实际箱体根与视觉子实体是否一致，不要求箱体瞬间等于目标。显示同步移到固定循环后的插值阶段，仍保留实际 `app.update()` 返回后立即断言的测试边界。

## 持有关系与生命周期

`HeldBy` 是快递到持有者的自定义 Bevy 关系，`HoldingItems` 是 Bevy 自动维护的反向索引。业务系统插入或移除 `HeldBy`，只读取反向索引。

交互系统在范围内选择距离最近的未持有 `Pickable`，射线检查阻挡，防止隔墙抓箱；已有持有物时，取反向索引中的第一件解除持握。拿起和释放都不瞬移箱体，释放保留当前位置、线速度与角速度，后续由重力、惯性和碰撞推进。

玩法系统通过 `.chain()` 建立顺序，并在交互与目标同步、施力之间应用延迟命令，使本步新建立的持有关系立即可见。交互系统为本批次拾取维护临时预留集合，防止命令尚未应用时两个角色重复占用同一箱体。当前业务按一次持有一件实现，关系容器本身可存多件，尚无多件携带规则。

`sync_held_objects` 在固定步和逐帧同步中复用，只根据当前有效的 `HeldBy` 计算 `HeldTarget` 的位置与朝向，不消费输入、积分运动或写箱体 `Transform`。固定步的持握系统按目标误差施加弹簧阻尼力与角加速度，并向角色施加相反的力；箱体始终为动态刚体，受阻时保留真实碰撞结果。

`CarryGrip` 保存每件物品相对角色脚底与水平朝向的持握偏移。普通纸箱和易碎纸箱使用 `(0, 1.3, -0.48)`，较大的木箱使用 `(0, 1.3, -0.62)`。模拟施力目标和逐帧 `HeldTarget` 同步都读取该组件，避免美术持箱姿态与两条目标计算路径不一致；不同尺寸的物品仍沿用同一拿放与碰撞规则。

`GamePhysicsLayer` 分为 `World`、`Character`、`Parcel` 和仅供相机空间查询的 `CameraQuery`。自由箱体与前三层碰撞；持有期间忽略 `Character` 层，避免手前目标与角色自身互撞，保留 `World` 与 `Parcel` 碰撞。`CameraQuery` 实体的空碰撞掩码阻止真实接触，玩法空间查询另外只选前三层。目前场景只有一个角色，因此持有过滤暂不区分持有者与其他角色。释放后恢复自由箱体的碰撞层。

当持有者销毁或持有关系异常解除时，清理失效目标并恢复自由碰撞。箱体一直保留动态刚体和重力，因此会继续自然下落；不依赖释放时把箱体放到地面的兜底瞬移。清理记录失效关联及原因日志。

下列边界继续暂缓，未纳入当前原型的实现与验收范围：

| 场景 | 当前限制 |
| --- | --- |
| 多个角色在同一固定步请求拿起同一个木箱 | 已有同批次预留防止重复占用；尚无多人公平裁决与联机抢箱规则。 |
| 角色退出或被销毁时仍持有木箱 | 已有失效目标清理与自然释放；尚无角色退出前的主动交接业务流程。 |
| 多角色持有碰撞过滤 | 当前忽略整个 `Character` 层，尚未实现只忽略持有者的细分规则。 |

## 主角动画与落水恢复

`CharacterAnimationPlugin` 等待主角视觉实例、GLB 与片段就绪后，按名称绑定 `Idle`、`Walk`、`Walk_Backward`、`Walk_Left`、`Walk_Right`、`Carry_Idle`、`Carry_Walk`、`Carry_Backward`、`Carry_Left`、`Carry_Right`、`Jump`、`Fall`、`Carry_Jump`、`Carry_Fall`、`Land`、`Carry_Land`。所有片段均长 `0.8 s` 且无根运动；`Jump / Land` 及对应持箱片段为一次性动作，其他片段循环，人物位置由物理模拟决定。八个步行片段保持同一左右脚相位，持箱只改变上身，腿部与对应空手动作一致；制作源与独立刷新入口见 [美术说明](../art/ASSET_GUIDE.txt)。

逐帧系统在固定循环的姿态同步后将实际水平速度转到人物局部空间，按前后左右速度分量分配动作权重；静止到行走使用 `0.15..0.65 m/s` 的连续过渡，权重以 `75 ms` 时间常数指数平滑。所有步行动作共用归一化相位，按前后 `1.5 m/s`、侧向 `1.1 m/s` 的资产步长调整步频，并补偿斜向混合造成的步长缩短。转向、拿放和速度变化不重启播放器。接地短暂丢失有 `60 ms` 过滤，真实向上起跳立即进入空中姿态；最高点附近保留起跳／下落状态以避免抖动，空中停止推进步相位。起跳片段在 `0.24 s` 内走完整并保持尾姿，下落按独立时钟循环；真实空中到接地时播放一次 `0.22 s` 落地缓冲，再回到当前速度对应动作。空中拿放使用同一阶段进度，暂停冻结时钟；一次性片段暂停自动推进后显式采样，避免 Bevy 在尾帧环回。

GLB 的八个 `Courier_Sole_*` 鞋底子节点跟随足部骨骼。`PostUpdate` 在动画求值后、变换传播前读取当前骨链姿态，按角色脚底平面修正视觉高度，避免不同方向混合伸直腿链后穿地；补偿不修改角色业务根、物理碰撞或持握目标。角色关联失效后停止播放器并清理绑定。NPC 不使用这套玩家动画路由。


`IslandRecoveryPlugin` 的 `recover_from_water` 在 `FixedUpdate` 明确先于 `camera::sync_character_facing` 和 `GameplaySystems::Simulate` 读取 Avian `Position`，玩家脚底或可搬物品中心低于 `Y = -1.5` 时恢复。玩家先解除持握关系，使物品恢复自由碰撞，再回到自己的 `SpawnPoint`，清除线速度、角速度与未消费的跳跃、交互请求；持续移动轴保留。恢复出生朝向后，本固定步立即按当前相机水平角重新同步角色朝向，再计算移动力，保证按住 W 时恢复当步也沿当前视角前进，不使用出生朝向计算移动方向。玩家恢复只释放手中物品，物品自身落水后再独立回到各自的出生姿态并清除运动。

恢复同时写入物理位姿与呈现 `Transform`，唤醒休眠刚体，并用 `NoTranslationEasing`、`NoRotationEasing` 暂停跨岛插值；暂停保持到下一固定步，因此连续没有固定步的渲染帧不会重新显示海中的旧位置。下一次 `FixedFirst` 的 `resume_interpolation` 在 `TransformEasingSystems::Reset` 之后、`UpdateStart` 之前清理本模块临时添加的暂停项，保留此前已有的暂停组件，再从新位置采样。恢复后物理位置已经离开阈值区，不会在连续更新中重复触发同一次恢复。

恢复属于异常位置的生命周期处理，普通释放仍保留实际位置与速度，日志为 `Carryable item picked up`、`Carryable item released`。加载状态、地图准备、动态实体生成、动画初始化及动作变化、落水恢复均通过统一会话日志记录；动画状态采用 `Idle`、`Walk`、`Carry_Idle` 等英文值。恢复消息为 `Entity recovered after entering water`，含 `position_before`、`position_after` 和 `reason="water_recovery"`；失败路径保留资源路径和原始错误。可复用检查与用户验收见 [验证指南](testing.md)。

## 音效数据流

`GameplayPlugin` 注册 `SoundEventsPlugin`。拾取与主动释放只在 `handle_interaction` 接受操作后，用 `Commands::write_message` 和关系变更一起提交 `SoundRequest`。固定步链的同步点保证关系和消息同时可见，失败尝试不会产生成功反馈。释放提示与真正的落地是两个事件。

菜单复用同一 `SoundRequest` 消息。真实键盘／手柄导航改变焦点，或真实鼠标移动进入已有可操作按钮时发送 `MenuHover`；静止光标、按钮内移动、页面重建产生的 `Hovered` 和单按钮页面导航不产生悬停音。集中请求消费系统每帧只接受一项 `UiRequest`，只在开始、打开页面、改变分类、实际调整设置、恢复默认或成功应用等有效结果后发送 `MenuConfirm`；音量拖动期间不连续确认，只在释放且最终值改变后一次。`Back`、恢复运行和返回主菜单发送 `MenuCancel`，游戏中按 Esc 打开暂停发送 `MenuConfirm`；设置保存失败也用 `MenuCancel`，不借用交付失败事件。无效动作、当前分类重选和设置边界不发声。鼠标确认请求在下一次 `PreUpdate` 被接受后发出反馈；`Update` 的指针悬停反馈由后续播放系统同帧消费。`Test SFX` 在主菜单或暂停的 Audio 页请求 `ParcelPickup`，不建立持有关系，按 SFX 分类遵守正常播放限制。

`warn_hold_strain` 在 `FixedUpdate` 的 `GameplaySystems::Simulate` 之后读取角色与包裹的模拟 `Position`，按最新水平朝向与物品的 `CarryGrip` 计算手前目标，和实际持握施力使用同一偏移来源，检查持续误差。新持握有 0.5 秒宽限；距离超过 0.65 米持续 0.35 秒触发一次，降到 0.45 米以下才重置。系统的 `Local` 只保存当前持握包裹的时间与锁存状态，解除关系或销毁后清理；这是音频提示阈值，不代表新增失稳玩法规则。

`emit_parcel_land` 在 `FixedPostUpdate` 的 `PhysicsSystems::StepSimulation` 之后读取只读 `ContactGraph`，逐步检查活动与休眠的真实支撑接触。只有未持握的 `Parcel`，在向上支撑法线至少 0.65、法向求解冲量至少 1.8 kg·m/s 时发出落地事件，并锁存到完全失去支撑；侧墙、轻微接触和持续静置不发出。Avian 的预测接触可能在实际撞击前产生 `CollisionStart`，因此不能只在开始事件当步检查冲量，否则会漏掉后续实际落地。现有碰撞日志继续独立读取开始与结束消息。

落地和持握警告收集系统受 `gameplay_running` 条件限制，主菜单和暂停时不产生新的玩法反馈。默认主调度在固定模拟后进入 `Update`。`GameAudioPlugin` 在 `UiSystems::Style` 之后先选择并同步有效音量，再连续消费短音请求，清理已停止的实例，按清单冷却、单事件并发和全局四个声音上限排队；其中为 UI 预留一条，SFX 最多占用三条。冷却使用 `Time<Real>`，暂停冻结虚拟时间不会阻断菜单反馈。Kira `Queued` 状态同样计入并发；尚未加载的音效直接略过，避免稍后重放过期交互。第一版为全局二维反馈，尚无距离衰减或方位。UI 与 SFX 使用独立类型通道，退出时停止；`Quit` 直接退出，不等待确认音播完。Bevy 内建音频插件在主入口关闭，避免两个后端同时初始化设备。

`AudioMix` 保存有效音量及是否处于预览：设置页使用 `SettingsDraft.audio`，切换分类仍预览，离开设置页使用最近成功应用的 `GameSettings.audio`。两个业务通道的线性增益分别为 `0.25 × master_volume / 100 × ui_volume / 100` 和 `0.25 × master_volume / 100 × sfx_volume / 100`，再乘清单素材增益后换算为 Kira 分贝；默认三个 `100%` 保留素材间响度。Kira 0.26 的通道 `set_volume` 会覆盖实例绝对音量，因此 `sync_voice_volumes` 逐实例按素材基准与统一增益更新正在播放的声音；`PostUpdate` 在 `AudioSystemSet::PlayTypedChannels` 后再次同步刚从 `Queued` 就绪的实例，避免多留一帧旧增益。零增益使用明确的 `Decibels::SILENCE`，新请求直接丢弃，不占冷却或并发，恢复音量不重放。预览进入／退出和正式配置变化记录 `Audio mix changed`；箭头调整及拖动释放汇总记录 `Audio volume preview changed`，试听记录 `Audio sample requested` 与 `reason="settings_preview"`，加载、保存和应用日志包含三项音量。

清单在编译时嵌入，文件路径相对 `assets`，启动时校验映射和策略，再由 `AssetServer` 加载。清单无效只禁用声音并记录错误，素材加载错误包含实际路径与外部错误；修改清单后需要重新编译。合成环境底声只供试听，不预加载、不自动循环。交接、推车、弹开和交付的 `SoundCue` 供未来业务结果发送，当前没有伪造触发器。资源与事件表见 [音频管线](audio.md)。无窗口测试不安装 `GameAudioPlugin`，因此不会打开音频设备。

## 会话日志实现

`main` 在添加 `DefaultPlugins` 前调用 `session_log::prepare` 创建日志目录和文件；失败时中止启动。文件使用 Unix 时间戳、纳秒和 UUID 命名，以 `create_new` 防止覆盖；文件名和日志时间分别使用 Unix 时间与可读 UTC 时间。

随后通过 Bevy `LogPlugin::custom_layer` 的文件层和 `LogPlugin::fmt_layer` 的控制台格式层输出，沿用统一日志过滤，文件层关闭 ANSI 颜色。文件和控制台分别使用无界队列和独立后台写入线程；游戏系统记录事件时只将格式化内容入队，不在调用线程等待文件或 stderr 的实际写入与刷新，也不因队列已满而丢弃记录。两个输出端相互隔离，慢控制台不会阻塞文件记录，慢文件也不会阻塞控制台。临时写入器资源在插件构建时取出，由日志 layer 和会话守护对象持有，不作为玩法共享状态。

移动时可能连续产生接地、碰撞和动画状态变化；旧同步文件写入和控制台输出会把外部 I/O 的等待带入游戏帧。后台输出保留这些记录，不通过降低日志级别或省略关键变化规避开销。两路格式层显式设置 `.log_internal_errors(false)`，关闭 tracing 的同步 stderr 错误回退，防止设备故障后重新阻塞事件调用或先于 panic 文件同步等待控制台；后台保留首个错误，在刷新和关闭时反馈。文件与控制台显示可以稍晚于事件发生，核对完整会话时应等待刷新完成。

`LogPlugin` 初始化后记录会话开始与版本，设置、场景、输入、相机和玩法模块记录各自关键变化。`App::run` 返回后由 `record_exit` 记录退出结果，先等待文件队列、再等待控制台队列写完并刷新；守护对象释放时显式发送关闭命令，排空两路输出并等待写入线程结束。全局日志 layer 仍持有队列发送端，不能依赖发送端析构结束线程。退出阶段可以等待 I/O，普通日志调用不能承担这项等待。写入或刷新失败会保存错误，并通过后续写入、刷新或关闭结果反馈。

panic hook 尽力记录错误，优先等待文件队列写完并调用 `sync_data`，然后调用原有 hook；不先等待可能阻塞的控制台。写入线程自身发生 panic 时由线程内部捕获并反馈，避免等待自己的队列。panic 日志通过已安装的 subscriber 输出，不能保证覆盖日志插件就绪前的异常或进程被强制终止的情况。慢写入端隔离与完整刷新回归见 [验证指南](testing.md#按变更类型选择检查)。

`StartupLogPlugin` 集中注册 `log_configuration`、`log_simulation_timestep`、`log_pose_synchronization` 和 `log_world_inspector` 四个 `Startup` 系统；前两个分别只读 `PrototypeConfig` 和 `Time<Fixed>`，后两个记录当前装配采用的固定约定。资源继续由玩法插件和主入口准备，日志插件不创建默认配置，也不添加功能插件。四条日志之间及其与场景生成之间没有显式执行顺序，均不依赖已生成实体。各条日志保留原来的 `demo::gameplay`、`demo::settings`、`demo::camera` 和 `demo::inspector` target，日志过滤与查找路径保持一致；会话文件和退出刷新仍由 `session_log` 管理。

其中 `log_pose_synchronization` 通过统一日志设施记录 `Camera pose synchronization configured`，字段 `simulation_schedule="FixedUpdate"`、`grip_force_schedule="FixedUpdate"`、`physics_schedule="FixedPostUpdate"`、`presentation_schedule="RunFixedMainLoop"` 和 `presentation_order="interpolation_character_facing_hold_target_camera_occlusion_fade_visibility"` 说明模拟与显示同步的阶段和顺序，便于排查持箱转动或视角切换时的不同步问题。相机初始化记录 `perspective="third_person"`；每次有效切换以 `info` 级别记录 `Camera perspective changed`，包含 `perspective_before`、`perspective_after`、`yaw`、`pitch_before`、`pitch_after` 和 `reason="toggle_perspective_action"`。

连续角度和世界速度按 `debug` 级别最多每 0.5 秒采样一次，离散输入与鼠标捕获变化使用 `info`。日志查找见 [README](../README.md)，过滤设置见 [开发规范](development.md#日志排查)，用户验收步骤见 [验证指南](testing.md)。
