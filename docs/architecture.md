# 当前 demo 架构

本文是当前代码组织、ECS 归属和数据流的查阅入口。项目玩法尚未确定，探索方向见 [设计探索](game-design.md)，操作与配置见 [使用说明](usage.md)，工程约定见 [开发规范](development.md)。[交互式架构图](diagrams/README.md) 提供真实应用的调度快照、对象关系及源码定位。

## 模块职责

[main.rs](../src/main.rs) 显式装配功能插件、运行设置与固定时钟。`src/` 的每个一级功能目录只定义一个项目 Plugin，内部实现和无窗口测试使用平铺文件；功能插件不自动安装其他项目插件。

| 功能与源码入口 | 唯一项目 Plugin | 职责 |
| --- | --- | --- |
| [game_flow/](../src/game_flow/mod.rs) | `GameFlowPlugin` | 管理应用与运行子状态、模拟时钟，以及跨功能调度集合的依赖。 |
| [first_person/](../src/first_person/mod.rs) | `FirstPersonPlugin` | 注册玩家动作与控制者路由，管理捕获、朝向、镜头和自身视觉显示。 |
| [character/](../src/character/mod.rs) | `CharacterPlugin` | 定义角色身份、身体、意图和运动状态，执行接地、移动与跳跃。 |
| [item_interaction/](../src/item_interaction/mod.rs) | `ItemInteractionPlugin` | 定义物品身体，管理拾取、共享刚体持握、转向碰撞、释放和音效反馈。 |
| [physics/](../src/physics/mod.rs) | `GamePhysicsPlugin` | 安装 Avian，提供共享碰撞层，同步重力并记录碰撞。 |
| [bounds_recovery/](../src/bounds_recovery/mod.rs) | `BoundsRecoveryPlugin` | 管理角色和物品的落水恢复及临时插值暂停。 |
| [scene_assembly/](../src/scene_assembly/mod.rs) | `SceneAssemblyPlugin` | 加载运行资源，装配地图、静态碰撞与动态业务实体。 |
| [character_animation/](../src/character_animation/mod.rs) | `CharacterAnimationPlugin` | 绑定、混合主角动作并补偿视觉接地。 |
| [ui/](../src/ui/mod.rs) | `GameUiPlugin` | 管理页面生命周期、菜单输入、控件、音量编辑与独立展示舞台。 |
| [audio/](../src/audio/mod.rs) | `GameAudioPlugin` | 提供音效消息契约，管理 Kira 播放、混音与设备输出。 |
| [settings/](../src/settings/mod.rs) | `SettingsPlugin` | 管理设置持久化、草稿、共享原型参数与渲染限帧。 |
| [inspector/](../src/inspector/mod.rs) | `InspectorPlugin` | 安装 Egui 和世界检查器，直接反射 ECS 世界。 |
| [session_log/](../src/session_log/mod.rs) | `SessionLogPlugin` | 在其他插件构建前安装统一日志，管理后台输出与退出刷新。 |
| [window_policy/](../src/window_policy/mod.rs) | `WindowPolicyPlugin` | 管理原生窗口约束、窗口线程策略安装与清理。 |

依赖声明和锁定版本分别见 [Cargo.toml](../Cargo.toml) 和 [Cargo.lock](../Cargo.lock)。

`GameFlowPlugin` 只注册状态和时钟行为，并调用 `configure_feature_order` 连接公开调度集合。该普通函数只配置顺序，不安装插件、资源或行为系统；没有应用状态的跨功能测试可复用它。`main` 单独安装一次第三方 `EnhancedInputPlugin`，`FirstPersonPlugin` 与 `GameUiPlugin` 分别注册 `GameplayContext` 和 `MenuContext`，两者不借用彼此的插件安装输入基础设施。

`PrototypeConfig` 与设置字段 `SettingKey` 分别归属 [prototype.rs](../src/settings/prototype.rs) 和 [draft.rs](../src/settings/draft.rs)；角色、物品、场景和 UI 消费这些数据契约。

## 菜单与会话生命周期

`AppState` 区分 `MainMenu / InGame`；`PlayState` 是只在 `InGame` 存在的 `Running / Paused` 子状态。进入游戏先准备会话光照与加载相机，运行时才推进 [场景装配](#美术加载与-bsn-场景装配)。暂停保留实体、持有关系和装配进度，不退出会话。

地图根、独立业务根、控制者、相机和灯光通过 `DespawnOnExit(AppState::InGame)` 清理，NPC、碰撞和视觉子树沿 `ChildOf` 清理。`ArtAssets` 强句柄与 `ArtLoadState` 跨会话保留；再次开始复用资源，创建新地图实例。

`MenuState` 管理页面、分类、返回来源与提示；`MenuFocus` 保存可操作按钮序号，`MenuInputSource` 区分鼠标与导航来源。设置和帮助切换页面，不改变其主菜单或暂停来源。`SettingsDraft` 与已应用的 `GameSettings` 分离；切换分类保留草稿，成功保存后才替换已应用值。预览与返回规则见 [设置](usage.md#设置)。

菜单控制者的高优先级 `MenuContext` 使用 `require_reset`；动作与绑定通过 BSN `Actions<Context>` 和 `Bindings` 声明，随控制者一起清理。键盘、手柄与原生 `PointerPress` 主键消息均产生 `UiRequest`。按钮使用 `bevy::ui_widgets::Button`，`Hovered` 表达悬停，`Pressed` 与项目 `PrimaryPress` 区分原生任意键按压和主键来源；原生键盘 `Activate` 不进入请求，避免与 Enhanced Input 重复。集中入口每帧接受一项语义请求；连续滑条采样合并，返回优先于同帧采样，最终数值与释放反馈一并处理。

请求在 `PreUpdate` 的 `EnhancedInputSystems::Trigger` 后消费，确保动作 Observer 已写入请求，随后进入 `StateTransition`。`Update` 先重建并销毁旧页面，再消费缓冲的 `PointerPress`；从原始命中沿 `ChildOf` 查找仍存活的菜单按钮，同帧按下并释放也保留点击，右键与中键不生成请求。鼠标请求留到下一次 `PreUpdate` 消费，避免旧页面返回动作穿透。样式统一读取输入来源、焦点与交互；真实光标移动切回鼠标来源，静止光标和页面重建产生的 `Hovered` 不抢导航焦点。完整规则见 [UI 布局与高亮规范](development.md#ui-布局与高亮规范)。

音量滑条通过主键 `PointerPress` 命中开始捕获，并局部读取底层左键与物理光标位置，表达菜单动作无法提供的绝对轨道坐标。滑条不走普通按钮请求路径；同帧完整点击仍采样最终位置并结束捕获，释放、失焦、光标离窗或页面销毁时也结束捕获。原生 `Pressed` 移除时清理项目 `PrimaryPress`；`PickingSystems::Last` 后还按指针身份补清取消状态，窗口失焦或鼠标离窗也清理鼠标按压，避免后续副键继承残留样式。

`CharacterPlugin` 在 `OnEnter(AppState::MainMenu)` 和 `OnEnter(PlayState::Paused)` 清空 `CharacterIntent`。暂停时，第一人称功能响应同一状态停用 `GameplayContext` 并释放鼠标，应用流程冻结 `Time<Virtual>` 与 `Time<Physics>`，UI 切换到暂停页；各功能只处理自己拥有的状态。物理增量立即归零，避免复用前一步增量。玩法、显示同步、动画状态和落水恢复受 `gameplay_running` 门控；输入捕获检查仍执行。菜单继续响应，恢复后重新启用时间，捕获恢复当帧跳过自由光标位移。主菜单只运行虚拟时间以播放展示动画，物理时间暂停。无应用状态的最小测试中，`gameplay_running` 允许独立玩法系统执行。

`Continue`、`Multiplayer` 和未实现设置项只声明灰色 `Coming Soon` 展示节点，不包含 `Button`、`MenuButton` 或业务动作，因而不会进入鼠标行为或键盘焦点列表。菜单行为与占位说明见 [使用说明](usage.md#菜单与占位功能)。

## BSN 页面与菜单展示资产

UI 控件与主菜单舞台通过 `bsn!`、`bsn_list!` 和返回 `impl Scene` 的辅助函数声明结构；系统负责交互和运行时变化。页面与共享控件入口见 [pages.rs](../src/ui/pages.rs) 和 [widgets.rs](../src/ui/widgets.rs)。

`rebuild_page` 仅在页面、分类、返回来源或视口结构变化时替换 `MenuRoot`。焦点、设置值和成功／失败提示原位更新，保留按钮、音量滑条和滚动实体身份。内容缩短时只夹取越界的 `ScrollPosition`；离页再进入或切换分类才初始化新页面。

主菜单、暂停与帮助是固定内容区，没有 `MenuScroll`。设置仅右侧面板的标题、字段、说明和保存提示滚动；分类、底部操作和页脚固定。滚轮及焦点滚入只作用于该内容区。

视口与 `Scrollbar` 轨道是同一容器的兄弟，轨道以普通 `Entity` 引用目标，`ScrollbarThumb` 直接属于轨道。原生 `ScrollbarPlugin` 管理比例、拖动、轨道分页及指针清理，控件不进入菜单导航。项目在 `PostUpdate` 的 UI `Layout` 后、可见性传播前同步显隐、拾取、高亮与有效范围；无溢出时归零并隐藏，离页或失效拖动同步清理。右侧预留空间不随显隐改变，避免内容折行反复切换。

`UiSystems` 声明 `Build / Pointer / Style`，`Update` 的局部依赖是 `Build → Pointer → 音量处理 → Style`。滚动条绑定只约束在 Build 后、Style 前；两个音量系统之间及 Style 内的样式、数值、说明、焦点滚入之间均无全序。Build 的延迟命令在后续读取前应用。

文字测量与高亮约束见 [UI 布局规范](development.md#ui-布局与高亮规范)，字体测量与输入来源回归见 [验证指南](testing/README.md#文字布局与高亮回归)。

主菜单的 `MenuBackdrop` 使用 `DespawnOnExit(AppState::MainMenu)` 管理相机、光照和展示模型；设置和帮助沿用这个舞台，暂停沿用当前玩法相机。菜单相机标记 `IsDefaultUiCamera` 与 `PrimaryEguiContext`，进入游戏时随舞台销毁，玩法相机接管界面。

模型通过 `WorldAssetRoot` 加载 `#Scene0`；快递员实例、父 GLB 和命名片段就绪后，在骨架的 `AnimationPlayer` 循环播放 `Carry_Idle`。展示包裹是独立模型附件，没有角色控制器、Avian 刚体或玩法持有关系。菜单舞台与可游玩海岛分别装配；菜单模型不参与玩法碰撞或交互。字体资源与资产准备约定见 [使用说明](usage.md#美术与字体准备)。

## 设置草稿与持久化

保存设置前校验与序列化完整 `GameSettings`，然后在根 `tmp/settings-save/` 写入唯一临时文件、同步并关闭句柄，再用 `rename` 替换目标文件。替换失败时保留原文件并清理临时产物；临时文件与设置及会话日志各自管理。菜单步进范围不收紧 JSON 的有效范围，打开设置保留有效自定义值，实际调整相应字段后才进入菜单范围。

音量的 `SetVolume` 请求只更新草稿，`FinishVolumeEdit` 在释放且最终值改变时汇总反馈；`TestSfx` 只发 `SoundRequest`。字段、默认值、步进与缺省兼容见 [设置](usage.md#设置)，草稿到有效混音的数据流见 [音效数据流](#音效数据流)。

## 原生窗口策略

`WindowPolicyPlugin` 在窗口线程的 `PreUpdate` 通过 `NonSendMarker` 读取线程局部 `WINIT_WINDOWS`，确认真实主窗口后安装策略；Windows 与 macOS 初始隐藏窗口，安装完成再显示。取得身份快照后结束后端表借用，再调用原生 API，避免同步通知重入。

原生守卫由 NonSend 资源拥有，窗口实体或后端退出时清理；安装失败显示固定窗口并记录错误。仅有 `Window` ECS 数据的测试不调用原生 API。窗口行为见 [使用说明](usage.md#菜单与占位功能)。

平台适配在系统应用尺寸前约束窗口，业务键鼠输入仍走 Enhanced Input 与 Bevy UI：

- macOS 在 `NSWindow` 上设置 `contentAspectRatio` 与工作区尺寸边界，保留 Winit 代理，禁用系统全屏和平铺。绕过比例属性的 Zoom／平铺请求仅在实际越界时校准。
- Windows 通过 `SetWindowSubclass` 处理 `WM_SIZING / WM_WINDOWPOSCHANGING`，保留 `DefSubclassProc` 链与 Winit 的 DPI 处理。客户区按 `(16k, 9k)` 计算；最大化转换为工作区内的普通窗口。共用几何入口见 [geometry.rs](../src/window_policy/geometry.rs)。

Windows MSVC 的 `GetWindowSubclass` 等静态导入依赖 Common Controls v6 清单；缺少清单时可能以 `0xc0000139`（`STATUS_ENTRYPOINT_NOT_FOUND`）在初始化前退出，此时既没有窗口策略回退，也没有会话日志。清单嵌入与链接检查见 [构建与调试](development.md#构建与调试)。

## 世界检查器

`InspectorPlugin` 在默认插件后安装，内部先注册 `EguiPlugin`，再注册受 `gameplay_running` 门控的 `WorldInspectorPlugin`。检查器复用主窗口和当前相机，在 `EguiPrimaryContextPass` 直接反射 ECS 世界，不维护数据镜像。该 pass 由 `PostUpdate` 内的 Egui 驱动，可在一帧中运行多轮，不是 `PostUpdate` 之后另一个逐帧主 Schedule。

插件的 Startup 记录表示已注册，不代表主菜单显示面板。检查器仅在游戏运行时显示，主菜单与暂停时隐藏。

F3 在游戏控制与检查器操作之间切换，检查器在两种模式下均保持显示，游戏模拟继续运行。游戏模式通过主上下文的 `EguiContextSettings.input_system_settings` 关闭键鼠与输入法转发，捕获切换清除 Egui 的遗留光标位置；检查器模式恢复转发并停用玩法上下文。切换前结束输入手势的约束见 [世界检查器](usage.md#世界检查器)。Esc 通过菜单动作进入暂停。

玩法组件、`PrototypeConfig` 和相机状态注册 Bevy 反射元数据，让检查器直接访问 ECS 数据。`HeldBy`／`HoldingItems` 不开放反射修改，反向索引继续由 Bevy 的关系钩子维护；鼠标捕获状态不开放反射编辑。检查器编辑仅影响内存中的本次会话。

## 实体与状态归属

- **控制者实体**保存 `PlayerId`、`GameplayContext`、设备绑定、`ControlsCharacter` 和 `ControlsCamera`。`PlayerId` 表达业务身份，两个控制组件使用运行时 `Entity` 指向角色与相机。
- **角色业务实体**通过 `Character`、意图与运动组件表达能力，Avian 动态刚体保存物理状态，`Transform` 表达插值呈现。根位于脚底；物理旋转锁定以防倾倒，水平朝向由相机系统同步。
- **可搬物品实体**以 `Parcel / Pickable` 表达身份和能力，根位于模型中心。自由时拥有独立动态刚体，持握时通过 `HeldBy / HeldAttachment` 连接持有者与同形碰撞代理；业务根始终独立，具体装卸见 [持有关系与生命周期](#持有关系与生命周期)。
- **展示 NPC 实例**保存 `DisplayNpc`，保留原模型和固定姿态；其 `IslandCollider` 子实体保存静态刚体与身体胶囊碰撞，不加入 `Character`、玩家意图、移动或拾取能力。碰撞随原实例和地图层级一同清理。
- **相机实体**通过 `FirstPersonCamera` 保存控制目标与观察姿态，`MouseLookState` 保存捕获状态；跟随系统根据人物本帧插值位置计算眼位，并把位置与朝向写入 `Transform`。
- **共享资源**保存跨系统配置、菜单、音频预览与资源加载状态；帧率设置的已应用值和连续数据日志采样使用各系统的 `Local`。

模型通过 `ChildOf` 属于业务根，人物视觉根带 `CharacterVisual`。玩法查询操作业务组件，网格、材质和骨骼留在视觉子树。持有关系与视觉父子关系相互独立；`Forces / RecoverableBody` 是 `QueryData`，`SpatialQuery / CarryRotationQuery` 是 `SystemParam`，几何辅助值也不作为 ECS 组件或独立系统。

## 美术加载与 BSN 场景装配

`ArtAssets` 持有海岛、主角和三类箱体的运行 GLB 强句柄，路径由 [assets.rs](../src/scene_assembly/assets.rs) 定义。制作与坐标约定见 [美术说明](../art/ASSET_GUIDE.md)，运行时不依赖 Blender。

`SceneAssemblyPlugin` 在构建时初始化 `ArtAssets`，每次发起加载后立即记录请求。`ArtLoadState` 独立保存 `Loading / Ready / Failed`，Update 轮询模型及递归依赖，主菜单期间也可完成加载。

同一插件在运行且资源 Ready 后，以 BSN 装配地图；`SpawnScene` 实例化 `WorldAssetRoot` 并触发 `WorldInstanceReady`，后续 Update 消费待准备标记。`source_asset` 元数据只在此边界识别美术实例，玩法身份与能力使用业务组件。

地图中的展示主角、易碎纸箱和三只木箱连同子树移除，由独立 GLB 重建业务实体，避免模型或碰撞重复。四名 NPC 保留，各添加一份静态 `IslandCollider` 子实体；胶囊沿本地 Y 轴从脚底开始，复用 `PrototypeConfig` 的人物高度和半径，并沿 `ChildOf` 继承原实例变换。

NPC 身体碰撞属于 `World` 层，阻挡人物、自由箱与持箱代理，但不加入角色控制或对话业务。柜台、货架纸箱和摆件是无 `Pickable` 的固定装饰。资源、地图实例和实际碰撞全部就绪后，才生成玩家与可搬物品。

静态碰撞从地形、建筑、码头、固定道具和棕榈树干的结构网格提取顶点与三角形，应用节点的实际变换后合并生成。建筑保持开放前厅与入口，不能用覆盖整栋模型的包围盒封住通道。海水、草和棕榈叶片不生成碰撞；台阶显示保留原始网格，原步阶不参与碰撞。三个商铺与两栋住宅的五组入口台阶按包围体生成不可见斜坡，并与各自实际地板边界配对：斜坡顶面接到室内地板高度，向地板内延伸 `0.05 m`，消除台阶与地板间的门槛落差和间隙。入口通行依赖这些斜坡，没有通用自动跨台阶控制器。物理组件位于静态业务根或碰撞实体，模型视觉层级不重复添加刚体。

场景生成 `PlayerId { id: 1 }` 的控制者、人物、五件可搬物和一台跟随相机。初始姿态由 [actors.rs](../src/scene_assembly/actors.rs) 装配，木箱位于不穿透的室内位置。角色和物品业务根各自保存 `SpawnPoint`，供落水恢复读取。

资源加载失败记录路径和原始错误，不提前生成玩家。交付资源规则见 [美术与字体准备](usage.md#美术与字体准备)，装配检查见 [无窗口验证](testing/README.md#海岛资源与无窗口验证)。

## 输入与相机数据流

`FirstPersonPlugin` 使用显式安装的 `bevy_enhanced_input` 注册 `MoveAction`、`LookAction`、`JumpAction` 和 `InteractAction`。设备绑定位于控制者的 `GameplayContext`，Observer 从事件的 `context` 查到对应控制目标，再写入目标状态。

移动、跳跃和交互沿下面的路径进入固定模拟：

```text
设备绑定 → Enhanced Input 动作 → 控制者 → CharacterIntent → FixedUpdate
```

`CharacterIntent.movement` 保存持续有效的移动轴，动作完成或取消时归零。跳跃和交互使用 `Press` 与 `require_reset` 产生单次请求，Observer 将相应的 `pending` 置为 `true`，固定步通过 `std::mem::take` 消费并清除。没有固定步的渲染帧不会丢失请求；消费前的同类请求会合并为一次布尔请求，当前没有动作队列。

观察动作直接更新相机持续状态：

```text
鼠标位移 → 动作 Observer → ControlsCamera → FirstPersonCamera
                                             ├→ 固定步朝向
                                             └→ 插值后的显示同步链
```

`on_camera_look` 按灵敏度和 Y 轴设置更新角度，不乘帧时间。角色朝向和移动只读取水平角，镜头位于角色眼位，初始平视。角度边界与眼位见 [当前操作](usage.md#当前操作)，显示链顺序见 [调度与模拟边界](#调度与模拟边界)。

`sync_character_visibility` 在镜头更新后按有效控制关联隐藏对应角色视觉子实体的 `CharacterVisual`，持有物与其他角色保持显示。相机或控制者丢失、关联不再有效时恢复人物显示，避免模型停留在隐藏状态。

`sync_mouse_capture` 直接读取 F3、Esc 与 `WindowFocused`，结合应用状态和控制关联更新 `MouseLookState` 与光标。F3 管理窗口捕获生命周期，必须独立于检查器模式下停用的 `GameplayContext`，并在 Egui 输入转发及 Enhanced Input Prepare 前确定本帧归属；底层 Esc 只用于及时释放，业务暂停仍由菜单动作执行。

输入归属只由捕获模式决定，点击面板内外均不切换模式。窗口失焦释放捕获，回焦后由 F3 恢复；暂停、主菜单或控制关联失效时保持释放。恢复捕获时跳过自由光标阶段累积位移。

检查器模式通过 `ContextActivity<GameplayContext>` 统一停用玩法输入，而不清空全局底层键盘资源；延迟命令在动作准备前应用。停用触发动作完成或取消，已有移动意图归零，单次动作继续遵循 `require_reset` 的松键要求。主菜单和暂停同样停用玩法输入，从暂停恢复时自动捕获鼠标。

## 调度与模拟边界

| 阶段 | 数据变换与执行依赖 |
| --- | --- |
| 插件构建 | `SessionLogPlugin` 先安装日志并记录会话开始；场景插件初始化 `ArtAssets`，由 `FromWorld` 发起五份 GLB 加载并分别记录请求，再初始化独立的 `ArtLoadState`。 |
| `Startup` | 创建菜单输入控制者；玩法、设置与检查器插件分别注册自身初始化日志，启动日志不依赖已生成玩法实体。 |
| `PreUpdate` | 更新鼠标捕获和菜单上下文，Enhanced Input 评估动作并通过 Observer 更新意图与观察角度；动作应用后消费菜单请求。 |
| `StateTransition` | 紧随 `PreUpdate`；主菜单入口生成展示舞台，游戏入口准备海岛会话的光照和加载相机，暂停入口清意图并冻结时间，退出状态清理对应实体。 |
| `FixedFirst` | 落水与释放各自恢复临时暂停的插值通道，均在 `TransformEasingSystems::Reset` 后、`UpdateStart` 前，彼此无全序。 |
| `FixedUpdate` | `FixedGameplaySystems` 依次连接 `Recover → Facing → Motion → Interaction → Target → Attachment`：落水恢复、转向检查、接地／移动／跳跃、交互、持物目标与呈现、挂接维护。物品插件的 Attachment 内部链执行失效箱释放 → 孤儿代理清理 → 质量恢复 → 挂接 → 安全对齐 → 真实姿态同步；结构依赖处应用命令。重力同步只约束在 Motion 前。 |
| `FixedPostUpdate` | 物理 First 阶段检测外部修改的休眠身体，并在 Avian `Prepare` 前应用 `WakeBody`；随后求解速度、位姿与碰撞。`Writeback` 后持物真实同步与“接地 → 速度日志”是独立分支；落地反馈只依赖 `StepSimulation`，不与日志或回写建立额外全序。 |
| `FixedLast` | Avian 记录本固定步的插值端点，供渲染帧呈现使用。 |
| `RunFixedMainLoop` 固定循环之后 | `PresentationSystems` 在 `TransformEasingSystems::Ease` 之后、`UpdateEasingTick` 之前依次连接 `Facing → HeldPhysics → HeldPresentation → Camera → Visibility`。第一人称与物品插件分别注册自己的系统，依次同步角色朝向、持箱物理姿态、本帧箱体与 `HeldTarget`、镜头和人物可见性。 |
| `Update` | 资源轮询、海岛装配链、主角动画链、菜单动画绑定各自运行，彼此无显式全序。UI 局部依赖见 [BSN 页面](#bsn-页面与菜单展示资产)；UI Style 发布预览后，依次执行 Audio Mix 与 Playback。 |
| `PostUpdate` | 骨骼动画求值 → 鞋底视觉补偿 → 变换传播；Egui 检查器为独立分支。布局后同步滚动条；Kira 排队播放阶段后补同步实例增益。 |
| `Last` | 将本帧已应用的 `max_fps` 同步到 `WinitSettings`，由原生窗口循环调度后续更新。 |

相机与玩法的固定步顺序由显式依赖表达；跨阶段数据流依赖 Bevy 默认主调度，`PreUpdate` 结束时应用动作命令，完成状态转换后进入固定循环。玩法模拟和相机姿态同步只在 `Running` 执行。一次渲染帧可以没有固定步，也可以有多个固定步，因此输入 Observer 不直接积分角色位置。

上表按正常帧的主调度顺序阅读。首次初始化时，`StatesPlugin` 还会在 `PreStartup` 前执行 `StateTransition`；`OnEnter` 只在进入对应状态时运行，不能把状态入口理解为每帧都会执行的系统链。

固定模拟通过人物 Avian `Position`、安全朝向与箱体局部 `ColliderTransform` 求解同一刚体。人物保留 `TranslationInterpolation`，持握箱暂停独立插值；显示链从人物本帧 `Transform` 与 `HeldAttachment.local_pose` 派生箱根姿态，`HeldTarget` 则按 `CarryGrip` 更新目标，两者在对齐期间可不同。

物理回写后同步真实箱体姿态，`PostUpdate` 再传播模型的 `GlobalTransform`。零固定步帧也同步安全朝向与呈现，不额外积分平移或消费拿放请求。

Avian 在默认固定调度中处理重力、速度积分与碰撞。接地通过脚底球体 shape cast 和地面法线判断，探测按角色的真实碰撞层过滤支撑物，持握箱不会作为角色支撑面；跳跃请求只在接地时施加一次向上冲量，侧面碰墙不能充当地面。移动轴先限制长度再转换为水平目标速度，通过力加速或减速，空中操控力度低于接地时；碰撞与外力可以改变实际速度，斜向输入不会提高目标速度。

`GamePhysicsPlugin` 的提前唤醒只处理 `Sleeping` 身体：位姿、速度或 `SleepTimer` 的变化必须晚于 `LastPhysicsTick`，才排队 `WakeBody`，并在准备求解器前提交。这样跳跃、主动移动与外部冲量在首个固定步参与重力和位置积分；物理自身的回写不会反复唤醒静置物体，正常休眠继续由 Avian 管理。离散唤醒以 `debug` 记录实体和 `external_physics_change` 原因。

角色使用 `SweptCcd::default().with_filter(CcdFilter::ALL)`，按每步运动与碰撞体最薄尺寸的比例启用非线性扫掠，默认门槛为半厚度。普通步行不持续扫掠密集建筑网格，高速外力与旋转接触仍受保护；过滤覆盖静态、运动学和动态刚体。角色与自由箱体还显式设置 `SpeculativeCcd::default()`，按速度扩张预测邻域，让相向高速动态物体在扫掠前互为碰撞候选。

纸箱和木箱采用相同半厚度门槛与完整过滤，保留动态接触与旋转扫掠。角色或箱体形状、旋转约束及运动速度变化后须重评门槛，并保留不同水平 yaw 的高速薄墙及无 CCD 穿透对照；检查见 [无窗口验证](testing/README.md#海岛资源与无窗口验证) 与 [游戏验收](testing/game-acceptance.md)。

运动与尺寸参数以 [PrototypeConfig](../src/settings/prototype.rs) 的定义和默认值为准；重力每个固定步同步到物理资源，检查器编辑只影响当前会话。

渲染限帧与固定 60 Hz 模拟分别管理。`SettingsPlugin` 将 `WinitSettings` 的前台与后台模式统一设为 `UpdateMode::Reactive`，以 `1 / max_fps` 为近似更新间隔，关闭设备、用户与窗口事件触发的提前更新；输入缓冲到下一次更新。计时、等待和超时处理由 Bevy 原生窗口循环负责，启动与生命周期切换可强制更新，不保证任意相邻帧的严格最小间隔。`AutoNoVsync` 独立控制呈现方式，仍可能被平台回退。

## 持有关系与生命周期

`HeldBy` 是可搬物品到持有者的自定义 Bevy 关系，`HoldingItems` 是 Bevy 自动维护的反向索引。业务系统插入或移除 `HeldBy`，只读取反向索引。

交互系统在范围内选择距离最近的未持有 `Pickable`，射线检查阻挡，防止隔墙抓箱；已有持有物时，取反向索引中的第一件解除持握。拿起和释放都不瞬移箱体，释放保留当前位置、线速度与角速度，后续由重力、惯性和碰撞推进。

玩法系统通过 `.chain()` 建立顺序；变更刚体归属前先禁用原碰撞并清理空间索引，再创建挂接代理；释放时清理代理后恢复原刚体与碰撞。不能让归属变更遗留旧空间代理或让人物的碰撞体销毁关系删除箱子业务根。交互系统为本批次拾取维护临时预留集合，防止命令尚未应用时两个角色重复占用同一箱体。当前业务按一次持有一件实现，关系容器本身可存多件，尚无多件携带规则。

持握连接保留拾取瞬间的相对姿态，固定步经连续形状查询后逐步对齐到手前，避免瞬移或穿过障碍；对齐完成后局部姿态固定。人物胶囊与真实箱体形状归属同一动态刚体，箱体撞到 NPC、墙或其他物体时，求解直接阻挡整个组合，人物不能继续追入受阻箱体。

视角始终自由更新。角色同步新水平朝向前，以人物位置为旋转中心，对箱体完整转动路径做连续碰撞查询，覆盖公转、自转和复合形状偏移。`FirstPersonCamera` 保留动作的有向水平增量，检查后消费一次，180° 或整圈输入也按实际方向扫过；不能只检查终点，也不依赖锁定旋转人物的 CCD 推断显式转向安全。只有转向新引入的阻挡才自动释放，直走接触仍保持持握；释放保留转动前的安全世界姿态与实际运动速度，再让空手人物继续朝向当前视角。

三角网格查询仅在能证明整段路径分离时跳过完整连续查询：使用平面距离、支撑映射与转动位移上界，必要时二分区间；不能把离散安全姿态当作证明。起点分离用零余量，仅同一平面的真实已有接触允许 `0.001 m` 数值余量。有限三角面与方盒采用支持映射最近点查询，复合箱体逐子形状分派；无法证明安全或达到细分上限时回到完整查询，仍阻挡中途薄墙和再次穿入。查询入口与扫掠几何分别见 [rotation_query.rs](../src/item_interaction/rotation_query.rs) 和 [rotation_sweep.rs](../src/item_interaction/rotation_sweep.rs)。

自动释放记录 `Held parcel turn blocked`，包含阻挡实体、导入名称与实际有向转角，便于区分建筑、平台和栏杆来源。

`CarryGrip` 是每件物品相对角色脚底与水平朝向的目标偏移，由场景按模型尺寸设置。实际挂接姿态存于 `HeldAttachment.local_pose`，供真实碰撞和呈现共同读取；拾取对齐朝目标逐步推进，不直接以目标覆盖真实姿态。

`GamePhysicsLayer` 分为 `World`、`Character` 和 `Parcel`。自由箱体与持箱代理都保留外部碰撞；同一人物刚体内的形状由 Avian 排除自碰，转向查询另按 `ColliderOf.body` 排除整套自身碰撞，持握不会忽略其他角色所属的 `Character` 层。

当持有者销毁、落水或持有关系异常解除时，统一清理连接与失效目标，恢复箱体独立动态刚体、自由碰撞和插值，并还原仍存在的持有者质量。箱体业务根不属于人物子树，因此不会随人物级联消失；恢复独立物理后从安全世界位置自然下落，不把它瞬移到地面。清理记录失效关联及原因日志。

## 主角动画与落水恢复

`CharacterAnimationPlugin` 等待主角实例、父 GLB 与全部命名片段就绪，再绑定实际 `AnimationPlayer`，清理 `AnimationTransitions` 并保存 `CourierAnimation`。就绪 Observer 只标记 pending；绑定与混合系统通过 chain 让新状态同帧可见。片段清单、时长、根运动和制作契约见 [美术说明](../art/ASSET_GUIDE.md)。

动作混合在固定循环的姿态同步后读取真实水平速度，转到角色局部空间分配方向权重并平滑。步行共用归一化相位，步频按资产步长与真实速度调整，并补偿斜向混合的步长缩短；转向、拿放和变速不重启播放器。

接地短暂丢失先过滤，真实向上起跳立即进入空中姿态，最高点附近保留阶段以防抖动。空中停止推进步相位，起跳和落地显式采样一次性片段并保持终点，下落用独立时钟循环。空中拿放共用阶段进度，暂停冻结时钟；采样时间与过渡参数由 [state.rs](../src/character_animation/state.rs) 定义。

`CourierFootGrounding` 缓存角色、播放器与八个 `Courier_Sole_*` 节点的普通实体引用。骨骼动画求值后，`TransformHelper` 读取本帧局部骨链，按角色脚底平面修正视觉根高度，再进行变换传播；不改业务根、碰撞或持握目标。关联失效后停止播放器并清理绑定，NPC 不走玩家动画路由。

`BoundsRecoveryPlugin` 的 `recover_from_water` 在 FixedUpdate 的 Facing 与 Motion 前读取 Avian `Position`。玩家脚底或物品中心低于 `Y = -1.5` 时，使用各自 `SpawnPoint` 恢复。

玩家先解除持握，再重置位姿、线速度、角速度与单次请求，保留持续移动轴。本固定步随后同步当前相机水平角，再计算移动力，因此持续移动沿当前视角执行。玩家落水只释放手中物品；物品自身越界后才独立恢复，不随玩家传送。

恢复同时写入物理位姿与呈现 `Transform`，唤醒休眠刚体，并用 `NoTranslationEasing`、`NoRotationEasing` 暂停跨岛插值；暂停保持到下一固定步，因此连续没有固定步的渲染帧不会重新显示海中的旧位置。下一次 `FixedFirst` 的 `resume_interpolation` 在 `TransformEasingSystems::Reset` 之后、`UpdateStart` 之前清理本模块临时添加的暂停项，保留此前已有的暂停组件，再从新位置采样。恢复后物理位置已经离开阈值区，不会在连续更新中重复触发同一次恢复。

普通释放仍保留实际姿态与速度，落水恢复单独记录恢复前后位置和原因。无窗口检查见 [验证指南](testing/README.md)，实机动作与落水验收见 [游戏验收](testing/game-acceptance.md)。

## 音效数据流

`ItemInteractionPlugin` 注册物品反馈收集系统，音效消息类型由 [audio/messages.rs](../src/audio/messages.rs) 定义。拾取与主动释放只在 `handle_interaction` 接受操作后，用 `Commands::write_message` 和关系变更一起提交 `SoundRequest`。固定步链的同步点保证关系和消息同时可见，失败尝试不会产生成功反馈。释放提示与真正的落地是两个事件。

菜单向同一消息流提交焦点变化和已接受操作的反馈。鼠标确认在下一次 `PreUpdate` 消费请求后发出，指针悬停在当前 `Update` 后续播放；滑条只在结束且最终值改变时汇总确认。`TestSfx` 请求现有素材，不执行玩法。具体事件映射、去重与阈值见 [音效事件表](../assets/audio/events.md)。

`warn_hold_strain` 用模拟 `Position`、最新水平角与 `CarryGrip` 判断持续误差；`Local` 只保存当前持物的计时和锁存状态，解除关系或销毁时清理。它是音频提示，不引入额外失稳规则；正常整体持握与直走受阻不应误报警。

`emit_parcel_land` 在 `StepSimulation` 后只读 `ContactGraph`，持续检查活动与休眠的真实支撑接触，仅为自由 `Parcel` 发声并锁存到完全失去支撑。预测接触的 `CollisionStart` 可能早于实际冲量，不能据此只检查首步；碰撞开始／结束日志是独立消费者。

物品反馈收集受 Running 门控；`GameAudioPlugin` 的 Mix 阶段依次处理加载错误、选择混音与同步实例增益，Playback 阶段依次消费请求和处理退出。跨功能组合约束 `UiSystems::Style → AudioSystems::Mix → AudioSystems::Playback`。UI/SFX 使用独立类型通道，为 UI 预留并发；`Queued` 同样计数，未加载请求直接丢弃。冷却使用 `Time<Real>`，所以暂停菜单仍可反馈。声音是全局二维输出，退出停止通道且不等待确认音播完；主入口禁用 Bevy 内建音频，避免双后端初始化。

UI 在 Style 阶段发布 `AudioPreview.settings = Some(SettingsDraft.audio)`，设置页的分类切换保留预览，离页时设为 `None`。音频后端只读取这一可选数据和 `GameSettings.audio`：有预览时采用草稿音量，清空后采用最近成功应用值，不读取菜单状态或草稿资源。`sync_voice_volumes` 将有效增益与素材基准相乘后逐实例写入 Kira，避免通道 `set_volume` 覆盖素材响度；`PostUpdate` 在 `PlayTypedChannels` 后补同步刚就绪的实例。零增益用 `Decibels::SILENCE`，静音新请求不占冷却或并发，恢复不补播。

清单在编译时嵌入，启动校验后由 `AssetServer` 加载；清单无效只禁用声音，加载错误保留路径和外部错误。物品与 UI 的消息生产不安装 Kira。素材制作、来源与预留 cue 见 [音频管线](audio.md)，无窗口检查见 [音频验证](testing/README.md#音频无窗口验证)。

## 会话日志实现

`SessionLogPlugin::prepare()` 准备插件与 `SessionLogGuard`，目录、文件或线程准备失败时中止启动。该插件先于其他插件构建安装 panic hook 和日志层，记录 `Session started` 与版本；`DefaultPlugins` 禁用内建 `LogPlugin`，日志只有一个安装入口。文件使用 Unix 时间戳、纳秒和 UUID 命名，以 `create_new` 防止覆盖；文件名和日志时间分别使用 Unix 时间与可读 UTC 时间。

文件与控制台日志层沿用统一过滤，文件关闭 ANSI 颜色。两路输出使用各自的无界队列和后台线程，游戏系统只将格式化内容入队，不等待文件或 stderr 的写入与刷新，不因队列已满丢弃记录，两端也不相互阻塞。临时写入器资源在插件构建时取出，由日志 layer 和会话守护对象持有，不作为玩法共享状态。

两路格式层显式设置 `.log_internal_errors(false)`，关闭 tracing 的同步 stderr 错误回退，防止设备故障后重新阻塞事件调用或先于 panic 文件同步等待控制台；后台保留首个错误，在刷新和关闭时反馈。文件与控制台显示可以稍晚于事件发生，核对完整会话时应等待刷新完成。

主入口在游戏运行或专用调度导出返回后调用 `record_exit` 记录退出结果，先等待文件队列、再等待控制台队列写完并刷新；守护对象释放时显式发送关闭命令，排空两路输出并等待写入线程结束。全局日志 layer 仍持有队列发送端，不能依赖发送端析构结束线程。退出阶段可以等待 I/O，普通日志调用不能承担这项等待。写入或刷新失败会保存错误，并通过后续写入、刷新或关闭结果反馈。

panic hook 尽力记录错误，优先等待文件队列写完并调用 `sync_data`，然后调用原有 hook；不先等待可能阻塞的控制台。写入线程自身发生 panic 时由线程内部捕获并反馈，避免等待自己的队列。panic 日志通过已安装的 subscriber 输出，不能保证覆盖日志插件就绪前的异常或进程被强制终止的情况。慢写入端隔离与完整刷新回归见 [验证指南](testing/README.md#按变更类型选择检查)。

玩法、设置和检查器在各自插件的 `Startup` 注册初始化日志；配置值从实际资源只读取得，不由日志系统初始化或覆盖。各条记录及其与场景生成之间无全序，也不依赖已生成玩法实体；缺失插件不会由别处代报初始化。

连续角度和世界速度按 `debug` 每 0.5 秒最多采样一次，离散输入与捕获变化用 `info`。会话位置见 [使用说明](usage.md#会话日志)，过滤配置见 [开发规范](development.md#日志排查)，字段与实际运行核对见 [日志验收](testing/game-acceptance.md#日志检查与问题反馈)。
