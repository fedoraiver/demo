"""邮局工业道具的低多边形建模；只创建资产，不启动游戏或执行导出。"""

from math import atan2, cos, pi, sin, sqrt

import bpy
from mathutils import Vector


CATEGORY = "items/industrial"


def _asset(h, asset_id, display_name, item_id=None, variant="default"):
    """生产机器使用地面轴心，分类与变体信息留在根节点供清单读取。"""
    asset = h.asset(asset_id, CATEGORY)
    asset.root["display_name_zh"] = display_name
    asset.root["item_id"] = item_id or asset_id
    asset.root["variant"] = variant
    asset.root["source_up_axis"] = "Z"
    asset.root["source_forward_axis"] = "+Y"
    asset.root["origin_role"] = "ground_contact"
    return asset


def _empty(asset, name, loc, rotation=(0, 0, 0), purpose=None):
    """挂点和转轴是独立 Empty，保证未来交互无需修改静态网格。"""
    obj = bpy.data.objects.new(asset.root.name + "__" + name, None)
    asset.collection.objects.link(obj)
    obj.parent = asset.root
    obj.location = loc
    obj.rotation_euler = rotation
    obj.empty_display_size = 0.12
    if purpose:
        obj["purpose"] = purpose
    return obj


def _parent_objects(parent, objects):
    """保留零姿态的世界位置，动画时只移动命名转轴下的机器部件。"""
    bpy.context.view_layer.update()
    for obj in objects:
        world = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = world


def _bolts(h, a, name, x, y, heights, facing="front"):
    for i, z in enumerate(heights):
        if facing == "front":
            h.cylinder(a, f"{name}_{i}", (x, y, z), 0.017, 0.012,
                       "metal", vertices=6, rotation=(pi / 2, 0, 0))
        else:
            h.cylinder(a, f"{name}_{i}", (x, y, z), 0.017, 0.012,
                       "metal", vertices=6, rotation=(0, pi / 2, 0))


def _foot(h, a, name, x, y, top):
    """脚垫接地，伸缩支脚与三角撑形成可读的机器承重结构。"""
    h.box(a, name + "_pad", (x, y, 0.035), (0.18, 0.17, 0.07), "metal", bevel=0.015)
    h.box(a, name + "_stem", (x, y, (top + 0.07) / 2), (0.075, 0.075, top - 0.07),
          "blue_dark", bevel=0.008)
    h.box(a, name + "_collar", (x, y, 0.17), (0.09, 0.09, 0.055), "gold", bevel=0.007)


def _mail_icon(h, a, name, x, y, z, size=0.12):
    """邮封线条取代长文字，远景仍能读出工业设施属于邮局。"""
    h.box(a, name + "_plate", (x, y, z), (size * 1.4, 0.012, size), "cream", bevel=0.01)
    h.beam(a, name + "_fold_left", (x - size * 0.62, y - 0.009, z + size * 0.37),
           (x, y - 0.009, z - size * 0.05), 0.012, "blue_dark")
    h.beam(a, name + "_fold_right", (x + size * 0.62, y - 0.009, z + size * 0.37),
           (x, y - 0.009, z - size * 0.05), 0.012, "blue_dark")


def _label(h, a, name, body, loc, width=0.38, height=0.13):
    x, y, z = loc
    h.box(a, name + "_back", loc, (width, 0.018, height), "cream", bevel=0.008)
    h.text(a, name + "_letters", body, (x, y - 0.012, z), height * 0.44, "blue_dark")


def _control_panel(h, a, name, loc, width=0.34, height=0.31):
    """小型实体按钮、状态灯和运单屏幕，不依赖游戏 UI 或外部贴图。"""
    x, y, z = loc
    h.box(a, name + "_housing", loc, (width, 0.11, height), "blue_dark", bevel=0.025)
    h.box(a, name + "_face", (x, y - 0.061, z), (width - 0.033, 0.016, height - 0.028),
          "blue", bevel=0.009)
    h.box(a, name + "_screen", (x - width * 0.11, y - 0.073, z + height * 0.17),
          (width * 0.53, 0.011, height * 0.28), "ink", bevel=0.004)
    for i, line_width in enumerate((0.12, 0.075)):
        h.box(a, f"{name}_screen_line_{i}",
              (x - width * 0.13, y - 0.081, z + height * (0.22 - i * 0.11)),
              (min(width * 0.38, line_width), 0.008, 0.01), "teal")
    for i, color in enumerate(("olive", "red")):
        h.cylinder(a, f"{name}_button_{i}",
                   (x - width * 0.23 + i * width * 0.35, y - 0.086, z - height * 0.2),
                   0.035, 0.024, color, vertices=10, rotation=(pi / 2, 0, 0))
    h.cylinder(a, name + "_status_lamp", (x + width * 0.34, y - 0.083, z + height * 0.19),
               0.017, 0.016, "warm_light", vertices=8, rotation=(pi / 2, 0, 0))
    for dx in (-width * 0.39, width * 0.39):
        _bolts(h, a, name + f"_bolt_{dx}", x + dx, y - 0.075,
               (z - height * 0.37, z + height * 0.37))


def _hazard_band(h, a, name, loc, width, height=0.08):
    """短警示条采用窄斜条几何，边界内收以避免悬出机器外壳。"""
    x, y, z = loc
    h.box(a, name + "_yellow", loc, (width, 0.016, height), "gold")
    count = max(2, round(width / 0.13))
    for i in range(count):
        offset = -width / 2 + (i + 0.5) * width / count
        h.box(a, f"{name}_stripe_{i}", (x + offset, y - 0.012, z),
              (0.035, 0.008, height * 0.77), "ink", rotation=(0, 0.42, 0))


def _cable(h, a, name, points, width=0.025, mat="ink"):
    """折线电缆保持低面数，弯头用六边截面的接头遮住连接缝。"""
    for i in range(len(points) - 1):
        h.beam(a, f"{name}_segment_{i}", points[i], points[i + 1], width, mat)
    for i, point in enumerate(points[1:-1]):
        h.ico(a, f"{name}_joint_{i}", point, (width * 0.8,) * 3, mat)


def _roller(h, a, name, center, width=0.77, radius=0.045, yaw=0):
    """滚轮沿本地 X，六边金属端帽和暗轴表现真实输送床结构。"""
    direction = Vector((cos(yaw), sin(yaw), 0))
    rotation = direction.to_track_quat("Z", "Y").to_euler()
    parts = [h.cylinder(a, name + "_rubber", center, radius, width, "metal",
                        vertices=10, rotation=rotation)]
    for side in (-1, 1):
        cap = Vector(center) + direction * (width / 2 + 0.005) * side
        parts.append(h.cylinder(a, f"{name}_cap_{side}", cap, radius * 0.68,
                                0.022, "concrete_light", vertices=8, rotation=rotation))
    return parts


def _arrow(h, a, name, center, yaw=0, scale=1):
    x, y, z = center
    # 箭头为朝 +Y 的顶面浮雕；绕 Z 转动时与对应运输口方向一致。
    local = [(-0.065, -0.12), (0.065, -0.12), (0.065, 0.005),
             (0.12, 0.005), (0, 0.14), (-0.12, 0.005), (-0.065, 0.005)]
    verts = [(x + scale * (px * cos(yaw) - py * sin(yaw)),
              y + scale * (px * sin(yaw) + py * cos(yaw)), z) for px, py in local]
    return h.mesh(a, name, verts, [tuple(range(len(verts)))], "gold")


def _conveyor(h, name="mach_conveyor", rise=0, variant="default"):
    a = _asset(h, name, "模块传送带" if not rise else "模块传送带·缓坡",
               "mach_conveyor", variant)
    slope = atan2(rise, 1.5)
    # 滚轮顶面为 0.75 米；缓坡的水平投影仍是一个 1.5 米模块。
    for i in range(13):
        y = -0.70 + i * 1.4 / 12
        z = 0.705 + (y + 0.75) * rise / 1.5
        _roller(h, a, f"roller_{i:02d}", (0, y, z))
    for side in (-1, 1):
        x = side * 0.435
        h.box(a, f"bed_rail_{side}", (x, 0, 0.69 + rise / 2),
              (0.075, sqrt(1.5 ** 2 + rise ** 2), 0.14), "blue", bevel=0.014,
              rotation=(slope, 0, 0))
        h.box(a, f"guard_rail_{side}", (x, 0, 0.83 + rise / 2),
              (0.032, sqrt(1.5 ** 2 + rise ** 2), 0.043), "gold", bevel=0.006,
              rotation=(slope, 0, 0))
        for j, y in enumerate((-0.56, 0.56)):
            top = 0.64 + (y + 0.75) * rise / 1.5
            _foot(h, a, f"support_{side}_{j}", x, y, top)
        h.beam(a, f"leg_diagonal_{side}", (x, -0.55, 0.18),
               (x, 0.55, 0.57 + rise * 0.87), 0.035, "metal")
        for j in range(4):
            y = -0.63 + j * 0.42
            z = 0.69 + (y + 0.75) * rise / 1.5
            _bolts(h, a, f"rail_bolt_{side}_{j}", x + side * 0.044, y,
                   (z,), facing="side")
    h.box(a, "cross_brace", (0, 0.5, 0.26), (0.81, 0.045, 0.045), "metal")
    h.box(a, "motor_cover", (-0.55, 0.38, 0.55 + rise * 0.75),
          (0.20, 0.31, 0.22), "blue_dark", bevel=0.024)
    for i in range(3):
        h.box(a, f"motor_vent_{i}", (-0.655, 0.31 + i * 0.065, 0.55 + rise * 0.75),
              (0.01, 0.028, 0.12), "ink")
    h.cylinder(a, "drive_end", (-0.515, 0.66, 0.675 + rise * 0.94),
               0.10, 0.12, "metal", vertices=12, rotation=(0, pi / 2, 0))
    _control_panel(h, a, "control", (-0.57, -0.48, 0.52), width=0.22, height=0.24)
    _cable(h, a, "power_cable", [(-0.60, -0.35, 0.45), (-0.6, -0.14, 0.32),
                                 (-0.6, 0.36, 0.32), (-0.6, 0.38, 0.48 + rise * 0.75)])
    _empty(a, "socket_input", (0, -0.75, 0.75), purpose="roller_bed_input")
    _empty(a, "socket_output", (0, 0.75, 0.75 + rise),
           rotation=(slope, 0, 0), purpose="roller_bed_output")
    a.root["bed_width_m"] = 0.82
    a.root["module_length_m"] = 1.5
    a.root["bed_input_height_m"] = 0.75
    a.root["bed_output_height_m"] = 0.75 + rise
    return a


def _arc_wall(h, a, name, center, radius, thickness, z, height, mat, segments=12):
    """弯道护栏采用封闭扇环网格，内外缘一致并保持明显的四分之一圆剪影。"""
    vertices = []
    for i in range(segments + 1):
        theta = pi - i * pi / (2 * segments)
        for r, top in ((radius - thickness / 2, 0), (radius + thickness / 2, 0),
                       (radius + thickness / 2, 1), (radius - thickness / 2, 1)):
            vertices.append((center[0] + r * cos(theta), center[1] + r * sin(theta),
                             z + (top - 0.5) * height))
    faces = [(0, 3, 2, 1)]
    for i in range(segments):
        k, nxt = 4 * i, 4 * (i + 1)
        faces.extend(((k, k + 1, nxt + 1, nxt), (k + 1, k + 2, nxt + 2, nxt + 1),
                      (k + 2, k + 3, nxt + 3, nxt + 2), (k + 3, k, nxt, nxt + 3)))
    k = 4 * segments
    faces.append((k, k + 1, k + 2, k + 3))
    return h.mesh(a, name, vertices, faces, mat)


def _conveyor_corner(h):
    a = _asset(h, "mach_conveyor_corner", "模块传送带·弯道", "mach_conveyor", "corner")
    center = (0.75, -0.75)
    for i in range(13):
        theta = pi - (i + 0.5) * pi / 26
        x, y = center[0] + 0.75 * cos(theta), center[1] + 0.75 * sin(theta)
        _roller(h, a, f"corner_roller_{i:02d}", (x, y, 0.705), yaw=theta)
    for side, radius in (("inner", 0.315), ("outer", 1.185)):
        _arc_wall(h, a, side + "_rail", center, radius, 0.07, 0.69, 0.14, "blue")
        _arc_wall(h, a, side + "_guard", center, radius, 0.035, 0.83, 0.04, "gold")
        for i, theta in enumerate((pi - 0.09, 3 * pi / 4, pi / 2 + 0.09)):
            x, y = center[0] + radius * cos(theta), center[1] + radius * sin(theta)
            _foot(h, a, f"corner_support_{side}_{i}", x, y, 0.63)
    h.box(a, "corner_motor", (-0.52, -0.58, 0.53), (0.22, 0.26, 0.20),
          "blue_dark", bevel=0.025)
    _control_panel(h, a, "corner_control", (-0.52, -0.64, 0.54), width=0.20, height=0.19)
    _cable(h, a, "corner_cable", [(-0.51, -0.5, 0.50), (-0.51, -0.32, 0.28),
                                   (-0.36, -0.13, 0.28), (-0.36, -0.13, 0.62)])
    _empty(a, "socket_input", (0, -0.75, 0.75), purpose="roller_bed_input")
    _empty(a, "socket_output", (0.75, 0, 0.75), rotation=(0, 0, -pi / 2),
           purpose="roller_bed_output_positive_x")
    a.root["bed_width_m"] = 0.82
    a.root["turn_degrees"] = 90
    return a


def _sorter(h):
    a = _asset(h, "mach_address_sorter", "地址分拣闸")
    # 主线保持直通，右侧支线用分段滚轮床；不在几何中预塞演示包裹。
    for i in range(16):
        _roller(h, a, f"main_roller_{i:02d}", (0, -0.94 + i * 1.88 / 15, 0.705))
    for i in range(7):
        _roller(h, a, f"branch_roller_{i}", (0.42 + i * 0.11, 0.41, 0.705), yaw=pi / 2)
    for side in (-1, 1):
        h.box(a, f"sorter_main_rail_{side}", (side * 0.435, -0.515 if side > 0 else 0, 0.69),
              (0.07, 0.97 if side > 0 else 2.02, 0.14), "blue", bevel=0.014)
        for j, y in enumerate((-0.76, 0.76)):
            _foot(h, a, f"sorter_leg_{side}_{j}", side * 0.43, y, 0.63)
        h.box(a, f"scanner_column_{side}", (side * 0.45, -0.40, 1.12),
              (0.12, 0.15, 1.06), "blue_dark", bevel=0.018)
        h.box(a, f"scanner_inner_lamp_{side}", (side * 0.378, -0.40, 1.19),
              (0.016, 0.08, 0.35), "teal")
    h.box(a, "scanner_head", (0, -0.40, 1.64), (1.03, 0.25, 0.19), "blue", bevel=0.035)
    h.box(a, "scanner_lens_housing", (0, -0.55, 1.60), (0.26, 0.07, 0.11), "ink", bevel=0.014)
    h.box(a, "scanner_lens", (0, -0.59, 1.60), (0.18, 0.011, 0.06), "glass", bevel=0.006)
    _label(h, a, "sort_sign", "SORT", (0, -0.538, 1.71), width=0.32, height=0.095)
    for side in (-1, 1):
        _bolts(h, a, f"scanner_bolts_{side}", side * 0.44, -0.483, (0.83, 1.43))
    for y in (0.0, 0.82):
        h.box(a, f"branch_rail_{y}", (0.86, y, 0.69), (0.94, 0.065, 0.14), "blue", bevel=0.012)
    # 外侧支脚承接横跨两根侧轨的托梁，不能只顶到滚轮下方的空隙。
    h.box(a, "branch_support_crossbeam", (1.24, 0.41, 0.635),
          (0.10, 0.88, 0.10), "blue_dark", bevel=0.012)
    _foot(h, a, "branch_leg", 1.24, 0.41, 0.63)
    _control_panel(h, a, "sort_control", (-0.59, -0.69, 1.07), width=0.26, height=0.28)
    _mail_icon(h, a, "sort_mail", -0.59, -0.763, 0.81, size=0.105)
    _cable(h, a, "scanner_power", [(-0.53, -0.40, 1.57), (-0.56, -0.40, 0.52),
                                    (-0.56, -0.76, 0.52), (-0.56, -0.76, 0.96)])
    _label(h, a, "route_a", "A", (-0.37, 0.95, 0.83), width=0.10, height=0.10)
    _label(h, a, "route_b", "B", (1.24, -0.038, 0.83), width=0.10, height=0.10)
    # 挡板在收回姿态贴合左轨，转轴转动时将包裹推向右侧分流口。
    gate = _empty(a, "pivot_gate", (-0.345, 0.64, 0.96), purpose="rotate_z_diverter")
    parts = [h.box(a, "diverter_blade", (-0.345, 0.27, 0.96),
                   (0.035, 0.73, 0.34), "gold", bevel=0.015),
             h.box(a, "diverter_inset", (-0.366, 0.27, 0.96),
                   (0.007, 0.56, 0.16), "blue_dark", bevel=0.005),
             h.cylinder(a, "diverter_axle", (-0.345, 0.64, 0.96), 0.047, 0.46,
                        "metal", vertices=10)]
    _parent_objects(gate, parts)
    _empty(a, "socket_input", (0, -1.0, 0.75), purpose="scan_input")
    _empty(a, "socket_output", (0, 1.0, 0.75), purpose="route_a_output")
    _empty(a, "socket_output_branch", (1.34, 0.41, 0.75),
           rotation=(0, 0, -pi / 2), purpose="route_b_output")
    a.root["clear_scan_width_m"] = 0.74
    a.root["bed_height_m"] = 0.75
    return a


def _buffer(h):
    a = _asset(h, "mach_buffer_cabinet", "蓄件缓存柜")
    # 上层入口与下层出口分开；每格留出 0.6 米方箱需要的净高和净宽。
    for side in (-1, 1):
        h.box(a, f"cabinet_side_{side}", (side * 0.47, 0, 1.26),
              (0.16, 1.12, 1.77), "blue", bevel=0.035)
        h.box(a, f"cabinet_corner_{side}", (side * 0.48, -0.53, 1.29),
              (0.085, 0.075, 1.79), "blue_dark", bevel=0.011)
        for j, y in enumerate((-0.45, 0.45)):
            _foot(h, a, f"cabinet_foot_{side}_{j}", side * 0.46, y, 0.43)
        h.box(a, f"cabinet_service_cover_{side}", (side * 0.558, 0.12, 1.05),
              (0.023, 0.52, 0.42), "blue_dark", bevel=0.012)
        for i in range(4):
            h.box(a, f"cabinet_vent_{side}_{i}", (side * 0.573, 0.12, 0.94 + i * 0.065),
                  (0.012, 0.38, 0.017), "ink")
        for y in (-0.14, 0.38):
            _bolts(h, a, f"service_bolt_{side}_{y}", side * 0.58, y, (0.87, 1.23), facing="side")
    h.box(a, "cabinet_top", (0, 0, 2.12), (1.11, 1.14, 0.10), "blue_dark", bevel=0.026)
    h.box(a, "cabinet_base", (0, 0, 0.44), (1.09, 1.10, 0.16), "blue_dark", bevel=0.025)
    for level, z in enumerate((0.705, 1.415)):
        for i in range(9):
            _roller(h, a, f"buffer_roller_{level}_{i}", (0, -0.47 + i * 0.1175, z), width=0.76)
        for side in (-1, 1):
            h.box(a, f"buffer_shelf_rail_{level}_{side}", (side * 0.38, 0, z - 0.035),
                  (0.04, 1.06, 0.075), "metal")
        _hazard_band(h, a, f"slot_warning_{level}", (0, -0.553, z - 0.07), width=0.78, height=0.065)
    # 可升降闸门只挡住下层出口，柜体上层保持开口以显露内部结构。
    gate = _empty(a, "pivot_gate", (0, 0.55, 0.83), purpose="translate_z_buffer_release")
    parts = [h.box(a, "buffer_release_bar", (0, 0.55, 0.83), (0.78, 0.05, 0.10), "gold", bevel=0.008)]
    for x in (-0.35, 0.35):
        parts.append(h.box(a, f"release_stem_{x}", (x, 0.55, 0.91),
                           (0.028, 0.05, 0.24), "metal"))
    _parent_objects(gate, parts)
    _label(h, a, "buffer_sign", "BUFFER", (0, -0.58, 2.12), width=0.53, height=0.12)
    _control_panel(h, a, "buffer_control", (0.66, -0.23, 1.45), width=0.24, height=0.31)
    h.beam(a, "control_bracket", (0.52, -0.19, 1.32), (0.66, -0.19, 1.32), 0.045, "metal")
    _cable(h, a, "cabinet_power", [(0.62, -0.13, 1.32), (0.62, 0.32, 1.32),
                                    (0.62, 0.32, 0.56), (0.49, 0.32, 0.56)])
    _mail_icon(h, a, "cabinet_mail", -0.47, -0.578, 1.10, size=0.105)
    for level, z in enumerate((1.09, 1.80)):
        for i, color in enumerate(("gold", "gold", "ink")):
            h.box(a, f"capacity_lamp_{level}_{i}", (0.475, -0.576, z + i * 0.075),
                  (0.044, 0.018, 0.036), color, bevel=0.005)
    _empty(a, "socket_input", (0, -0.58, 1.46), purpose="upper_buffer_input")
    _empty(a, "socket_output", (0, 0.58, 0.75), purpose="lower_buffer_output")
    a.root["clear_slot_width_m"] = 0.78
    a.root["clear_slot_height_m"] = 0.61
    return a


def _pallet(h, a):
    """托盘是完整的独立子树，复制子树即可复用；本体不附带演示货物。"""
    pallet = _empty(a, "pallet", (0, 0, 0.395), purpose="reusable_detachable_pallet")
    objects = []
    for i, x in enumerate((-0.44, -0.22, 0, 0.22, 0.44)):
        objects.append(h.box(a, f"pallet_top_plank_{i}", (x, 0, 0.46),
                             (0.205, 1.16, 0.08), "weathered_wood" if i % 2 else "wood", bevel=0.006))
        for y in (-0.45, 0.45):
            objects.append(h.cylinder(a, f"pallet_nail_{i}_{y}", (x, y, 0.504),
                                      0.011, 0.009, "metal", vertices=6))
    for i, y in enumerate((-0.43, 0, 0.43)):
        objects.append(h.box(a, f"pallet_cross_member_{i}", (0, y, 0.385),
                             (1.12, 0.16, 0.072), "wood_dark"))
        for x in (-0.43, 0, 0.43):
            objects.append(h.box(a, f"pallet_block_{i}_{x}", (x, y, 0.33),
                                 (0.16, 0.16, 0.08), "weathered_dark", bevel=0.006))
    for i, x in enumerate((-0.43, 0, 0.43)):
        objects.append(h.box(a, f"pallet_bottom_runner_{i}", (x, 0, 0.275),
                             (0.16, 1.12, 0.04), "weathered_wood"))
    _parent_objects(pallet, objects)
    return pallet


def _packer(h):
    a = _asset(h, "mach_pallet_packer", "托盘打包机")
    h.box(a, "packer_floor", (0, 0, 0.07), (1.75, 1.68, 0.14), "blue_dark", bevel=0.04)
    h.cylinder(a, "turntable_edge", (0, 0, 0.165), 0.76, 0.12, "metal", vertices=16)
    h.cylinder(a, "turntable_deck", (0, 0, 0.235), 0.71, 0.026, "blue", vertices=16)
    table = _empty(a, "pivot_turntable", (0, 0, 0.235), purpose="rotate_z_wrapping_table")
    pallet = _pallet(h, a)
    _parent_objects(table, [pallet])
    # 龙门上跨而不封住货物空间，双卷带轮与移动横梁展示打包工艺。
    for side in (-1, 1):
        x = side * 0.81
        h.box(a, f"packer_tower_{side}", (x, 0.18, 1.075),
              (0.17, 0.30, 1.94), "blue", bevel=0.024)
        h.box(a, f"packer_slide_rail_{side}", (x - side * 0.097, 0.16, 1.16),
              (0.033, 0.18, 1.68), "metal", bevel=0.004)
        _bolts(h, a, f"tower_bolt_{side}", x, 0.013, (0.35, 1.91))
        h.box(a, f"tower_floor_brace_{side}", (x, 0.18, 0.18),
              (0.31, 0.52, 0.16), "metal", bevel=0.02)
    h.box(a, "packer_header", (0, 0.18, 2.02), (1.78, 0.32, 0.17), "blue_dark", bevel=0.03)
    _label(h, a, "packer_sign", "PACK", (0, 0.005, 2.04), width=0.36, height=0.10)
    _hazard_band(h, a, "packer_header_warning", (0, -0.006, 1.956), 1.15, 0.065)
    carriage = _empty(a, "pivot_packing_head", (0, 0.18, 1.67), purpose="translate_z_strapping_head")
    parts = [h.box(a, "packing_crosshead", (0, 0.18, 1.67), (1.42, 0.20, 0.13),
                   "gold", bevel=0.018),
             h.box(a, "packing_guide", (0, 0.18, 1.58), (0.19, 0.26, 0.12),
                   "metal", bevel=0.012)]
    for side in (-1, 1):
        parts.append(h.box(a, f"slide_carriage_{side}", (side * 0.74, 0.18, 1.67),
                           (0.12, 0.27, 0.26), "blue_dark", bevel=0.01))
    _parent_objects(carriage, parts)
    for side in (-1, 1):
        x = side * 0.99
        h.cylinder(a, f"strap_reel_{side}", (x, 0.21, 0.95), 0.26, 0.13, "gold",
                   vertices=14, rotation=(0, pi / 2, 0))
        h.cylinder(a, f"strap_reel_hub_{side}", (x + side * 0.077, 0.21, 0.95),
                   0.10, 0.025, "metal", vertices=10, rotation=(0, pi / 2, 0))
        h.cylinder(a, f"strap_reel_inner_{side}", (x + side * 0.070, 0.21, 0.95),
                   0.18, 0.018, "tape", vertices=14, rotation=(0, pi / 2, 0))
        _cable(h, a, f"strap_path_{side}", [(x, 0.21, 1.16), (x, 0.21, 1.51),
                                           (side * 0.70, 0.21, 1.51)], width=0.016, mat="tape")
    _control_panel(h, a, "packer_control", (-0.98, -0.15, 1.47), width=0.28, height=0.31)
    _mail_icon(h, a, "packer_mail", 0.81, -0.004, 0.62, size=0.12)
    _hazard_band(h, a, "packer_floor_warning", (0, -0.846, 0.09), 1.55, 0.09)
    _empty(a, "socket_input", (0, -0.87, 0.50), purpose="pallet_loading_edge")
    _empty(a, "socket_output", (0, 0.87, 0.50), purpose="pallet_unloading_edge")
    _empty(a, "socket_pallet", (0, 0, 0.50), purpose="pallet_load_surface")
    return a


def _loading_arm(h):
    a = _asset(h, "mach_loading_arm", "回转装车臂")
    h.box(a, "arm_floor", (0, 0, 0.08), (0.82, 0.82, 0.16), "blue_dark", bevel=0.045)
    for x in (-0.30, 0.30):
        for y in (-0.30, 0.30):
            h.cylinder(a, f"foundation_bolt_{x}_{y}", (x, y, 0.17), 0.035, 0.024,
                       "metal", vertices=6)
    h.cone(a, "arm_pedestal", (0, 0, 0.49), 0.28, 0.21, 0.72, "blue", vertices=10)
    h.cylinder(a, "rotation_ring", (0, 0, 0.84), 0.25, 0.11, "gold", vertices=16)
    h.cylinder(a, "rotation_race", (0, 0, 0.91), 0.19, 0.05, "metal", vertices=12)
    base = _empty(a, "pivot_arm_base", (0, 0, 0.94), purpose="rotate_z_arm_slew")
    elbow = _empty(a, "pivot_arm_elbow", (0, 0.56, 1.51), purpose="rotate_x_arm_elbow")
    wrist = _empty(a, "pivot_arm_wrist", (0, 1.26, 1.21), purpose="rotate_x_gripper_level")
    base_parts = []
    # 双侧臂板与中间空隙，比实心柱更容易读出装车臂的机构层级。
    for side in (-1, 1):
        x = side * 0.115
        base_parts.append(h.beam(a, f"upper_arm_plate_{side}", (x, 0.03, 1.0),
                                 (x, 0.56, 1.51), 0.115, "blue"))
        base_parts.append(h.beam(a, f"upper_arm_inset_{side}", (x + side * 0.06, 0.12, 1.075),
                                 (x + side * 0.06, 0.46, 1.40), 0.045, "gold"))
    base_parts.append(h.cylinder(a, "shoulder_axle", (0, 0.03, 1.0), 0.14, 0.35,
                                "metal", vertices=12, rotation=(0, pi / 2, 0)))
    base_parts.append(h.beam(a, "lift_ram_body", (0, 0.01, 1.18), (0, 0.33, 1.38),
                             0.085, "metal"))
    base_parts.append(h.beam(a, "lift_ram_rod", (0, 0.33, 1.38), (0, 0.51, 1.50),
                             0.043, "concrete_light"))
    _parent_objects(base, base_parts + [elbow])
    elbow_parts = [h.cylinder(a, "elbow_axle", (0, 0.56, 1.51), 0.14, 0.36,
                             "gold", vertices=12, rotation=(0, pi / 2, 0))]
    for side in (-1, 1):
        x = side * 0.10
        elbow_parts.append(h.beam(a, f"forearm_plate_{side}", (x, 0.56, 1.51),
                                  (x, 1.26, 1.21), 0.10, "blue_dark"))
    elbow_parts.append(h.beam(a, "forearm_link", (0, 0.64, 1.57), (0, 1.2, 1.33),
                              0.048, "concrete_light"))
    _parent_objects(elbow, elbow_parts + [wrist])
    gripper_parts = [h.box(a, "gripper_crosshead", (0, 1.26, 1.14),
                          (0.82, 0.18, 0.10), "gold", bevel=0.014),
                     h.cylinder(a, "wrist_axle", (0, 1.26, 1.21), 0.10, 0.26,
                                "metal", vertices=10, rotation=(0, pi / 2, 0))]
    for side in (-1, 1):
        gripper_parts.append(h.box(a, f"gripper_jaw_{side}", (side * 0.39, 1.26, 0.95),
                                  (0.045, 0.17, 0.32), "blue", bevel=0.009))
        gripper_parts.append(h.box(a, f"gripper_pad_{side}", (side * 0.356, 1.26, 0.94),
                                  (0.025, 0.14, 0.15), "ink", bevel=0.007))
    _parent_objects(wrist, gripper_parts)
    # 电缆随对应机械层级运动，避免示范动画留下静止的跨臂悬线。
    before = set(a.collection.objects)
    _cable(h, a, "upper_arm_cable", [(-0.20, 0.02, 0.98), (-0.20, 0.15, 1.30),
                                     (-0.20, 0.49, 1.62), (-0.20, 0.56, 1.54)], width=0.028)
    _parent_objects(base, list(set(a.collection.objects) - before))
    before = set(a.collection.objects)
    _cable(h, a, "forearm_cable", [(-0.18, 0.58, 1.54), (-0.18, 0.87, 1.48),
                                   (-0.18, 1.23, 1.30), (-0.18, 1.26, 1.20)], width=0.025)
    _parent_objects(elbow, list(set(a.collection.objects) - before))
    _control_panel(h, a, "arm_control", (0, -0.24, 0.53), width=0.28, height=0.28)
    _label(h, a, "arm_sign", "LOAD", (0, -0.424, 0.105), width=0.29, height=0.10)
    _mail_icon(h, a, "arm_mail", 0, -0.227, 0.77, size=0.105)
    _empty(a, "socket_input", (0, 1.26, 0.75), purpose="gripper_pickup_bed")
    _empty(a, "socket_output", (0, -1.26, 0.75), rotation=(0, 0, pi),
           purpose="slew_180_drop_bed")
    grip_socket = _empty(a, "socket_grip", (0, 1.26, 0.87), purpose="moving_grip_center")
    _parent_objects(wrist, [grip_socket])
    a.root["clear_gripper_width_m"] = 0.687
    return a


def _launcher(h):
    a = _asset(h, "mach_pneumatic_launcher", "气动发射台")
    for x in (-0.45, 0.45):
        h.box(a, f"launcher_skid_{x}", (x, 0, 0.055), (0.22, 1.20, 0.11),
              "blue_dark", bevel=0.025)
        h.box(a, f"launcher_leg_{x}", (x, 0.11, 0.37), (0.11, 0.40, 0.62),
              "blue", bevel=0.019)
    h.box(a, "launcher_crossbeam", (0, 0.11, 0.53), (1.08, 0.26, 0.13), "metal", bevel=0.019)
    for side in (-1, 1):
        h.cylinder(a, f"pressure_tank_{side}", (side * 0.40, -0.19, 0.29),
                   0.15, 0.85, "blue", vertices=12, rotation=(pi / 2, 0, 0))
        for y in (-0.615, 0.235):
            h.cone(a, f"pressure_tank_cap_{side}_{y}", (side * 0.4, y, 0.29),
                   0.145, 0.095, 0.07, "blue_dark", vertices=12, rotation=(pi / 2, 0, 0))
        for y in (-0.42, 0.06):
            h.box(a, f"tank_strap_{side}_{y}", (side * 0.40, y, 0.29),
                  (0.33, 0.045, 0.34), "metal", bevel=0.02)
    # 发射舱为开放矩形滑槽，能够容纳 0.6 米方箱，不做狭窄炮管。
    barrel = _empty(a, "pivot_launch_barrel", (0, 0.12, 0.75), purpose="rotate_x_launch_elevation")
    # 底板压到轮轴下方，滚轮顶面保持 0.75 米；避免静态板面把滚轮完全遮住。
    parts = [h.box(a, "launch_bed", (0, 0.04, 0.66), (0.75, 1.46, 0.08), "metal", bevel=0.02)]
    for side in (-1, 1):
        parts.append(h.box(a, f"launch_sidewall_{side}", (side * 0.40, 0.04, 0.88),
                           (0.07, 1.46, 0.34), "blue", bevel=0.023))
        parts.append(h.box(a, f"launch_lip_{side}", (side * 0.40, 0.04, 1.06),
                           (0.082, 1.50, 0.045), "gold", bevel=0.006))
        parts.append(h.cylinder(a, f"launch_trunnion_{side}", (side * 0.45, 0.12, 0.75),
                                0.16, 0.12, "gold", vertices=12, rotation=(0, pi / 2, 0)))
    for i in range(11):
        parts.extend(_roller(h, a, f"launch_roller_{i}", (0, -0.62 + i * 0.126, 0.71),
                             width=0.72, radius=0.04))
    parts.append(_arrow(h, a, "launch_arrow", (0, 0.55, 0.758), scale=0.75))
    _parent_objects(barrel, parts)
    pusher = _empty(a, "pivot_launch_pusher", (0, -0.56, 0.88), purpose="translate_y_pneumatic_pusher")
    pusher_parts = [h.box(a, "pusher_plate", (0, -0.56, 0.91), (0.70, 0.065, 0.30),
                         "gold", bevel=0.017),
                    h.box(a, "pusher_pad", (0, -0.52, 0.91), (0.59, 0.018, 0.20), "ink", bevel=0.009)]
    _parent_objects(pusher, pusher_parts)
    _parent_objects(barrel, [pusher])
    h.cylinder(a, "pneumatic_ram", (0, -0.32, 0.61), 0.075, 0.68,
               "metal", vertices=10, rotation=(pi / 2, 0, 0))
    h.cylinder(a, "pneumatic_rod", (0, 0.11, 0.61), 0.031, 0.24,
               "concrete_light", vertices=8, rotation=(pi / 2, 0, 0))
    _control_panel(h, a, "launch_control", (-0.67, -0.31, 0.72), width=0.26, height=0.29)
    h.beam(a, "launch_control_bracket", (-0.44, -0.23, 0.60), (-0.66, -0.23, 0.62), 0.05, "metal")
    h.cylinder(a, "pressure_gauge_rim", (0.64, -0.22, 0.70), 0.10, 0.045,
               "metal", vertices=12, rotation=(pi / 2, 0, 0))
    h.cylinder(a, "pressure_gauge_face", (0.64, -0.246, 0.70), 0.083, 0.012,
               "cream", vertices=12, rotation=(pi / 2, 0, 0))
    h.beam(a, "pressure_gauge_needle", (0.64, -0.258, 0.70), (0.68, -0.258, 0.744), 0.009, "red")
    _cable(h, a, "pressure_hose", [(0.4, -0.59, 0.33), (0.64, -0.59, 0.33),
                                   (0.64, -0.39, 0.61), (0.64, -0.22, 0.63)])
    _label(h, a, "launcher_sign", "AIR", (0, -0.637, 0.36), width=0.30, height=0.12)
    _hazard_band(h, a, "launcher_warning", (0, -0.704, 0.71), width=0.72, height=0.07)
    _empty(a, "socket_input", (0, -0.69, 0.75), purpose="launch_tray_input")
    output = _empty(a, "socket_output", (0, 0.79, 0.75), purpose="moving_launch_muzzle")
    _parent_objects(barrel, [output])
    a.root["clear_launch_width_m"] = 0.73
    return a


def _receiver(h):
    a = _asset(h, "mach_receiver_basket", "气动发射台·接货篮",
               "mach_pneumatic_launcher", "receiver")
    for x in (-0.48, 0.48):
        for y in (-0.40, 0.40):
            _foot(h, a, f"basket_support_{x}_{y}", x, y, 0.66)
    h.box(a, "basket_cushion", (0, 0, 0.695), (0.92, 0.93, 0.10), "olive", bevel=0.035)
    for i in range(5):
        h.box(a, f"cushion_channel_{i}", (-0.34 + i * 0.17, 0, 0.752),
              (0.018, 0.86, 0.01), "leaf", bevel=0.003)
    # 左右格栅与后倾挡架吸收来件，入口敞开，出口底层接回标准输送高度。
    for side in (-1, 1):
        x = side * 0.50
        h.box(a, f"basket_bottom_rail_{side}", (x, 0, 0.73), (0.055, 1.03, 0.10), "blue", bevel=0.013)
        h.box(a, f"basket_top_rail_{side}", (x, 0.14, 1.17), (0.055, 0.75, 0.06), "gold", bevel=0.008)
        for i in range(5):
            y = -0.21 + i * 0.175
            h.beam(a, f"basket_side_bar_{side}_{i}", (x, y, 0.77), (x, y, 1.14), 0.034, "blue_dark")
    for i in range(6):
        x = -0.43 + i * 0.172
        h.beam(a, f"basket_back_bar_{i}", (x, 0.49, 0.77), (x, 0.65, 1.29), 0.038, "blue_dark")
    h.beam(a, "basket_back_top", (-0.51, 0.65, 1.29), (0.51, 0.65, 1.29), 0.065, "gold")
    h.beam(a, "basket_back_mid", (-0.51, 0.57, 1.04), (0.51, 0.57, 1.04), 0.043, "blue")
    h.box(a, "basket_entry_roll", (0, -0.50, 0.72), (1.03, 0.11, 0.09), "blue", bevel=0.02)
    _hazard_band(h, a, "basket_warning", (0, -0.561, 0.73), width=0.89, height=0.075)
    _label(h, a, "basket_sign", "CATCH", (0, -0.562, 0.53), width=0.40, height=0.13)
    h.beam(a, "basket_sign_support", (0, -0.50, 0.35), (0, -0.50, 0.68), 0.04, "metal")
    _empty(a, "socket_input", (0, -0.56, 0.85), purpose="airborne_catch_target")
    _empty(a, "socket_output", (0, 0.56, 0.75), purpose="manual_unload_position")
    return a


def build_industrial(h):
    """返回六件主道具与三件组装变体；所有模型保持米制与接地原点。"""
    return [_conveyor(h), _sorter(h), _buffer(h), _packer(h), _loading_arm(h),
            _launcher(h), _conveyor_corner(h),
            _conveyor(h, "mach_conveyor_ramp", rise=0.35, variant="ramp"), _receiver(h)]
