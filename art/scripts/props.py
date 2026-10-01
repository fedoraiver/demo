"""配送街区的低多边形道具与植被；仅生成资产，不修改场景或执行导出。"""

from math import cos, pi, sin
from random import Random


def _front_polygon(h, asset, name, points, y, material):
    """在朝向 -Y 的表面生成标识，保留真实几何以避免依赖外部贴图。"""
    vertices = [(x, y, z) for x, z in points]
    area = sum(points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1] for i in range(len(points)))
    indices = tuple(range(len(vertices)))
    # 面的绕序与箱体外侧一致，避免导出后的背面剔除隐藏印刷图案。
    if (area < 0) == (y < 0):
        indices = tuple(reversed(indices))
    return h.mesh(asset, name, vertices, [indices], material)


def _parcel(h, name, fragile):
    """纸箱原点保持在中心，与游戏当前 0.6 米拾取模型一致。"""
    asset = h.asset(name, "props")
    h.box(asset, "Cardboard body", (0, 0, 0), (0.6, 0.6, 0.6), "cardboard", bevel=0.012)
    # 胶带跨过顶面并沿正背面落下，区分纸箱与木质货箱。
    h.box(asset, "Top packing tape", (0, 0, 0.304), (0.075, 0.603, 0.005), "tape")
    h.box(asset, "Bottom packing tape", (0, 0, -0.304), (0.075, 0.603, 0.005), "tape")
    for side in (-1, 1):
        h.box(asset, f"Tape side {side}", (0, side * 0.304, 0), (0.075, 0.005, 0.60), "tape")
    for side in (-1, 1):
        h.box(asset, f"Top fold seam {side}", (side * 0.17, 0, 0.303), (0.002, 0.58, 0.002), "wood")
    # 运单正面保留地址线与条码；条码用不同宽度的面片形成明确节奏。
    h.box(asset, "Shipping label", (0.137, -0.308, 0.085), (0.19, 0.004, 0.205), "cream")
    for i, width in enumerate((0.106, 0.071, 0.09)):
        h.box(asset, f"Address line {i}", (0.12, -0.312, 0.158 - i * 0.018), (width, 0.002, 0.003), "ink")
    cursor = 0.06
    for i, units in enumerate((1, 2, 1, 1, 3, 1, 2, 1, 2, 1, 1, 3, 1, 2, 1)):
        width = units * 0.0024
        h.box(asset, f"Barcode line {i:02d}", (cursor + width / 2, -0.312, 0.050), (width, 0.002, 0.058), "ink")
        cursor += width + 0.0035
    h.text(asset, "Label parcel code", "CF-2048", (0.137, -0.314, 0.002), 0.018, "ink")
    _front_polygon(h, asset, "Courier emblem", [(-0.211, 0.082), (-0.15, 0.119), (-0.089, 0.082), (-0.15, 0.045)], -0.311, "blue")
    h.text(asset, "Courier label", "COURIER", (-0.15, -0.314, 0.015), 0.026, "blue_dark")
    if fragile:
        # 酒杯、向上箭头与红色角标可在中景直接辨认易碎箱。
        _front_polygon(h, asset, "Fragile glass bowl", [(0.096, -0.115), (0.174, -0.115), (0.162, -0.162), (0.135, -0.18), (0.108, -0.162)], -0.31, "ink")
        h.box(asset, "Fragile glass stem", (0.135, -0.311, -0.2), (0.008, 0.002, 0.048), "ink")
        h.box(asset, "Fragile glass foot", (0.135, -0.311, -0.225), (0.056, 0.002, 0.007), "ink")
        h.box(asset, "Fragile sticker", (-0.159, -0.310, -0.15), (0.17, 0.004, 0.07), "red")
        h.text(asset, "Fragile sticker letters", "FRAGILE", (-0.159, -0.314, -0.159), 0.028, "white")
        for x in (-0.2, -0.12):
            _front_polygon(h, asset, f"Up arrow {x}", [(x - 0.006, -0.258), (x + 0.006, -0.258), (x + 0.006, -0.233), (x + 0.019, -0.233), (x, -0.21), (x - 0.019, -0.233), (x - 0.006, -0.233)], 0.308, "ink")
    else:
        h.box(asset, "Priority sticker", (-0.15, -0.310, -0.147), (0.175, 0.004, 0.071), "blue")
        h.text(asset, "Priority sticker letters", "EXPRESS", (-0.15, -0.314, -0.158), 0.026, "white")
        h.text(asset, "Weight code", "2.4 KG", (0.14, -0.311, -0.165), 0.025, "ink")
    return asset


def _crate(h):
    """木箱采用独立木板与加固框，轴心仍在箱体中心。"""
    asset = h.asset("prop_crate", "props")
    h.box(asset, "Crate dark core", (0, 0, 0), (0.72, 0.62, 0.65), "wood_dark")
    for side in (-1, 1):
        for i in range(4):
            x = -0.275 + i * 0.183
            h.box(asset, f"Front plank {side} {i}", (x, side * 0.322, 0), (0.17, 0.038, 0.65), "wood")
        for i in range(3):
            y = -0.21 + i * 0.21
            h.box(asset, f"Side plank {side} {i}", (side * 0.37, y, 0), (0.035, 0.195, 0.65), "wood")
        for z in (-0.278, 0.278):
            h.box(asset, f"Front frame {side} {z}", (0, side * 0.35, z), (0.8, 0.065, 0.09), "wood_dark")
            h.box(asset, f"Side frame {side} {z}", (side * 0.39, 0, z), (0.06, 0.70, 0.09), "wood_dark")
        for x in (-0.341, 0.341):
            h.box(asset, f"Corner brace {side} {x}", (x, side * 0.35, 0), (0.077, 0.063, 0.55), "wood_dark")
            for z in (-0.267, 0.267):
                h.sphere(asset, f"Iron nail {side} {x} {z}", (x, side * 0.387, z), (0.012, 0.004, 0.012), "metal", segments=8, rings=4)
    for i in range(4):
        h.box(asset, f"Lid plank {i}", (-0.27 + i * 0.18, 0, 0.34), (0.168, 0.67, 0.035), "wood")
    h.beam(asset, "Front diagonal brace", (-0.29, -0.391, -0.225), (0.29, -0.391, 0.225), 0.065, "wood")
    return asset


def _leaf(h, asset, name, origin, angle, height, width, lean, material):
    """有厚度的弯折叶片，侧面也能读出轮廓而不是单面卡片。"""
    ux, uy = cos(angle), sin(angle)
    vx, vy = -uy, ux
    ox, oy, oz = origin
    vertices = []
    for advance, elevation, half_width in ((0, 0, width * 0.5), (lean * 0.48, height * 0.52, width * 0.36)):
        for lateral, thickness in ((-half_width, -0.006), (half_width, -0.006), (half_width, 0.006), (-half_width, 0.006)):
            vertices.append((ox + ux * advance + vx * lateral, oy + uy * advance + vy * lateral, oz + elevation + thickness))
    vertices.append((ox + ux * lean, oy + uy * lean, oz + height))
    faces = [(3, 2, 1, 0), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 8), (5, 6, 8), (6, 7, 8), (7, 4, 8)]
    h.mesh(asset, name, vertices, faces, material)


def _grass(h):
    asset = h.asset("prop_grass_clump", "environment")
    rng = Random(29)
    for i in range(13):
        angle = i * 2.399 + rng.uniform(-0.15, 0.15)
        radius = rng.uniform(0.025, 0.12)
        _leaf(h, asset, f"Grass blade {i:02d}", (cos(angle) * radius, sin(angle) * radius, 0.012), angle, rng.uniform(0.23, 0.51), rng.uniform(0.065, 0.11), rng.uniform(0.08, 0.26), ("leaf", "leaf_light", "olive")[i % 3])
    return asset


def _pine_tier(h, asset, name, z, radius, rng, material):
    """使用不规则折角、向上枝端与内收底缘，形成层叠针叶枝冠。"""
    count = 10
    phase = rng.uniform(0, pi)
    vertices = [(rng.uniform(-0.08, 0.08), rng.uniform(-0.08, 0.08), z + radius * 0.71)]
    for i in range(count):
        angle = phase + i * 2 * pi / count
        r = radius * (1.0 if i % 2 == 0 else 0.67) * rng.uniform(0.91, 1.08)
        vertices.append((cos(angle) * r, sin(angle) * r, z + rng.uniform(-0.11, 0.06)))
    for i in range(count):
        angle = phase + i * 2 * pi / count
        r = radius * rng.uniform(0.30, 0.42)
        vertices.append((cos(angle) * r, sin(angle) * r, z - 0.18))
    vertices.append((0, 0, z - 0.25))
    faces = []
    for i in range(count):
        nxt = (i + 1) % count
        faces.append((0, 1 + i, 1 + nxt))
        faces.append((1 + i, 1 + count + i, 1 + count + nxt, 1 + nxt))
        faces.append((1 + count + i, 2 * count + 1, 1 + count + nxt))
    h.mesh(asset, name, vertices, faces, material)


def _pine(h):
    asset = h.asset("prop_pine_tree", "environment")
    rng = Random(53)
    h.cone(asset, "Pine tapered trunk", (0, 0, 1.63), 0.19, 0.055, 3.26, "wood_dark", vertices=7)
    for i in range(5):
        angle = i * 2 * pi / 5
        h.beam(asset, f"Pine surface root {i}", (0, 0, 0.15), (cos(angle) * 0.42, sin(angle) * 0.42, 0.035), 0.09, "wood_dark")
    for tier, (z, radius) in enumerate(((1.36, 1.1), (1.99, 0.97), (2.56, 0.76), (3.06, 0.56), (3.48, 0.34))):
        _pine_tier(h, asset, f"Pine jagged crown {tier}", z, radius, rng, ("leaf", "olive", "leaf_light", "leaf", "olive")[tier])
        if tier < 3:
            for branch in range(4):
                angle = branch * pi / 2 + tier * 0.45
                h.beam(asset, f"Pine bough {tier} {branch}", (0, 0, z - 0.23), (cos(angle) * radius * 0.7, sin(angle) * radius * 0.7, z - 0.02), 0.05, "wood_dark")
    h.cone(asset, "Pine leader", (0, 0, 3.82), 0.12, 0.0, 0.38, "leaf", vertices=5)
    return asset


def _broadleaf(h):
    asset = h.asset("prop_broadleaf_tree", "environment")
    h.cone(asset, "Broadleaf trunk", (0, 0, 1.08), 0.22, 0.13, 2.16, "wood", vertices=7)
    branches = [((-0.02, 0, 1.44), (-0.66, 0.06, 2.57)), ((0, 0, 1.65), (0.59, -0.27, 2.77)), ((0, 0.02, 1.97), (0.06, 0.61, 3.03))]
    for i, (start, end) in enumerate(branches):
        h.beam(asset, f"Broadleaf branch {i}", start, end, 0.14, "wood")
    for i in range(5):
        angle = 2 * pi * i / 5
        h.beam(asset, f"Broadleaf root {i}", (0, 0, 0.12), (cos(angle) * 0.43, sin(angle) * 0.43, 0.04), 0.12, "wood")
    crowns = [((-0.69, -0.15, 2.66), (0.84, 0.7, 0.69), "leaf"), ((0.65, -0.39, 2.75), (0.84, 0.79, 0.77), "leaf_light"), ((0.03, 0.61, 3.06), (0.91, 0.76, 0.81), "olive"), ((-0.27, -0.19, 3.39), (0.84, 0.76, 0.66), "leaf_light"), ((0.46, 0.33, 3.47), (0.71, 0.72, 0.63), "leaf"), ((-0.75, 0.42, 3.09), (0.57, 0.57, 0.56), "olive")]
    for i, (loc, scale, material) in enumerate(crowns):
        h.ico(asset, f"Broadleaf faceted crown {i}", loc, scale, material, subdivisions=1)
    return asset


def _shrub(h):
    asset = h.asset("prop_shrub", "environment")
    clusters = [((-0.32, -0.06, 0.30), (0.37, 0.36, 0.30), "olive"), ((0.26, 0.05, 0.34), (0.42, 0.39, 0.33), "leaf"), ((-0.08, 0.15, 0.53), (0.38, 0.34, 0.39), "leaf_light"), ((0.08, -0.23, 0.30), (0.30, 0.3, 0.28), "leaf"), ((0.28, -0.14, 0.57), (0.25, 0.24, 0.25), "olive")]
    for i, (loc, scale, material) in enumerate(clusters):
        h.ico(asset, f"Shrub crown {i}", loc, scale, material, subdivisions=1)
    return asset


def _planter(h):
    asset = h.asset("prop_planter", "props")
    h.box(asset, "Planter base", (0, 0, 0.045), (0.74, 0.74, 0.09), "concrete")
    for side in (-1, 1):
        h.box(asset, f"Planter front wall {side}", (0, side * 0.326, 0.315), (0.74, 0.088, 0.54), "concrete")
        h.box(asset, f"Planter side wall {side}", (side * 0.326, 0, 0.315), (0.088, 0.57, 0.54), "concrete_light")
    h.box(asset, "Planter soil", (0, 0, 0.42), (0.56, 0.56, 0.09), "wood_dark")
    for i in range(9):
        angle = i * 2.399
        _leaf(h, asset, f"Planter pointed leaf {i}", (0, 0, 0.469), angle, 0.32 + (i % 3) * 0.085, 0.16, 0.28 + (i % 2) * 0.12, ("leaf", "leaf_light", "olive")[i % 3])
    return asset


def _bench(h):
    asset = h.asset("prop_bench", "props")
    for x in (-0.66, 0.66):
        for y in (-0.23, 0.23):
            h.box(asset, f"Bench leg {x} {y}", (x, y, 0.218), (0.065, 0.07, 0.436), "metal")
        h.box(asset, f"Bench seat support {x}", (x, 0, 0.414), (0.075, 0.66, 0.055), "metal")
        h.beam(asset, f"Bench back support {x}", (x, 0.25, 0.2), (x, 0.34, 1.0), 0.065, "metal")
        h.box(asset, f"Bench arm upright {x}", (x, -0.12, 0.57), (0.055, 0.055, 0.23), "metal")
        h.box(asset, f"Bench armrest {x}", (x, 0.03, 0.697), (0.095, 0.49, 0.055), "wood")
    for i in range(5):
        h.box(asset, f"Bench seat slat {i}", (0, -0.252 + i * 0.126, 0.462), (1.76, 0.11, 0.063), "wood")
    for i in range(3):
        h.box(asset, f"Bench back slat {i}", (0, 0.305 + i * 0.012, 0.74 + i * 0.103), (1.76, 0.057, 0.087), "wood")
    return asset


def _street_lamp(h):
    asset = h.asset("prop_street_lamp", "props")
    h.box(asset, "Lamp foundation", (0, 0, 0.075), (0.3, 0.3, 0.15), "concrete")
    h.cone(asset, "Lamp stepped base", (0, 0, 0.235), 0.115, 0.075, 0.32, "metal", vertices=8)
    h.cylinder(asset, "Lamp mast", (0, 0, 1.6), 0.047, 2.67, "metal", vertices=8)
    h.cone(asset, "Lantern lower collar", (0, 0, 2.933), 0.08, 0.16, 0.12, "metal", vertices=8)
    h.box(asset, "Lantern illuminated panes", (0, 0, 3.18), (0.252, 0.252, 0.36), "warm_light")
    for x in (-0.143, 0.143):
        for y in (-0.143, 0.143):
            h.box(asset, f"Lantern frame {x} {y}", (x, y, 3.18), (0.023, 0.023, 0.385), "metal")
    for z in (2.99, 3.37):
        h.box(asset, f"Lantern rim {z}", (0, 0, z), (0.324, 0.324, 0.038), "metal")
    h.cone(asset, "Lantern peaked roof", (0, 0, 3.44), 0.26, 0.0, 0.16, "roof", vertices=4, rotation=(0, 0, pi / 4))
    h.sphere(asset, "Lantern finial", (0, 0, 3.56), (0.039, 0.039, 0.055), "gold", segments=8, rings=4)
    return asset


def _mailbox(h):
    asset = h.asset("prop_mailbox", "props")
    h.box(asset, "Mailbox foot", (0, 0, 0.042), (0.3, 0.3, 0.084), "concrete")
    h.box(asset, "Mailbox post", (0, 0, 0.46), (0.08, 0.08, 0.86), "blue_dark")
    h.box(asset, "Mailbox body", (0, 0, 1.0), (0.46, 0.38, 0.36), "blue", bevel=0.025)
    # 屋顶由折角网格构成，保持低多边形造型与实体内部空间。
    vertices = [(-0.255, -0.22, 1.16), (0.255, -0.22, 1.16), (0, -0.22, 1.31), (-0.255, 0.22, 1.16), (0.255, 0.22, 1.16), (0, 0.22, 1.31)]
    h.mesh(asset, "Mailbox pitched lid", vertices, [(0, 1, 2), (3, 5, 4), (0, 2, 5, 3), (2, 1, 4, 5), (0, 3, 4, 1)], "blue_dark")
    h.box(asset, "Mailbox letter slot", (0, -0.195, 1.076), (0.29, 0.008, 0.036), "ink")
    h.box(asset, "Mailbox collection flap", (0, -0.199, 0.936), (0.347, 0.008, 0.185), "blue_dark")
    h.text(asset, "Mailbox POST letters", "POST", (0, -0.211, 0.952), 0.055, "cream")
    h.box(asset, "Mailbox handle", (0, -0.22, 0.879), (0.09, 0.027, 0.015), "gold")
    return asset


def _dock_bollard(h):
    asset = h.asset("prop_dock_bollard", "props")
    h.box(asset, "Bollard slab", (0, 0, 0.037), (0.5, 0.42, 0.074), "concrete")
    h.cone(asset, "Bollard flared foot", (0, 0, 0.11), 0.16, 0.11, 0.15, "metal", vertices=8)
    h.cylinder(asset, "Bollard stem", (0, 0, 0.25), 0.11, 0.3, "metal", vertices=8)
    h.cylinder(asset, "Bollard cap", (0, 0, 0.39), 0.19, 0.085, "metal", vertices=8)
    h.cylinder(asset, "Bollard cross horn", (0, 0, 0.35), 0.066, 0.48, "metal", vertices=8, rotation=(0, pi / 2, 0))
    for x in (-0.173, 0.173):
        for y in (-0.135, 0.135):
            h.cylinder(asset, f"Bollard mounting bolt {x} {y}", (x, y, 0.081), 0.02, 0.02, "gold", vertices=6)
    return asset


def build_props(h):
    """生成可重复执行的独立道具与植被资产，返回资产描述列表。"""
    return [
        _parcel(h, "prop_parcel_standard", False),
        _parcel(h, "prop_parcel_fragile", True),
        _crate(h),
        _grass(h),
        _pine(h),
        _broadleaf(h),
        _shrub(h),
        _planter(h),
        _bench(h),
        _street_lamp(h),
        _mailbox(h),
        _dock_bollard(h),
    ]
