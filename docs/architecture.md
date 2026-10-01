# 当前原型架构

本文描述当前代码的组织与数据流。玩法目标见[游戏设计](game-design.md)，开发要求见[开发规范](development.md)，操作与配置见 [README](../README.md)。物流到货、岛内配送、收件人和任务系统尚未实现。

## 模块职责

| 模块 | 当前职责 |
| --- | --- |
| [main.rs](../src/main.rs) | 组装应用与插件，先准备会话日志，再加载设置；指定固定 60 Hz 模拟和窗口策略，退出后记录结果并刷新日志。 |
| [input.rs](../src/input.rs) | 注册 `bevy_enhanced_input`、`GameplayContext` 和输入动作；创建键盘控制者，按动作的 `context` 路由角色意图。 |
| [camera.rs](../src/camera.rs) | 管理相机控制关联、视角模式、环绕状态和鼠标捕获；处理观察与视角切换动作，固定步同步角色朝向，逐帧按角色朝向、持物、镜头、人物可见性的顺序同步显示状态。 |
| [gameplay.rs](../src/gameplay.rs) | 定义玩家身份、角色与快递组件、持有关系和原型参数；固定步执行移动、跳跃、重力与拿放，提供固定步和逐帧共用的持物同步系统。 |
| [scene.rs](../src/scene.rs) | 启动时生成地面、光照、角色、木箱、控制者和相机；创建可替换的视觉子实体。 |
| [settings.rs](../src/settings.rs) | 加载、校验玩家设置，失败时保留原文件并回退默认值；在时间更新之前限制渲染循环频率。 |
| [session_log.rs](../src/session_log.rs) | 创建独立会话文件，扩展 Bevy 日志输出，记录会话生命周期和 panic 上下文，并负责刷新。 |

依赖声明和锁定版本分别见 [Cargo.toml](../Cargo.toml) 和 [Cargo.lock](../Cargo.lock)。

## 实体与状态归属

- **控制者实体**保存 `PlayerId`、`GameplayContext`、设备绑定、`ControlsCharacter` 和 `ControlsCamera`。`PlayerId` 表达业务身份，两个控制组件使用运行时 `Entity` 指向角色与相机。
- **角色业务实体**保存 `Character`、`CharacterIntent`、`CharacterMotion` 和 `Transform`。移动能力与控制设备分离；位置和朝向由 `Transform` 唯一保存，角色根位置对应脚底。
- **快递业务实体**保存 `Parcel`、`Pickable` 和 `Transform`，被持有时增加 `HeldBy`。快递根位置对应木箱中心；拾取系统按 `Pickable` 能力过滤，不依赖名称或模型。
- **相机实体**保存 `OrbitCamera`、`MouseLookState`、`Camera3d` 和 `Transform`。`OrbitCamera` 保存目标、`CameraPerspective` 视角模式、共享水平角、各模式的俯仰角和跟随参数，实际位置与朝向写入 `Transform`。
- **共享资源**为 `PrototypeConfig` 与 `GameSettings`；限帧计时和连续数据日志采样使用各系统的 `Local`。

场景当前只创建 `PlayerId(1)` 对应的一名键盘控制者、一名角色、一件木箱快递和一台相机。数据结构支持按控制者路由，不代表已经实现多人、联机或分屏。

人物模型和木箱模型分别通过 `ChildOf` 挂在业务实体下。人物视觉子实体带有 `CharacterVisual` 标记，第一人称只隐藏当前相机目标的人物视觉，不隐藏角色业务实体或木箱。玩法查询操作业务实体，视觉网格和材质留在子实体，替换美术不必改变移动或拾取流程。持有关系与视觉父子关系相互独立。

## 输入与相机数据流

`PlayerInputPlugin` 使用 `bevy_enhanced_input` 注册五个动作：`MoveAction`、`LookAction`、`JumpAction`、`InteractAction`、`TogglePerspectiveAction`。设备绑定位于控制者的 `GameplayContext`，Observer 从事件的 `context` 查到对应控制目标，再写入目标状态。

移动、跳跃和交互沿下面的路径进入固定模拟：

```text
设备绑定 → Enhanced Input 动作 → 控制者 → CharacterIntent → FixedUpdate
```

`CharacterIntent.movement` 保存持续有效的移动轴，动作完成或取消时归零。跳跃和交互使用 `Press` 与 `require_reset` 产生单次请求，Observer 将相应的 `pending` 置为 `true`，固定步通过 `std::mem::take` 消费并清除。没有固定步的渲染帧不会丢失请求；消费前的同类请求会合并为一次布尔请求，当前没有动作队列。

观察动作直接更新相机持续状态，视角切换动作先写入相机上的单次请求，再于本帧动作应用完成后消费：

```text
鼠标位移 / I 键 → 观察 / 视角切换动作 → ControlsCamera → OrbitCamera
                                      ├→ 固定步角色水平朝向
                                      └→ Update 角色朝向 → 持物 Transform → 相机 Transform → 人物 Visibility
                                                  → PostUpdate 视觉子实体 GlobalTransform
```

`on_camera_look` 根据灵敏度和 Y 轴设置换算角度，不另存 `CameraLookIntent`，也不乘帧时间或固定步时间。默认第三人称保持固定环绕距离，俯仰限制在 `5°..80°`；初始镜头相对脚底偏移为 `(0, 6, 8)`，观察中心位于脚底上方 `0.8`。第一人称镜头位于脚底上方 `1.65`，首次俯仰角为 `0°`，之后限制在 `-85°..85°`。两种模式共享水平角并分别保存俯仰角，人物朝向和移动只使用水平角。

`TogglePerspectiveAction` 默认绑定 I，使用 `Press` 与 `require_reset` 保证每次按下只切换一次，长按不重复。`request_perspective_toggle` Observer 验证窗口聚焦、控制关联和目标有效后，将请求保存到 `OrbitCamera.toggle_requested_by`；`apply_perspective_toggle` 在 `PreUpdate` 的 `EnhancedInputSystems::Apply` 之后消费请求并切换同一台相机的模式。因此同帧鼠标位移先作用于原模式，切换后恢复目标模式记住的俯仰角，不依赖动作遍历顺序；首次进入第一人称仍为平视。切换在本帧完成，不修改鼠标捕获、角色位置或玩法请求。Esc 释放鼠标后仍可切换视角，失焦时忽略切换。

`sync_character_visibility` 在镜头更新后按有效控制关联和模式更新角色视觉子实体的 `Visibility`：第一人称隐藏对应的 `CharacterVisual`，切回第三人称时恢复。相机或控制者丢失、关联不再有效时也恢复人物显示，避免模型停留在隐藏状态。

鼠标捕获是窗口生命周期处理：当前 `sync_mouse_capture` 直接读取 Esc 的 `ButtonInput`、`MouseButtonInput` 和 `WindowFocused`，结合控制关联与目标是否存在更新 `MouseLookState` 和光标设置。捕获恢复当帧跳过观察位移，避免自由光标阶段的位移造成镜头跳转。它在底层 `InputSystems` 之后、`EnhancedInputSystems::Prepare` 之前执行，捕获状态在动作评估前生效。

## 调度与模拟边界

| 阶段 | 数据变换与执行依赖 |
| --- | --- |
| `Startup` | 生成场景并记录玩法配置、固定时间步与姿态同步阶段及顺序。 |
| `First` | `limit_frame_rate.before(TimeSystems)` 在引擎更新时钟前补足帧间剩余时间。 |
| `PreUpdate` | 更新鼠标捕获，Enhanced Input 评估动作并通过 Observer 更新意图、观察角度或切换请求；`apply_perspective_toggle.after(EnhancedInputSystems::Apply)` 在本帧动作应用完成后切换模式。 |
| `FixedUpdate` | `sync_character_facing.before(GameplaySystems::Simulate)` 先同步角色朝向，再依次执行移动、跳跃与重力、交互、持物跟随。 |
| `Update` | `CameraControlPlugin` 注册 `(sync_character_facing, gameplay::sync_held_objects, follow_orbit_camera, sync_character_visibility).chain()`，依次同步角色朝向、持物、镜头和人物可见性。 |
| `PostUpdate` | Bevy 的变换传播根据业务根实体 `Transform` 更新模型子实体的 `GlobalTransform`，可见性传播应用人物视觉状态，供渲染使用。 |

相机与玩法的固定步顺序由显式依赖表达；跨阶段数据流依赖 Bevy 默认主调度，`PreUpdate` 结束时应用动作命令后进入固定循环。一次渲染帧可以没有固定步，也可以有多个固定步，因此输入 Observer 不直接积分角色位置。

角色朝向与持物同步保留在 `FixedUpdate`，保证本步移动和交互使用最新水平朝向；`Update` 再同步一次显示姿态与人物可见性，保证没有固定步的帧也能让角色、持物和镜头使用相同视角，第一人称切换当帧不会保留遮挡镜头的人物模型。逐帧同步不运行移动、重力或交互，不额外推进模拟时间。在渲染上限高于固定模拟频率时，如果只逐帧更新镜头，持物会沿用上一固定步的姿态，在连续转动视角时出现交替滞后的画面；顺序同步后，模型子实体在同一帧的 `PostUpdate` 获得更新后的世界变换。

玩法系统使用 `Time<Fixed>` 积分运动。移动轴先限制长度再转换为角色局部方向，保证斜向移动不会更快；跳跃与重力在同一固定步处理，并在配置的平面高度着陆。

渲染循环上限和固定 60 Hz 模拟分别管理。限帧系统只等待剩余间隔，超时后从实际帧起点重新计时；`WinitSettings::continuous()` 避免窗口失焦时额外套用默认更新频率。窗口使用 `AutoNoVsync`，但平台可能回退。当前没有移动插值、镜头碰撞、滚轮缩放或通用物理碰撞系统。

### 持箱转向错位的经验

自由视角曾出现持箱转动鼠标时木箱抖动或虚影。旧实现让 `Fire<LookAction>` 每帧更新环绕角，`Update` 据此更新镜头，而人物朝向和持箱姿态仅在 60 Hz 的 `FixedUpdate` 更新。渲染为 120 FPS 时，部分帧没有固定步，镜头使用本帧角度，人物和箱子仍使用上一固定步的角度；固定步再次执行后箱子才追上，导致画面中的相对姿态交替滞后。

原测试在鼠标输入后的 `app.update()` 返回时，没有立即检查姿态，而是先主动补跑一次固定步。补跑使人物与箱子追上镜头，掩盖了真实渲染帧已经发生的错位。回归测试必须检查每个实际帧末的状态，具体方法见[避免测试掩盖帧间错位](testing.md#避免测试掩盖帧间错位)。

本次修复保留固定步的模拟顺序，同时在 `Update` 明确建立“人物水平朝向 → 持物姿态 → 相机”的同步链，再由 `PostUpdate` 传播视觉子实体的世界变换。该链只同步当前角度对应的姿态，移动、重力和拿放仍由固定步执行；放下后的物体因已移除 `HeldBy`，不会继续跟随。

用户已通过实际游玩反馈确认，持箱转动视角的虚影消失。反馈仅确认这一现象，未单独提供 60／120 FPS 或完整验收清单的执行结果。后续增加手持工具、武器或其他随角色转向的附件时，也应核对本帧的角度来源、附件姿态和相机是否一致；通用约束见[固定模拟与逐帧显示的一致性](development.md#固定模拟与逐帧显示的一致性)。

## 持有关系与生命周期

`HeldBy` 是快递到持有者的自定义 Bevy 关系，`HoldingItems` 是 Bevy 自动维护的反向索引。业务系统插入或移除 `HeldBy`，只读取反向索引。

交互系统在范围内选择距离最近的未持有 `Pickable`；已有持有物时，取反向索引中的第一件放到人物面前的地面。跟随系统按持有者世界位置和朝向更新物体 `Transform`，不把快递设为角色的视觉子实体。

玩法系统通过 `.chain()` 建立顺序，并在交互与跟随之间应用延迟命令，使本步新建立的持有关系立即被跟随系统看见。当前业务按一次持有一件实现，关系容器本身可存多件，尚无多件携带规则。

`sync_held_objects` 在固定步和逐帧同步中复用，只根据当前有效的 `HeldBy` 计算位置与朝向，不消费输入或积分运动。放下后关系已移除，后续转动视角不会让地面的快递继续跟随角色；视觉子实体仍通过自己的业务根实体传播变换。

下列边界继续暂缓，未纳入当前原型的实现与验收范围：

| 场景 | 当前限制 |
| --- | --- |
| 多个角色在同一固定步请求拿起同一个木箱 | 尚无集中裁决、同批次占用预留和多人抢箱规则。 |
| 角色退出或被销毁时仍持有木箱 | 尚无销毁前主动放下木箱的业务流程及离开原因日志；仅保留 Bevy 关系自身的生命周期维护。 |
| 持有关系被异常解除后，木箱留在空中 | 尚无自由物体落地兜底或异常关系恢复流程。 |

## 会话日志实现

`main` 在添加 `DefaultPlugins` 前调用 `session_log::prepare` 创建日志目录和文件；失败时中止启动。文件使用 Unix 时间戳、纳秒和 UUID 命名，以 `create_new` 防止覆盖；文件名和日志时间分别使用 Unix 时间与可读 UTC 时间。

随后通过 Bevy `LogPlugin::custom_layer` 添加文件输出，保留 Bevy 的默认控制台配置和日志过滤，文件层关闭 ANSI 颜色。临时写入器资源在插件构建时取出，由日志 layer 和会话守护对象持有，不作为玩法共享状态。文件写入锁只保护外部 I/O。

写入器在每次写入后刷新；`LogPlugin` 初始化后记录会话开始与版本，设置、场景、输入、相机和玩法模块记录各自关键变化。panic hook 尽力记录错误并同步文件，然后调用原有 hook；`App::run` 返回后记录退出结果并刷新，守护对象释放时再次刷新。panic 日志通过已安装的 subscriber 输出，不能保证覆盖日志插件就绪前的异常或进程被强制终止的情况。

相机插件在 `Startup` 通过统一日志设施记录 `Camera pose synchronization configured`，字段 `simulation_schedule="FixedUpdate"`、`presentation_schedule="Update"` 和 `presentation_order="character_facing_held_objects_camera_visibility"` 说明显示同步的阶段与顺序，便于排查持箱转动或视角切换时的不同步问题。相机初始化记录 `perspective="third_person"`；每次有效切换以 `info` 级别记录 `Camera perspective changed`，包含 `perspective_before`、`perspective_after`、`yaw`、`pitch_before`、`pitch_after` 和 `reason="toggle_perspective_action"`。

连续角度和世界速度按 `debug` 级别最多每 0.5 秒采样一次，离散输入与鼠标捕获变化使用 `info`。日志查找见 [README](../README.md)，过滤设置见 [开发规范](development.md#日志排查)，用户验收步骤见 [验证指南](testing.md)。
