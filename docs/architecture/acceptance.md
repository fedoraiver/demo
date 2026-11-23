# 应用验收接入

[验收入口](../../apps/acceptance/src/main.rs)安装 `bevy-acceptance-test` 的 `AcceptancePlugin`。插件在 `RenderApp` 创建前安装 Bevy 自带的 `RemotePlugin` 和 `RemoteHttpPlugin`，通过本机回环地址暴露主世界的 BRP。HTTP 响应提供 `X-Bevy-Pid`，供客户端核对所启动的进程。

Rust 插件和 Python 驱动来自验收工具仓库的 `master` 分支。项目脚本维护游戏用例、进程日志核对和用户设置事务。[验收工具](https://github.com/fedoraiver/bevy-acceptance-test/tree/master) · [自动化启动准备](../testing/README.md#自动化启动准备)

验收入口由 `ScheduleRunnerPlugin` 以约 `60 Hz` 驱动，保留一个 `1920×1080`、缩放因子为 `1` 的逻辑主窗口。逻辑窗口给输入路由、鼠标捕获状态与正常退出提供实体身份。入口通过 Bevy 的必需组件把 `IsDefaultUiCamera` 映射到工具的 `AcceptanceCamera`。菜单与玩法相机重建时会获得同一标记，由工具切换到同尺寸的离屏图像渲染目标。[验收入口](../../apps/acceptance/src/main.rs)

无窗验收与普通游戏都通过 `GameSettingsPlugin` 读写同一个用户设置文件。自动化脚本负责启用测试配置，并在进程退出后恢复用户设置。[设置架构](settings.md#设置草稿与持久化) · [共用设置与恢复](../testing/README.md#共用设置与恢复)

脚本使用 Bevy 自动注册的组件、资源、消息和事件。验收插件显式注册 `ButtonInput<KeyCode>` 和 `ButtonInput<MouseButton>`，应用流程插件在诊断构建中显式注册 `State<AppState>`。Bevy 自动注册不覆盖这三个泛型实例。脚本通过 `world.query`、`world.get_components` 和 `world.get_resources` 读取当前世界的数据，项目类型使用验收二进制的 `demo_acceptance::` 反射路径。

按键、按钮、相对鼠标位移和逻辑窗口关闭通过 `world.write_message` 投递。玩法消费具体键鼠消息，Picking 从 Bevy 原生 `WindowEvent` 转换光标和鼠标按钮。绝对光标位置在逻辑窗口及 `CursorMoved` 中同步，Picking 的指针目标由逻辑窗口映射到离屏图像。连续 BRP 请求可以在同一帧处理，脚本轮询键鼠和业务状态确认输入已被消费。

脚本共用[开局、相对鼠标位移与状态采样](../../scripts/acceptance/gameplay.py)，由[驱动](../../scripts/acceptance/driver.py)管理按键保持和释放。验收项可以通过原生 `world.insert_components` 为当前会话的角色同时准备 Avian `Position` 和 `LinearVelocity`，再等待物理位置、呈现位置和接地状态符合前置条件。场景行为继续由键鼠消息触发。

脚本查询相机的离屏 `RenderTarget`，用 `world.observe+watch` 订阅 `ScreenshotCaptured`，随后用 `world.spawn_entity` 创建指向该图像的 `Screenshot`。事件传输图像尺寸、纹理格式、像素和请求实体。客户端按实体关联事件，将 RGBA8 或 BGRA8 像素编码为 PNG。菜单和玩法验收要求有可见内容，渲染准备期间只收到纯色图像时在时限内重新捕获。具体运行、退出、恢复及覆盖见[验收测试指南](../testing/README.md#自动化启动准备)。

截图事件异步到达。镜头与移动脚本在关键阶段的截图前后读取 BRP 状态，以两次采样核对截图期间的稳定性。采样覆盖的时点及观察要求见[人物移动与镜头验收](../testing/app-acceptance.md#人物移动与镜头)。
