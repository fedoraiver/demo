"""在已打开的 Blender 中构建海岛源文件，保留用户原来的 Scene。"""

import importlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
importlib.invalidate_caches()
import assetlib as h
import buildings
import characters
import island
import props
import district
import tropical
import huts


def activate(scene):
    bpy.context.window.scene = scene


def camera(scene, name, position, target, ortho):
    data = bpy.data.cameras.new(name)
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    data.type = "ORTHO"
    data.ortho_scale = ortho
    data.lens = 48
    data.clip_end = 500
    return obj


def configure_sky(world):
    """天空保持蓝色，环境补光用淡色，避免旧木板在阴影中变成浓蓝色。"""
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    nodes.clear()
    ambient = nodes.new("ShaderNodeBackground")
    ambient.inputs["Color"].default_value = (0.68,0.78,0.92,1)
    ambient.inputs["Strength"].default_value = 0.75
    sky = nodes.new("ShaderNodeBackground")
    sky.inputs["Color"].default_value = (0.18,0.42,0.78,1)
    sky.inputs["Strength"].default_value = 0.8
    rays = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    output = nodes.new("ShaderNodeOutputWorld")
    links.new(rays.outputs["Is Camera Ray"],mix.inputs[0])
    links.new(ambient.outputs[0],mix.inputs[1])
    links.new(sky.outputs[0],mix.inputs[2])
    links.new(mix.outputs[0],output.inputs["Surface"])


def lighting(scene):
    """暖阳与柔和补光保留木板颜色和低多边形的平面层次。"""
    world = bpy.data.worlds.new(scene.name + "_Sky")
    configure_sky(world)
    scene.world = world
    sun_data = bpy.data.lights.new(scene.name + "_Sun", "SUN")
    sun_data.energy = 3.0
    sun_data.angle = math.radians(12)
    sun_data.color = (1, 0.91, 0.79)
    sun = bpy.data.objects.new(sun_data.name, sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(40), math.radians(-25), math.radians(-15))
    area_data = bpy.data.lights.new(scene.name + "_Fill", "AREA")
    area_data.energy = 1700
    area_data.shape = "DISK"
    area_data.size = 16
    area = bpy.data.objects.new(area_data.name, area_data)
    scene.collection.objects.link(area)
    area.location = (3, -15, 18)
    area.rotation_euler = (Vector((0, 1, 1)) - area.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.fps = 24
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    if hasattr(scene.eevee, "taa_render_samples"):
        scene.eevee.taa_render_samples = 64


def build():
    # 同一 Blender 进程可再次执行，载入最新脚本并以稳定 asset_id 组装新场景。
    for module in (h,characters,props,huts,buildings,island,district,tropical):
        importlib.reload(module)
    library = bpy.data.scenes.new("Courier_Asset_Library")
    activate(library)
    library.unit_settings.system = "METRIC"
    library.unit_settings.scale_length = 1.0
    library.render.fps = 24
    library.frame_end = 25
    h.ASSETS.clear()
    base = characters.build_characters(h) + props.build_props(h) + buildings.build_buildings(h)
    plants = tropical.build_tropical(h)
    for plant in plants:
        if plant.root["asset_id"] == "prop_wild_grass_patch":
            h.merge_static_meshes(plant,"Wild_grass_cluster")
    assets = base + plants + island.build_environment(h) + district.build_district(h)
    assemble(assets, library)


def assemble(assets, library):
    """将已完成的源资产组装成独立地图与人物展示场景。"""
    map_scene = bpy.data.scenes.new("Courier_Island")
    activate(map_scene)
    map_scene.unit_settings.system = "METRIC"
    map_scene.frame_end = 25
    collection = bpy.data.collections.new("Island_Map")
    map_scene.collection.children.link(collection)
    island.dress_map(h, assets, collection)
    district.dress_district(h, {a.root["asset_id"]:a for a in assets}, collection)
    lighting(map_scene)
    overview = camera(map_scene, "Camera_Island_Overview", (100,-137,98), (0,0,0), 153)
    street = camera(map_scene, "Camera_Street_View", (19,-29,15), (0,3,1.8), 35)
    courier_view = camera(map_scene,"Camera_Courier_View",(5,-13,4.2),(-1,5,2.4),35)
    courier_view.data.type = "PERSP"
    courier_view.data.lens = 24
    beach = camera(map_scene,"Camera_Beach_View",(-26,-36,3.3),(-26,-11,3.9),35)
    beach.data.type = "PERSP"
    beach.data.lens = 30
    map_scene.camera = overview
    map_scene.frame_set(1)

    lineup = bpy.data.scenes.new("Character_Lineup")
    activate(lineup)
    stage = h.asset("preview_character_stage", "preview")
    h.box(stage,"Backdrop",(0,0,-0.075),(12,9,0.1),"sand",bevel=0.04)
    char_assets = [a for a in assets if a.category == "characters"]
    for i,a in enumerate(char_assets):
        h.instance(a,"Lineup_"+a.root.name,((i-2)*1.45,0,0),collection=lineup.collection)
    lighting(lineup)
    lineup.camera = camera(lineup,"Camera_Characters",(4,11,4.2),(0,0,1),8.5)
    lineup.render.resolution_x = 1600
    lineup.render.resolution_y = 800
    lineup.frame_set(1)
    activate(map_scene)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
                area.spaces.active.overlay.show_overlays = False
                area.spaces.active.shading.type = "MATERIAL"
    bpy.ops.object.select_all(action="DESELECT")
    output = BASE / "art/blender/courier_island.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    report = {"blend_file":str(output),"library_scene":library.name,"map_scene":map_scene.name,
              "lineup_scene":lineup.name,"cameras":{"overview":overview.name,"street":street.name,"courier":courier_view.name,"beach":beach.name},
              "assets":[{"id":a.root["asset_id"],"root":a.root.name,"category":a.category} for a in assets],
              "map_objects":len(map_scene.objects),"blender_version":bpy.app.version_string}
    (BASE / "art/build_report.json").write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False))


if __name__ == "__main__":
    build()
