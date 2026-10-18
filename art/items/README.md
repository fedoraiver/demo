# 道具美术资产

本文提供道具资产的浏览入口、导入参考与重建步骤。资产分为能力装备、工业设施和魔法道具，完整清单与接口数据由 [asset_manifest.json](asset_manifest.json) 维护。

当前游戏未装配该道具库，装备能力、分拣规则、机械模拟和魔法效果均未接入。资产的造型、名称与接口不构成玩法承诺；玩法确认状态见 [游戏设计](../../docs/game-design.md)。

## 制作源与浏览

- Blender 源库：[courier_items.blend](../blender/courier_items.blend)，场景 `Courier_Items_Library`。
- 带中文标签的 [总览](../previews/items/overview.png) 与 [本地目录](../previews/items/catalog.html)。目录可放大单件预览、打开对应 GLB。
- 分组预览：[能力装备](../previews/items/equipment.png)、[工业设施](../previews/items/industrial.png)、[魔法道具](../previews/items/magic.png)、[结构变体](../previews/items/variants.png)。
- 快递员的静态穿戴尺度示意：[背面](../previews/items/equipment_fit.png)、[正面](../previews/items/equipment_fit_front.png)，对应源场景 `Courier_Items_Equipment_Fit`。它是制作参考，没有角色动画或游戏装备绑定。

所有模型沿用岛屿资产库的共享配色，颜色存储在内置材质中。模型没有外部贴图、下载模型或字体依赖；目录标签字体只影响预览排版。

## 资产范围

| 分类 | 内容 | 制作模块 |
| --- | --- | --- |
| 能力装备 | 手部、脚部与背部装备 | [items_equipment.py](../scripts/items_equipment.py) |
| 工业设施 | 输送、分拣、暂存与装载模块 | [items_industrial.py](../scripts/items_industrial.py) |
| 魔法道具 | 邮票、胶带、瓶体与地贴 | [items_magic.py](../scripts/items_magic.py) |

单件名称、资产 ID、变体与文件路径以资产清单和 [预览目录](../previews/items/catalog.html) 为准。变体通过清单中的 `item_id` 与主件关联，各自提供独立 GLB。

## 坐标、接口与接入边界

Blender 源坐标为米制、Z 向上，装备的使用前方和工业运输方向为 +Y；GLB 转为 Y 向上，源 +Y 对应 -Z。独立模型根节点位于原点，最低点在地面。源库中的行列摆放只用于浏览，不写入独立 GLB。

- 装备保留手部、脚部或背部槽位信息；成对手套和鞋有 `part_left` / `part_right` 子根，可分别挂接。`socket_wrist_*`、`socket_ankle_*` 与 `socket_spine` 描述制作参考位置。
- 工业设施保留 `socket_input` / `socket_output`。传送带标准承载面高 0.75 m、模块长 1.5 m；弯道与斜坡按各自接口连接，不能仅按包围盒拼接。
- 分拣挡板、打包转台、装车臂关节和发射炮筒保留独立 `pivot_*` 节点。机械动作需要 ECS 系统驱动，资产没有预设动画。
- 魔法邮票与地贴正面朝 +Z；胶带和瓶身主要标识朝 -Y。`socket_attach` / `socket_effect` 为后续贴附和特效挂点。风瓶静态微光符文不代表已实现风场。
- 清单中的挂点矩阵为源坐标的列主序矩阵；转换到游戏坐标时使用 GLB 节点变换。不能直接将未对齐的装备零旋转套到角色骨骼局部轴。

这些资产不提供角色蒙皮、碰撞体、寻路、玩法逻辑或粒子系统。角色装备接入时需根据骨骼姿态、遮挡和鞋底高度处理贴合；机械接入时需另行定义交互范围与物理约束。美术验证只针对文件和预览，当前游戏内不能操作这些道具。

## 重建与离线验证

以下为重建操作步骤，从仓库根执行。准备与制作源匹配的 Blender 和安装 Pillow 的普通 Python；制作版本记录在资产清单中。`$blenderExe` 可使用 PATH 中的命令名，也可替换为本机 Blender 程序路径。

```powershell
$blenderExe = "blender"
New-Item -ItemType Directory -Force tmp/item-assets | Out-Null
$env:PYTHONPYCACHEPREFIX = "tmp/python-cache"
& $blenderExe --background --factory-startup --python-exit-code 1 --python art/scripts/build_items.py -- --render *> tmp/item-assets/build.log
& $blenderExe --background art/blender/courier_items.blend --python-exit-code 1 --python art/scripts/render_item_context.py *> tmp/item-assets/context.log
python art/scripts/compose_item_catalog.py
python art/scripts/validate_items.py --report tmp/item-assets/validation.json
python art/scripts/validate_assets.py --report tmp/item-assets/all-assets.json
```

命令依次重建模型与预览、生成静态穿戴示意、排版目录，再验证道具和完整资产库。统一入口为 [build_items.py](../scripts/build_items.py)；只有普通 Python 的目录排版需要 Pillow。后台制作不打开游戏，也不覆盖海岛源文件。

离线检查读取实际 GLB 顶点、索引、法线和节点，核对根原点、米制尺寸、三角预算、挂点矩阵、成对子根、清单字节大小以及摄影棚隔离；全库验证同时覆盖海岛资产。报告保存在根 `tmp/`，不提交。

视觉检查应逐组打开预览，观察道具轮廓、薄面法线、文字与徽记、机械连接和比例，再在 Blender 源库中从背面检查薄片与肩带。预览目录按件取景，图片中大小不能用于比较真实尺寸，应以清单和 Blender 米制网格为准。后续游戏内接入的验收按 [游戏手动验收](../../docs/testing/game-acceptance.md) 组织，日志位置见 [会话日志](../../docs/usage.md#会话日志)。
