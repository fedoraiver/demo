# demo 海岛美术资产说明

## 风格与范围

本文提供海岛资产的制作源、导入参考和再生成步骤。当前游戏的可用能力与操作见 [使用说明](../docs/usage.md)，玩法确认状态见 [游戏设计](../docs/game-design.md)。

海岛采用低多边形风格，陆地约 110×90 米，海湾、凹口与岬角形成不规则岸线。人物穿蓝色制服；建筑使用风化木板与锈蚀屋顶，分散布置物流总站、商铺和居民木屋。地表以沙地、碎石、野草和不规则棕榈为主，不包含规则路网、铺装广场或海景公园。

## 交付文件

| 入口 | 用途 |
| --- | --- |
| [courier_island.blend](blender/courier_island.blend) | 完整海岛与独立源资产库 |
| [courier_actions.blend](blender/courier_actions.blend) | 主角骨架与动作制作源 |
| [asset_manifest.json](asset_manifest.json) | 模型路径、尺寸、轴心、动作和地图实例的完整清单 |
| [courier_island.glb](../assets/maps/courier_island.glb) | 组合地图；独立模型按类别导出到 [models/](../assets/models/) |
| [previews/](previews/) | 岛屿、角色及场景静态预览 |
| [动作预览](previews/courier_actions.png)与[跳跃预览](previews/courier_jump.png) | 空手／持箱动作的姿态参考 |

道具扩展库的制作源、分类预览与挂点接口见 [道具美术资产](items/README.md)。已有 [结构报告](validation_report.json) 仅反映生成时的检查；当前资源的验证方法见 [海岛资源与无窗口验证](../docs/testing/README.md#海岛资源与无窗口验证)。

## Blender 场景

- `Courier_Island` 是完整海岛，保存后默认打开此场景与全景相机视角。
- `Courier_Asset_Library` 是独立源资产库，角色、道具、建筑按行排列。
- `Character_Lineup` 是五名角色的展示。

环境源件在资产库中隐藏，防止大型海面遮住其他模型；它们在地图场景中可见。

## 比例与导入

- Blender 使用米制、Z-up；glTF 导出转换为 Y-up。
- 人物朝 Blender 本地 `+Y`，导出后朝 glTF 本地 `-Z`；人物原点位于脚底。
- 人物约 1.9 米高，纸箱主体 0.6 米见方；纸箱和木箱的原点均位于中心。
- 建筑店面朝 Blender `-Y`，导出后朝 `+Z`，原点位于底部中心。
- 所有资产颜色由内置材质提供，不依赖外部图像贴图。

主角动作是 0.8 秒的原地片段，包含空手／持箱的站立、四方向行走及空中阶段。起跳与落地为一次性动作，其余片段循环；完整名称和配对以 [动作定义](scripts/courier_actions.py) 与资产清单为准。步行动作共用左右脚相位，持箱与空手的腿部姿态一致。

骨架采用刚性分段权重，保留低多边形棱面。八个 `Courier_Sole_*` 鞋底标记供动画混合后的接地补偿使用；包裹是独立模型，`Carry_Idle` 提供双手夹持姿态。运行时的动作混合、阶段时钟和持握同步见 [主角动画与落水恢复](../docs/architecture.md#主角动画与落水恢复)。

## 验证与接入边界

海岛与主角已接入当前演示。运行时从地图网格提取结构碰撞；GLB 本身不提供玩法组件或导航网格。资源就绪与地图装配流程见 [美术加载与 BSN 场景装配](../docs/architecture.md#美术加载与-bsn-场景装配)。

无窗口验证覆盖清单契约、角色蒙皮与动作、岸坡法线及模型结构，命令统一见 [海岛资源与无窗口验证](../docs/testing/README.md#海岛资源与无窗口验证)。这些检查不代表游戏内显示、通行或动画观感已经验收。

在 Blender 中查看预览时：

- 全景应看到整个岛四周的海水、零散木建筑及不规则棕榈群落。
- 街景应显示物流总站、Pizza 店、Music 店与对应招牌。
- 沙滩视角应看到弯曲棕榈、荒草、自然沙坡与海面，没有环岛路、海景公园或铺装广场。
- 角色展示应看到主角、调度员、披萨店员、音乐店员和居民。

游戏启动、行走、台阶碰撞和视觉验收由用户按 [游戏手动验收](../docs/testing/game-acceptance.md) 完成。美术渲染不产生游戏日志；运行日志位置见 [会话日志](../docs/usage.md#会话日志)。

## 再生成

以下为制作流程；执行前准备 Blender。只调整主角动作时，从第 3 步开始，无需重建整张地图。

1. 使用 [build_scene.py](scripts/build_scene.py) 通过 Blender MCP 插件在已打开的 Blender 中生成场景。
2. 使用 [export_assets.py](scripts/export_assets.py) 导出独立模型和地图；重复导出会归零独立源件的展示位移。
3. 使用 [export_courier_actions.py](scripts/export_courier_actions.py) 刷新主角动作、制作源和运行 GLB。完整导出海岛后必须执行此步，保证独立主角包含完整动作；脚本可在 Blender 内执行，或通过 `--background --python` 调用。
4. 使用 [render_previews.py](scripts/render_previews.py) 渲染预览，再执行无窗口资源检查并核对上面的预览要求。

这些工具只制作和导出美术资产，不启动游戏。
