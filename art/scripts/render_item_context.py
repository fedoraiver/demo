"""在 Blender 中用现有快递员制作装备尺度示意，不绑定游戏或角色动作。"""

from pathlib import Path
import sys

import bpy
from mathutils import Matrix, Vector

BASE = Path(__file__).resolve().parents[2]
sys.pycache_prefix = str(BASE / "tmp/python-cache")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import assetlib as h
import build_items as pipeline


def copy_asset(root, target, name, location=(0, 0, 0)):
    """沿用原来的层级并共享网格，复制骨架后重定向角色蒙皮。"""
    originals = h.descendants(root)
    copied = {}
    for obj in originals:
        clone = obj.copy()
        if obj.type == "ARMATURE":
            clone.data = obj.data.copy()
        target.collection.objects.link(clone)
        clone.name = name + "__" + obj.name.split("__", 1)[-1]
        copied[obj] = clone
    for original, clone in copied.items():
        clone.parent = target.root if original == root else copied[original.parent]
        for modifier in clone.modifiers:
            if modifier.type == "ARMATURE" and modifier.object in copied:
                modifier.object = copied[modifier.object]
        if clone.type == "ARMATURE":
            clone.animation_data_clear()
            for bone in clone.pose.bones:
                bone.matrix_basis = Matrix.Identity(4)
    copied[root].matrix_basis = Matrix.Translation(Vector(location))
    return copied[root]


def align_socket(root, suffix, target, scale=1):
    """静态穿戴先对齐源轴；将来接动画时还需叠加骨骼姿态差矩阵。"""
    root.scale = (scale, scale, scale)
    bpy.context.view_layer.update()
    socket = next(obj for obj in h.descendants(root) if obj.name.endswith("__" + suffix))
    root.location += Vector(target) - socket.matrix_world.translation
    bpy.context.view_layer.update()


def equip_pair(source, assembly, name, x, socket_prefix, targets, scale=1):
    """左右部分分别对齐，不让源库用于展示的左右间距影响角色挂接。"""
    root = copy_asset(source, assembly, name)
    root.matrix_basis = Matrix.Identity(4)
    for side, destination in targets.items():
        part = next(obj for obj in root.children if obj.name.endswith("__part_" + side))
        part.scale = (scale, scale, scale)
        bpy.context.view_layer.update()
        socket = next(obj for obj in h.descendants(part)
                      if obj.name.endswith("__" + socket_prefix + "_" + side))
        part.location += Vector((destination[0] + x, destination[1], destination[2])) - socket.matrix_world.translation
        bpy.context.view_layer.update()
    return root


def hide_original_parts(root, parts):
    """替换示意中的旧鞋或手网格，避免重叠；原快递员源资产保持不变。"""
    for obj in h.descendants(root):
        if obj.type == "MESH" and any(part in obj.name.split("__", 1)[-1] for part in parts):
            obj.hide_render = True


def main():
    library = bpy.data.scenes["Courier_Items_Library"]
    context_name = "Courier_Items_Equipment_Fit"
    if context_name in bpy.data.scenes:
        raise RuntimeError("Equipment context scene already exists; rebuild the source library first")
    scene = bpy.data.scenes.new(context_name)
    scene["asset_context_preview"] = True
    scene["integration_status"] = "static_fit_reference_only"
    bpy.context.window.scene = scene
    with bpy.data.libraries.load(str(BASE / "art/blender/courier_island.blend"), link=False) as (source, loaded):
        if "chr_courier" not in source.collections:
            raise RuntimeError("Courier source collection missing")
        loaded.collections = ["chr_courier"]
    courier_collection = loaded.collections[0]
    courier_root = next(obj for obj in courier_collection.objects if obj.parent is None
                        and obj.get("asset_id") == "chr_courier")
    assembly = h.asset("Equipment_Fit_Reference", "preview")
    assets = {obj["asset_id"]: obj for obj in library.objects
              if obj.parent is None and obj.get("asset_id")}
    for index, x in enumerate((-.85, .85)):
        lift = 0 if index == 0 else .07
        character = copy_asset(courier_root, assembly, f"Courier_Kit_{index}", (x, 0, lift))
        hide_original_parts(character, ("Boot ", "Boot sole ", "Boot toe ", "Hand ", "Thumb "))
        gloves = assets["itm_grip_gloves"]
        equip_pair(gloves, assembly, f"Gloves_Kit_{index}", x, "socket_wrist",
                   {"left": (.314, .033, .963 + lift), "right": (-.314, .033, .963 + lift)}, .78)
        boots_id = "itm_goat_boots" if index == 0 else "itm_spring_boots"
        boots = copy_asset(assets[boots_id], assembly, f"Boots_Kit_{index}", (x, 0, 0))
        # 鞋以地面为基准；角色本体独立抬高，让加厚弹簧鞋保持落地。
        boots.matrix_basis = Matrix.Translation(Vector((x, 0, 0)))
        back_id = "itm_courier_frame" if index == 0 else "itm_glider_cape"
        back = copy_asset(assets[back_id], assembly, f"Back_Kit_{index}")
        align_socket(back, "socket_spine", (x, -.140, 1.215 + lift))
    studio = pipeline.configure_studio(scene)
    pipeline.frame_asset(scene, studio, assembly)
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1100
    # 摄像机从后方三分之四看背架与展开翼，两件装备都能读出结构。
    scene.camera.data.ortho_scale *= 1.16
    scene.render.filepath = str(BASE / "art/previews/items/equipment_fit.png")
    bpy.ops.render.render(write_still=True)
    minimum, maximum = pipeline.bounds(h.descendants(assembly.root))
    center = (minimum + maximum) / 2
    direction = Vector((4.5, 7, 4.8))
    scene.camera.location = center + direction.normalized() * max(maximum - minimum) * 5
    scene.camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(BASE / "art/previews/items/equipment_fit_front.png")
    bpy.ops.render.render(write_still=True)
    pipeline.configure_library_view()
    bpy.context.window.scene = library
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(BASE / "art/blender/courier_items.blend"))
    print("EQUIPMENT_CONTEXT_SAVED", flush=True)


if __name__ == "__main__":
    main()
