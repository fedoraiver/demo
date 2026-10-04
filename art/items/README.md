# 快递道具美术资产

本库将道具设计草案转为独立低多边形资产，包含角色能力装备、工业流水线设施、魔法与奇怪效果道具三组。资产清单与接口数据的完整维护位置为 [asset_manifest.json](asset_manifest.json)。装备能力、分拣规则、机械模拟和魔法效果尚未接入游戏，不能据此推断当前版本可使用这些道具。

## 制作源与浏览

- Blender 源库：[courier_items.blend](../blender/courier_items.blend)，场景 `Courier_Items_Library`。
- 带中文标签的 [总览](../previews/items/overview.png) 与 [本地目录](../previews/items/catalog.html)。目录可放大单件预览、打开对应 GLB。
- 分组预览：[能力装备](../previews/items/equipment.png)、[工业设施](../previews/items/industrial.png)、[魔法道具](../previews/items/magic.png)、[结构变体](../previews/items/variants.png)。
- 现有快递员的静态穿戴尺度示意：[背面](../previews/items/equipment_fit.png)、[正面](../previews/items/equipment_fit_front.png)，对应源场景 `Courier_Items_Equipment_Fit`。它是制作参考，没有角色动画或游戏装备绑定。

所有模型沿用岛屿资产库的蓝黄、奶油、金属与风化木材配色。颜色存储在内置材质中，没有外部贴图、下载模型或字体依赖；目录标签字体只影响预览排版。

## 资产范围

| 分类 | 道具 | 主资产 ID |
| --- | --- | --- |
| 能力装备 | 抓牢手套 | `itm_grip_gloves` |
| 能力装备 | 伸缩搬运夹 | `itm_reach_grabber` |
| 能力装备 | 山羊登山靴 | `itm_goat_boots` |
| 能力装备 | 蓄力弹簧鞋 | `itm_spring_boots` |
| 能力装备 | 邮差背架 | `itm_courier_frame` |
| 能力装备 | 折叠滑翔披风 | `itm_glider_cape` |
| 工业设施 | 模块传送带 | `mach_conveyor` |
| 工业设施 | 地址分拣闸 | `mach_address_sorter` |
| 工业设施 | 蓄件缓存柜 | `mach_buffer_cabinet` |
| 工业设施 | 托盘打包机 | `mach_pallet_packer` |
| 工业设施 | 回转装车臂 | `mach_loading_arm` |
| 工业设施 | 气动发射台 | `mach_pneumatic_launcher` |
| 魔法道具 | 羽毛邮票 | `magic_feather_stamp` |
| 魔法道具 | 停时胶带 | `magic_stasis_tape` |
| 魔法道具 | 折角邮票 | `magic_fold_stamp` |
| 魔法道具 | 地板换向贴 | `magic_turn_sticker` |
| 魔法道具 | 溜溜雾瓶 | `magic_slip_mist` |
| 魔法道具 | 口袋风瓶 | `magic_wind_bottle` |

配套变体为收拢披风 `itm_glider_cape_folded`、传送带弯道 `mach_conveyor_corner`、斜坡 `mach_conveyor_ramp` 与发射接货篮 `mach_receiver_basket`。变体通过清单中的 `item_id` 与主件关联，具有各自独立 GLB。

## 坐标、接口与接入边界

Blender 源坐标为米制、Z 向上，装备的使用前方和工业运输方向为 +Y；GLB 转为 Y 向上，源 +Y 对应 -Z。独立模型根节点位于原点，最低点在地面。源库中的行列摆放只用于浏览，不写入独立 GLB。

- 装备保留手部、脚部或背部槽位信息；成对手套和鞋有 `part_left` / `part_right` 子根，可分别挂接。`socket_wrist_*`、`socket_ankle_*` 与 `socket_spine` 描述制作参考位置。
- 工业设施保留 `socket_input` / `socket_output`。传送带标准承载面高 0.75 m、模块长 1.5 m；弯道与斜坡按各自接口连接，不能仅按包围盒拼接。
- 分拣挡板、打包转台、装车臂关节和发射炮筒保留独立 `pivot_*` 节点。机械动作需要后续 ECS 系统驱动，本批资产没有预设动画。
- 魔法邮票与地贴正面朝 +Z；胶带和瓶身主要标识朝 -Y。`socket_attach` / `socket_effect` 为后续贴附和特效挂点。风瓶静态微光符文不代表已实现风场。
- 清单中的挂点矩阵为源坐标的列主序矩阵；转换到游戏坐标时使用 GLB 节点变换。不能直接将未对齐的装备零旋转套到角色骨骼局部轴。

这些资产不提供角色蒙皮、碰撞体、寻路、订单判定或粒子系统。角色装备接入时需根据骨骼姿态、遮挡和鞋底高度处理贴合；机械接入时需另行定义交互范围与物理约束。当前游戏未加载新道具，启动游戏不能验收它们。

## 重建与离线验证

制作使用 Blender 5.2.2 LTS。命令中的 Blender 路径可替换为本机安装位置；所有命令从仓库根执行。后台制作不会打开游戏，也不会覆盖原有海岛源文件。

```sh
mkdir -p tmp/item-assets
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python-exit-code 1 --python art/scripts/build_items.py -- --render > tmp/item-assets/build.log 2>&1
/Applications/Blender.app/Contents/MacOS/Blender --background art/blender/courier_items.blend --python-exit-code 1 --python art/scripts/render_item_context.py > tmp/item-assets/context.log 2>&1
PYTHONPYCACHEPREFIX=tmp/python-cache python3 art/scripts/compose_item_catalog.py
PYTHONPYCACHEPREFIX=tmp/python-cache python3 art/scripts/validate_items.py --report tmp/item-assets/validation.json
PYTHONPYCACHEPREFIX=tmp/python-cache python3 art/scripts/validate_assets.py --report tmp/item-assets/all-assets.json
```

目录排版脚本需要 Pillow；Blender 建模与 GLB 导出不需要 Pillow。生成器分别为 [装备](../scripts/items_equipment.py)、[工业设施](../scripts/items_industrial.py)、[魔法道具](../scripts/items_magic.py)，统一流程为 [build_items.py](../scripts/build_items.py)。

离线检查读取实际 GLB 顶点、索引、法线和节点，核对根原点、米制尺寸、三角预算、挂点矩阵、成对子根、清单字节大小以及摄影棚隔离；全库验证同时覆盖旧海岛资产。报告保存在根 `tmp/`，不提交。

视觉检查应逐组打开预览，观察道具轮廓、薄面法线、文字与徽记、机械连接和比例，再在 Blender 源库中从背面检查薄片与肩带。预览目录按件取景，图片中大小不能用于比较真实尺寸，应以清单和 Blender 米制网格为准。游戏内显示和操控需要在后续接入后由用户自行验收，查看当次 `logs/unix-<时间戳>_<会话UUID>.log`。
