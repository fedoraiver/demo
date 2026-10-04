"""在 Blender 内独立刷新快递员动作、制作源与运行 GLB，不重导出整张地图。"""

from pathlib import Path
import sys

# 本工具的缓存统一交给调用者根 tmp 配置；默认不在制作脚本旁产生临时 pyc。
sys.dont_write_bytecode = True

import bpy
from mathutils import Matrix

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from courier_actions import add_sole_markers, build_actions


def main():
    """只追加角色集合，不清除用户已有场景；导出仅选择角色层级。"""
    scene = bpy.context.scene
    rig = next((o for o in scene.objects if o.type == "ARMATURE" and o.parent
                and o.parent.get("asset_id") == "chr_courier"), None)
    if rig is None:
        source = BASE / "art/blender/courier_actions.blend"
        if not source.exists():
            source = BASE / "art/blender/courier_island.blend"
        with bpy.data.libraries.load(str(source), link=False) as (available, loaded):
            loaded.collections = ["chr_courier"]
        scene = bpy.data.scenes.new("Courier_Actions")
        scene.collection.children.link(loaded.collections[0])
        bpy.context.window.scene = scene
        rig = next(o for o in scene.objects if o.type == "ARMATURE")
    root = rig.parent
    root.matrix_world = Matrix.Identity(4)
    for collection in root.users_collection:
        collection.hide_viewport = False
        collection.hide_render = False
    # 标记先在静止骨架下定位；之后跟随标准骨骼导出，运行时无需读取网格。
    add_sole_markers(rig)
    build_actions(rig)
    bpy.ops.object.select_all(action="DESELECT")
    objects = [root, *root.children_recursive]
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    # 新场景先初始化 ViewLayer，再保存；当前 Blender 的 partial write 对未初始化视图有崩溃缺陷。
    source_scene = bpy.data.scenes.new("Courier_Action_Source")
    for collection in root.users_collection:
        source_scene.collection.children.link(collection)
    source_scene.render.fps = scene.render.fps
    source_scene.render.fps_base = scene.render.fps_base
    source_scene.frame_start, source_scene.frame_end = 1, 25
    bpy.context.window.scene = source_scene
    bpy.context.view_layer.update()
    bpy.data.libraries.write(str(BASE / "art/blender/courier_actions.blend"), {source_scene})
    bpy.context.window.scene = scene
    bpy.data.scenes.remove(source_scene)
    output = BASE / "assets/models/characters/chr_courier.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", check_existing=False,
        use_selection=True, use_active_scene=True, export_extras=True, export_yup=True,
        export_cameras=False, export_lights=False, export_animations=True,
        export_animation_mode="ACTIONS", export_anim_single_armature=True,
        export_frame_range=False, export_force_sampling=True, export_anim_slide_to_zero=True,
        export_optimize_animation_size=False, export_rest_position_armature=True,
        export_skins=True, export_def_bones=False, export_apply=False, export_materials="EXPORT",
    )
    print(f"Courier actions exported: {output}")


if __name__ == "__main__":
    main()
