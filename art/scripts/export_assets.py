"""从源资产集合导出独立 GLB 与完整海岛；不包含预览用灯光和相机。"""

import json
from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import assetlib as h


def select(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.context.view_layer.update()


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects if obj.type == "MESH" for corner in obj.bound_box]
    return {"min":[round(min(p[i] for p in points),4) for i in range(3)],
            "max":[round(max(p[i] for p in points),4) for i in range(3)]}


def export(path, objects, animate=False):
    select(objects)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", check_existing=False,
        use_selection=True, use_active_scene=True, export_extras=True, export_yup=True,
        export_cameras=False, export_lights=False, export_animations=animate,
        export_animation_mode="ACTIONS", export_anim_single_armature=True,
        export_frame_range=False, export_force_sampling=True,
        export_rest_position_armature=animate, export_skins=True, export_def_bones=False,
        export_apply=False, export_materials="EXPORT")


def main():
    report = json.loads((BASE/"art/build_report.json").read_text(encoding="utf-8"))
    library = bpy.data.scenes[report["library_scene"]]
    map_scene = bpy.data.scenes[report["map_scene"]]
    bpy.context.window.scene = library
    library.frame_set(1)
    entries = []
    for item in report["assets"]:
        asset_id = item["id"]
        root = next(obj for obj in library.objects if obj.get("asset_id") == asset_id and obj.parent is None)
        objects = h.descendants(root)
        path = BASE / "assets/models" / item["category"] / (asset_id + ".glb")
        # 源库的排列只用于浏览；重复导出时必须恢复独立模型的原点与单位比例。
        display_transform = root.matrix_world.copy()
        visibility = [(col,col.hide_viewport,col.hide_render) for col in root.users_collection]
        for col,_,_ in visibility:
            col.hide_viewport = False
            col.hide_render = False
        root.matrix_world = Matrix.Identity(4)
        try:
            export(path, objects, animate=asset_id == "chr_courier")
            local_bounds = bounds(objects)
        finally:
            root.matrix_world = display_transform
            for col,hidden_view,hidden_render in visibility:
                col.hide_viewport = hidden_view
                col.hide_render = hidden_render
        entries.append({"id":asset_id,"category":item["category"],"file":path.relative_to(BASE).as_posix(),
            "root_node":root.name,"pivot":"center" if asset_id in ("prop_parcel_standard","prop_parcel_fragile","prop_crate") else "base",
            "blender_bounds":local_bounds, "mesh_objects":sum(obj.type=="MESH" for obj in objects),
            "triangles":sum(len(poly.vertices)-2 for obj in objects if obj.type=="MESH" for poly in obj.data.polygons),
            "animations":["Idle","Walk","Carry_Idle"] if asset_id=="chr_courier" else [],
            "bytes":path.stat().st_size})
    bpy.context.window.scene = map_scene
    map_scene.frame_set(1)
    map_objects = list(next(col for col in map_scene.collection.children if col.name.startswith("Island_Map")).objects)
    map_path = BASE / "assets/maps/courier_island.glb"
    export(map_path, map_objects)
    instances = [{"name":o.name,"asset":o["source_asset"],"position_blender":list(o.location),
                  "rotation_z":o.rotation_euler.z,"scale":list(o.scale)}
                 for o in map_objects if o.get("source_asset")]
    manifest = {"name":"Courier Island", "blender_version":bpy.app.version_string,
        "units":"meters", "source_file":"art/blender/courier_island.blend",
        "source_axes":"Z-up; characters +Y forward; buildings -Y front", "export_axes":"glTF Y-up; characters -Z forward",
        "palette_srgb":h.PALETTE,"assets":entries,
        "map":{"file":map_path.relative_to(BASE).as_posix(),"bytes":map_path.stat().st_size,"instances":instances},
        "integration_status":"Art assets only; not yet loaded by the game; collision and navigation not provided",
        "land_dimensions_m":[109,87],"coastline_area_m2":6070,
        "art_direction":"Irregular desolate tropical island; weathered wooden buildings; no planned roads or parks",
        "notes_zh":["地图为不规则荒凉海岛，陆地约110×90米，以沙地、碎石、野草和弯曲棕榈组成。",
                    "移除规则路网、环岛步道、铺装广场与海景公园，建筑改为破旧木屋和木棚。", "模型颜色使用内置材质，不依赖外部贴图。",
                    "主角骨架使用分段刚性权重；动作无根运动。", "台阶、建筑与地图不包含物理碰撞、寻路数据或玩法组件。"]}
    (BASE/"art/asset_manifest.json").write_text(json.dumps(manifest,indent=2,ensure_ascii=False),encoding="utf-8")
    # 源库排成可浏览的行列，环境在地图场景单独查看，避免巨大的海面遮挡其他源件。
    category_index = {}
    for item in report["assets"]:
        root = next(o for o in library.objects if o.get("asset_id")==item["id"] and o.parent is None)
        category = item["category"]
        i = category_index.get(category,0)
        category_index[category] = i+1
        if category == "characters":
            root.location = ((i-2)*2,0,0)
        elif category == "props":
            root.location = ((i%6-2.5)*5,-6-(i//6)*6,0.4 if item["id"] in ("prop_parcel_standard","prop_parcel_fragile","prop_crate") else 0)
        elif category == "buildings":
            root.location = ((i-2)*10,12,0)
        elif item["id"].startswith("prop_"):
            root.location = ((i-1.5)*6,-22,0)
        else:
            for collection in root.users_collection:
                collection.hide_viewport = True
                collection.hide_render = True
    bpy.context.window.scene = map_scene
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.wm.save_as_mainfile(filepath=str(BASE/"art/blender/courier_island.blend"))
    print(json.dumps({"exported_assets":len(entries),"map":str(map_path),"total_bytes":sum(x["bytes"] for x in entries)+map_path.stat().st_size}))


if __name__ == "__main__":
    main()
