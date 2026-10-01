# 当前原型架构

本文描述当前代码的组织与数据流。玩法目标见[游戏设计](game-design.md)，开发要求见[开发规范](development.md)，操作与配置见 [README](../README.md)。物流到货、岛内配送、收件人和任务系统尚未实现。

## 模块职责

| 模块 | 当前职责 |
| --- | --- |
| [main.rs](../src/main.rs) | 组装英文菜单、游戏与检查器插件，先准备会话日志，再加载设置；指定固定 60 Hz 模拟和窗口策略，退出后记录结果并刷新日志。 |
| [app_flow.rs](../src/app_flow.rs) | 管理主菜单／游戏状态与运行／暂停子状态，清理玩法输入并暂停或恢复时间；暂停保留玩法实体。 |
| [ui/mod.rs](../src/ui/mod.rs) | 定义菜单页面、返回来源、焦点、设置分类与语义请求，注册 UI 插件和更新顺序。 |
| [ui/navigation.rs](../src/ui/navigation.rs) | Enhanced Input 处理菜单键盘与手柄动作，Bevy UI 处理鼠标命中；统一消费请求、切换页面及保存和应用设置。 |
| [ui/screens.rs](../src/ui/screens.rs)、[ui/widgets.rs](../src/ui/widgets.rs)、[ui/theme.rs](../src/ui/theme.rs) | 用 BSN 声明页面与控件树，复用字体、颜色和间距；系统更新焦点、设置说明与滚动位置。 |
| [ui/backdrop.rs](../src/ui/backdrop.rs) | 主菜单的独立 GLB 展示舞台、相机与光照；启动快递员展示动画，记录资产加载失败。 |
| [input.rs](../src/input.rs) | 注册 `bevy_enhanced_input`、`GameplayContext` 和玩法／调试动作；创建键盘控制者，按动作的 `context` 路由角色意图。 |
| [camera.rs](../src/camera.rs) | 管理相机控制关联、视角模式、环绕状态和鼠标捕获；处理观察与视角切换动作，固定步同步角色朝向，物理插值后逐帧同步朝向、持握目标、镜头和人物可见性。 |
| [gameplay.rs](../src/gameplay.rs) | 定义玩家身份、角色与快递组件、持有关系和原型参数；固定步查询接地、施加移动力、跳跃冲量与持握力并执行拿放，固定步和逐帧共用持握目标同步。 |
| [physics.rs](../src/physics.rs) | 注册 Avian3D 物理插件、重力和碰撞层，构建角色与箱体物理组件，并记录接触开始和结束日志。 |
| [scene.rs](../src/scene.rs) | 进入游戏时生成带静态碰撞的地面与墙体、光照、动态角色与木箱、控制者和相机；退出游戏时清理，视觉子实体保持可替换。 |
| [settings.rs](../src/settings.rs) | 加载、校验、编辑草稿和保存玩家设置，失败时保留原文件；在时间更新之前限制渲染循环频率。 |
| [startup_log.rs](../src/startup_log.rs) | 通过 `StartupLogPlugin` 集中注册四项启动日志，只读玩法配置与固定时间步，并记录姿态同步约定和检查器启用信息。 |
| [session_log.rs](../src/session_log.rs) | 创建独立会话文件，扩展 Bevy 日志输出，记录会话生命周期和 panic 上下文，并负责刷新。 |

依赖声明和锁定版本分别见 [Cargo.toml](../Cargo.toml) 和 [Cargo.lock](../Cargo.lock)。

## 菜单与会话生命周期

`AppState` 只有 `MainMenu` 与 `InGame`。`PlayState` 是仅在 `InGame` 存在的 `Running / Paused` 子状态。`PrototypeScenePlugin` 在 `OnEnter(AppState::InGame)` 生成玩法；独立业务根、控制者、相机和灯光使用 `DespawnOnExit(AppState::InGame)`，退出会话时清理，视觉子树沿 `ChildOf` 一同销毁。暂停不退出 `InGame`，因此不重新生成角色、箱体或持有关系。

`MenuState` 保存 `Main / Hidden / Settings / Help / Pause` 页面、设置分类、返回页面与提示文本；`MenuFocus` 独立保存可操作按钮序号，`MenuInputSource` 区分鼠标与键盘／手柄导航来源。设置和帮助只切换页面，返回主菜单来源时仍在主菜单，返回暂停来源时仍暂停。`SettingsDraft` 是独立草稿，`Back` 丢弃未应用修改；`Apply` 先校验并保存，成功才替换 `GameSettings`，失败保留生效设置和草稿。

菜单控制者的 `MenuContext` 使用较高优先级与 `require_reset`，接收方向键、Enter、Esc 和手柄菜单按键。鼠标经 Bevy UI `Interaction` 发出相同 `UiRequest`。集中处理系统每帧消费一项请求，避免同帧两种输入重复触发。键盘动作在 `PreUpdate` 的 `EnhancedInputSystems::Apply` 后处理，`StateTransition` 随后执行；`Update` 先重建页面并应用旧树销毁，再读取鼠标点击，避免旧页面的 `Back` 穿透新页面。鼠标请求交给下一次 `PreUpdate` 消费。窗口光标位置仅用于判断真实鼠标移动，静止光标造成的新 `Hovered` 不抢走键盘焦点。

按钮样式由当前输入来源决定：鼠标模式只高亮实际悬停或按下的按钮，离开后恢复纸色；键盘／手柄实际导航时显示 `MenuFocus`。鼠标真实移动即切回鼠标模式，包括移到空白区域，因此离开按钮不会留下导航高亮。`Apply` 与当前设置分类不另设常驻黄色样式；帮助编号的黄色装饰节点不参与按钮交互。

进入暂停时 `suspend_input` 清空角色意图、停用 `GameplayContext`、释放鼠标，并暂停 `Time<Virtual>` 与 `Time<Physics>`。物理增量立即归零，避免 Avian 使用前一步的非零增量再模拟一次。玩法系统和相机姿态同步受 `gameplay_running` 条件限制；菜单渲染与输入仍可处理。恢复运行时重新启用时间，相机在下一次输入准备时恢复捕获并跳过自由光标位移。主菜单保持虚拟时间运行以播放展示动画，物理时间仍暂停。

`Continue`、`Multiplayer` 和未实现设置项只声明灰色 `Coming Soon` 展示节点，不包含 `Button`、`MenuButton` 或业务动作，因而不会进入鼠标行为或键盘焦点列表。当前可用项与完整占位清单以 [README](../README.md#菜单与占位功能) 为准。

## BSN 页面与菜单展示资产

UI 控件与主菜单舞台使用 Bevy 0.19 的 `bsn!`、`bsn_list!` 和返回 `impl Scene` 的辅助函数声明。页面结构与组件数据由 BSN 创建，交互、焦点、设置应用和跨实体行为仍由 ECS 系统负责。`rebuild_page` 在页面、草稿或窗口宽度变化时清理旧 `MenuRoot` 并生成新树；焦点变化只更新按钮颜色与说明。字号按窗口宽度缩放，窄窗口折行，高度不足由滚动区域和焦点滚入系统处理。

自动宽度的 `Text` 节点保留文本的自然测量，避免短文字在可收缩布局中被压成零宽。键帽、帧率值、按钮标题和帮助编号都使用这一规则；容器按实际布局需要设置尺寸与折行约束。BSN 组件检查不能代替最终字体与排版的用户目测，重点检查短标签和数字是否完整可见。

文字零宽与鼠标离开后高亮残留的原因及预防要求统一见 [UI 布局与高亮规范](development.md#ui-布局与高亮规范)，对应的字体测量、悬停循环和输入来源回归见 [文字布局与高亮回归](testing.md#文字布局与高亮回归)。

主菜单的 `MenuBackdrop` 使用 `DespawnOnExit(AppState::MainMenu)` 管理相机、光照和真实美术模型。它由独立快递员、快递站、地形、海水、植物与包裹 GLB 组成；设置和帮助沿用这个舞台，暂停沿用当前玩法相机。菜单相机标记 `IsDefaultUiCamera` 与 `PrimaryEguiContext`，进入游戏时随舞台销毁，玩法相机接管界面。

模型通过 `WorldAssetRoot` 加载原有 `#Scene0`；快递员 `WorldInstanceReady` 后查找骨架中的 `AnimationPlayer` 并循环播放索引 0 的 `Carry_Idle`。展示包裹是独立模型附件，没有角色控制器、Avian 刚体或玩法持有关系。组合地图 `assets/maps/courier_island.glb` 未接入当前玩法；菜单舞台不能作为碰撞地图或完整配送世界。字体资源与资产准备约定见 [README](../README.md#美术与字体准备)。

保存设置前校验与序列化完整 `GameSettings`，然后在根 `tmp/settings-save/` 写入唯一临时文件、同步并关闭句柄，再用 `rename` 替换目标文件。替换失败时保留原文件并清理临时产物；临时文件与设置及会话日志各自管理。菜单步进范围不收紧 JSON 的原有有效范围，打开设置保留有效自定义值，实际调整相应字段后才进入菜单范围。

## 世界检查器

`main` 在默认插件之后依次注册 `EguiPlugin` 和 `WorldInspectorPlugin::run_if(gameplay_running)`，检查器只在游戏运行时显示，主菜单与暂停时隐藏。它复用主窗口与当前相机，在 `EguiPrimaryContextPass` 中展示实体、资源和资产。插件自身的独占世界访问用于通用反射检查，项目不另建世界扫描或数据镜像。`StartupLogPlugin` 在启动时通过统一日志记录 `World inspector enabled`，表示插件已注册，并不表示启动主菜单显示检查器。

鼠标仍被游戏捕获时，`filter_captured_egui_input` 在 Egui 收集输入后、开始本帧之前过滤面板交互，补齐 Egui 内部残留按键的释放并清除拖拽和文本焦点。这样隐藏光标即使位于面板上也不会误编辑字段或中断玩家输入。F3 的 `ReleasePointerAction` 由相机 Observer 释放光标以操作检查器，游戏仍保持运行；Esc 通过菜单动作进入暂停。

玩法组件、`PrototypeConfig` 和相机状态注册 Bevy 反射元数据，让检查器直接访问 ECS 数据。`HeldBy`／`HoldingItems` 不开放反射修改，反向索引继续由 Bevy 的关系钩子维护；鼠标捕获状态不开放反射编辑。检查器编辑仅影响内存中的本次会话。

## 实体与状态归属

- **控制者实体**保存 `PlayerId`、`GameplayContext`、设备绑定、`ControlsCharacter` 和 `ControlsCamera`。`PlayerId` 表达业务身份，两个控制组件使用运行时 `Entity` 指向角色与相机。
- **角色业务实体**保存 `Character`、`CharacterIntent`、`CharacterMotion`、动态 `RigidBody`、胶囊 `Collider` 和 Avian 运动组件。移动能力与控制设备分离；物理位置与速度由 Avian 管理，`Transform` 用于插值呈现，角色根位置对应脚底。锁定刚体旋转避免碰撞后倾倒，水平朝向仍由视角系统控制。
- **快递业务实体**保存 `Parcel`、`Pickable`、动态 `RigidBody`、方盒 `Collider` 和 Avian 运动组件，被持有时增加 `HeldBy` 与 `HeldTarget`。快递根位置对应木箱中心；拾取系统按 `Pickable` 能力过滤，不依赖名称或模型。
- **相机实体**保存 `OrbitCamera`、`MouseLookState`、`Camera3d` 和 `Transform`。`OrbitCamera` 保存目标、`CameraPerspective` 视角模式、共享水平角、各模式的俯仰角和跟随参数，实际位置与朝向写入 `Transform`。
- **共享资源**包括 `PrototypeConfig`、`GameSettings`、`SettingsDraft`、`SettingsFile`、菜单状态与焦点；限帧计时和连续数据日志采样使用各系统的 `Local`。

场景当前只创建 `PlayerId(1)` 对应的一名键盘控制者、一名角色、一件木箱快递和一台相机。数据结构支持按控制者路由，不代表已经实现多人、联机或分屏。

地面是 `200 × 1 × 200` 的静态盒体，顶面在 `PrototypeConfig.ground_y`；前方 `z = -5` 处有一面 `4 × 2.5 × 0.5` 的可见静态墙，便于验证人物阻挡、箱体碰撞和物理持握。地面范围有限，当前没有越界后自动回到出生点的流程。

人物模型和木箱模型分别通过 `ChildOf` 挂在业务实体下。人物视觉子实体带有 `CharacterVisual` 标记，第一人称只隐藏当前相机目标的人物视觉，不隐藏角色业务实体或木箱。玩法查询操作业务实体，视觉网格和材质留在子实体，替换美术不必改变移动或拾取流程。持有关系与视觉父子关系相互独立。

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

`on_camera_look` 根据灵敏度和 Y 轴设置换算角度，不另存 `CameraLookIntent`，也不乘帧时间或固定步时间。默认第三人称保持固定环绕距离，俯仰限制在 `5°..80°`；初始镜头相对脚底偏移为 `(0, 6, 8)`，观察中心位于脚底上方 `0.8`。第一人称镜头位于脚底上方 `1.65`，首次俯仰角为 `0°`，之后限制在 `-85°..85°`。两种模式共享水平角并分别保存俯仰角，人物朝向和移动只使用水平角。

`TogglePerspectiveAction` 默认绑定 I，使用 `Press` 与 `require_reset` 保证每次按下只切换一次，长按不重复。`request_perspective_toggle` Observer 验证窗口聚焦、控制关联和目标有效后，将请求保存到 `OrbitCamera.toggle_requested_by`；`apply_perspective_toggle` 在 `PreUpdate` 的 `EnhancedInputSystems::Apply` 之后消费请求并切换同一台相机的模式。因此同帧鼠标位移先作用于原模式，切换后恢复目标模式记住的俯仰角，不依赖动作遍历顺序；首次进入第一人称仍为平视。切换在本帧完成，不修改鼠标捕获、角色位置或玩法请求。F3 释放光标后，未操作检查器时仍可切换视角；失焦或暂停时忽略切换。

`sync_character_visibility` 在镜头更新后按有效控制关联和模式更新角色视觉子实体的 `Visibility`：第一人称隐藏对应的 `CharacterVisual`，切回第三人称时恢复。相机或控制者丢失、关联不再有效时也恢复人物显示，避免模型停留在隐藏状态。

鼠标捕获是窗口生命周期处理：`sync_mouse_capture` 直接读取用于及时释放光标的 Esc、`MouseButtonInput` 和 `WindowFocused`，并结合应用状态、控制关联与目标是否存在更新 `MouseLookState` 和光标设置。Esc 的业务暂停只经菜单 Enhanced Input 路径执行，底层读取不再触发另一套暂停行为。捕获同步在底层 `InputSystems` 与 `EguiPreUpdateSet::BeginPass` 之后、`EnhancedInputSystems::Prepare` 之前执行。默认主 Egui 上下文使用多遍 UI 调度，本帧界面在 `PostUpdate` 处理；输入同步读取最近一次 UI 的拖拽、文本焦点和检查器菜单状态，并用当前窗口物理光标位置命中已有面板布局，避免同帧移入面板并点击时重新捕获鼠标。捕获恢复当帧跳过观察位移，避免自由光标阶段的位移造成镜头跳转。

操作检查器时通过 `ContextActivity<GameplayContext>` 停用输入上下文，而不清空全局底层键盘资源；延迟命令在动作准备前应用。停用触发动作完成或取消，已有移动意图归零，单次动作继续遵循 `require_reset` 的松键要求。F3 释放后未操作检查器时保留原有键盘控制，包括 I 切换视角；主菜单和暂停强制停用玩法输入，点击菜单背景不能重新捕获鼠标。

## 调度与模拟边界

| 阶段 | 数据变换与执行依赖 |
| --- | --- |
| `Startup` | 创建菜单输入控制者；`StartupLogPlugin` 注册玩法配置、固定时间步、姿态同步约定与检查器启用日志。启动日志不依赖已生成玩法实体。 |
| `First` | `limit_frame_rate.before(TimeSystems)` 在引擎更新时钟前补足帧间剩余时间。 |
| `PreUpdate` | 更新鼠标捕获和菜单上下文，Enhanced Input 评估动作；动作应用后消费菜单请求及视角切换请求。 |
| `StateTransition` | 紧随 `PreUpdate`；主菜单入口生成展示舞台，游戏入口生成物理原型，暂停入口清意图并冻结时间，退出状态清理对应实体。 |
| `FixedUpdate` | `sync_character_facing.before(GameplaySystems::Simulate)` 先同步角色朝向，再更新重力与接地状态、施加移动力和跳跃冲量、执行交互、同步持握目标并施加持握力。相关系统通过显式顺序共享同一步状态。 |
| `FixedPostUpdate` | Avian 的 `PhysicsPlugins` 执行固定物理步，积分速度与位姿并求解接触和碰撞；`PhysicsSystems::Writeback` 之后再次更新接地并采样实际速度。 |
| `FixedLast` | Avian 记录本固定步的插值端点，供渲染帧呈现使用。 |
| `RunFixedMainLoop` 固定循环之后 | `CameraControlPlugin` 的显示同步链在 `TransformEasingSystems::Ease` 之后、`UpdateEasingTick` 之前执行；使用本帧插值位置，依次同步角色朝向、`HeldTarget`、镜头和人物可见性。 |
| `Update` | 按页面与草稿变化生成 BSN 树并清理旧页面，再读取鼠标按钮命中产生菜单请求，最后更新焦点、说明与滚动位置。 |
| `PostUpdate` | Bevy 变换与可见性传播供渲染使用；Egui 仅在游戏运行时绘制检查器。 |

相机与玩法的固定步顺序由显式依赖表达；跨阶段数据流依赖 Bevy 默认主调度，`PreUpdate` 结束时应用动作命令，完成状态转换后进入固定循环。玩法模拟和相机姿态同步只在 `Running` 执行。一次渲染帧可以没有固定步，也可以有多个固定步，因此输入 Observer 不直接积分角色位置。

角色朝向与持握目标同步保留在 `FixedUpdate`。物理持握施力直接读取持有者的 Avian `Position` 与最新水平朝向计算模拟目标，`HeldTarget` 仅用于呈现检查和检查器，不作为物理解算的位置来源，避免把插值状态反馈进模拟。角色使用 `TranslationInterpolation`，木箱使用 `TransformInterpolation`；固定循环后的显示链在插值完成后再次同步目标、镜头和人物可见性，使没有固定步的帧也能使用本帧视角与呈现位置。该链不直接搬动箱体、不施力或消费请求，不额外推进模拟时间。`PostUpdate` 再传播实际业务根实体的呈现姿态，保证木箱视觉子实体与箱体根一致。

`GameplayPlugin` 注册 `DemoPhysicsPlugin`，后者安装 Avian 默认固定调度的 `PhysicsPlugins`。项目不再手动积分角色位移或把角色高度夹到 `ground_y`：Avian 统一处理重力、速度积分与碰撞。接地通过脚底球体 shape cast 和地面法线判断，探测按角色的真实碰撞层过滤支撑物，持握箱不会作为角色支撑面；跳跃请求只在接地时施加一次向上冲量，侧面碰墙不能充当地面。移动轴先限制长度再转换为水平目标速度，通过力加速或减速，空中操控力度低于接地时；碰撞与外力可以改变实际速度，斜向输入不会提高目标速度。

当前默认参数为目标速度 `4.5 m/s`、接地加速度 `30 m/s²`、松键制动加速度 `45 m/s²`、空中加速度 `6 m/s²`、重力 `9.81 m/s²`、跳跃速度 `5 m/s`、角色质量 `75 kg`，胶囊高度 `1.9 m`、半径 `0.32 m`。箱体质量为 `3 kg`；持握使用 `3 Hz`、阻尼比 `1` 的弹簧阻尼力，最大拉力为 `450 N`。这些参数在 `PrototypeConfig` 中定义，重力每个固定步同步到物理资源；检查器编辑只影响当前会话。

渲染循环上限和固定 60 Hz 模拟分别管理。限帧系统只等待剩余间隔，超时后从实际帧起点重新计时；`WinitSettings::continuous()` 避免窗口失焦时额外套用默认更新频率。窗口使用 `AutoNoVsync`，但平台可能回退。当前已启用物理运动插值与刚体碰撞，尚无镜头碰撞、滚轮缩放或自动跨越台阶的角色控制规则。

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

`GamePhysicsLayer` 分为 `World`、`Character`、`Parcel`。自由箱体与三层碰撞；持有期间忽略 `Character` 层，避免手前目标与角色自身互撞，保留 `World` 与 `Parcel` 碰撞。目前场景只有一个角色，因此这一过滤暂不区分持有者与其他角色。释放后恢复自由箱体的碰撞层。

当持有者销毁或持有关系异常解除时，清理失效目标并恢复自由碰撞。箱体一直保留动态刚体和重力，因此会继续自然下落；不依赖释放时把箱体放到地面的兜底瞬移。清理记录失效关联及原因日志。

下列边界继续暂缓，未纳入当前原型的实现与验收范围：

| 场景 | 当前限制 |
| --- | --- |
| 多个角色在同一固定步请求拿起同一个木箱 | 已有同批次预留防止重复占用；尚无多人公平裁决与联机抢箱规则。 |
| 角色退出或被销毁时仍持有木箱 | 已有失效目标清理与自然释放；尚无角色退出前的主动交接业务流程。 |
| 多角色持有碰撞过滤 | 当前忽略整个 `Character` 层，尚未实现只忽略持有者的细分规则。 |

## 会话日志实现

`main` 在添加 `DefaultPlugins` 前调用 `session_log::prepare` 创建日志目录和文件；失败时中止启动。文件使用 Unix 时间戳、纳秒和 UUID 命名，以 `create_new` 防止覆盖；文件名和日志时间分别使用 Unix 时间与可读 UTC 时间。

随后通过 Bevy `LogPlugin::custom_layer` 添加文件输出，保留 Bevy 的默认控制台配置和日志过滤，文件层关闭 ANSI 颜色。临时写入器资源在插件构建时取出，由日志 layer 和会话守护对象持有，不作为玩法共享状态。文件写入锁只保护外部 I/O。

写入器在每次写入后刷新；`LogPlugin` 初始化后记录会话开始与版本，设置、场景、输入、相机和玩法模块记录各自关键变化。panic hook 尽力记录错误并同步文件，然后调用原有 hook；`App::run` 返回后记录退出结果并刷新，守护对象释放时再次刷新。panic 日志通过已安装的 subscriber 输出，不能保证覆盖日志插件就绪前的异常或进程被强制终止的情况。

`StartupLogPlugin` 集中注册 `log_configuration`、`log_simulation_timestep`、`log_pose_synchronization` 和 `log_world_inspector` 四个 `Startup` 系统；前两个分别只读 `PrototypeConfig` 和 `Time<Fixed>`，后两个记录当前装配采用的固定约定。资源继续由玩法插件和主入口准备，日志插件不创建默认配置，也不添加功能插件。四条日志之间及其与场景生成之间没有显式执行顺序，均不依赖已生成实体。各条日志保留原来的 `demo::gameplay`、`demo::settings`、`demo::camera` 和 `demo::inspector` target，日志过滤与查找路径保持一致；会话文件和退出刷新仍由 `session_log` 管理。

其中 `log_pose_synchronization` 通过统一日志设施记录 `Camera pose synchronization configured`，字段 `simulation_schedule="FixedUpdate"`、`grip_force_schedule="FixedUpdate"`、`physics_schedule="FixedPostUpdate"`、`presentation_schedule="RunFixedMainLoop"` 和 `presentation_order="interpolation_character_facing_hold_target_camera_visibility"` 说明模拟与显示同步的阶段和顺序，便于排查持箱转动或视角切换时的不同步问题。相机初始化记录 `perspective="third_person"`；每次有效切换以 `info` 级别记录 `Camera perspective changed`，包含 `perspective_before`、`perspective_after`、`yaw`、`pitch_before`、`pitch_after` 和 `reason="toggle_perspective_action"`。

连续角度和世界速度按 `debug` 级别最多每 0.5 秒采样一次，离散输入与鼠标捕获变化使用 `info`。日志查找见 [README](../README.md)，过滤设置见 [开发规范](development.md#日志排查)，用户验收步骤见 [验证指南](testing.md)。
