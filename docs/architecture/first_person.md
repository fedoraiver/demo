# 第一人称架构

源码入口见 [first_person/](../../src/first_person/mod.rs)。

- **控制者实体**保存 `PlayerId`、`GameplayContext`、设备绑定、`ControlsCharacter` 和 `ControlsCamera`。`PlayerId` 表达业务身份；控制关系分别指向角色与相机，`CharacterControllers / CameraControllers` 由 Bevy 维护反向索引。

- **相机实体**通过 `CameraTarget / CharacterCameras` 关系关联角色，`FirstPersonCamera` 保存观察姿态，`MouseLookState` 保存捕获状态；跟随系统根据人物本帧插值位置计算眼位，并把位置与朝向写入 `Transform`。

## 动作与相机数据流

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

`on_camera_look` 按灵敏度和 Y 轴设置更新角度，不乘帧时间。角色朝向和移动只读取水平角，镜头位于角色眼位，初始平视。角度边界与眼位见 [当前操作](../player-guide.md#当前操作)，显示链顺序见 [调度与模拟边界](game_flow.md#调度与模拟边界)。

`sync_character_visibility` 在镜头更新后按有效控制关联隐藏对应角色视觉子实体的 `CharacterVisual`，持有物与其他角色保持显示。相机或控制者丢失、关联不再有效时恢复人物显示，避免模型停留在隐藏状态。

## 鼠标捕获与输入归属

`sync_mouse_capture` 直接读取 F3、Esc 与 `WindowFocused`，结合应用状态和控制关联更新 `MouseLookState` 与光标。F3 独立于 `GameplayContext`，在 Enhanced Input Prepare 前确定本帧输入归属。启用 `inspector` 时也排在 Egui 输入转发前。底层 Esc 及时释放光标，业务暂停由菜单动作执行。

F3 手动释放或重新捕获鼠标，点击不改变捕获模式。窗口失焦释放捕获，回焦后由 F3 恢复。暂停、主菜单或控制关联失效时保持释放。恢复捕获时跳过自由光标阶段累积位移。

释放捕获时通过 `ContextActivity<GameplayContext>` 停用玩法输入，保留底层键盘状态。延迟命令在动作准备前应用。停用触发动作完成或取消，已有移动意图归零，单次动作继续遵循 `require_reset` 的松键要求。主菜单和暂停同样停用玩法输入。退出暂停后，下次 `PreUpdate` 会在窗口有焦点、控制关联有效时重新捕获鼠标。[Egui 输入转发](inspector.md#输入与反射)
