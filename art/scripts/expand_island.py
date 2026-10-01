"""保留人物与通用道具，重新生成荒岛、棕榈和风化木建筑。"""

import importlib
import json
from pathlib import Path
import sys

import bpy

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(Path(__file__).resolve().parent))
importlib.invalidate_caches()
import assetlib as h
import build_scene
import district
import island
import buildings
import tropical
import huts

for module in (h,island,district,huts,buildings,tropical,build_scene):
    importlib.reload(module)
report = json.loads((BASE/"art/build_report.json").read_text(encoding="utf-8"))
library = bpy.data.scenes[report["library_scene"]]
build_scene.activate(library)
roots = {o["asset_id"]:o for o in library.objects if o.get("asset_id") and o.parent is None}
h.ASSETS[:] = [h.Asset(roots[item["id"]], roots[item["id"]].users_collection[0],item["category"])
               for item in report["assets"]]
for scene_name in (report["map_scene"],report.get("lineup_scene","Character_Lineup")):
    scene = bpy.data.scenes.get(scene_name)
    if scene:
        # 只清理本次生成的展示场景，不触及用户原有 Scene 或源资产网格数据。
        for obj in list(scene.objects):
            bpy.data.objects.remove(obj,do_unlink=True)
        for col in list(scene.collection.children):
            bpy.data.collections.remove(col)
        bpy.data.scenes.remove(scene)
for a in list(h.ASSETS):
    if a.category == "preview":
        h.ASSETS.remove(a)
    elif a.root["asset_id"].startswith(("env_","bld_","prop_palm_","prop_wild_grass_")):
        for obj in list(a.collection.objects):
            bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.collections.remove(a.collection)
        h.ASSETS.remove(a)
plants = tropical.build_tropical(h)
for plant in plants:
    if plant.root["asset_id"] == "prop_wild_grass_patch":
        h.merge_static_meshes(plant,"Wild_grass_cluster")
assets = [a for a in h.ASSETS if a.category != "preview"]
new_buildings = buildings.build_buildings(h)
new_environment = island.build_environment(h) + district.build_district(h)
assets += new_buildings + new_environment
build_scene.assemble(assets,library)
