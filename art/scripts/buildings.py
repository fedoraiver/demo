"""风化海岛木建筑：分片木板、修补屋顶与仍在营业的敞开柜台。"""

from math import pi
from random import Random

from huts import build_huts


WOOD = ("weathered_wood", "weathered_dark", "wood_gray")


def _plank(h, a, name, u, plane, bottom, top, width, material, rng, side=False):
    """每块木板有轻微错位和局部缺口，墙面不使用光滑大盒子替代。"""
    lean = rng.uniform(-0.035, 0.035)
    notch = rng.uniform(0.035, 0.13) if rng.random() < 0.28 else 0.012
    outline = [
        (u - width / 2, bottom + 0.025), (u - width * 0.11, bottom),
        (u, bottom + notch), (u + width * 0.15, bottom + 0.009),
        (u + width / 2, bottom + rng.uniform(0.008, 0.035)),
        (u + width / 2 + lean, top - 0.022),
        (u + width * 0.21 + lean, top), (u - width / 2 + lean, top - 0.044),
    ]
    vertices = []
    for depth in (-0.050, 0.050):
        for q, z in outline:
            vertices.append((plane + depth, q, z) if side else (q, plane + depth, z))
    n = len(outline)
    faces = [tuple(range(n)), tuple(reversed(range(n, 2 * n)))]
    faces.extend((i, i + n, (i + 1) % n + n, (i + 1) % n) for i in range(n))
    if side:
        # 侧墙坐标交换 X/Y 后改变了绕序，翻转法线使木板外侧照明正确。
        faces = [tuple(reversed(face)) for face in faces]
    return h.mesh(a, name, vertices, faces, material)


def _roof_panel(h, a, name, x0, x1, y0, y1, z0, z1, material):
    """斜面铁皮保留厚度，分段接缝和锈色补片可直接导出。"""
    top = [(x0, y0, z0), (x1, y0, z1), (x1, y1, z1), (x0, y1, z0)]
    vertices = top + [(x, y, z - 0.055) for x, y, z in top]
    h.mesh(a, name, vertices, [(0, 1, 2, 3), (7, 6, 5, 4),
                               (0, 4, 5, 1), (1, 5, 6, 2),
                               (2, 6, 7, 3), (3, 7, 4, 0)], material)


def _shed(h, a, width, depth, eave, ridge, paint, seed):
    """三面板墙与独立承重架围出店面，前方保持敞开可见室内。"""
    rng = Random(seed)
    ridge_x = -0.28 if seed % 2 else 0.32
    left_z, right_z = eave, eave + 0.11

    def roof_height(x):
        if x <= ridge_x:
            return left_z + (ridge - left_z) * (x + width / 2) / (ridge_x + width / 2)
        return ridge - (ridge - right_z) * (x - ridge_x) / (width / 2 - ridge_x)

    # 木地板顶面统一为 0.18 米，与地图 NPC 的站立高度一致。
    for x in (-width / 2 + 0.27, width / 2 - 0.27):
        h.box(a, f"Floor_runner_{x}", (x, 0, 0.045), (0.23, depth, 0.09), "weathered_dark")
    boards = max(12, round(width / 0.32))
    spacing = width / boards
    for i in range(boards):
        x = -width / 2 + (i + 0.5) * spacing
        h.box(a, f"Floor_board_{i}", (x, 0, 0.137), (spacing - 0.009, depth, 0.086),
              rng.choice(("weathered_wood", "wood_gray", "weathered_wood")), bevel=0.006)
    for side in (-1, 1):
        x = side * (width / 2 - 0.06)
        top = left_z if side < 0 else right_z
        count = max(12, round(depth / 0.30))
        for i in range(count):
            y = -depth / 2 + (i + 0.5) * depth / count
            material = paint if rng.random() < 0.21 else rng.choice(WOOD)
            _plank(h, a, f"Side_board_{side}_{i}", y, x, 0.19, top - rng.uniform(0.01, 0.09),
                   depth / count - 0.014, material, rng, side=True)
        h.beam(a, f"Side_external_brace_{side}", (x + side * 0.10, -depth / 2 + 0.16, 0.43),
               (x + side * 0.14, depth / 2 - 0.13, top - 0.28), 0.15, "weathered_dark")
        for level in (0.31, top - 0.17):
            h.beam(a, f"Side_crossbeam_{side}_{level}", (x, -depth / 2, level),
                   (x, depth / 2, level + 0.022), 0.15, "weathered_dark")
    for i in range(boards):
        x = -width / 2 + (i + 0.5) * spacing
        _plank(h, a, f"Back_board_{i}", x, depth / 2 - 0.04, 0.19,
               roof_height(x) - 0.05, spacing - 0.012, rng.choice(WOOD), rng)
        top = roof_height(x) - 0.13
        if top > eave + 0.08:
            _plank(h, a, f"Front_gable_board_{i}", x, -depth / 2,
                   eave - 0.05, top, spacing - 0.016, rng.choice(WOOD), rng)
    for side in (-1, 1):
        x, top = side * (width / 2 - 0.11), left_z if side < 0 else right_z
        for front in (-1, 1):
            y = front * (depth / 2 - 0.05)
            h.beam(a, f"Corner_post_{side}_{front}", (x, y, 0.10),
                   (x + side * 0.07, y + 0.025, top + 0.02), 0.20, "weathered_dark")
    h.beam(a, "Front_header_beam", (-width / 2 - 0.08, -depth / 2 - 0.05, left_z - 0.09),
           (width / 2 + 0.08, -depth / 2 - 0.05, right_z - 0.09), 0.19, "weathered_dark")
    # 单独屋顶条片混入旧铁皮与修补木板，避免平整的新屋顶轮廓。
    count = round((depth + 0.62) / 0.39)
    front_y = -depth / 2 - 0.32
    stride = (depth + 0.64) / count
    for side, x0, x1, z0, z1 in ((0, -width / 2 - 0.31, ridge_x, left_z - 0.10, ridge),
                                (1, ridge_x, width / 2 + 0.35, ridge, right_z - 0.10)):
        for i in range(count):
            y0, y1 = front_y + i * stride, front_y + (i + 1) * stride + 0.035
            offset = rng.uniform(-0.013, 0.018)
            material = rng.choices(("wood_gray", "weathered_dark", "rust", "weathered_wood"), (5, 2, 2, 2))[0]
            _roof_panel(h, a, f"Roof_panel_{side}_{i}", x0, x1, y0, y1,
                        z0 + offset, z1 + offset, material)
            h.beam(a, f"Roof_ridge_line_{side}_{i}", (x0, y0 + 0.17, z0 + offset + 0.025),
                   (x1, y0 + 0.17, z1 + offset + 0.025), 0.025, "wood_gray")
    for front in (-1, 1):
        y = front * (depth / 2 + 0.33)
        h.beam(a, f"Roof_edge_left_{front}", (-width / 2 - 0.32, y, left_z - 0.11),
               (ridge_x, y, ridge - 0.01), 0.15, "weathered_dark")
        h.beam(a, f"Roof_edge_right_{front}", (ridge_x, y, ridge - 0.01),
               (width / 2 + 0.36, y, right_z - 0.11), 0.15, "weathered_dark")
    h.beam(a, "Roof_peak_cap", (ridge_x, front_y - 0.035, ridge + 0.01),
           (ridge_x, depth / 2 + 0.36, ridge + 0.035), 0.13, "rust")
    _roof_panel(h, a, "Roof_repair_patch", ridge_x + 0.30, width / 2 - 0.33,
                0.31, 1.29, roof_height(ridge_x + 0.30) + 0.070,
                roof_height(width / 2 - 0.33) + 0.070, "rust")
    return rng


def _old_sign(h, a, name, x, y, z, width, height, paint):
    """褪色招牌由几块旧板拼成，端头错位与铁钉保留手作感。"""
    rows = max(3, round(height / 0.19))
    for i in range(rows):
        offset = 0.036 if i % 3 == 0 else -0.021
        h.box(a, f"{name}_board_{i}", (x + offset, y, z - height / 2 + (i + 0.5) * height / rows),
              (width - (0.12 if i == 1 else 0), 0.09, height / rows - 0.01),
              paint if i != rows - 2 else "weathered_wood", bevel=0.006,
              rotation=(0, 0.008 if i % 2 else -0.009, 0))
    for side in (-1, 1):
        h.box(a, f"{name}_strap_{side}", (x + side * (width / 2 - 0.24), y - 0.052, z),
              (0.075, 0.025, height + 0.045), "rust", rotation=(0, side * 0.035, 0))
        for level in (-height * 0.34, height * 0.34):
            h.sphere(a, f"{name}_nail_{side}_{level}",
                     (x + side * (width / 2 - 0.24), y - 0.075, z + level),
                     (0.024, 0.009, 0.024), "metal", segments=6, rings=4)


def _old_window(h, a, name, x, y, z, width, height, paint):
    h.box(a, f"{name}_pane", (x, y, z), (width, 0.018, height), "glass")
    for side in (-1, 1):
        h.beam(a, f"{name}_jamb_{side}", (x + side * width / 2, y - 0.045, z - height / 2),
               (x + side * width / 2 + 0.03, y - 0.045, z + height / 2), 0.08, "weathered_dark")
        h.box(a, f"{name}_frame_{side}", (x, y - 0.05, z + side * height / 2),
              (width + 0.17, 0.10, 0.075), paint, rotation=(0, side * 0.019, 0))
    h.box(a, f"{name}_mullion", (x + 0.025, y - 0.06, z), (0.055, 0.06, height), "wood_gray")
    h.box(a, f"{name}_sill", (x, y - 0.08, z - height / 2 - 0.06),
          (width + 0.25, 0.29, 0.075), "weathered_wood", rotation=(0, -0.018, 0))


def _parcel(h, a, name, location, scale=1):
    x, y, z = location
    h.box(a, name, location, (0.62 * scale, 0.54 * scale, 0.52 * scale), "cardboard", bevel=0.012)
    h.box(a, name + "_tape", (x, y, z + 0.266 * scale), (0.09 * scale, 0.55 * scale, 0.009), "tape")
    h.box(a, name + "_label", (x + 0.13 * scale, y - 0.277 * scale, z),
          (0.19 * scale, 0.012, 0.12 * scale), "cream")


def _open_sign(h, a, name, x, y, z):
    h.box(a, name + "_board", (x, y, z), (0.64, 0.06, 0.29), "weathered_dark",
          bevel=0.01, rotation=(0, 0.035, 0))
    h.text(a, name + "_letters", "OPEN", (x, y - 0.045, z), 0.17, "coral")
    for side in (-1, 1):
        h.beam(a, name + f"_cord_{side}", (x + side * 0.23, y, z + 0.15),
               (x, y, z + 0.43), 0.012, "weathered_wood")


def _counter(h, a, x, y, width, text, paint):
    for side in (-1, 1):
        h.box(a, f"Counter_leg_{side}", (x + side * (width / 2 - 0.17), y, 0.69),
              (0.12, 0.61, 1.02), "weathered_dark")
    count = round(width / 0.27)
    for i in range(count):
        h.box(a, f"Counter_front_board_{i}", (x - width / 2 + (i + 0.5) * width / count, y - 0.31, 0.71),
              (width / count - 0.012, 0.08, 0.96), paint if i % 4 == 0 else WOOD[i % 3],
              bevel=0.006, rotation=(0, 0.012 if i % 2 else -0.006, 0))
    for i in range(3):
        h.box(a, f"Counter_top_board_{i}", (x + (0.04 if i == 1 else 0), y - 0.26 + i * 0.26, 1.27),
              (width + 0.13, 0.247, 0.10), "weathered_wood", bevel=0.012)
    h.text(a, "Counter_caption", text, (x, y - 0.365, 0.75), 0.19, "cream")


def _courier_station(h):
    a = h.asset("bld_courier_station", "buildings")
    rng = _shed(h, a, 7.0, 4.8, 3.68, 4.78, "faded_blue", 420)
    # 服务口保持大开口，右侧旧木门提供仓库的第二个出入口。
    for i in range(7):
        x = 1.36 + (i + 0.5) * 2.05 / 7
        _plank(h, a, f"Door_wall_board_{i}", x, -2.4, 0.19, 2.77, 2.05 / 7 - 0.012,
               "faded_blue" if i % 3 else "wood_gray", rng)
    h.box(a, "Side_door", (2.46, -2.477, 1.36), (0.97, 0.11, 2.22), "weathered_dark")
    for i in range(5):
        h.box(a, f"Door_face_board_{i}", (2.46 - 0.41 + i * 0.205, -2.547, 1.35),
              (0.19, 0.045, 2.15 - i * 0.007), "faded_blue" if i % 2 else "weathered_wood",
              rotation=(0, 0.01 if i % 2 else -0.01, 0))
    h.beam(a, "Door_diagonal_brace", (2.08, -2.59, 0.44), (2.86, -2.59, 2.14), 0.08, "weathered_dark")
    h.box(a, "Door_handle", (2.81, -2.629, 1.25), (0.065, 0.08, 0.18), "rust")
    h.beam(a, "Service_mullion", (1.16, -2.46, 0.17), (1.11, -2.48, 2.86), 0.18, "weathered_dark")
    h.beam(a, "Service_lintel", (-3.50, -2.51, 2.77), (1.20, -2.51, 2.85), 0.19, "weathered_dark")
    _old_sign(h, a, "Station_sign", -0.70, -2.67, 3.26, 5.40, 1.07, "faded_blue")
    h.text(a, "Courier_letters", "COURIER", (0.02, -2.754, 3.50), 0.62, "cream")
    h.text(a, "Station_letters", "STATION", (0.02, -2.754, 3.05), 0.48, "cream")
    h.mesh(a, "Parcel_mark_top", [(-2.85, -2.76, 3.36), (-2.52, -2.76, 3.54),
                                  (-2.19, -2.76, 3.36), (-2.52, -2.76, 3.18)], [(0, 3, 2, 1)], "cream")
    h.mesh(a, "Parcel_mark_left", [(-2.85, -2.76, 3.31), (-2.56, -2.76, 3.13),
                                   (-2.56, -2.76, 2.83), (-2.85, -2.76, 3.01)], [(0, 3, 2, 1)], "wood_gray")
    h.mesh(a, "Parcel_mark_right", [(-2.48, -2.76, 3.13), (-2.19, -2.76, 3.31),
                                    (-2.19, -2.76, 3.01), (-2.48, -2.76, 2.83)], [(0, 3, 2, 1)], "cream")
    _counter(h, a, -1.20, -1.05, 3.65, "DELIVERY DESK", "faded_blue")
    _parcel(h, a, "Desk_parcel", (0.04, -1.01, 1.59))
    for x in (-2.95, -1.22, 0.54):
        h.box(a, f"Shelf_post_{x}", (x, 1.54, 1.43), (0.075, 0.10, 2.30), "weathered_dark")
    for row, level in enumerate((0.42, 1.13, 1.88)):
        h.box(a, f"Parcel_shelf_{row}", (-1.20, 1.54, level), (3.62, 0.60, 0.08), "weathered_wood")
        for i, x in enumerate((-2.55, -1.68, -0.73, 0.10)):
            scale = 0.72 + 0.11 * ((i + row) % 3)
            _parcel(h, a, f"Shelf_parcel_{row}_{i}", (x, 1.51, level + 0.04 + 0.26 * scale), scale)
    _old_window(h, a, "Door_window", 2.46, -2.590, 1.83, 0.48, 0.39, "wood_gray")
    h.box(a, "Hanging_lamp", (-1.25, 0, 2.90), (0.36, 0.33, 0.07), "warm_light", bevel=0.01)
    h.beam(a, "Lamp_cord", (-1.25, 0, 2.95), (-1.25, 0, 3.58), 0.018, "weathered_dark")
    h.box(a, "Desk_logbook", (-2.32, -1.08, 1.35), (0.39, 0.27, 0.045), "wood_dark", rotation=(0, 0, 0.14))
    return a


def _pizza_sign(h, a):
    points = [(-0.57, 4.42), (0.76, 4.09), (-0.22, 3.38)]
    verts = [(x, y, z) for y in (-0.26, -0.06) for x, z in points]
    h.mesh(a, "Pizza_slice_sign", verts, [(0, 2, 1), (3, 4, 5), (0, 1, 4, 3),
                                         (1, 2, 5, 4), (2, 0, 3, 5)], "gold")
    h.beam(a, "Pizza_crust", (-0.57, -0.30, 4.42), (0.76, -0.30, 4.09), 0.15, "weathered_wood")
    for i, (x, z, radius) in enumerate(((-0.29, 4.16, 0.098), (0.16, 4.01, 0.095), (-0.11, 3.78, 0.085))):
        h.cylinder(a, f"Pepperoni_{i}", (x, -0.377, z), radius, 0.021,
                   "faded_red", vertices=10, rotation=(pi / 2, 0, 0))
    h.beam(a, "Pizza_sign_stick", (-0.16, -0.005, 3.10), (-0.10, -0.005, 3.87), 0.075, "weathered_dark")


def _pizza_shop(h):
    a = h.asset("bld_pizza_shop", "buildings")
    _shed(h, a, 5.0, 4.0, 2.87, 3.66, "faded_red", 913)
    _old_sign(h, a, "Pizza_shop_sign", 0.03, -2.25, 2.74, 4.74, 0.73, "faded_red")
    h.text(a, "Pizza_letters", "PIZZA", (0.03, -2.332, 2.75), 0.73, "cream")
    _pizza_sign(h, a)
    _counter(h, a, -0.63, 0.16, 2.91, "HOT PIZZA", "faded_red")
    _old_sign(h, a, "Menu_board", -1.06, 1.86, 2.01, 1.66, 0.99, "weathered_dark")
    h.text(a, "Menu_title", "TODAY'S PIZZA", (-1.06, 1.775, 2.30), 0.14, "gold")
    for i, body in enumerate(("MARGHERITA  8", "PEPPERONI  10", "ISLAND SPECIAL  12")):
        h.text(a, f"Menu_line_{i}", body, (-1.06, 1.775, 2.08 - i * 0.20), 0.098, "cream")
    h.box(a, "Oven_base", (1.49, 1.10, 0.70), (1.19, 1.14, 0.99), "rock", bevel=0.055)
    h.box(a, "Oven_chamber", (1.49, 1.10, 1.44), (1.22, 1.16, 0.53), "rust", bevel=0.06)
    h.box(a, "Oven_mouth", (1.49, 0.508, 1.40), (0.84, 0.025, 0.29), "ink", bevel=0.065)
    h.box(a, "Oven_glow", (1.49, 0.491, 1.33), (0.51, 0.016, 0.044), "coral")
    h.box(a, "Oven_hood", (1.49, 1.10, 1.91), (1.32, 1.21, 0.26), "wood_gray", bevel=0.025)
    h.box(a, "Oven_flue", (1.49, 1.35, 2.39), (0.31, 0.37, 0.79), "rust")
    h.box(a, "Roof_chimney", (1.49, 1.35, 3.69), (0.28, 0.33, 0.65), "rust")
    h.box(a, "Chimney_cap", (1.49, 1.35, 4.03), (0.42, 0.43, 0.065), "wood_gray", rotation=(0, 0.034, 0))
    for i in range(3):
        h.box(a, f"Pizza_box_{i}", (-1.53, 0.15, 1.36 + i * 0.066),
              (0.60, 0.56, 0.059), "cardboard", bevel=0.008)
    h.cylinder(a, "Serving_tray", (0.05, 0.17, 1.332), 0.29, 0.028, "metal", vertices=16)
    h.cylinder(a, "Fresh_pizza", (0.05, 0.17, 1.358), 0.265, 0.032, "gold", vertices=12)
    for i, (x, y) in enumerate(((-0.09, 0.11), (0.18, 0.09), (0.05, 0.30))):
        h.cylinder(a, f"Fresh_topping_{i}", (x, y, 1.383), 0.049, 0.009, "red", vertices=8)
    _open_sign(h, a, "Pizza_open", 0.71, -1.93, 2.03)
    h.beam(a, "Pizza_front_brace", (-2.35, -2.10, 0.32), (-2.16, -2.12, 2.66), 0.14, "weathered_dark")
    return a


def _guitar(h, a, name, x, y, z, color):
    """简单琴身与琴颈保留店内商品识别，全部使用实体几何。"""
    h.sphere(a, name + "_body", (x, y, z), (0.21, 0.066, 0.24), color, segments=10, rings=6)
    h.sphere(a, name + "_shoulder", (x, y, z + 0.24), (0.16, 0.062, 0.17), color, segments=10, rings=6)
    h.box(a, name + "_neck", (x, y - 0.018, z + 0.59), (0.073, 0.065, 0.54), "weathered_wood")
    h.box(a, name + "_head", (x, y - 0.018, z + 0.92), (0.10, 0.065, 0.18), color,
          bevel=0.012, rotation=(0, -0.09, 0))
    h.cylinder(a, name + "_sound_hole", (x, y - 0.075, z + 0.15), 0.064, 0.018,
               "ink", vertices=12, rotation=(pi / 2, 0, 0))
    h.box(a, name + "_bridge", (x, y - 0.075, z - 0.04), (0.14, 0.027, 0.04), "cream")
    h.box(a, name + "_string", (x, y - 0.069, z + 0.46), (0.012, 0.01, 0.91), "cream")


def _record(h, a, name, x, y, z, radius, label="faded_red"):
    h.cylinder(a, name, (x, y, z), radius, 0.046, "ink", vertices=20, rotation=(pi / 2, 0, 0))
    h.cylinder(a, name + "_label", (x, y - 0.033, z), radius * 0.29, 0.022,
               label, vertices=12, rotation=(pi / 2, 0, 0))
    h.cylinder(a, name + "_hub", (x, y - 0.048, z), radius * 0.046, 0.018,
               "cream", vertices=8, rotation=(pi / 2, 0, 0))


def _music_shop(h):
    a = h.asset("bld_music_shop", "buildings")
    _shed(h, a, 5.6, 4.3, 3.04, 3.86, "faded_olive", 716)
    _old_sign(h, a, "Music_shop_sign", 0, -2.37, 2.91, 5.30, 0.83, "faded_olive")
    h.text(a, "Music_letters", "MUSIC", (-0.57, -2.45, 2.94), 0.71, "cream")
    _record(h, a, "Shop_record_mark", 1.86, -2.47, 2.94, 0.40)
    _counter(h, a, 0.50, -0.02, 3.50, "ISLAND RECORDS", "faded_olive")
    h.beam(a, "Guitar_hanging_rail", (-2.18, 1.98, 2.45), (0.42, 1.98, 2.41), 0.09, "weathered_dark")
    _guitar(h, a, "Acoustic_guitar", -1.70, 1.94, 1.20, "gold")
    _guitar(h, a, "Midnight_guitar", -0.75, 1.94, 1.20, "ink")
    _guitar(h, a, "Red_guitar", 0.17, 1.94, 1.20, "faded_red")
    for row, level in enumerate((0.64, 1.17, 1.70)):
        h.box(a, f"Record_shelf_{row}", (1.70, 1.77, level), (0.95, 0.52, 0.07), "weathered_wood")
        for i, mat in enumerate(("faded_blue", "faded_red", "weathered_wood")):
            h.box(a, f"Record_sleeve_{row}_{i}", (1.41 + i * 0.29, 1.72, level + 0.22),
                  (0.25, 0.065, 0.36), mat, rotation=(0, i * 0.021, 0))
    h.box(a, "Turntable_base", (1.50, -0.02, 1.385), (0.64, 0.46, 0.13), "weathered_dark", bevel=0.016)
    h.cylinder(a, "Turntable_disc", (1.47, -0.01, 1.459), 0.19, 0.018, "ink", vertices=20)
    h.cylinder(a, "Turntable_label", (1.47, -0.01, 1.474), 0.054, 0.014, "coral", vertices=12)
    h.beam(a, "Turntable_arm", (1.72, 0.12, 1.484), (1.55, -0.06, 1.484), 0.018, "metal")
    h.box(a, "Old_speaker", (-2.03, 0.47, 0.65), (0.53, 0.53, 0.94), "weathered_dark", bevel=0.02)
    for j, z in enumerate((0.43, 0.80)):
        _record(h, a, f"Speaker_cone_{j}", -2.03, 0.19, z, 0.15, "wood_gray")
    _open_sign(h, a, "Music_open", 1.65, -2.10, 2.09)
    _old_sign(h, a, "Music_notice", -1.96, -2.30, 1.97, 0.50, 0.65, "weathered_wood")
    h.text(a, "Music_notice_live", "LIVE", (-1.96, -2.385, 2.10), 0.15, "cream")
    h.text(a, "Music_notice_friday", "FRIDAY", (-1.96, -2.385, 1.86), 0.10, "cream")
    return a


def build_buildings(h):
    """保留五个稳定建筑 ID，居民木屋由独立模块提供。"""
    return [_courier_station(h), _pizza_shop(h), _music_shop(h)] + build_huts(h)
