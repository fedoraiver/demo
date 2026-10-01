# demo

小岛快递游戏原型。玩家是岛上唯一的快递员，负责将物流公司收到的快递分发给岛内居民和商户；完整玩法仍处于 [设计阶段](docs/game-design.md)。

当前原型提供英文主菜单、暂停菜单、设置与操作说明，以及简易 3D 场景、基于 Avian3D 的人物移动与跳跃、物理持握木箱和可切换第一／第三人称的跟随镜头。主菜单使用真实美术资产搭建独立海岛展示舞台；开始游戏后仍进入原有占位角色、木箱、平地和墙体的物理原型。仅生成一名键盘玩家，尚无联机、分屏或游戏存档。项目使用 Rust 和 Bevy，依赖版本以 [Cargo.toml](Cargo.toml) 与 [Cargo.lock](Cargo.lock) 为准。

## 用户启动

以下命令由用户在仓库根目录自行执行：

```powershell
cargo run --locked
```

开发构建与发布说明见 [开发规范](docs/development.md)。实际游玩和视觉验收由用户完成，步骤见 [验证指南](docs/testing.md)。

## 菜单与占位功能

启动后进入英文主菜单。`Start Game` 开始原型，`Settings` 打开设置，`How to Play` 查看当前操作，`Quit` 正常退出。游戏内按 Esc 打开暂停菜单；`Resume` 或再次按 Esc 恢复，`Settings` 和 `How to Play` 返回后仍保持暂停，`Back to Main Menu` 清理当前玩法场景。再次选择 `Start Game` 会从初始场景开始。

鼠标可点击可用按钮；上／下方向键移动焦点，Enter 确认，Esc 返回，设置字段用左／右方向键或行内箭头调整。菜单也支持手柄方向键、南侧按钮确认、东侧按钮或 Start 返回；当前玩法仍只有键盘控制者。

可交互按钮在鼠标进入时高亮，离开后恢复普通纸色。键盘或手柄实际导航时显示当前焦点；鼠标实际移动到按钮或空白区域时切回鼠标模式。`Apply` 与当前设置分类使用相同规则，不常驻黄色；帮助页 `01 / 02 / 03` 的黄色编号块仅作装饰。

未实现功能以灰色 `Coming Soon` 行展示，鼠标不能激活，键盘导航跳过，不会改变游戏或设置：

| 页面 | 可用功能 | `Coming Soon` 占位 |
| --- | --- | --- |
| 主菜单 | Start Game、Settings、How to Play、Quit | Continue、Multiplayer |
| Graphics | Frame Rate Limit | Window Mode、Resolution、VSync、Shadow Quality、Anti-Aliasing、View Distance |
| Audio | 暂无可调音频功能 | Master Volume、Music Volume、SFX Volume |
| Controls | Mouse Sensitivity、Invert Camera Y | Rebind Keys |
| Accessibility | 暂无可调辅助功能 | UI Scale、Camera Shake |

界面随窗口宽度调整字号与布局；高度不足时可滚动，键盘焦点会滚入可视区域。这是自动布局行为，`UI Scale` 仍为未实现的独立设置。

## 美术与字体准备

`art/` 与原有 GLB 仍作为本机美术资源管理，新检出或 worktree 不会自动包含它们。菜单字体及许可证位于受版本控制的 `assets/ui/fonts/`。启动前把已有模型目录复制到仓库根 `assets/`，保留原有 GLB 路径和目录结构。菜单需要：

- `models/characters/chr_courier.glb`：独立快递员，包含索引 0 的 `Carry_Idle` 动画。
- `models/buildings/bld_courier_station.glb`：快递站。
- `models/environment/env_island_terrain.glb`、`env_ocean.glb`、`prop_palm_leaning.glb`、`prop_palm_crooked.glb`、`prop_palm_young.glb`、`prop_wild_grass_patch.glb`：岛屿、海水与植物；这些文件均位于 `models/environment/`。
- `models/props/prop_parcel_standard.glb`、`prop_parcel_fragile.glb`、`prop_crate.glb`：包裹与箱体；这些文件均位于 `models/props/`。
- `ui/fonts/heading.ttf`（Lilita One）、`ui/fonts/body.ttf`（Atkinson Hyperlegible），以及同目录的 `LICENSE-LilitaOne.txt`、`LICENSE-AtkinsonHyperlegible.txt`：菜单字体及 SIL Open Font License 1.1 许可。

当前仅把独立模型用于菜单展示，没有把 `assets/maps/courier_island.glb` 接入可游玩场景或生成碰撞地图。缺失或加载失败的资产会写入本次会话日志，检查 `Menu asset failed to load` 及对应路径。

## 当前操作

| 操作 | 行为 |
| --- | --- |
| 鼠标移动 | 直接控制镜头水平朝向和上下俯仰，无需按住右键；人物水平朝向随视角变化。 |
| W / S | 沿当前视角的水平前方加速前进或后退，松键后较快减速，不因后退改变朝向。 |
| A / D | 沿当前视角的水平左右方向加速横移，不改变朝向；斜向输入不会提高目标速度。 |
| 空格 | 地面起跳并落回地面；持续按住不会反复跳跃，空中不能再次起跳。 |
| E | 用力拉住范围内最近且无遮挡的可拾取木箱；持有时再次按下，从当前物理位置释放并保留速度，自然掉落。 |
| I | 在第三人称和第一人称间切换，每次按下切换一次，长按不重复；窗口失焦时忽略。 |
| Esc | 打开暂停菜单，显示光标并冻结当前玩法；在暂停菜单再次按下恢复。 |
| F3 | 调试时释放光标，保持游戏运行，以操作世界检查器。 |
| 左键点击检查器之外的游戏区域 | 恢复鼠标控制；窗口失焦会自动释放，重新获得焦点后也需点击恢复。点击检查器不会捕获鼠标。 |

默认使用第三人称，镜头保持原有环绕距离，俯仰范围为 `5°..80°`。第一人称镜头位于角色脚底上方 `1.65` 个单位，首次进入时水平向前看，俯仰范围为 `-85°..85°`；隐藏自己的角色模型，木箱仍在真实持有位置显示。两种视角共享水平朝向，分别记住俯仰角，按 I 即时切换。暂停期间玩法输入停用；恢复时重新捕获鼠标，并跳过自由光标阶段积累的位移。

两种视角下都可持箱移动和跳跃，切换本身不会改变人物位置、移动或拿放规则。当前没有滚轮缩放或镜头碰撞。具体实现和暂缓处理的业务边界见 [架构说明](docs/architecture.md)。

角色碰到墙体会受阻，能够推动自由木箱，也会受到外力影响。手持木箱仍参与地面、墙体和其他木箱碰撞：快速转向时会有惯性，遇到墙体会停在受阻位置，并通过持握力影响角色。箱子实际位置不会始终贴合手前目标；释放后可继续滑动、翻滚和落地。人物移动和箱体显示使用固定物理模拟与逐帧插值，60／120 FPS 的验收方法见 [验证指南](docs/testing.md#用户手动验收)。

## 世界检查器

进入游戏并运行时显示 [bevy-inspector-egui](https://github.com/jakobhellermann/bevy-inspector-egui) 的 `World Inspector` 面板，主菜单与暂停期间隐藏。它可查看实体层级、已注册反射的组件与资源，以及网格、材质等资产。人物输入与运动状态、原型参数和相机状态支持展开查看。

已启用组件变化高亮：带有 Bevy 变化标记的组件，其标题显示金色边框，便于观察移动、转向或编辑时的状态更新。

按 F3 释放光标后操作面板；光标位于面板、编辑字段或打开检查器菜单时，玩家输入会被屏蔽，避免编辑过程中移动、跳跃、拿放或切换视角。光标位于面板外且未编辑字段时，I 仍可切换视角，保持光标自由。点击面板之外的游戏区域恢复鼠标控制。检查器中的编辑只影响当前会话，不会写回 `settings.json` 或形成存档。

## 设置

可从主菜单或暂停菜单打开 `Settings`。`Graphics` 的 `Frame Rate Limit` 与 `Controls` 的 `Mouse Sensitivity`、`Invert Camera Y` 编辑独立草稿；`Apply` 保存成功后立即生效，`Back` 或 Esc 丢弃未应用的编辑，`Restore Defaults` 只恢复草稿，仍需 `Apply`。保存失败会显示英文提示，保留原设置文件、当前生效设置与草稿，方便重试。

玩家设置保存在工作目录的 `settings.json`，该文件由 Git 忽略，各工作目录保留自己的配置。文件缺失时使用代码中的默认值，首次在菜单中选择 `Apply` 后创建本地文件；也可手动创建或修改，文件修改在下次启动时读取。默认设置以 [GameSettings 与 CameraSettings 的实现](src/settings.rs) 为准：

```json
{
  "max_fps": 60,
  "camera": {
    "mouse_sensitivity": 0.003,
    "invert_y": false
  }
}
```

| 配置 | 含义与有效值 |
| --- | --- |
| `max_fps` | 渲染帧率上限，必须为不小于 `60` 的整数，默认 `60`；`120`、`144` 等也有效。 |
| `camera.mouse_sensitivity` | 鼠标灵敏度，单位为弧度/像素，必须为有限正数。 |
| `camera.invert_y` | 为 `true` 时反转鼠标上下方向。 |

菜单帧率选项为 `60 / 90 / 120 / 144 / 165 / 240`；灵敏度每次调整 `0.0005`，菜单范围为 `0.0005..0.02`，界面按默认灵敏度 `0.003` 显示百分比。文件中的有效自定义值不因打开菜单而被修改，只有实际调整相应字段时才进入菜单选项范围。

省略 `max_fps` 时采用默认上限 `60`；省略 `camera` 时采用默认相机设置，旧的仅含有效 `max_fps` 的配置仍然有效。文件缺失时使用默认设置；读取失败或内容无效（包括 `max_fps` 低于 `60`）时记录警告并使用默认设置，帧率上限回退为 `60`，保留原文件。保存前验证完整设置并写入根 `tmp/settings-save/` 的临时文件，成功替换后才更新运行设置。

渲染上限不会改变人物移动、跳跃速度或相同鼠标位移对应的旋转幅度，也不会保证实际达到该帧率。性能不足时实际帧率会更低；操作系统调度也可能令帧率略低于上限。垂直同步是否能关闭取决于平台支持，关闭后可能出现画面撕裂。

## 会话日志

每次启动生成独立的 `logs/unix-<时间戳>_<会话UUID>.log`，历史日志保留。文件记录启动、版本与配置、关键状态变化、错误上下文及正常退出；运行日志与游戏存档分别管理。

出现问题时，提供对应会话日志以辅助排查。提高日志详细程度的方法见 [开发规范中的日志排查](docs/development.md#日志排查)，日志验收方法见 [验证指南](docs/testing.md)。

## 音效

第一版通过 `bevy_kira_audio` 播放菜单焦点、确认与返回反馈，以及拾取、主动释放、包裹实际落地及持续持握失稳提示。菜单只对实际导航／移入可用按钮、接受的操作和设置结果发声；静止鼠标、页面重建、当前分类重选或设置已到边界不发声。打开暂停有确认音，返回、恢复和回主菜单有返回音；设置保存失败使用返回音。具体事件与去重规则见 [音效事件表](assets/audio/events.md)。

音频设置中的音量调节仍为 `Coming Soon`，游戏使用固定总增益；暂停期间菜单声音继续可用。失败拾取、静置接触和普通侧面碰墙不会播放成功或落地音；交接、推车、角色弹开和交付结果仍只有素材与事件接口，等待对应玩法实现。音效不改变输入绑定与物理规则。

在浏览器中打开 [逐项试听页面](assets/audio/audition.html)，可以单独播放、停止及试听唯一的合成环境循环；环境音默认不在游戏播放。页面由用户点击后播放，支持直接打开本地文件。素材、来源、生成参数和缺口见 [音频管线说明](docs/audio.md)、[资产清单](assets/audio/audio_manifest.json) 和 [归属记录](assets/audio/ATTRIBUTION.md)。外部资产来自 Kenney 官方 CC0 发布包；保留其原始发布 OGG 格式并明确有损，原创反馈音由本地脚本生成。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [游戏设计](docs/game-design.md) | 玩法目标、已确认设定、设计建议与待确认方向。 |
| [Agent 开发指南](AGENTS.md) | Agent 强约束、必读文件及技能读取入口。 |
| [开发规范](docs/development.md) | 工程规则、输入处理优先级、构建发布与调试方法。 |
| [当前架构](docs/architecture.md) | 模块职责、实体数据、输入与模拟流程、日志机制及业务边界。 |
| [验证指南](docs/testing.md) | 无窗口检查与用户手动验收步骤。 |
| [音频管线](docs/audio.md) | 音效事件入口、素材复现、来源限制与试听方式。 |
