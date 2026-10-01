"""荒凉海岛：明确凹凸的岸线、自然沙坡、稀疏建筑和简陋码头。"""

import math
import random
import json

from mathutils import Vector
from mathutils.geometry import tessellate_polygon


# 手工定义海湾、缺口与岬角，避免规则椭圆加轻微噪声仍显得像圆形岛。
COASTLINE = [(-52,-20),(-48,-31),(-32,-37),(-23,-31),(-17,-39),(-5,-44),
             (7,-39),(13,-30),(25,-32),(35,-24),(48,-22),(53,-8),(45,1),
             (50,14),(39,23),(29,24),(21,39),(8,43),(-1,32),(-13,35),
             (-18,25),(-34,29),(-41,20),(-39,10),(-50,4),(-46,-6),(-56,-11)]
SHOP_LAYOUT = [(-9,3,0.54,8.4,6.0),(3,10,0.72,6.5,5.4),(13,0,0.54,7.0,5.6)]


def railing(h, a, name, start, end, z, spacing=1.7):
    """栏杆使用开放结构，保留海景视线与宽阔的玩家通道。"""
    length = math.dist(start, end)
    count = max(1, math.ceil(length / spacing))
    for i in range(count + 1):
        t = i / count
        x = start[0] * (1 - t) + end[0] * t
        y = start[1] * (1 - t) + end[1] * t
        h.box(a, f"{name}_post_{i}", (x, y, z + 0.55), (0.085, 0.085, 1.1), "metal")
    for height in (0.5, 1.08):
        h.beam(a, f"{name}_bar_{height}", (*start, z + height), (*end, z + height), 0.075, "metal")


def build_environment(h):
    rng = random.Random(7283)
    terrain = h.asset("env_island_terrain", "environment")
    n = len(COASTLINE)
    outer = [(x,y,0) for x,y in COASTLINE]
    terrain.root["coastline_json"] = json.dumps(COASTLINE)
    vertices = []
    for ring, (scale, z) in enumerate(((0.89,0),(1,-0.30),(1.035,-1.45),(0.95,-2.6))):
        for x, y, _ in outer:
            vertices.append((x * scale + (rng.uniform(-0.5, 0.5) if ring else 0),
                             y * scale + (rng.uniform(-0.5, 0.5) if ring else 0),
                             z + (rng.uniform(-0.10,0.10) if ring else 0)))
    faces = []
    for ring in range(3):
        for i in range(n):
            j = (i + 1) % n
            faces.extend(((ring*n+i, ring*n+j, (ring+1)*n+i),
                          (ring*n+j, (ring+1)*n+j, (ring+1)*n+i)))
    cliff = h.mesh(terrain, "Faceted_coastal_cliffs", vertices, [tuple(reversed(f)) for f in faces], "sand")
    for key in ("dry_sand","wet_sand","rock","rock_light"):
        cliff.data.materials.append(h.material(key))
    for polygon in cliff.data.polygons:
        polygon.material_index = rng.choices(range(5),(8,4,2,1,1))[0]
    # 内陆主要为裸露沙地；岸边连成连续沙坡，不铺广场、网格或道路。
    top_points = [Vector((x*.89,y*.89,0)) for x,y,_ in outer]
    tris = tessellate_polygon([top_points])
    # Blender 5.2 的 tessellate_polygon 返回顶点索引，直接使用避免旧版 Vector 接口。
    top_faces = [tuple(tri) for tri in tris]
    top = h.mesh(terrain, "Island_surface", [tuple(v) for v in top_points], top_faces, "dry_sand")
    top.data.materials.append(h.material("sand"))
    for poly in top.data.polygons:
        poly.material_index = 0 if rng.random()<0.8 else 1
    for i,(x,y,_) in enumerate(outer):
        if i%3 == 1:
            continue
        loc = (x*1.005,y*1.005,-0.64)
        rock = h.ico(terrain,f"Shore_boulder_{i}",loc,(rng.uniform(1.1,2.3),rng.uniform(.8,1.6),rng.uniform(.65,1.1)),"rock")
        angle = math.atan2(y,x)
        rock.rotation_euler = (rng.random(), rng.random(), angle)

    sea = h.asset("env_ocean", "environment")
    h.box(sea, "Ocean_base", (0,0,-1.26), (320,320,0.08), "sea_deep")
    # 离岸浅水环带和少量细波纹使用实体网格，可在 glTF 中完整保留。
    ring_vertices = []
    for radius in (1.025,1.075,1.18):
        ring_vertices.extend((x*radius,y*radius,-1.20) for x,y,_ in outer)
    ring_faces = [(r*n+i, r*n+(i+1)%n, (r+1)*n+(i+1)%n, (r+1)*n+i)
                  for r in range(2) for i in range(n)]
    shallows = h.mesh(sea, "Turquoise_shallows", ring_vertices, [tuple(reversed(f)) for f in ring_faces], "sea_light")
    shallows.data.materials.append(h.material("sea"))
    for p in shallows.data.polygons:
        p.material_index = int(p.index >= n)
    for i in range(260):
        x, y = rng.uniform(-105, 105), rng.uniform(-90, 90)
        if (x/58)**2 + (y/48)**2 < 1:
            continue
        width = rng.uniform(0.65, 2.4)
        h.mesh(sea,f"Wave_glint_{i}",[(x-width,y,-1.17),(x+width,y,-1.17),
               (x+width*.62,y+.055,-1.17),(x-width*.65,y+.035,-1.17)],[(0,1,2,3)],"foam" if i%4==0 else "sea_light")
    for i,(x,y,_) in enumerate(outer):
        nx,ny,_ = outer[(i+1)%n]
        for j in range(3):
            t = (j+.5)/3
            px,py = (x*(1-t)+nx*t)*1.037,(y*(1-t)+ny*t)*1.037
            obj=h.box(sea,f"Coastal_foam_{i}_{j}",(px,py,-1.155),(rng.uniform(.7,1.8),.07,.008),"foam")
            obj.rotation_euler.z=math.atan2(ny-y,nx-x)

    steps = h.asset("env_stairs_railings", "environment")
    # 每组楼梯的最后一级和平台顶面齐平，入口前保留足够落脚空间。
    platforms = SHOP_LAYOUT
    for idx, (x,y,z,w,d) in enumerate(platforms):
        h.box(steps,f"Shop_platform_{idx}",(x,y,z/2),(w,d,z),"weathered_dark",bevel=.04)
        for board in range(round(w/.4)):
            h.box(steps,f"Shop_deck_board_{idx}_{board}",(x-w/2+(board+.5)*w/round(w/.4),y,z+.01),
                  (w/round(w/.4)-.012,d,.02),"weathered_wood" if board%3 else "wood_gray")
        count = round(z/0.18)
        tread = 0.36
        for i in range(count):
            rise = (i+1)*z/count
            step_y = y-d/2-count*tread+(i+0.5)*tread
            h.box(steps,f"Shop_{idx}_step_{i}",(x,step_y,rise/2),(3.7,tread+.025,rise),"weathered_wood",bevel=.018)
        for side in (-1,1):
            sx = x + side*1.98
            start_y = y-d/2-count*tread
            end_y = y-d/2
            h.beam(steps, f"Stair_handrail_{idx}_{side}", (sx,start_y,1.02), (sx,end_y,z+1.02), 0.075, "metal")
            for k in range(4):
                t = k/3
                h.box(steps, f"Stair_post_{idx}_{side}_{k}", (sx,start_y+(end_y-start_y)*t, z*t+0.5), (0.08,0.08,1), "metal")
        front_y = y-d/2+0.12
        railing(h, steps, f"Landing_left_{idx}", (x-w/2+0.15,front_y),(x-2.04,front_y),z)
        railing(h, steps, f"Landing_right_{idx}",(x+2.04,front_y),(x+w/2-0.15,front_y),z)
    for x,y in ((-23,19),(23,22)):
        h.box(steps,f"Residential_foundation_{x}",(x,y,.18),(5.5,4.6,.36),"weathered_dark",bevel=.03)
        for i in range(2):
            height = (i+1)*.18
            h.box(steps,f"Home_steps_{x}_{i}",(x-.8,y-2.9+i*.32,height/2),(1.7,.34,height),"weathered_wood",bevel=.02)

    dock = h.asset("env_dock", "environment")
    # 码头独立模型从接岛端为原点，支持其他岛屿场景重用。
    for i in range(32):
        h.box(dock,f"Dock_board_{i}",(0,-i*.30,-.16),(3.7,.28,.24),"weathered_wood" if i%4 else "weathered_dark",bevel=.015)
    for x in (-1.3,1.3):
        h.box(dock,f"Dock_underbeam_{x}",(x,-4.7,-0.37),(0.24,9.6,0.36),"wood_dark")
        for y in (-0.5,-4,-8.7):
            h.cylinder(dock,f"Dock_pier_{x}_{y}",(x,y,-2.15),0.22,4.5,"wood_dark",vertices=8)
            h.cylinder(dock,f"Pier_cap_{x}_{y}",(x,y,0.2),0.28,0.15,"wood",vertices=8)
    return [terrain,sea,steps,dock]


def dress_map(h, assets, collection, only=None):
    """地形、建筑和道具由实例组装；独立资产根始终留在原点。"""
    lookup = {a.root["asset_id"]: a for a in assets if only is None or a.root["asset_id"] in only}
    placements = {
        "env_island_terrain": (0,0,0), "env_ocean": (0,0,0),
        "env_stairs_railings": (0,0,0), "env_dock": (-5,-40,0.15),
        "bld_courier_station": (-9,3,0.54), "bld_pizza_shop": (3,10,0.72),
        "bld_music_shop": (13,0,0.54), "bld_residential_a": (-23,19,0.36),
        "bld_residential_b": (23,22,0.36),
    }
    for key,loc in placements.items():
        if key in lookup:
            h.instance(lookup[key],"Map_"+key,loc,collection=collection)
    for key,loc,yaw in (
        ("chr_courier",(-1.8,-3.5,0),0),
        ("chr_dispatcher",(-10.2,2.75,0.72),math.pi),
        ("chr_pizza_clerk",(3,10.8,0.9),math.pi),
        ("chr_music_clerk",(13.7,0.8,0.72),math.pi),
        ("chr_resident",(7.5,-3,0),-1.9),
    ):
        if key in lookup:
            root = h.instance(lookup[key],"Map_"+key,loc,yaw,collection=collection)
            if key == "chr_courier":
                for rig in h.descendants(root):
                    if rig.type == "ARMATURE":
                        for track in rig.animation_data.nla_tracks if rig.animation_data else []:
                            track.mute = True
                        # 独立主角仍用 Idle，只有地图实例预览持箱动作。
                        import bpy
                        rig.animation_data.action = bpy.data.actions.get("Carry_Idle")
    if "prop_parcel_fragile" in lookup:
        h.instance(lookup["prop_parcel_fragile"],"Map_carried_parcel",(-1.8,-3.02,1.30),collection=collection)
    rng = random.Random(622)
    for key,points in {
        "prop_mailbox": [(-13.3,0.3)],
        "prop_crate": [(-12.2,0.7),(-12.1,1.7),(-10.9,1.5)],
    }.items():
        if key not in lookup:
            continue
        for i,(x,y) in enumerate(points):
            yaw = rng.uniform(-.15,.15)
            z = 0.90 if key == "prop_crate" else 0
            h.instance(lookup[key],f"Map_{key}_{i}",(x,y,z),yaw,collection=collection)
    if "prop_dock_bollard" in lookup:
        for i,(x,y) in enumerate(((-6.4,-46),(-3.6,-46),(-6.4,-49),(-3.6,-49))):
            h.instance(lookup["prop_dock_bollard"],f"Map_bollard_{i}",(x,y,0.11),collection=collection)
