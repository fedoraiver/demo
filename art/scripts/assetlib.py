"""统一低多边形资产的材质、轴心和建模工具；只供 Blender MCP 执行。"""

import math
from dataclasses import dataclass

import bpy
from mathutils import Vector


# 输入为 sRGB，写入节点前转换到线性空间，避免导出后颜色过亮。
PALETTE = {
    "navy": "334E80", "blue": "4266AC", "blue_dark": "2B4275",
    "pants": "344879", "skin": "DDA664", "skin_light": "F2C58F",
    "skin_dark": "AC734F", "hair": "4D3530", "cream": "EFE1BE",
    "white": "FFF7E5", "ink": "293240", "coral": "E78064",
    "red": "B65058", "gold": "F2BA56", "olive": "788656",
    "leaf": "57734B", "leaf_light": "91A960", "wood": "AC7950",
    "wood_dark": "775438", "cardboard": "BA8A52", "tape": "DDB777",
    "metal": "414B59", "teal": "619992", "purple": "8C799D",
    "concrete": "919795", "concrete_light": "B8B5A9", "glass": "71979E",
    "warm_light": "FFE0A0", "roof": "59616B", "sand": "D5C5A3",
    "sea": "348C9B", "sea_deep": "296A85", "sea_light": "63B9BD",
    "foam": "BEE0D7", "rock": "7C8790", "rock_light": "98A09D",
    "plaza": "CABFA7", "soil": "9D9C7B",
    "dry_sand": "DBC79B", "wet_sand": "BBA982",
    "weathered_wood": "9E8B70", "weathered_dark": "706454", "wood_gray": "A19F8C",
    "rust": "936953", "faded_blue": "647B8B", "faded_red": "A2796C", "faded_olive": "8A8F6E",
}

ASSETS = []


def linear(value):
    return value / 12.92 if value < 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def material(key):
    """创建共享哑光材质，所有模型不依赖外部贴图。"""
    name = "CI_" + key
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    hex_color = PALETTE[key]
    color = tuple(linear(int(hex_color[i:i + 2], 16) / 255) for i in (0, 2, 4))
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = 0.82
    mat.diffuse_color = (*color, 1)
    if key == "metal":
        shader.inputs["Metallic"].default_value = 0.15
    if key in ("sea", "sea_deep", "sea_light", "glass"):
        shader.inputs["Roughness"].default_value = 0.32
    if key == "warm_light":
        shader.inputs["Emission Color"].default_value = (*color, 1)
        shader.inputs["Emission Strength"].default_value = 0.35
    return mat


@dataclass
class Asset:
    root: object
    collection: object
    category: str


def asset(name, category):
    """独立根实体保留稳定名称，便于逐件导出与游戏中复用。"""
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    root = bpy.data.objects.new(name, None)
    collection.objects.link(root)
    root["asset_id"] = name
    root["category"] = category
    root["units"] = "meters"
    result = Asset(root, collection, category)
    ASSETS.append(result)
    return result


def attach(a, obj, name, mat=None):
    obj.name = a.root.name + "__" + name
    for collection in list(obj.users_collection):
        collection.objects.unlink(obj)
    a.collection.objects.link(obj)
    obj.parent = a.root
    if mat:
        obj.data.materials.append(material(mat))
    return obj


def box(a, name, loc, size, mat, bevel=0, rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = attach(a, bpy.context.object, name, mat)
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if rotation:
        obj.rotation_euler = rotation
    if bevel:
        modifier = obj.modifiers.new("Small_edge_facets", "BEVEL")
        modifier.width = bevel
        modifier.segments = 1
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj


def ico(a, name, loc, scale, mat, subdivisions=1):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=loc)
    obj = attach(a, bpy.context.object, name, mat)
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def sphere(a, name, loc, scale, mat, segments=12, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1, location=loc)
    obj = attach(a, bpy.context.object, name, mat)
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def cone(a, name, loc, radius1, radius2, depth, mat, vertices=8, rotation=None):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1, radius2=radius2, depth=depth, location=loc)
    obj = attach(a, bpy.context.object, name, mat)
    if rotation:
        obj.rotation_euler = rotation
    return obj


def cylinder(a, name, loc, radius, depth, mat, vertices=12, rotation=None):
    return cone(a, name, loc, radius, radius, depth, mat, vertices, rotation)


def beam(a, name, start, end, width, mat):
    direction = Vector(end) - Vector(start)
    obj = box(a, name, (Vector(start) + Vector(end)) / 2, (width, width, direction.length), mat)
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return obj


def mesh(a, name, vertices, faces, mat):
    data = bpy.data.meshes.new(a.root.name + "__" + name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(data.name, data)
    a.collection.objects.link(obj)
    obj.parent = a.root
    obj.data.materials.append(material(mat))
    return obj


def text(a, name, body, loc, size, mat, rotation=(math.pi / 2, 0, 0), align="CENTER"):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    curve.size = size
    curve.align_x = align
    curve.align_y = "CENTER"
    curve.extrude = 0.006
    curve.bevel_depth = 0.001
    obj = bpy.data.objects.new(name, curve)
    a.collection.objects.link(obj)
    obj.parent = a.root
    obj.location = loc
    obj.rotation_euler = rotation
    obj.data.materials.append(material(mat))
    obj.name = a.root.name + "__" + name
    # glTF 不支持字体对象，因此源文件中也保留可导出的实体文字。
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return bpy.context.object


def descendants(root):
    result = [root]
    for child in root.children:
        result.extend(descendants(child))
    return result


def merge_static_meshes(a, name):
    """把静态草叶合为可共享网格，减少大量野草实例的对象开销。"""
    objects = [o for o in descendants(a.root) if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    result = bpy.context.object
    result.name = a.root["asset_id"] + "__" + name
    return result


def instance(a, name, loc, yaw=0, scale=1, collection=None):
    """复制对象层级但共享网格；角色实例保留独立姿态和骨架。"""
    collection = collection or bpy.context.scene.collection
    originals = descendants(a.root)
    copies = {}
    for obj in originals:
        duplicate = obj.copy()
        if obj.type == "ARMATURE":
            duplicate.data = obj.data.copy()
        collection.objects.link(duplicate)
        duplicate.name = name if obj == a.root else name + "__" + obj.name.split("__", 1)[-1]
        copies[obj] = duplicate
    for obj, duplicate in copies.items():
        if obj != a.root:
            duplicate.parent = copies[obj.parent]
        for mod in duplicate.modifiers:
            if mod.type == "ARMATURE" and mod.object in copies:
                mod.object = copies[mod.object]
    root = copies[a.root]
    root.location = loc
    root.rotation_euler.z = yaw
    root.scale = (scale, scale, scale)
    root["source_asset"] = a.root["asset_id"]
    return root
