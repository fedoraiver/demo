"""魔法快递道具的原创低多边形制作源；只建模，不装配游戏或导出文件。"""

import math

import bpy


def _item(h, item_id, display_name, surface_normal=None):
    """每件道具保留稳定业务名称，平面符纸额外声明可见面方向。"""
    asset = h.asset(item_id, "items/magic")
    asset.root["display_name_zh"] = display_name
    asset.root["item_id"] = item_id
    asset.root["variant"] = "default"
    if surface_normal:
        asset.root["surface_normal"] = surface_normal
    return asset


def _socket(asset, name, location, rotation=(0, 0, 0)):
    """挂点采用空节点，后续效果与装备装配无需猜测网格名称。"""
    obj = bpy.data.objects.new(asset.root.name + "__" + name, None)
    asset.collection.objects.link(obj)
    obj.parent = asset.root
    obj.location = location
    obj.rotation_euler = rotation
    obj.empty_display_type = "ARROWS"
    obj.empty_display_size = 0.025
    obj["socket_role"] = name.removeprefix("socket_")
    return obj


def _polygon(h, asset, name, points, bottom, thickness, material):
    """沿 +Z 挤出轮廓，显式维持外向绕序，邮票侧面有真实厚度。"""
    points = list(points)
    area = sum(
        points[i][0] * points[(i + 1) % len(points)][1]
        - points[(i + 1) % len(points)][0] * points[i][1]
        for i in range(len(points))
    )
    if area < 0:
        points.reverse()
    count = len(points)
    vertices = [(x, y, bottom) for x, y in points]
    vertices.extend((x, y, bottom + thickness) for x, y in points)
    faces = [tuple(reversed(range(count))), tuple(range(count, 2 * count))]
    faces.extend((i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count))
    return h.mesh(asset, name, vertices, faces, material)


def _front_polygon(h, asset, name, points, y, thickness, material):
    """平面轮廓旋至 XZ 面，表面法线为 -Y，避免正面图案被背面剔除。"""
    obj = _polygon(h, asset, name, points, 0, thickness, material)
    obj.rotation_euler.x = math.pi / 2
    obj.location.y = y
    return obj


def _ring(h, asset, name, outer, inner, depth, material, location=(0, 0, 0), rotation=(0, 0, 0), segments=24):
    """用封闭环形网格制作卷芯、邮戳和金属圈，不用实心圆柱冒充孔洞。"""
    vertices = []
    for z, radius in ((0, outer), (0, inner), (depth, outer), (depth, inner)):
        vertices.extend((radius * math.cos(i * math.tau / segments), radius * math.sin(i * math.tau / segments), z) for i in range(segments))
    faces = []
    for i in range(segments):
        j = (i + 1) % segments
        faces.extend(((i, j, j + 2 * segments, i + 2 * segments),
                      (i + segments, i + 3 * segments, j + 3 * segments, j + segments),
                      (i, i + segments, j + segments, j),
                      (i + 2 * segments, j + 2 * segments, j + 3 * segments, i + 3 * segments)))
    obj = h.mesh(asset, name, vertices, faces, material)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


def _lathe(h, asset, name, profile, material, segments=12, squash=1):
    """连续截面形成有肩、腰、底和颈的瓶身，保留低多边形切面。"""
    vertices = []
    for z, radius in profile:
        vertices.extend((radius * math.cos(i * math.tau / segments), squash * radius * math.sin(i * math.tau / segments), z) for i in range(segments))
    faces = [tuple(reversed(range(segments)))]
    for row in range(len(profile) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            faces.append((row * segments + i, row * segments + j, (row + 1) * segments + j, (row + 1) * segments + i))
    faces.append(tuple(range((len(profile) - 1) * segments, len(profile) * segments)))
    return h.mesh(asset, name, vertices, faces, material)


def _line(h, asset, name, points, width, material):
    """少量折线保留印刷和绑绳的几何形状，所有颜色来自共享材质。"""
    for i, (start, end) in enumerate(zip(points, points[1:])):
        h.beam(asset, f"{name}_{i:02d}", start, end, width, material)


def _glow(h, obj):
    """独立的微光材质只用于实体符文，按节点类型查找以兼容本地化界面。"""
    name = "CI_magic_rune"
    material = bpy.data.materials.get(name)
    if material is None:
        material = h.material("teal").copy()
        material.name = name
        shader = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
        shader.inputs["Emission Color"].default_value = (*material.diffuse_color[:3], 1)
        shader.inputs["Emission Strength"].default_value = 0.45
    obj.data.materials.clear()
    obj.data.materials.append(material)


def _stamp_outline(width=0.14, height=0.18, nx=8, ny=10):
    """纸边的半圆缺口是真实穿孔轮廓，而非涂在矩形上的圆点。"""
    half_x, half_y = width / 2, height / 2
    radius = 0.0031
    points = [(-half_x, -half_y)]
    for i in range(nx):
        center = -half_x + width * (i + 0.5) / nx
        points.extend((center - radius * math.cos(j * math.pi / 4), -half_y + radius * math.sin(j * math.pi / 4)) for j in range(5))
    points.append((half_x, -half_y))
    for i in range(ny):
        center = -half_y + height * (i + 0.5) / ny
        points.extend((half_x - radius * math.sin(j * math.pi / 4), center - radius * math.cos(j * math.pi / 4)) for j in range(5))
    points.append((half_x, half_y))
    for i in range(nx):
        center = half_x - width * (i + 0.5) / nx
        points.extend((center + radius * math.cos(j * math.pi / 4), half_y - radius * math.sin(j * math.pi / 4)) for j in range(5))
    points.append((-half_x, half_y))
    for i in range(ny):
        center = half_y - height * (i + 0.5) / ny
        points.extend((-half_x + radius * math.sin(j * math.pi / 4), center + radius * math.cos(j * math.pi / 4)) for j in range(5))
    return points


def _star(h, asset, name, center, radius, material, thickness=0.001):
    points = []
    for i in range(8):
        angle = i * math.pi / 4
        r = radius if i % 2 == 0 else radius * 0.28
        points.append((center[0] + r * math.cos(angle), center[1] + r * math.sin(angle)))
    return _polygon(h, asset, name, points, center[2], thickness, material)


def _postmark(h, asset, center, size, height, prefix="postmark"):
    """圆形邮局销戳搭配三道短波纹，保持快递主题而不依赖字体贴图。"""
    _ring(h, asset, prefix + "_circle", size, size - 0.0012, 0.0008, "ink", (center[0], center[1], height), segments=20)
    for row in range(3):
        points = [(center[0] + size * 0.55 + i * size * 0.29,
                   center[1] + (row - 1) * size * 0.30 + math.sin(i * math.pi / 2) * size * 0.065,
                   height + 0.0005) for i in range(6)]
        _line(h, asset, f"{prefix}_wave_{row}", points, 0.0011, "ink")


def _feather_stamp(h):
    asset = _item(h, "magic_feather_stamp", "羽毛邮票", "+Z")
    _polygon(h, asset, "perforated_paper", _stamp_outline(), 0, 0.004, "cream")
    h.box(asset, "blue_print", (0, 0, 0.0045), (0.118, 0.155, 0.001), "blue", bevel=0.002)
    h.box(asset, "gold_inner_frame", (0, 0.008, 0.0054), (0.109, 0.129, 0.0008), "gold", bevel=0.001)
    h.box(asset, "navy_feather_field", (0, 0.008, 0.0061), (0.102, 0.122, 0.0008), "navy", bevel=0.001)
    # 一片带锯齿羽枝的实体浮雕，是邮票在小尺寸下的主识别图案。
    feather = [(-0.026, -0.041), (-0.032, -0.027), (-0.033, -0.010), (-0.024, 0.016),
               (-0.010, 0.039), (0.021, 0.060), (0.028, 0.038), (0.021, 0.017),
               (0.014, 0.007), (0.014, -0.002), (0.001, -0.010), (0.001, -0.020),
               (-0.013, -0.028), (-0.012, -0.033)]
    _polygon(h, asset, "feather_relief", feather, 0.0067, 0.0022, "cream")
    _line(h, asset, "gold_quill", [(-0.034, -0.058, 0.0093), (-0.020, -0.028, 0.0093), (0.005, 0.025, 0.0093), (0.021, 0.053, 0.0093)], 0.002, "gold")
    for i in range(5):
        t = i / 4
        x, y = -0.019 + t * 0.032, -0.028 + t * 0.074
        _line(h, asset, f"feather_barb_{i}", [(x - 0.012, y + 0.004, 0.0094), (x, y, 0.0094), (x + 0.011, y - 0.005, 0.0094)], 0.0009, "gold")
    _postmark(h, asset, (-0.033, -0.056), 0.012, 0.0102)
    _star(h, asset, "upper_glint", (-0.034, 0.052, 0.0068), 0.008, "gold")
    _star(h, asset, "lower_glint", (0.038, -0.034, 0.0068), 0.006, "gold")
    for i in range(3):
        h.box(asset, f"air_rate_dash_{i}", (-0.032 + i * 0.011, 0.071, 0.006), (0.006, 0.002, 0.0009), "cream")
    _socket(asset, "socket_attach", (0, 0, 0))
    _socket(asset, "socket_effect", (0, 0.018, 0.011))
    return asset


def _tape_tail(h, asset):
    """末端胶带从卷边弯出并落在地上，形成可辨认的撕取片。"""
    path = [(0.067, 0.148), (0.091, 0.129), (0.111, 0.090), (0.122, 0.037), (0.141, 0.004)]
    vertices = []
    for x, z in path:
        vertices.extend(((x, -0.024, z), (x, 0.024, z), (x, 0.024, z + 0.0025), (x, -0.024, z + 0.0025)))
    faces = [(3, 2, 1, 0)]
    for i in range(len(path) - 1):
        base, nxt = i * 4, (i + 1) * 4
        faces.extend(((base, base + 1, nxt + 1, nxt), (base + 1, base + 2, nxt + 2, nxt + 1),
                      (base + 2, base + 3, nxt + 3, nxt + 2), (base + 3, base, nxt, nxt + 3)))
    faces.append(tuple(range((len(path) - 1) * 4, len(path) * 4)))
    h.mesh(asset, "peeled_tape_tail", vertices, faces, "purple")
    for row in range(3):
        h.beam(asset, f"tail_time_dash_{row}", (0.106 + row * 0.007, -0.010, 0.100 - row * 0.020), (0.106 + row * 0.007, 0.010, 0.100 - row * 0.020), 0.0023, "gold")


def _stasis_tape(h):
    asset = _item(h, "magic_stasis_tape", "停时胶带", "-Y")
    front_rotation = (math.pi / 2, 0, 0)
    _ring(h, asset, "purple_tape_winding", 0.090, 0.044, 0.064, "purple", (0, 0.032, 0.090), front_rotation, 32)
    _ring(h, asset, "hollow_paper_core", 0.0445, 0.035, 0.068, "cream", (0, 0.034, 0.090), front_rotation, 24)
    for sign in (-1, 1):
        y = sign * 0.033
        rotation = front_rotation if sign < 0 else (-math.pi / 2, 0, 0)
        _ring(h, asset, f"gold_roll_rim_{sign}", 0.089, 0.084, 0.002, "gold", (0, y, 0.090), rotation, 32)
        _ring(h, asset, f"winding_line_{sign}", 0.070, 0.068, 0.0008, "blue_dark", (0, y + sign * 0.002, 0.090), rotation, 28)
    # 沙漏在孔洞上方，暂停符号在侧边，卷芯始终保持贯通可见。
    _front_polygon(h, asset, "hourglass_top", [(-0.019, 0.158), (0.019, 0.158), (0.003, 0.142), (-0.003, 0.142)], -0.0355, 0.0015, "gold")
    _front_polygon(h, asset, "hourglass_bottom", [(-0.003, 0.140), (0.003, 0.140), (0.019, 0.124), (-0.019, 0.124)], -0.0355, 0.0015, "cream")
    for z in (0.121, 0.161):
        h.box(asset, f"hourglass_frame_{z}", (0, -0.038, z), (0.042, 0.003, 0.003), "gold")
    for x in (-0.018, 0.018):
        h.box(asset, f"hourglass_post_{x}", (x, -0.037, 0.141), (0.002, 0.002, 0.037), "blue_dark")
    for x in (-0.067, -0.057):
        h.box(asset, f"pause_bar_{x}", (x, -0.037, 0.084), (0.005, 0.002, 0.023), "gold", bevel=0.0008)
    for i in range(6):
        angle = math.pi + i * math.pi / 5
        radius = 0.080
        h.box(asset, f"clock_tick_{i}", (radius * math.cos(angle), -0.038, 0.090 + radius * math.sin(angle)), (0.004, 0.002, 0.009), "cream", rotation=(0, -angle - math.pi / 2, 0))
    _tape_tail(h, asset)
    _socket(asset, "socket_attach", (0, 0, 0.09), front_rotation)
    _socket(asset, "socket_effect", (0, -0.039, 0.141), front_rotation)
    return asset


def _fold_stamp(h):
    asset = _item(h, "magic_fold_stamp", "折角邮票", "+Z")
    _polygon(h, asset, "perforated_paper", _stamp_outline(), 0, 0.004, "cream")
    h.box(asset, "purple_print_border", (0, 0, 0.0045), (0.120, 0.156, 0.001), "purple", bevel=0.002)
    h.box(asset, "teal_fold_field", (0, 0.002, 0.0053), (0.105, 0.131, 0.0008), "teal", bevel=0.001)
    # 折纸浮雕只用一个封闭网格；底面严格低于折面，避免反向四边面穿过浮雕。
    left, front, right, back = (-0.036, 0, 0.016), (0, -0.025, 0.0095), (0.036, 0, 0.016), (0, 0.028, 0.024)
    ridge = (0, 0.005, 0.032)
    vertices = [left, front, right, back, ridge]
    vertices.extend((point[0], point[1], 0.007) for point in (left, front, right, back))
    faces = [(0, 1, 4), (0, 4, 3), (1, 2, 4), (4, 2, 3),
             (5, 6, 1, 0), (6, 7, 2, 1), (7, 8, 3, 2), (8, 5, 0, 3), (8, 7, 6, 5)]
    relief = h.mesh(asset, "origami_fold_relief", vertices, faces, "cream")
    relief.data.materials.append(h.material("gold"))
    relief.data.materials.append(h.material("blue_dark"))
    # 奶油、金色、蓝色分别占据不同坡面的三角折纸，侧缘统一蓝色表明纸厚。
    for polygon, material_index in zip(relief.data.polygons, (0, 2, 1, 0, 2, 2, 2, 2, 2)):
        polygon.material_index = material_index
    _line(h, asset, "origami_center_crease", [front, ridge, back], 0.0015, "blue_dark")
    # 抬起一角露出纸张反面，便于辨认折角机制并形成不同于羽毛邮票的剪影。
    corner_vertices = [(0.034, 0.089, 0.005), (0.070, 0.053, 0.005), (0.040, 0.058, 0.026),
                       (0.034, 0.089, 0.0063), (0.070, 0.053, 0.0063), (0.040, 0.058, 0.0273)]
    h.mesh(asset, "lifted_fold_corner", corner_vertices, [(2, 1, 0), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)], "white")
    h.beam(asset, "corner_hinge", (0.034, 0.089, 0.0066), (0.070, 0.053, 0.0066), 0.0016, "gold")
    for i in range(3):
        _polygon(h, asset, f"shrinking_corner_{i}", [(0.009 + i * 0.007, -0.053 + i * 0.003), (0.004 + i * 0.007, -0.048 + i * 0.003), (0.004 + i * 0.007, -0.058 + i * 0.003)], 0.0061, 0.0012, "cream")
    _postmark(h, asset, (-0.031, -0.058), 0.011, 0.0078)
    _star(h, asset, "fold_glint", (-0.031, 0.048, 0.0063), 0.008, "gold")
    _socket(asset, "socket_attach", (0, 0, 0))
    _socket(asset, "socket_effect", (0, 0.005, 0.033))
    return asset


def _turn_sticker(h):
    asset = _item(h, "magic_turn_sticker", "地板换向贴", "+Z")
    corners = [(-0.295, -0.325), (0.295, -0.325), (0.325, -0.295), (0.325, 0.295), (0.295, 0.325), (-0.295, 0.325), (-0.325, 0.295), (-0.325, -0.295)]
    _polygon(h, asset, "thick_sticker_backing", corners, 0, 0.010, "cream")
    _polygon(h, asset, "gold_boundary", [(x * 0.97, y * 0.97) for x, y in corners], 0.010, 0.0025, "gold")
    _polygon(h, asset, "teal_route_field", [(x * 0.90, y * 0.90) for x, y in corners], 0.0125, 0.002, "teal")
    arrow = [(-0.190, -0.225), (-0.090, -0.225), (-0.090, -0.050), (0.100, -0.050),
             (0.100, -0.120), (0.250, 0.020), (0.100, 0.160), (0.100, 0.090), (-0.190, 0.090)]
    _polygon(h, asset, "turn_arrow_shadow", [(x * 1.045, y * 1.045) for x, y in arrow], 0.0145, 0.0015, "blue_dark")
    _polygon(h, asset, "right_angle_arrow", arrow, 0.016, 0.0018, "white")
    # 边界短虚线是路线标识，旁边的几何文字说明固定九十度转向。
    for sign in (-1, 1):
        for i in range(6):
            coordinate = -0.225 + i * 0.090
            h.box(asset, f"edge_dash_x_{sign}_{i}", (coordinate, sign * 0.275, 0.015), (0.028, 0.007, 0.001), "blue_dark")
            h.box(asset, f"edge_dash_y_{sign}_{i}", (sign * 0.275, coordinate, 0.015), (0.007, 0.028, 0.001), "blue_dark")
    # 七段几何数字避免字体曲线细分让一张低多边形地贴产生数千面。
    digit_segments = {
        "a": (0, 0.024, 0.025, 0.004), "b": (0.012, 0.012, 0.004, 0.018),
        "c": (0.012, -0.012, 0.004, 0.018), "d": (0, -0.024, 0.025, 0.004),
        "e": (-0.012, -0.012, 0.004, 0.018), "f": (-0.012, 0.012, 0.004, 0.018),
        "g": (0, 0, 0.025, 0.004),
    }
    for digit, center_x, parts in ((9, 0.100, "abcdfg"), (0, 0.140, "abcdef")):
        for part in parts:
            x, y, width, height = digit_segments[part]
            h.box(asset, f"angle_digit_{digit}_{part}", (center_x + x, -0.190 + y, 0.017), (width, height, 0.0015), "gold")
    _ring(h, asset, "degree_mark", 0.007, 0.0045, 0.0013, "gold", (0.171, -0.171, 0.017), segments=12)
    _ring(h, asset, "postal_circuit", 0.035, 0.032, 0.0013, "blue_dark", (-0.150, 0.200, 0.015), segments=24)
    _star(h, asset, "postal_circuit_star", (-0.150, 0.200, 0.017), 0.020, "gold", 0.001)
    # 单个卷起的边角保留贴纸质感，厚度和图案可从斜视角辨认。
    h.mesh(asset, "peeled_corner", [(0.242, 0.315, 0.014), (0.315, 0.242, 0.014), (0.274, 0.274, 0.039),
                                    (0.242, 0.315, 0.0158), (0.315, 0.242, 0.0158), (0.274, 0.274, 0.0408)],
           [(2, 1, 0), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)], "cream")
    _socket(asset, "socket_attach", (0, 0, 0))
    _socket(asset, "socket_effect", (0.015, 0.020, 0.023))
    return asset


def _slip_mist(h):
    asset = _item(h, "magic_slip_mist", "溜溜雾瓶", "-Y")
    _lathe(h, asset, "pear_flask", [(0.000, 0.040), (0.012, 0.059), (0.035, 0.071), (0.095, 0.078),
                                   (0.152, 0.065), (0.197, 0.042), (0.215, 0.024), (0.247, 0.024)], "glass", 12, 0.86)
    _ring(h, asset, "purple_base_band", 0.062, 0.056, 0.008, "purple", (0, 0, 0.011), segments=12)
    for sign in (-1, 1):
        # 两道保护框沿瓶肩弯折，喷雾瓶有明显的实验器具轮廓。
        _line(h, asset, f"brass_cage_{sign}", [(sign * 0.047, -0.029, 0.014), (sign * 0.074, -0.035, 0.086),
                                              (sign * 0.057, -0.031, 0.168), (sign * 0.024, -0.016, 0.218)], 0.004, "gold")
    h.box(asset, "purple_front_label", (0, -0.0675, 0.102), (0.068, 0.004, 0.086), "purple", bevel=0.006)
    h.box(asset, "gold_label_top", (0, -0.070, 0.141), (0.049, 0.002, 0.002), "gold")
    h.box(asset, "gold_label_bottom", (0, -0.070, 0.063), (0.049, 0.002, 0.002), "gold")
    for row in range(3):
        points = [(i * 0.008 - 0.028, -0.071, 0.083 + row * 0.018 + math.sin(i * math.pi / 2) * 0.003) for i in range(8)]
        _line(h, asset, f"slippery_waves_{row}", points, 0.002, "cream")
    h.cylinder(asset, "threaded_neck_collar", (0, 0, 0.250), 0.031, 0.016, "gold", vertices=12)
    for z in (0.243, 0.249, 0.255):
        _ring(h, asset, f"collar_thread_{z}", 0.032, 0.028, 0.002, "wood_dark", (0, 0, z), segments=12)
    h.cylinder(asset, "pump_stem", (0, 0, 0.275), 0.012, 0.034, "metal", vertices=8)
    h.box(asset, "spray_pump_head", (0, -0.014, 0.296), (0.052, 0.067, 0.020), "gold", bevel=0.004)
    h.cylinder(asset, "spray_nozzle", (0, -0.050, 0.290), 0.010, 0.020, "metal", vertices=8, rotation=(math.pi / 2, 0, 0))
    h.cylinder(asset, "nozzle_opening", (0, -0.061, 0.290), 0.006, 0.001, "ink", vertices=8, rotation=(math.pi / 2, 0, 0))
    h.box(asset, "thumb_pad", (0, 0.001, 0.308), (0.039, 0.038, 0.005), "purple", bevel=0.003)
    # 侧面的空心挂环和系绳不遮住标签；药剂不额外生成烟雾粒子。
    _ring(h, asset, "neck_loop", 0.023, 0.017, 0.004, "gold", (0.045, 0.008, 0.233), (math.pi / 2, 0, 0), segments=16)
    _line(h, asset, "neck_loop_tie", [(0.020, 0.005, 0.246), (0.038, 0.003, 0.250), (0.045, 0.002, 0.242)], 0.003, "wood_dark")
    _socket(asset, "socket_attach", (0, 0, 0.121))
    _socket(asset, "socket_effect", (0, -0.062, 0.290), (math.pi / 2, 0, 0))
    return asset


def _wind_bottle(h):
    asset = _item(h, "magic_wind_bottle", "口袋风瓶", "-Y")
    # 高腰扁瓶与梨形喷雾瓶具有不同的体积、瓶肩和开口轮廓。
    _lathe(h, asset, "faceted_wind_canteen", [(0.000, 0.046), (0.014, 0.063), (0.050, 0.084), (0.145, 0.077),
                                             (0.220, 0.052), (0.264, 0.029), (0.306, 0.027)], "blue", 12, 0.73)
    _lathe(h, asset, "gold_foot", [(0.002, 0.048), (0.010, 0.064), (0.019, 0.066)], "gold", 12, 0.73)
    # 四条金属框贴合瓶身截面，竖向轮廓和基底共同表达耐用的随身容器。
    for sign in (-1, 1):
        for front in (-1, 1):
            _line(h, asset, f"bottle_cage_{sign}_{front}", [(sign * 0.040, front * 0.025, 0.014),
                                                          (sign * 0.069, front * 0.035, 0.067),
                                                          (sign * 0.062, front * 0.033, 0.158),
                                                          (sign * 0.038, front * 0.021, 0.235),
                                                          (sign * 0.021, front * 0.014, 0.284)], 0.0045, "gold")
    h.box(asset, "cream_wind_label", (0, -0.059, 0.126), (0.071, 0.004, 0.104), "cream", bevel=0.005)
    # 风纹以三条独立卷曲几何呈现；微光留在标签上，不混入环境飘尘。
    for row in range(3):
        z = 0.098 + row * 0.023
        points = [(-0.030, -0.063, z), (-0.011, -0.063, z), (0.015, -0.063, z + 0.001),
                  (0.025, -0.063, z + 0.009), (0.019, -0.063, z + 0.016), (0.009, -0.063, z + 0.013)]
        _line(h, asset, f"wind_scroll_{row}", points, 0.0023, "teal")
    h.cylinder(asset, "neck_brass_cuff", (0, 0, 0.295), 0.034, 0.019, "gold", vertices=12)
    for z in (0.282, 0.288, 0.304):
        _ring(h, asset, f"neck_rope_turn_{z}", 0.035, 0.031, 0.004, "wood_dark", (0, 0, z), segments=16)
    # 偏向前方的哨嘴、软木塞与提环形成风瓶的独特识别部分。
    h.cone(asset, "whistle_spout", (0, -0.040, 0.315), 0.024, 0.016, 0.071, "gold", vertices=8, rotation=(math.pi / 2, 0, 0))
    h.cylinder(asset, "whistle_mouth", (0, -0.077, 0.315), 0.014, 0.005, "blue_dark", vertices=8, rotation=(math.pi / 2, 0, 0))
    h.box(asset, "whistle_slot", (0, -0.080, 0.315), (0.017, 0.001, 0.005), "ink", bevel=0.001)
    h.cylinder(asset, "cork_neck", (0, 0, 0.327), 0.024, 0.034, "wood", vertices=10)
    h.cone(asset, "cork_stop", (0, 0, 0.355), 0.025, 0.029, 0.024, "wood_dark", vertices=10)
    h.cylinder(asset, "stopper_gold_top", (0, 0, 0.370), 0.030, 0.006, "gold", vertices=10)
    _ring(h, asset, "stopper_carry_loop", 0.026, 0.018, 0.007, "gold", (0, 0.0035, 0.394), (math.pi / 2, 0, 0), segments=16)
    h.box(asset, "loop_base", (0, 0, 0.373), (0.020, 0.014, 0.010), "gold", bevel=0.002)
    _line(h, asset, "knotted_cork_cord", [(0.025, 0.014, 0.305), (0.036, 0.012, 0.314), (0.043, 0.014, 0.293),
                                        (0.039, 0.013, 0.267), (0.048, 0.011, 0.259)], 0.003, "wood_dark")
    rune = _front_polygon(h, asset, "fx_static_wind_rune", [(-0.009, 0.204), (0.000, 0.214), (0.009, 0.204), (0.000, 0.199)], -0.041, 0.0015, "teal")
    _glow(h, rune)
    _socket(asset, "socket_attach", (0, 0, 0.145))
    _socket(asset, "socket_effect", (0, -0.083, 0.315), (math.pi / 2, 0, 0))
    return asset


def build_magic(h):
    """构建六件独立魔法资产，米制 Z-up，业务根均位于支撑底面。"""
    return [_feather_stamp(h), _stasis_tape(h), _fold_stamp(h), _turn_sticker(h), _slip_mist(h), _wind_bottle(h)]
