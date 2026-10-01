"""渲染美术预览，游戏运行与视觉验收仍由用户完成。"""

import json
from pathlib import Path

import bpy

BASE = Path(__file__).resolve().parents[2]
report = json.loads((BASE/"art/build_report.json").read_text(encoding="utf-8"))
map_scene = bpy.data.scenes[report["map_scene"]]
for camera_name, file_name in ((report["cameras"]["overview"],"island_overview.png"),
                               (report["cameras"]["street"],"island_street.png"),
                               (report["cameras"]["courier"],"courier_view.png"),
                               (report["cameras"]["beach"],"beach_view.png")):
    bpy.context.window.scene = map_scene
    map_scene.camera = bpy.data.objects[camera_name]
    map_scene.render.resolution_y = 1000 if file_name in ("courier_view.png","beach_view.png") else 1200
    map_scene.render.filepath = str(BASE/"art/previews"/file_name)
    bpy.ops.render.render(write_still=True)
    print("Preview saved: " + file_name,flush=True)
lineup = bpy.data.scenes[report["lineup_scene"]]
bpy.context.window.scene = lineup
lineup.render.filepath = str(BASE/"art/previews/characters.png")
bpy.ops.render.render(write_still=True)
print("Preview saved: characters.png",flush=True)
bpy.context.window.scene = map_scene
map_scene.camera = bpy.data.objects[report["cameras"]["overview"]]
map_scene.render.resolution_y = 1200
bpy.ops.wm.save_as_mainfile(filepath=str(BASE/"art/blender/courier_island.blend"))
