"""离线检查导出的 GLB 结构、蒙皮、动作与几何；不连接 Blender 或启动游戏。"""

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import struct
import sys


BASE = Path(__file__).resolve().parents[2]
COMPONENTS = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
SHAPES = {"SCALAR": (1, 1), "VEC2": (1, 2), "VEC3": (1, 3), "VEC4": (1, 4), "MAT2": (2, 2), "MAT3": (3, 3), "MAT4": (4, 4)}
IDENTITY = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))
RETIRED_ASSETS = {"env_island_paths", "env_residential_extension"}
PALM_ASSETS = {"prop_palm_leaning", "prop_palm_crooked", "prop_palm_young"}
WOODEN_HUT_ASSETS = {"bld_residential_a", "bld_residential_b"}
REQUIRED_ART_ASSETS = PALM_ASSETS | WOODEN_HUT_ASSETS | {"prop_wild_grass_patch", "env_wilderness_details"}


class InvalidGlb(ValueError):
    """文件结构或数据引用超出 GLB/glTF 约定。"""


def require(condition, message):
    if not condition:
        raise InvalidGlb(message)


def item(sequence, index, label):
    require(isinstance(index, int) and 0 <= index < len(sequence), f"Invalid {label} index: {index}")
    return sequence[index]


def multiply(a, b):
    return tuple(tuple(sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)) for r in range(4))


def transform(matrix, point):
    return tuple(sum(matrix[r][k] * point[k] for k in range(3)) + matrix[r][3] for r in range(3))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(vector):
    length = math.sqrt(sum(v * v for v in vector))
    return tuple(v / length for v in vector) if length else (0, 0, 0)


def normal_transform(matrix, normal):
    # 法线使用逆转置矩阵，避免非等比节点缩放改变检查结论。
    a, b, c = (matrix[i][:3] for i in range(3))
    cofactor = (cross(b, c), cross(c, a), cross(a, b))
    determinant = sum(a[i] * cofactor[0][i] for i in range(3))
    require(abs(determinant) > 1e-12, "Node transform has zero scale")
    return unit(tuple(sum(cofactor[r][k] * normal[k] for k in range(3)) / determinant for r in range(3)))


def forbidden_map_geometry(name):
    """按完整词匹配旧景观名，不把 broadleaf、码头板或楼梯 landing 误报为道路。"""
    words = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return bool(re.search(r"(?:^|_)(?:roads?|roadways?|parks?|promenades?)(?:_|$)", words)
                or re.search(r"(?:^|_)central_plaza(?:_|$)", words))


def node_matrix(node):
    if "matrix" in node:
        values = node["matrix"]
        require(len(values) == 16, "Node matrix must contain 16 values")
        return tuple(tuple(values[c * 4 + r] for c in range(4)) for r in range(4))
    t = node.get("translation", (0, 0, 0))
    s = node.get("scale", (1, 1, 1))
    q = node.get("rotation", (0, 0, 0, 1))
    require(len(t) == 3 and len(s) == 3 and len(q) == 4, "Invalid node TRS dimensions")
    x, y, z, w = q
    require(abs(sum(v * v for v in q) - 1) < 0.01, "Node rotation quaternion is not normalized")
    rotation = ((1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)),
                (2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)),
                (2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)))
    return tuple(tuple(rotation[r][c] * s[c] for c in range(3)) + (t[r],) for r in range(3)) + ((0, 0, 0, 1),)


class Glb:
    """解析嵌入式 GLB，并按访问器步长、矩阵对齐和稀疏覆盖读取数值。"""

    def __init__(self, path):
        self.path = path
        data = path.read_bytes()
        require(len(data) >= 20, "GLB is too short")
        magic, version, length = struct.unpack_from("<III", data)
        require(magic == 0x46546C67 and version == 2, "Expected GLB version 2 header")
        require(length == len(data), f"GLB declared length {length} differs from actual {len(data)}")
        require(length % 4 == 0, "GLB total length must be aligned to 4 bytes")
        chunks = []
        offset = 12
        while offset < length:
            require(offset + 8 <= length, "Truncated GLB chunk header")
            size, kind = struct.unpack_from("<II", data, offset)
            offset += 8
            require(size % 4 == 0 and offset + size <= length, "Invalid GLB chunk length")
            chunks.append((kind, data[offset:offset + size]))
            offset += size
        require(chunks and chunks[0][0] == 0x4E4F534A, "First GLB chunk must be JSON")
        require(sum(kind == 0x4E4F534A for kind, _ in chunks) == 1, "Expected exactly one JSON chunk")
        bins = [value for kind, value in chunks if kind == 0x004E4942]
        require(len(bins) <= 1, "Multiple BIN chunks are not supported by GLB 2")
        self.document = json.loads(chunks[0][1].decode("utf-8").rstrip(" \x00"))
        require(self.document.get("asset", {}).get("version") == "2.0", "Expected glTF asset version 2.0")
        self.binary = bins[0] if bins else b""
        buffers = self.document.get("buffers", [])
        require(len(buffers) == 1 and "uri" not in buffers[0], "Expected one embedded GLB buffer")
        buffer_length = buffers[0].get("byteLength", -1)
        require(isinstance(buffer_length, int) and 0 <= buffer_length <= len(self.binary) <= buffer_length + 3, "BIN length disagrees with buffer byteLength")
        for i, view in enumerate(self.document.get("bufferViews", [])):
            require(view.get("buffer") == 0, f"bufferView {i} must reference the embedded buffer")
            begin, size = view.get("byteOffset", 0), view.get("byteLength", -1)
            require(isinstance(begin, int) and isinstance(size, int) and begin >= 0 and size >= 0 and begin + size <= buffer_length, f"bufferView {i} exceeds buffer range")
            stride = view.get("byteStride")
            require(stride is None or isinstance(stride, int) and 4 <= stride <= 252 and stride % 4 == 0, f"bufferView {i} has invalid byteStride")
        self.cache = {}
        self.coastlines = {}
        self.transforms = self._transforms()

    def _transforms(self):
        nodes = self.document.get("nodes", [])
        parents = {}
        for i, node in enumerate(nodes):
            for child in node.get("children", []):
                item(nodes, child, "child node")
                require(child not in parents, f"Node {child} has multiple parents")
                parents[child] = i
        self.parents = parents
        cache, pending = {}, set()
        def resolve(index):
            if index in cache:
                return cache[index]
            require(index not in pending, "Node hierarchy contains a cycle")
            pending.add(index)
            local = node_matrix(nodes[index])
            require(all(math.isfinite(v) for row in local for v in row), f"Node {index} contains non-finite transform")
            cache[index] = multiply(resolve(parents[index]), local) if index in parents else local
            pending.remove(index)
            return cache[index]
        for i in range(len(nodes)):
            resolve(i)
        scenes = self.document.get("scenes", [])
        require(bool(scenes), "glTF has no scene")
        scene = item(scenes, self.document.get("scene", 0), "scene")
        require(scene.get("nodes"), "Default scene has no root nodes")
        for root in scene.get("nodes", []):
            item(nodes, root, "scene root node")
            require(root not in parents, "Scene root is also a child node")
        self.reachable = set()
        def visit(index):
            self.reachable.add(index)
            for child in nodes[index].get("children", []):
                visit(child)
        for root in scene["nodes"]:
            visit(root)
        require(any("mesh" in nodes[i] for i in self.reachable), "Default scene contains no reachable mesh")
        return cache

    def _view(self, index):
        view = item(self.document.get("bufferViews", []), index, "bufferView")
        offset = view.get("byteOffset", 0)
        return view, memoryview(self.binary)[offset:offset + view["byteLength"]]

    def _decode(self, view_index, offset, count, component, offsets, element_size, use_stride=True):
        view, data = self._view(view_index)
        code, width = COMPONENTS[component]
        stride = view.get("byteStride", element_size) if use_stride else element_size
        require(stride >= element_size and stride % width == 0, "Accessor byteStride is incompatible with its element")
        require(offset >= 0 and offset % width == 0 and (view.get("byteOffset", 0) + offset) % width == 0, "Accessor byteOffset is misaligned")
        end = offset + (count - 1) * stride + element_size if count else offset
        require(end <= len(data), f"Accessor range ends at {end}, bufferView has {len(data)} bytes")
        return [tuple(struct.unpack_from("<" + code, data, offset + i * stride + field)[0] for field in offsets) for i in range(count)]

    def accessor(self, index):
        if index in self.cache:
            return self.cache[index]
        accessor = item(self.document.get("accessors", []), index, "accessor")
        component, shape = accessor.get("componentType"), accessor.get("type")
        require(component in COMPONENTS and shape in SHAPES, f"Accessor {index} has invalid componentType/type")
        count = accessor.get("count", 0)
        require(isinstance(count, int) and count > 0, f"Accessor {index} has invalid count")
        columns, rows = SHAPES[shape]
        width = COMPONENTS[component][1]
        # 矩阵的每一列按 4 字节补齐；向量和标量无需列补齐。
        column_size = ((rows * width + 3) // 4 * 4) if columns > 1 else rows * width
        offsets = [c * column_size + r * width for c in range(columns) for r in range(rows)]
        size = columns * column_size
        if "bufferView" in accessor:
            values = self._decode(accessor["bufferView"], accessor.get("byteOffset", 0), count, component, offsets, size)
        else:
            require("sparse" in accessor, f"Accessor {index} has neither bufferView nor sparse data")
            values = [(0,) * len(offsets) for _ in range(count)]
        sparse = accessor.get("sparse")
        if sparse:
            sparse_count = sparse.get("count", 0)
            require(isinstance(sparse_count, int) and 0 < sparse_count <= count, "Invalid sparse accessor count")
            indices, payload = sparse["indices"], sparse["values"]
            kind = indices.get("componentType")
            require(kind in (5121, 5123, 5125), "Sparse indices must be unsigned integers")
            sparse_ids = self._decode(indices["bufferView"], indices.get("byteOffset", 0), sparse_count, kind, [0], COMPONENTS[kind][1], False)
            sparse_values = self._decode(payload["bufferView"], payload.get("byteOffset", 0), sparse_count, component, offsets, size, False)
            previous = -1
            for (target,), value in zip(sparse_ids, sparse_values):
                require(previous < target < count, "Sparse indices must be ascending and within accessor count")
                values[target], previous = value, target
        if accessor.get("normalized"):
            require(component != 5126, "Float accessor cannot be normalized")
            limit = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295}[component]
            values = [tuple(max(-1, value / limit) if component in (5120, 5122) else value / limit for value in row) for row in values]
        require(all(math.isfinite(value) for row in values for value in row), f"Accessor {index} contains non-finite values")
        self.cache[index] = values
        return values

    def _triangles(self, primitive, count):
        indices = [row[0] for row in self.accessor(primitive["indices"])] if "indices" in primitive else list(range(count))
        mode = primitive.get("mode", 4)
        if mode == 4:
            return [tuple(indices[i:i+3]) for i in range(0, len(indices), 3)]
        if mode == 5:
            return [(indices[i+1], indices[i], indices[i+2]) if i % 2 else tuple(indices[i:i+3]) for i in range(len(indices)-2)]
        if mode == 6:
            return [(indices[0], indices[i], indices[i+1]) for i in range(1, len(indices)-1)]
        return []

    def check(self):
        d = self.document
        accessors, meshes, nodes = d.get("accessors", []), d.get("meshes", []), d.get("nodes", [])
        require(meshes and nodes, "GLB has no meshes or nodes")
        for index in range(len(accessors)):
            self.accessor(index)
        triangles, vertex_count, skinned_nodes = 0, 0, 0
        for mesh_index, mesh in enumerate(meshes):
            require(mesh.get("primitives"), f"Mesh {mesh_index} has no primitives")
            for p in mesh["primitives"]:
                attributes = p.get("attributes", {})
                require("POSITION" in attributes and "NORMAL" in attributes, f"Mesh {mesh_index} primitive lacks POSITION/NORMAL")
                pos_id, norm_id = attributes["POSITION"], attributes["NORMAL"]
                pos, norm = self.accessor(pos_id), self.accessor(norm_id)
                require(accessors[pos_id]["type"] == "VEC3" and accessors[norm_id]["type"] == "VEC3", "POSITION/NORMAL must be VEC3")
                require(accessors[pos_id]["componentType"] == 5126 or "KHR_mesh_quantization" in d.get("extensionsUsed", []), "Integer POSITION requires KHR_mesh_quantization")
                require(accessors[norm_id]["componentType"] == 5126 or "KHR_mesh_quantization" in d.get("extensionsUsed", []), "Integer NORMAL requires KHR_mesh_quantization")
                for key, operation in (("min", min), ("max", max)):
                    declared = accessors[pos_id].get(key)
                    actual = [operation(v[axis] for v in pos) for axis in range(3)]
                    require(declared is not None and len(declared) == 3, f"POSITION accessor lacks {key} bounds")
                    require(all(abs(a-b) <= 0.0002 for a,b in zip(declared, actual)), f"POSITION accessor {key} differs from binary values")
                require(len(pos) == len(norm), "POSITION/NORMAL counts differ")
                require(all(0.97 <= math.sqrt(sum(v*v for v in row)) <= 1.03 for row in norm), "NORMAL vectors must have unit length")
                for attr_id in attributes.values():
                    require(len(self.accessor(attr_id)) == len(pos), "Primitive attribute counts differ")
                if "indices" in p:
                    a = item(accessors, p["indices"], "indices accessor")
                    require(a["type"] == "SCALAR" and a["componentType"] in (5121, 5123, 5125) and not a.get("normalized"), "Indices must be unsigned SCALAR values")
                    require(all(0 <= row[0] < len(pos) for row in self.accessor(p["indices"])), "Triangle index exceeds vertex count")
                mode = p.get("mode", 4)
                require(mode in range(7), "Invalid primitive mode")
                index_count = len(self.accessor(p["indices"])) if "indices" in p else len(pos)
                require(mode != 4 or index_count % 3 == 0, "TRIANGLES index count must be divisible by 3")
                if "material" in p:
                    item(d.get("materials", []), p["material"], "material")
                vertex_count += len(pos)
                triangles += len(self._triangles(p, len(pos)))
        skins = d.get("skins", [])
        for i, skin in enumerate(skins):
            require(skin.get("joints"), f"Skin {i} has no joints")
            for joint in skin["joints"]:
                item(nodes, joint, "skin joint node")
            if "skeleton" in skin:
                item(nodes, skin["skeleton"], "skeleton node")
            if "inverseBindMatrices" in skin:
                a = item(accessors, skin["inverseBindMatrices"], "inverse bind accessor")
                require(a["type"] == "MAT4" and a["componentType"] == 5126 and a["count"] >= len(skin["joints"]), "Invalid inverseBindMatrices accessor")
        for node in nodes:
            if "mesh" in node:
                mesh = item(meshes, node["mesh"], "mesh")
                if "skin" in node:
                    skinned_nodes += 1
                    skin = item(skins, node["skin"], "skin")
                    for p in mesh["primitives"]:
                        attrs = p["attributes"]
                        require("JOINTS_0" in attrs and "WEIGHTS_0" in attrs, "Skinned mesh lacks JOINTS_0/WEIGHTS_0")
                        joint_accessor = accessors[attrs["JOINTS_0"]]
                        require(joint_accessor["type"] == "VEC4" and joint_accessor["componentType"] in (5121, 5123) and not joint_accessor.get("normalized"), "Invalid JOINTS_0 encoding")
                        require(accessors[attrs["WEIGHTS_0"]]["type"] == "VEC4", "WEIGHTS_0 must be VEC4")
                        for joints, weights in zip(self.accessor(attrs["JOINTS_0"]), self.accessor(attrs["WEIGHTS_0"])):
                            require(all(j < len(skin["joints"]) for j in joints), "JOINTS_0 exceeds skin joint count")
                            require(all(w >= 0 for w in weights) and abs(sum(weights)-1) < 0.02, "Skin weights must be nonnegative and sum to 1")
        animation_names = []
        for animation in d.get("animations", []):
            animation_names.append(animation.get("name", ""))
            require(animation.get("channels") and animation.get("samplers"), "Animation contains no channels/samplers")
            for channel in animation["channels"]:
                sampler = item(animation["samplers"], channel["sampler"], "animation sampler")
                source = item(accessors, sampler["input"], "animation input")
                require(source["type"] == "SCALAR" and source["componentType"] == 5126, "Animation input must be float SCALAR")
                times = [v[0] for v in self.accessor(sampler["input"])]
                require(all(a < b for a, b in zip(times, times[1:])), "Animation times must strictly increase")
                target = channel["target"]
                if "node" in target:
                    item(nodes, target["node"], "animation target node")
                require(target.get("path") in ("translation", "rotation", "scale", "weights"), "Invalid animation target path")
                out = self.accessor(sampler["output"])
                multiplier = 3 if sampler.get("interpolation") == "CUBICSPLINE" else 1
                require(target["path"] == "weights" or len(out) == len(times) * multiplier, "Animation output count disagrees with input count")
        summary = {"meshes": len(meshes), "nodes": len(nodes), "vertices": vertex_count, "triangles": triangles,
                   "skins": len(skins), "skinned_nodes": skinned_nodes, "animations": animation_names}
        stem = self.path.stem
        require(stem not in RETIRED_ASSETS, f"Retired independent asset remains: {stem}")
        if stem == "courier_island":
            summary["map_art_requirements"] = self.check_map_contents()
        if stem != "courier_island":
            roots = [i for i, node in enumerate(nodes) if node.get("extras", {}).get("asset_id") == stem]
            require(len(roots) == 1 and roots[0] in self.reachable, f"Independent asset lacks a unique reachable root with asset_id={stem}")
            pivot = [self.transforms[roots[0]][axis][3] for axis in range(3)]
            require(all(abs(v) < 0.00001 for v in pivot), f"Independent asset root is displaced from origin: {pivot}")
            summary["root_origin_y_up_m"] = pivot
        if stem.startswith("chr_"):
            require(skins and skinned_nodes, "Independent character must retain its skin and skinned mesh")
            bounds = self.bounds()
            height = bounds[1][1] - bounds[0][1]
            require(abs(bounds[0][1]) <= 0.075, f"Character feet origin is displaced: min_y={bounds[0][1]:.4f}")
            require(1.5 <= height <= 2.3, f"Unexpected character height: {height:.4f} m")
            summary["feet_min_y_m"] = bounds[0][1]
            summary["height_m"] = height
            summary["bounds_y_up_m"] = bounds
        if stem == "chr_courier":
            require({"Idle", "Walk", "Carry_Idle"}.issubset(animation_names), f"Courier animation clips missing; found {animation_names}")
        if stem in WOODEN_HUT_ASSETS or stem in PALM_ASSETS:
            summary["art_asset_structure"] = self.check_art_asset_structure(stem)
        summary["surface_orientation"] = self.surface_orientation()
        return summary

    def check_art_asset_structure(self, asset_id):
        """检查木屋与棕榈的实际网格组成，防止保留稳定 ID 却导出旧居民楼或旧树。"""
        nodes = [self.document["nodes"][i] for i in self.reachable if "mesh" in self.document["nodes"][i]]
        names = [re.sub(r"[_\s]+", " ", node.get("name", "").lower()) for node in nodes]
        minimum, maximum = self.bounds()
        height = maximum[1] - minimum[1]
        require(abs(minimum[1]) < .02, f"Natural/wooden asset base is not grounded: {asset_id}, min_y={minimum[1]:.4f}")
        if asset_id in PALM_ASSETS:
            trunks = sum("bent trunk segment" in name for name in names)
            fronds = sum("wild palm frond" in name and "central vein" not in name for name in names)
            require(trunks >= 6 and fronds >= 7, f"Palm lacks segmented trunk or broad fronds: {asset_id}, trunks={trunks}, fronds={fronds}")
            require(4 <= height <= 8, f"Palm height outside expected scale: {asset_id}, height={height:.4f}")
            return {"height_m": height, "trunk_segments": trunks, "leaf_fronds": fronds}
        floorboards = sum("hut floor board" in name for name in names)
        wallboards = sum("front row" in name and "plank" in name for name in names)
        referenced_materials = {primitive.get("material") for node in nodes
                                for primitive in self.document["meshes"][node["mesh"]]["primitives"]
                                if "material" in primitive}
        materials = {self.document["materials"][i].get("name", "").lower() for i in referenced_materials}
        wood = {name for name in materials if any(key in name for key in ("weathered_wood", "weathered_dark", "wood_gray"))}
        require(floorboards >= 10 and wallboards >= 10 and len(wood) >= 2,
                f"Residential asset lacks wooden hut construction: {asset_id}, floorboards={floorboards}, wallboards={wallboards}, wood_materials={sorted(wood)}")
        require(2.5 <= height <= 4.5, f"Residential hut is not at single-floor scale: {asset_id}, height={height:.4f}")
        return {"height_m": height, "floorboards": floorboards, "front_wallboards": wallboards, "wood_materials": sorted(wood)}

    def check_map_contents(self):
        """只审查实际地图可达的几何和资产引用，楼梯平台与码头仍然允许存在。"""
        instances = {}
        for index in self.reachable:
            node = self.document["nodes"][index]
            extras = node.get("extras", {})
            retired = RETIRED_ASSETS.intersection((extras.get("asset_id"), extras.get("source_asset")))
            require(not retired, f"Map contains retired asset: {sorted(retired)}")
            source = extras.get("source_asset")
            if source:
                instances[source] = instances.get(source, 0) + 1
                require(source not in {"prop_pine_tree", "prop_broadleaf_tree"}, f"Map still contains old non-palm tree: {source}")
            if "mesh" not in node:
                continue
            mesh = self.document["meshes"][node["mesh"]]
            for name in (node.get("name", ""), mesh.get("name", "")):
                require(not forbidden_map_geometry(name), f"Map contains forbidden road/park/promenade/plaza geometry: {name}")
        required = WOODEN_HUT_ASSETS | {"bld_courier_station", "bld_pizza_shop", "bld_music_shop",
                                       "prop_wild_grass_patch", "env_wilderness_details"}
        require(not required - instances.keys(), f"Map art instances missing: {sorted(required - instances.keys())}")
        require(PALM_ASSETS.intersection(instances), "Map contains no tropical palm instances")
        return {"palm_instances": sum(instances.get(asset, 0) for asset in PALM_ASSETS),
                "wild_grass_instances": instances["prop_wild_grass_patch"],
                "wooden_building_instances": {asset: instances[asset] for asset in sorted(required) if asset.startswith("bld_")}}

    def bounds(self):
        minimum, maximum = [math.inf] * 3, [-math.inf] * 3
        for i, node in enumerate(self.document.get("nodes", [])):
            if i not in self.reachable or "mesh" not in node:
                continue
            for p in self.document["meshes"][node["mesh"]]["primitives"]:
                for point in self.accessor(p["attributes"]["POSITION"]):
                    point = transform(self.transforms[i], point)
                    for axis in range(3):
                        minimum[axis] = min(minimum[axis], point[axis])
                        maximum[axis] = max(maximum[axis], point[axis])
        require(all(math.isfinite(v) for v in minimum + maximum), "No finite mesh bounds found")
        return minimum, maximum

    def _coastline_segments(self, node_index):
        """岸线属于资产根的本地坐标；实例需沿根节点变换到 glTF 世界坐标。"""
        nodes = self.document["nodes"]
        root = node_index
        while "coastline_json" not in nodes[root].get("extras", {}):
            require(root in self.parents, f"Coastal cliff node {node_index} has no ancestor coastline_json")
            root = self.parents[root]
        if root in self.coastlines:
            return self.coastlines[root]
        raw = nodes[root]["extras"]["coastline_json"]
        require(isinstance(raw, str), "coastline_json must contain a JSON string")
        points = json.loads(raw)
        require(isinstance(points, list) and len(points) >= 3, "Coastline needs at least three points")
        require(all(isinstance(p, (list, tuple)) and len(p) == 2
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in p)
                    for p in points), "Coastline points must contain finite Blender XY pairs")
        if points[0] == points[-1]:
            points = points[:-1]
        require(len(points) >= 3, "Coastline has fewer than three distinct points")
        edges = list(zip(points, points[1:] + points[:1]))
        area_twice = sum(a[0] * b[1] - b[0] * a[1] for a, b in edges)
        require(area_twice > 1e-8, "Blender XY coastline must be counterclockwise with positive area")
        segments = []
        for edge_index, (a, b) in enumerate(edges):
            dx, dy = b[0] - a[0], b[1] - a[1]
            require(dx * dx + dy * dy > 1e-12, f"Coastline edge {edge_index} has zero length")
            # Blender 外法线 (dy,-dx,0) 经 Y-up 转换成为 (dy,0,dx)。
            normal = normal_transform(self.transforms[root], (dy, 0, dx))
            target = unit((normal[0], 0, normal[2]))
            require(target != (0, 0, 0), f"Coastline edge {edge_index} has no horizontal normal")
            start = transform(self.transforms[root], (a[0], 0, -a[1]))
            end = transform(self.transforms[root], (b[0], 0, -b[1]))
            length_squared = (end[0] - start[0]) ** 2 + (end[2] - start[2]) ** 2
            require(length_squared > 1e-12, f"Transformed coastline edge {edge_index} collapses horizontally")
            segments.append((start, end, target, length_squared))
        self.coastlines[root] = segments
        return segments

    def _nearest_coast_normal(self, segments, midpoint):
        """凹海湾按最近岸边线段判断外侧，不能用岛心径向法线。"""
        nearest = None
        distance_squared = math.inf
        for edge_index, (start, end, normal, length_squared) in enumerate(segments):
            dx, dz = end[0] - start[0], end[2] - start[2]
            t = max(0, min(1, ((midpoint[0] - start[0]) * dx + (midpoint[2] - start[2]) * dz) / length_squared))
            gap = (midpoint[0] - start[0] - t * dx) ** 2 + (midpoint[2] - start[2] - t * dz) ** 2
            if gap < distance_squared:
                nearest, distance_squared = (normal, edge_index), gap
        return nearest

    def surface_orientation(self):
        """同时检查三角绕序与实际 NORMAL；海洋方盒只检查其顶面。"""
        records = {}
        for i, node in enumerate(self.document.get("nodes", [])):
            if i not in self.reachable or "mesh" not in node:
                continue
            mesh = self.document["meshes"][node["mesh"]]
            name = (node.get("name", "") + " " + mesh.get("name", "")).lower()
            kind = next((key for key in ("faceted_coastal_cliffs", "island_surface", "turquoise_shallows", "ocean_base") if key in name), None)
            if kind is None:
                continue
            record = records.setdefault(kind, {"triangles": 0, "correct_winding": 0, "correct_normals": 0})
            coastline = self._coastline_segments(i) if kind == "faceted_coastal_cliffs" else None
            for p in mesh["primitives"]:
                pos = [transform(self.transforms[i], v) for v in self.accessor(p["attributes"]["POSITION"])]
                norm = [normal_transform(self.transforms[i], v) for v in self.accessor(p["attributes"]["NORMAL"])]
                top = max(v[1] for v in pos)
                for ids in self._triangles(p, len(pos)):
                    points = [pos[j] for j in ids]
                    edges = [tuple(points[j][k]-points[0][k] for k in range(3)) for j in (1, 2)]
                    winding = unit(cross(*edges))
                    if winding == (0, 0, 0):
                        require(kind != "faceted_coastal_cliffs", f"Coastal cliff has a degenerate triangle: node={node.get('name', '')}, vertices={ids}")
                        continue
                    midpoint = tuple(sum(v[k] for v in points)/3 for k in range(3))
                    if kind == "ocean_base" and abs(midpoint[1]-top) > 0.002:
                        continue
                    average_normal = unit(tuple(sum(norm[j][k] for j in ids)/3 for k in range(3)))
                    if coastline is not None:
                        target, coast_edge = self._nearest_coast_normal(coastline, midpoint)
                        winding = unit((winding[0], 0, winding[2]))
                        average_normal = unit((average_normal[0], 0, average_normal[2]))
                    else:
                        target, coast_edge = (0, 1, 0), None
                    threshold = 0 if kind == "faceted_coastal_cliffs" else 0.9
                    record["triangles"] += 1
                    winding_dot = sum(winding[k] * target[k] for k in range(3))
                    normal_dot = sum(average_normal[k] * target[k] for k in range(3))
                    record["correct_winding"] += winding_dot > threshold
                    record["correct_normals"] += normal_dot > threshold
                    if winding_dot <= threshold or normal_dot <= threshold:
                        failures = record.setdefault("failed_triangles", [])
                        if len(failures) < 10:
                            failures.append({"node": node.get("name", ""), "vertex_indices": list(ids),
                                             "coast_edge": coast_edge, "midpoint": midpoint,
                                             "winding_dot": winding_dot, "normal_dot": normal_dot})
        required = {"env_island_terrain": {"faceted_coastal_cliffs", "island_surface"},
                    "env_ocean": {"ocean_base", "turquoise_shallows"},
                    "courier_island": {"faceted_coastal_cliffs", "island_surface", "ocean_base", "turquoise_shallows"}}
        missing = required.get(self.path.stem, set()) - records.keys()
        require(not missing, f"Required island/ocean surfaces missing: {sorted(missing)}")
        for name, record in records.items():
            count = record["triangles"]
            require(count > 0, f"Surface {name} has no triangles")
            threshold = 1.0 if name == "faceted_coastal_cliffs" else 0.999
            for metric in ("correct_winding", "correct_normals"):
                require(record[metric] / count >= threshold,
                        f"Surface {name}: {metric} {record[metric]}/{count} faces outward/up; failures={record.get('failed_triangles', [])}")
        return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=BASE)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    report_path = args.report or root / "art/validation_report.json"
    discovered_models = sorted((root / "assets/models").rglob("*.glb"))
    models = discovered_models
    map_path = root / "assets/maps/courier_island.glb"
    report = {"checked_at_utc": datetime.now(timezone.utc).isoformat(), "root": str(root), "files": [], "errors": []}
    if not discovered_models:
        report["errors"].append("No GLB assets found under assets/models")
    if not map_path.is_file():
        report["errors"].append("Map GLB missing: assets/maps/courier_island.glb")
    manifest = root / "art/asset_manifest.json"
    if not manifest.is_file():
        manifest = root / "art/build_report.json"
    if manifest.is_file():
        try:
            entries = json.loads(manifest.read_text(encoding="utf-8"))["assets"]
            require(isinstance(entries, list) and entries, "Manifest assets must be a nonempty list")
            expected = set()
            expected_paths = set()
            for entry in entries:
                asset_id = entry["id"]
                require(isinstance(asset_id, str) and asset_id and asset_id not in expected, f"Invalid or duplicate manifest asset ID: {asset_id}")
                require(asset_id not in RETIRED_ASSETS, f"Manifest still lists retired asset: {asset_id}")
                expected.add(asset_id)
                # 完整清单的 file 优先；初次导出前的 build_report 按分类恢复预期路径。
                relative_path = entry.get("file") or f"assets/models/{entry['category']}/{asset_id}.glb"
                path = (root / relative_path).resolve()
                require(path.is_relative_to((root / "assets/models").resolve()) and path.suffix.lower() == ".glb"
                        and path.stem == asset_id, f"Manifest asset file does not match its ID or models directory: {relative_path}")
                require(path not in expected_paths, f"Duplicate manifest asset file: {relative_path}")
                expected_paths.add(path)
            require(not REQUIRED_ART_ASSETS - expected, f"Manifest missing required tropical/wooden assets: {sorted(REQUIRED_ART_ASSETS - expected)}")
            report["manifest"] = str(manifest.relative_to(root))
            report["expected_asset_count"] = len(expected)
            missing = sorted(str(path.relative_to(root)) for path in expected_paths if not path.is_file())
            if missing:
                report["errors"].append("Independent assets missing: " + ", ".join(missing))
            unlisted = sorted(str(path.relative_to(root)) for path in discovered_models if path.resolve() not in expected_paths)
            if unlisted:
                report["errors"].append("Independent assets not listed by manifest: " + ", ".join(unlisted))
            models = sorted(path for path in expected_paths if path.is_file())
        except (InvalidGlb, KeyError, TypeError, ValueError, OSError) as error:
            report["errors"].append(f"Manifest invalid: {error}")
    else:
        report["errors"].append("Asset manifest/build report missing; independent asset list cannot be verified")
    retired_files = sorted(path.name for path in discovered_models if path.stem in RETIRED_ASSETS)
    if retired_files:
        report["errors"].append("Retired independent assets remain: " + ", ".join(retired_files))
    paths = models + ([map_path] if map_path.is_file() else [])
    for path in paths:
        record = {"file": str(path.relative_to(root)), "bytes": path.stat().st_size}
        try:
            record.update(Glb(path).check())
            record["status"] = "passed"
        except (InvalidGlb, KeyError, TypeError, ValueError, struct.error, OSError) as error:
            record["status"] = "failed"
            record["error"] = str(error)
            report["errors"].append(f"{record['file']}: {error}")
        report["files"].append(record)
    report["status"] = "passed" if not report["errors"] else "failed"
    report["files_checked"] = len(paths)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"status": report["status"], "files_checked": len(paths), "errors": report["errors"], "report": str(report_path)}, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
