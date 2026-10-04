"""用 Blender 制作、导出与渲染快递道具；不装配或启动游戏。"""

import argparse
import importlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector

BASE = Path(__file__).resolve().parents[2]
sys.pycache_prefix = str(BASE / "tmp/python-cache")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import assetlib as h


def set_enum(owner, name, preferred):
    """先读取当前版本支持的枚举，避免将旧版本选项写入 Blender。"""
    valid = {item.identifier for item in owner.bl_rna.properties[name].enum_items}
    if preferred not in valid:
        raise RuntimeError(f"Unsupported enum: {name}={preferred}; accepted={sorted(valid)}")
    setattr(owner, name, preferred)


def bounds(objects):
    """只测量可导出网格，不把挂点、灯光与预览地板计入道具尺寸。"""
    bpy.context.view_layer.update()
    points = [obj.matrix_world @ vertex.co for obj in objects
              if obj.type == "MESH" for vertex in obj.data.vertices]
    if not points:
        raise RuntimeError("Asset has no geometry")
    return [Vector(tuple(operation(point[axis] for point in points) for axis in range(3)))
            for operation in (min, max)]


def export_asset(asset):
    """GLB 保持米制原点，独立导出时排除摄影棚和展示摆放变换。"""
    objects = h.descendants(asset.root)
    asset.root.matrix_world = Matrix.Identity(4)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = asset.root
    path = BASE / "assets/models" / asset.category / (asset.root["asset_id"] + ".glb")
    path.parent.mkdir(parents=True, exist_ok=True)
    # 动态枚举的RNA列表可能为空；使用导出器本身的默认GLB格式，不猜测枚举值。
    properties = bpy.ops.export_scene.gltf.get_rna_type().properties
    arguments = {"filepath": str(path), "check_existing": False, "use_selection": True,
                 "use_active_scene": True, "export_extras": True, "export_yup": True,
                 "export_cameras": False, "export_lights": False, "export_animations": False,
                 "export_apply": False}
    material_modes = {item.identifier for item in properties["export_materials"].enum_items}
    if "EXPORT" in material_modes:
        arguments["export_materials"] = "EXPORT"
    bpy.ops.export_scene.gltf(**arguments)
    if not path.is_file() or path.read_bytes()[:4] != b"glTF":
        raise RuntimeError(f"Expected embedded GLB output: {path}")
    minimum, maximum = bounds(objects)
    sockets = []
    for obj in objects:
        suffix = obj.name.split("__", 1)[-1]
        if obj.type == "EMPTY" and (suffix.startswith("socket_") or suffix.startswith("part_")):
            local = asset.root.matrix_world.inverted() @ obj.matrix_world
            # 空节点的完整矩阵为将来挂接提供旋转依据；转成glTF轴时由导出器负责。
            sockets.append({"node": obj.name, "kind": suffix,
                            "position_blender_m": [round(value, 6) for value in local.translation],
                            "matrix_blender_column_major": [round(local[row][column], 6)
                                                             for column in range(4) for row in range(4)]})
    return {"id": asset.root["asset_id"], "item_id": asset.root.get("item_id", asset.root["asset_id"]),
            "name_zh": asset.root.get("display_name_zh", asset.root["asset_id"]),
            "category": asset.category, "variant": asset.root.get("variant", "default"),
            "file": path.relative_to(BASE).as_posix(), "root_node": asset.root.name,
            "pivot": "base", "bounds_blender_m": {"min": list(minimum), "max": list(maximum)},
            "dimensions_m": [round(value, 6) for value in maximum - minimum],
            "mesh_objects": sum(obj.type == "MESH" for obj in objects),
            "triangles": sum(len(face.vertices) - 2 for obj in objects if obj.type == "MESH"
                             for face in obj.data.polygons), "bytes": path.stat().st_size,
            "equip_slot": asset.root.get("equip_slot"),
            "surface_normal": asset.root.get("surface_normal", "+Y"), "sockets": sockets,
            "mechanical_pivots": [obj.name for obj in objects if obj.type == "EMPTY"
                                  and "pivot_" in obj.name],
            "animations": [], "preview": f"art/previews/items/{asset.root['asset_id']}.png"}


def configure_studio(scene):
    """摄影棚只用于资产视觉检查，所有对象都放在独立的预览集合中。"""
    set_enum(scene.unit_settings, "system", "METRIC")
    scene.unit_settings.scale_length = 1.0
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    set_enum(scene.render.image_settings, "file_format", "PNG")
    scene.render.film_transparent = False
    # 保留当前实际有效的渲染器；不依赖版本或插件提供的动态引擎枚举。
    scene["render_engine"] = scene.render.engine
    world = bpy.data.worlds.new("Courier_Items_Studio_World")
    world.use_nodes = True
    background = next(node for node in world.node_tree.nodes if node.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.68, 0.71, 0.75, 1)
    background.inputs["Strength"].default_value = 0.55
    scene.world = world
    collection = bpy.data.collections.new("Items_Preview_Studio")
    scene.collection.children.link(collection)
    camera_data = bpy.data.cameras.new("Camera_Items_Studio")
    set_enum(camera_data, "type", "ORTHO")
    camera = bpy.data.objects.new(camera_data.name, camera_data)
    collection.objects.link(camera)
    camera_data.clip_start = 0.001
    camera_data.clip_end = 200
    scene.camera = camera
    floor_mesh = bpy.data.meshes.new("Items_Studio_Floor")
    floor_mesh.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
    floor_mesh.update()
    floor = bpy.data.objects.new(floor_mesh.name, floor_mesh)
    collection.objects.link(floor)
    floor_mesh.materials.append(h.material("cream"))
    lights = []
    for name in ("Items_Key", "Items_Fill", "Items_Rim"):
        data = bpy.data.lights.new(name, "AREA")
        light = bpy.data.objects.new(name, data)
        collection.objects.link(light)
        lights.append(light)
    return {"collection": collection, "camera": camera, "floor": floor, "lights": lights}


def frame_asset(scene, studio, asset):
    """以投影后的真实包围盒取景，薄邮票和展开披风也不被裁切。"""
    minimum, maximum = bounds(h.descendants(asset.root))
    center = (minimum + maximum) / 2
    extent = max(maximum - minimum)
    direction = Vector((4.5, -7, 5.4))
    if asset.root.get("surface_normal") == "+Z":
        direction = Vector((1.8, -3, 6.3))
    elif asset.root["asset_id"] == "magic_stasis_tape":
        # 低角度显出贯通卷芯，避免地板在孔后被误读为封闭盖面。
        direction = Vector((3.4, -8, 2))
    camera = studio["camera"]
    camera.location = center + direction.normalized() * extent * 5
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    rotation = camera.rotation_euler.to_quaternion().inverted()
    projected = [rotation @ (Vector((x, y, z)) - center)
                 for x in (minimum.x, maximum.x) for y in (minimum.y, maximum.y)
                 for z in (minimum.z, maximum.z)]
    span = max(max(point[axis] for point in projected) - min(point[axis] for point in projected)
               for axis in (0, 1))
    camera.data.ortho_scale = span * 1.26
    floor = studio["floor"]
    floor.location = (center.x, center.y, minimum.z - extent * 0.005)
    floor.scale = (extent * 200, extent * 200, 1)
    for light, offset, energy, size in zip(studio["lights"], ((-3, -4, 6), (4, 1, 3), (-2, 4, 5)),
                                          (360, 170, 260), (4, 5, 3)):
        light.location = center + Vector(offset) * extent
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
        light.data.energy = energy * extent * extent
        light.data.size = size * extent
    bpy.context.view_layer.update()


def render_previews(scene, studio, assets):
    """每张预览只显示对应道具，渲染不包含其他模型或示例包裹。"""
    target = BASE / "art/previews/items"
    target.mkdir(parents=True, exist_ok=True)
    for asset in assets:
        for other in assets:
            other.collection.hide_render = other != asset
        frame_asset(scene, studio, asset)
        scene.render.filepath = str(target / (asset.root["asset_id"] + ".png"))
        bpy.ops.render.render(write_still=True)
        print(f"ITEM_PREVIEW_SAVED {asset.root['asset_id']}", flush=True)
    for asset in assets:
        asset.collection.hide_render = False


def layout_library(scene, studio, assets):
    """源库保留真实尺寸与独立集合，按类别排列，摄影棚默认隐藏。"""
    categories = {"items/equipment": 0, "items/industrial": 1, "items/magic": 2}
    counts = {}
    for asset in assets:
        category = asset.category
        index = counts.get(category, 0)
        counts[category] = index + 1
        asset.root.location = (index * 4, categories[category] * 6, 0)
    studio["collection"].hide_viewport = True
    studio["collection"].hide_render = True
    bpy.ops.object.select_all(action="DESELECT")
    configure_library_view()
    scene["asset_library"] = "Courier Items"
    scene["integration_status"] = "art_assets_only"


def configure_library_view():
    """打开源库即可俯瞰三组资产，隐藏挂点连线和网格以便审阅。"""
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                space = area.spaces.active
                set_enum(space.shading, "type", "MATERIAL")
                set_enum(space.shading, "background_type", "VIEWPORT")
                space.shading.background_color = (0.18, 0.20, 0.22)
                for name in ("show_extras", "show_relationship_lines", "show_floor",
                             "show_axis_x", "show_axis_y", "show_cursor"):
                    if hasattr(space.overlay, name):
                        setattr(space.overlay, name, False)
                if space.region_3d:
                    set_enum(space.region_3d, "view_perspective", "ORTHO")
                    space.region_3d.view_location = (16, 6, 0.8)
                    space.region_3d.view_distance = 35
                    space.region_3d.view_rotation = (-Vector((8, -16, 24))).to_track_quat("-Z", "Y")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render", action="store_true")
    options = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    scene = bpy.data.scenes.new("Courier_Items_Library")
    bpy.context.window.scene = scene
    h.ASSETS.clear()
    assets = []
    for module_name, function in (("items_equipment", "build_equipment"),
                                  ("items_industrial", "build_industrial"),
                                  ("items_magic", "build_magic")):
        module = importlib.import_module(module_name)
        print(f"ITEM_GROUP_BUILDING {module_name}", flush=True)
        assets.extend(getattr(module, function)(h))
    studio = configure_studio(scene)
    entries = []
    for asset in assets:
        entry = export_asset(asset)
        entries.append(entry)
        print(f"ITEM_EXPORTED {entry['id']} {entry['triangles']} triangles", flush=True)
    manifest = {"name": "Courier Items", "schema_version": 1, "blender_version": bpy.app.version_string,
                "units": "meters", "source_file": "art/blender/courier_items.blend",
                "source_axes": "Z-up; equipment +Y forward; industrial +Y output; decals +Z normal",
                "export_axes": "glTF Y-up; source +Y maps to -Z",
                "palette_srgb": h.PALETTE, "assets": entries,
                "main_item_count": len({entry['item_id'] for entry in entries}),
                "integration_status": "art_assets_only",
                "notes_zh": ["模型与预览已制作；装备效果、流水线与魔法玩法尚未接入。",
                             "左右装备、机械枢轴与接口保留命名节点，未提供碰撞或玩法组件。",
                             "材质为项目共享内置配色，不依赖外部图片。",
                             "源库展示位置不参与GLB导出；独立模型的根原点为零。"]}
    manifest_path = BASE / "art/items/asset_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # 渲染失败时仍保留完整模型源；重复保存不产生仓库外的备份文件。
    bpy.context.preferences.filepaths.save_version = 0
    path = BASE / "art/blender/courier_items.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
    if options.render:
        render_previews(scene, studio, assets)
    layout_library(scene, studio, assets)
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
    print(json.dumps({"status": "built", "assets": len(entries),
                      "main_items": manifest['main_item_count'], "source": str(path)}), flush=True)


if __name__ == "__main__":
    main()
