"""角色能力道具：米制低多边形模型、成对子根与后续装备挂点。"""

from math import cos, pi, sin

import bmesh
import bpy


CATEGORY = "items/equipment"


def _new(h, name, display_name, slot, variant="default", item_id=None):
    """根实体只记录资产身份；此阶段不实现任何装备或物理玩法。"""
    a = h.asset(name, CATEGORY)
    a.root["display_name_zh"] = display_name
    a.root["item_id"] = item_id or name
    a.root["variant"] = variant
    a.root["equip_slot"] = slot
    a.root["forward_axis"] = "+Y"
    a.root["source_character"] = "chr_courier"
    a.root["character_height_m"] = 1.91
    a.root["asset_notes"] = "Low-poly equipment, Z-up, +Y forward, ground origin, static mesh"
    return a


def _empty(a, name, location=(0, 0, 0), parent=None):
    obj = bpy.data.objects.new(a.root.name + "__" + name, None)
    a.collection.objects.link(obj)
    obj.parent = parent or a.root
    obj.location = location
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = .04
    return obj


def _under(obj, part):
    """几何按子根局部坐标创建；配对装备未来可以独立挂到左右骨骼。"""
    obj.parent = part
    return obj


def _loft(h, a, name, rings, material, parent=None):
    """封闭的等点数轮廓放样；保持厚度和硬棱，避免单面布片导出后消失。"""
    vertices = [point for ring in rings for point in ring]
    count = len(rings[0])
    faces = [tuple(range(count - 1, -1, -1))]
    for level in range(len(rings) - 1):
        lower = level * count
        upper = (level + 1) * count
        for i in range(count):
            following = (i + 1) % count
            faces.append((lower + i, lower + following, upper + following, upper + i))
    faces.append(tuple((len(rings) - 1) * count + i for i in range(count)))
    obj = h.mesh(a, name, vertices, faces, material)
    return _under(obj, parent) if parent else obj


def _oval_ring(width, front, rear, z, center_y=0):
    """八边鞋楦：宽鞋头、收窄鞋跟，轮廓比球体或方盒更接近工作靴。"""
    return [(width * .34, front + center_y, z),
            (-width * .34, front + center_y, z),
            (-width * .50, front * .68 + center_y, z),
            (-width * .50, rear * .65 + center_y, z),
            (-width * .34, rear + center_y, z),
            (width * .34, rear + center_y, z),
            (width * .50, rear * .65 + center_y, z),
            (width * .50, front * .68 + center_y, z)]


def _cuff(h, a, name, center, radius_x, radius_y, thickness, height, material, parent=None):
    """开放的八边袖口／鞋口，内壁和顶缘都有实体厚度。"""
    x, y, z = center
    vertices = []
    for elevation, inner in ((z - height / 2, False), (z + height / 2, False),
                             (z - height / 2, True), (z + height / 2, True)):
        rx = radius_x - (thickness if inner else 0)
        ry = radius_y - (thickness if inner else 0)
        vertices.extend((x + rx * cos(pi / 8 + i * pi / 4),
                         y + ry * sin(pi / 8 + i * pi / 4), elevation)
                        for i in range(8))
    faces = []
    for i in range(8):
        j = (i + 1) % 8
        faces.extend(((i, j, 8 + j, 8 + i), (16 + i, 24 + i, 24 + j, 16 + j),
                      (8 + i, 8 + j, 24 + j, 24 + i), (i, 16 + i, 16 + j, j)))
    obj = h.mesh(a, name, vertices, faces, material)
    return _under(obj, parent) if parent else obj


def _rivet(h, a, name, position, parent=None, radius=.007, material="gold"):
    obj = h.ico(a, name, position, (radius, radius * .55, radius), material)
    return _under(obj, parent) if parent else obj


def _webbing(h, a, name, start, end, width=.031, material="cream"):
    """布带保留正面宽度，但截面厚度仅 8 mm，避免方杆穿入肩部和胸袋。"""
    obj = h.beam(a, name, start, end, width, material)
    for vertex in obj.data.vertices:
        vertex.co.y *= .008 / width
    obj.data.update()
    return obj


def _gloves(h):
    a = _new(h, "itm_grip_gloves", "抓牢手套", "hands")
    for side, sign, bone in (("left", 1, "hand.L"), ("right", -1, "hand.R")):
        part = _empty(a, "part_" + side, (sign * .098, 0, 0))
        part["bone_target"] = bone
        part["mount_offset_character_z"] = .897
        suffix = "_" + side
        # 掌体与指节分开，蓝色皮面、深色防滑掌垫和奶油缝边有清楚层次。
        _under(h.box(a, "palm_shell" + suffix, (0, 0, .109), (.103, .076, .090),
                     "blue", bevel=.014), part)
        _under(h.box(a, "palm_rubber" + suffix, (0, .042, .109), (.076, .012, .068),
                     "ink", bevel=.008), part)
        for j, x in enumerate((-.028, -.009, .010, .029)):
            _under(h.box(a, "palm_grip_ridge_%02d" % j + suffix, (x, .050, .106),
                         (.009, .004, .047), "metal", bevel=.001), part)
        for i, (x, length) in enumerate(((-.037, .053), (-.012, .064), (.012, .068), (.036, .057))):
            z = .070 - length / 2
            _under(h.box(a, "finger_%02d" % i + suffix, (x, 0, z),
                         (.022, .062, length), "blue", bevel=.006), part)
            _under(h.box(a, "finger_pad_%02d" % i + suffix, (x, .032, z + .007),
                         (.016, .008, length * .67), "ink", bevel=.003), part)
            for k, joint_z in enumerate((z + length * .13, z + length * .38)):
                _under(h.box(a, "finger_joint_%02d_%02d" % (i, k) + suffix,
                             (x, -.032, joint_z), (.019, .009, .011),
                             "cream", bevel=.002), part)
        thumb_x = -sign * .063
        _under(h.ico(a, "thumb_base" + suffix, (thumb_x, .014, .105),
                     (.026, .031, .029), "blue", subdivisions=1), part)
        _under(h.box(a, "thumb_tip" + suffix, (thumb_x - sign * .009, .021, .083),
                     (.032, .051, .047), "blue", bevel=.008,
                     rotation=(0, sign * -.35, 0)), part)
        _under(h.box(a, "thumb_grip" + suffix, (thumb_x - sign * .011, .045, .089),
                     (.023, .009, .035), "ink", bevel=.003), part)
        _under(h.box(a, "knuckle_guard" + suffix, (0, -.043, .133),
                     (.080, .018, .031), "gold", bevel=.007), part)
        for i, x in enumerate((-.027, 0, .027)):
            _under(h.box(a, "guard_segment_%02d" % i + suffix, (x, -.054, .135),
                         (.017, .009, .020), "cream", bevel=.003), part)
        _cuff(h, a, "open_wrist_cuff" + suffix, (0, 0, .179), .059, .051,
              .015, .045, "blue_dark", part)
        _under(h.box(a, "wrist_strap" + suffix, (0, -.052, .181),
                     (.095, .014, .022), "cream", bevel=.004), part)
        _under(h.box(a, "wrist_buckle" + suffix, (sign * .025, -.062, .181),
                     (.027, .010, .030), "gold", bevel=.003), part)
        _under(h.box(a, "buckle_inset" + suffix, (sign * .025, -.068, .181),
                     (.012, .004, .015), "ink", bevel=.001), part)
        for i, x in enumerate((-.048, .048)):
            _under(h.beam(a, "palm_seam_%02d" % i + suffix, (x, .034, .073),
                          (x, .034, .144), .0035, "cream"), part)
        socket = _empty(a, "socket_wrist_" + side, (0, 0, .179), part)
        socket["bone_target"] = bone
        # 源模型按独立物品展示；角色实例缩放后与现有手掌、袖口尺寸贴合。
        socket["fit_scale"] = .78
    return a


def _boot_upper(h, a, part, suffix, base_z, height, spring=False):
    """鞋楦与鞋筒共享角色比例；脚掌朝 +Y，入口留有可读的深色内腔。"""
    foot = [_oval_ring(.181, .202, -.119, base_z),
            _oval_ring(.179, .187, -.113, base_z + .085),
            _oval_ring(.143, .113, -.104, base_z + .148)]
    _loft(h, a, "boot_upper" + suffix, foot, "blue" if spring else "blue_dark", part)
    _under(h.box(a, "reinforced_toe" + suffix, (0, .175, base_z + .063),
                 (.151, .059, .065), "gold" if spring else "wood",
                 bevel=.014), part)
    _under(h.box(a, "heel_counter" + suffix, (0, -.104, base_z + .068),
                 (.130, .034, .105), "metal", bevel=.009), part)
    _under(h.box(a, "ankle_shaft" + suffix, (0, -.019, base_z + height * .72),
                 (.142, .156, height * .51), "blue", bevel=.018), part)
    _cuff(h, a, "open_boot_collar" + suffix, (0, -.019, base_z + height - .020),
          .080, .085, .018, .038, "cream", part)
    _under(h.box(a, "collar_inner_shadow" + suffix, (0, -.019, base_z + height - .040),
                 (.097, .110, .018), "ink", bevel=.009), part)
    _under(h.box(a, "tongue" + suffix, (0, .068, base_z + .147),
                 (.075, .018, .130), "cream", bevel=.008,
                 rotation=(-.22, 0, 0)), part)
    for i, z in enumerate((base_z + .100, base_z + .131, base_z + .163)):
        for sign in (-1, 1):
            _rivet(h, a, "lace_eyelet_%02d_%s" % (i, "L" if sign == 1 else "R") + suffix,
                   (sign * .043, .078, z), part, .005)
        _under(h.beam(a, "lace_cross_a_%02d" % i + suffix, (-.040, .088, z),
                      (.040, .089, z + .015), .007, "cream"), part)
        _under(h.beam(a, "lace_cross_b_%02d" % i + suffix, (.040, .088, z),
                      (-.040, .089, z + .015), .007, "cream"), part)
    _under(h.box(a, "ankle_strap" + suffix, (0, .070, base_z + .190),
                 (.140, .020, .025), "wood", bevel=.003), part)
    _under(h.box(a, "strap_buckle" + suffix, (.046, .086, base_z + .190),
                 (.032, .012, .032), "gold", bevel=.004), part)
    _under(h.box(a, "heel_pull_loop" + suffix, (0, -.110, base_z + height - .026),
                 (.023, .032, .058), "cream", bevel=.004), part)


def _goat_boots(h):
    a = _new(h, "itm_goat_boots", "山羊登山靴", "feet")
    for side, sign, bone in (("left", 1, "foot.L"), ("right", -1, "foot.R")):
        part = _empty(a, "part_" + side, (sign * .116, 0, 0))
        part["bone_target"] = bone
        suffix = "_" + side
        _loft(h, a, "sole" + suffix,
              [_oval_ring(.189, .211, -.124, .008),
               _oval_ring(.191, .211, -.124, .034),
               _oval_ring(.182, .202, -.117, .048)], "ink", part)
        _loft(h, a, "sole_welt" + suffix,
              [_oval_ring(.187, .207, -.121, .035),
               _oval_ring(.183, .203, -.117, .048)], "cream", part)
        # 齿块从最低地面起算，前后横纹和侧爪体现攀坡抓地用途。
        for row, y in enumerate((-.084, -.035, .020, .080, .142, .184)):
            for col, x in enumerate((-.056, .056)):
                _under(h.box(a, "tread_%02d_%02d" % (row, col) + suffix,
                             (x, y, .012), (.044, .027, .024), "metal", bevel=.003,
                             rotation=(0, 0, (-1 if col == 0 else 1) * .20)), part)
        _boot_upper(h, a, part, suffix, .046, .214)
        for sign_x in (-1, 1):
            for i, y in enumerate((-.067, .069, .150)):
                _under(h.box(a, "side_cleat_%s_%02d" % ("L" if sign_x == 1 else "R", i) + suffix,
                             (sign_x * .087, y, .042), (.016, .027, .029), "metal",
                             bevel=.003), part)
        socket = _empty(a, "socket_ankle_" + side, (0, 0, .115), part)
        socket["bone_target"] = bone
    return a


def _coil(h, a, name, center, radius, height, turns, wire_radius, parent):
    """使用实体八边截面管生成螺旋，不依赖曲线导出或外部插件。"""
    cx, cy, cz = center
    rings = []
    segments = int(turns * 20)
    for step in range(segments + 1):
        angle = step / segments * turns * 2 * pi
        z = cz + step / segments * height
        # 线圈截面沿径向／竖向建立，低面数下仍可读出连续弹簧。
        rings.append([(cx + (radius + wire_radius * cos(j * pi / 4)) * cos(angle),
                       cy + (radius + wire_radius * cos(j * pi / 4)) * sin(angle),
                       z + wire_radius * sin(j * pi / 4)) for j in range(8)])
    return _loft(h, a, name, rings, "gold", parent)


def _spring_boots(h):
    a = _new(h, "itm_spring_boots", "蓄力弹簧鞋", "feet")
    for side, sign, bone in (("left", 1, "foot.L"), ("right", -1, "foot.R")):
        part = _empty(a, "part_" + side, (sign * .116, 0, 0))
        part["bone_target"] = bone
        suffix = "_" + side
        _loft(h, a, "ground_plate" + suffix,
              [_oval_ring(.196, .216, -.128, .000),
               _oval_ring(.196, .216, -.128, .024)], "ink", part)
        _loft(h, a, "compression_plate" + suffix,
              [_oval_ring(.190, .210, -.122, .096),
               _oval_ring(.190, .210, -.122, .117)], "metal", part)
        for coil_index, y in enumerate((-.068, .130)):
            _under(h.cylinder(a, "spring_seat_bottom_%02d" % coil_index + suffix,
                              (0, y, .032), .057, .012, "metal", vertices=10), part)
            _under(h.cylinder(a, "spring_seat_top_%02d" % coil_index + suffix,
                              (0, y, .090), .054, .012, "metal", vertices=10), part)
            _coil(h, a, "coil_%02d" % coil_index + suffix, (0, y, .039),
                  .043, .043, 2.7, .006, part)
            _under(h.cylinder(a, "damper_%02d" % coil_index + suffix, (0, y, .062),
                              .014, .057, "metal", vertices=8), part)
        for sign_x in (-1, 1):
            _under(h.beam(a, "guide_arm_%s" % ("L" if sign_x == 1 else "R") + suffix,
                          (sign_x * .087, -.070, .030), (sign_x * .076, .110, .103),
                          .014, "blue_dark"), part)
            _rivet(h, a, "guide_rivet_%s" % ("L" if sign_x == 1 else "R") + suffix,
                   (sign_x * .084, -.075, .032), part, .008)
        _boot_upper(h, a, part, suffix, .116, .206, spring=True)
        _under(h.box(a, "compression_indicator" + suffix, (.097, -.035, .065),
                     (.011, .056, .050), "cream", bevel=.003), part)
        for i in range(3):
            _under(h.box(a, "indicator_mark_%02d" % i + suffix, (.104, -.035, .048 + i * .015),
                         (.005, .034, .004), "red"), part)
        # 弹簧装置高于普通靴，挂点保留鞋上脚踝位置，地面轴心仍为零。
        pivot = _empty(a, "pivot_compression_" + side, (0, 0, .097), part)
        pivot["animation_axis"] = "Z"
        socket = _empty(a, "socket_ankle_" + side, (0, 0, .185), part)
        socket["bone_target"] = bone
    return a


def _grabber(h):
    a = _new(h, "itm_reach_grabber", "伸缩搬运夹", "hands")
    # 握把—三级伸缩筒—对称四连杆爪，整件长度约一米且前端开口可读。
    h.box(a, "handle_grip", (0, -.190, .104), (.056, .161, .067), "blue", bevel=.012)
    for i, y in enumerate((-.246, -.221, -.196, -.171, -.146)):
        h.box(a, "grip_ridge_%02d" % i, (0, y, .112), (.060, .010, .072), "ink", bevel=.003)
    h.box(a, "handle_guard_base", (0, -.186, .035), (.105, .193, .019), "gold", bevel=.006)
    for sign in (-1, 1):
        h.beam(a, "handle_guard_side_" + ("left" if sign == 1 else "right"),
               (sign * .043, -.261, .043), (sign * .043, -.107, .065), .016, "gold")
    h.box(a, "trigger", (0, -.104, .070), (.018, .047, .041), "metal", bevel=.004,
          rotation=(.38, 0, 0))
    h.cylinder(a, "outer_telescope_tube", (0, .016, .112), .032, .235,
               "blue_dark", vertices=10, rotation=(pi / 2, 0, 0))
    h.cylinder(a, "middle_telescope_tube", (0, .247, .112), .025, .260,
               "metal", vertices=10, rotation=(pi / 2, 0, 0))
    h.cylinder(a, "inner_telescope_tube", (0, .467, .112), .018, .230,
               "cream", vertices=10, rotation=(pi / 2, 0, 0))
    for i, (y, radius) in enumerate(((.119, .039), (.360, .031), (.572, .026))):
        h.cylinder(a, "locking_collar_%02d" % i, (0, y, .112), radius, .037,
                   "gold", vertices=10, rotation=(pi / 2, 0, 0))
        for sign in (-1, 1):
            h.box(a, "collar_thumb_tab_%02d_%s" % (i, "L" if sign == 1 else "R"),
                  (sign * (radius + .006), y, .112), (.015, .021, .025), "blue", bevel=.003)
    h.beam(a, "actuation_link", (0, -.106, .084), (0, .601, .084), .008, "metal")
    h.box(a, "claw_hub", (0, .610, .112), (.132, .083, .081), "blue", bevel=.011)
    h.box(a, "claw_hub_badge", (0, .616, .158), (.043, .044, .010), "gold", bevel=.004)
    for side, sign in (("left", 1), ("right", -1)):
        pivot = _empty(a, "pivot_claw_" + side, (sign * .046, .640, .112))
        pivot["animation_axis"] = "Z"
        h.cylinder(a, "claw_pin_" + side, (sign * .049, .640, .112), .019, .096,
                   "gold", vertices=10)
        h.beam(a, "claw_outer_link_" + side, (sign * .050, .652, .112),
               (sign * .140, .730, .112), .032, "metal")
        h.beam(a, "claw_inner_link_" + side, (sign * .027, .634, .088),
               (sign * .109, .735, .088), .012, "cream")
        h.cylinder(a, "claw_elbow_" + side, (sign * .137, .731, .112), .024, .043,
                   "gold", vertices=10)
        h.beam(a, "curved_jaw_" + side, (sign * .138, .730, .112),
               (sign * .088, .806, .112), .035, "blue_dark")
        h.beam(a, "jaw_tip_" + side, (sign * .088, .806, .112),
               (sign * .054, .815, .112), .035, "metal")
        h.box(a, "jaw_grip_pad_" + side, (sign * .055, .806, .112),
              (.018, .051, .047), "ink", bevel=.004)
        for i, y in enumerate((.786, .802, .818)):
            h.box(a, "jaw_pad_ridge_%s_%02d" % (side, i), (sign * .044, y, .112),
                  (.008, .006, .041), "cream", bevel=.001)
    _empty(a, "socket_hand", (0, -.180, .112))["bone_target"] = "hand.R"
    _empty(a, "socket_grasp_target", (0, .792, .112))
    _empty(a, "pivot_telescope", (0, .121, .112))["animation_axis"] = "Y"
    return a


def _frame(h):
    a = _new(h, "itm_courier_frame", "邮差背架", "back")
    # 靠身体的一侧为 +Y；托盘向背部 -Y 伸出，木垫和金属框保持通风间隙。
    for side, sign in (("left", 1), ("right", -1)):
        h.box(a, "frame_foot_" + side, (sign * .240, -.080, .024),
              (.046, .053, .048), "ink", bevel=.005)
        h.beam(a, "vertical_frame_" + side, (sign * .240, -.080, .061),
               (sign * .240, -.080, .765), .031, "metal")
        h.beam(a, "top_frame_curve_" + side, (sign * .240, -.080, .765),
               (sign * .195, -.080, .810), .031, "metal")
        h.beam(a, "shelf_side_" + side, (sign * .240, -.080, .080),
               (sign * .240, -.290, .080), .028, "metal")
        h.beam(a, "shelf_brace_" + side, (sign * .240, -.080, .270),
               (sign * .240, -.280, .090), .021, "metal")
        h.beam(a, "cargo_retainer_" + side, (sign * .250, -.280, .084),
               (sign * .250, -.280, .240), .022, "blue_dark")
    for i, z in enumerate((.117, .365, .622, .800)):
        width = .399 if i == 3 else .480
        h.beam(a, "frame_crossbar_%02d" % i, (-width / 2, -.080, z),
               (width / 2, -.080, z), .027, "metal")
    h.beam(a, "shelf_front_rail", (-.240, -.291, .080), (.240, -.291, .080), .030, "metal")
    for i, x in enumerate((-.159, -.053, .053, .159)):
        h.box(a, "ventilated_back_slat_%02d" % i, (x, -.060, .418),
              (.080, .032, .654), "wood", bevel=.006)
        for j, z in enumerate((.130, .680)):
            _rivet(h, a, "slat_fixing_%02d_%02d" % (i, j), (x, -.041, z), radius=.008)
    for i, y in enumerate((-.126, -.184, -.243)):
        h.box(a, "cargo_shelf_slat_%02d" % i, (0, y, .092),
              (.464, .044, .024), "wood", bevel=.005)
    h.box(a, "lumbar_pad", (0, -.016, .180), (.366, .060, .126), "blue_dark", bevel=.016)
    h.box(a, "upper_back_pad", (0, -.016, .660), (.347, .058, .138), "blue", bevel=.016)
    for side, sign in (("left", 1), ("right", -1)):
        # socket_spine 对齐角色 (0,-.140,1.215) 后，本模型位移为 (0,-.125,.795)。
        # 布带从后方上绕肩膀，在前胸 Y≈.164 留出胸袋余量，再沿体外绕回腰侧。
        strap_points = [(sign * .140, -.032, .733), (sign * .148, .045, .697),
                        (sign * .155, .285, .649), (sign * .155, .289, .423),
                        (sign * .173, .285, .302), (sign * .236, .285, .282),
                        (sign * .257, .130, .267), (sign * .252, -.050, .265),
                        (sign * .193, -.032, .265)]
        for i, (start, end) in enumerate(zip(strap_points, strap_points[1:])):
            _webbing(h, a, "shoulder_webbing_%s_%02d" % (side, i), start, end)
        h.box(a, "strap_adjuster_" + side, (sign * .155, .309, .453),
              (.050, .013, .044), "gold", bevel=.003)
        h.box(a, "strap_adjuster_inset_" + side, (sign * .155, .317, .453),
              (.025, .004, .025), "ink", bevel=.002)
        h.box(a, "hip_webbing_" + side, (sign * .257, .130, .267),
              (.036, .104, .058), "blue", bevel=.009)
        h.box(a, "cargo_strap_anchor_" + side, (sign * .265, -.092, .534),
              (.038, .047, .058), "gold", bevel=.005)
        for j, z in enumerate((.351, .561)):
            h.beam(a, "cargo_tie_%s_%02d" % (side, j),
                   (sign * .247, -.094, z), (sign * .247, -.260, z), .018, "cream")
            h.box(a, "cargo_tie_buckle_%s_%02d" % (side, j), (sign * .247, -.242, z),
                  (.035, .040, .026), "gold", bevel=.003)
    h.box(a, "mail_badge_plate", (0, -.084, .751), (.118, .014, .066), "blue", bevel=.006)
    for sign in (-1, 1):
        h.beam(a, "mail_badge_diagonal_" + ("left" if sign == 1 else "right"),
               (sign * .043, -.094, .773), (0, -.094, .750), .006, "cream")
    h.beam(a, "mail_badge_bottom", (-.043, -.094, .733), (.043, -.094, .733), .006, "cream")
    mount = _empty(a, "socket_spine", (0, -.015, .420))
    mount["bone_target"] = "spine"
    mount["character_offset"] = [0, -.140, 1.215]
    _empty(a, "socket_cargo_lower", (0, -.188, .165))
    _empty(a, "socket_cargo_upper", (0, -.188, .460))
    return a


def _sail_panel(h, a, name, points, material, thickness=.008, parent=None):
    """帆面用闭合棱柱形成双面实体；三角扇分面让曲折的布面清楚可见。"""
    count = len(points)
    vertices = [(x, y - thickness / 2, z) for x, y, z in points]
    vertices += [(x, y + thickness / 2, z) for x, y, z in points]
    faces = []
    for i in range(1, count - 1):
        faces.extend(((0, i + 1, i), (count, count + i, count + i + 1)))
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, count + j, count + i))
    obj = h.mesh(a, name, vertices, faces, material)
    return _under(obj, parent) if parent else obj


def _glider(h, folded=False):
    identifier = "itm_glider_cape_folded" if folded else "itm_glider_cape"
    a = _new(h, identifier, "折叠滑翔披风" + ("（收拢）" if folded else "（展开）"),
             "back", "folded" if folded else "default", "itm_glider_cape")
    # 背部中央铰链和肩带在两个变体中保持同一位置，后续可以直接切换外观。
    h.box(a, "back_harness", (0, .016, .325), (.186, .102, .407), "blue_dark", bevel=.018)
    h.box(a, "harness_cushion", (0, .078, .329), (.150, .039, .345), "cream", bevel=.011)
    h.box(a, "hinge_spine", (0, -.052, .341), (.057, .052, .480), "metal", bevel=.007)
    h.cylinder(a, "deployment_hinge", (0, -.058, .558), .042, .210,
               "gold", vertices=10, rotation=(0, pi / 2, 0))
    for side, sign in (("left", 1), ("right", -1)):
        # 挂点对齐同一角色脊柱位置；前胸原点 Y=.370 使布带位于世界 Y≈.167。
        # 薄带绕肩与腰侧闭合，不用大块实心体遮住角色制服。
        shoulder = [(sign * .071, .055, .526), (sign * .085, .070, .573),
                    (sign * .125, .150, .588),
                    (sign * .145, .370, .545)]
        front = [(sign * .145, .370, .545), (sign * .145, .372, .310),
                 (sign * .180, .363, .245)]
        return_path = [(sign * .180, .363, .245), (sign * .240, .363, .221),
                       (sign * .260, .200, .215), (sign * .250, .040, .210),
                       (sign * .082, .040, .210)]
        for label, points in (("shoulder", shoulder), ("front", front), ("return", return_path)):
            for i, (start, end) in enumerate(zip(points, points[1:])):
                _webbing(h, a, "harness_%s_%s_%02d" % (label, side, i),
                         start, end, .025)
        h.box(a, "harness_clasp_" + side, (sign * .145, .389, .328),
              (.040, .016, .029), "gold", bevel=.004)
        pivot = _empty(a, "pivot_wing_" + side, (sign * .073, -.061, .559))
        pivot["animation_axis"] = "Y"
        if folded:
            # 折叠骨条和逐片折帆保留原来材料关系；宽度适合背在现有主角后方。
            spine = (sign * .091, -.103, .556)
            mid = (sign * .142, -.130, .314)
            end = (sign * .194, -.115, .025)
            h.beam(a, "folded_leading_spar_" + side, spine, mid, .023, "metal")
            h.beam(a, "folded_lower_spar_" + side, mid, end, .019, "wood")
            for i in range(3):
                x0 = sign * (.045 + i * .038)
                x1 = sign * (.089 + i * .033)
                points = [(x0, -.085 - i * .020, .533),
                          (x1, -.145 - i * .016, .300),
                          (sign * (.060 + i * .044), -.126 - i * .018, .019),
                          (sign * (.029 + i * .033), -.089 - i * .020, .133)]
                _sail_panel(h, a, "folded_sail_%s_%02d" % (side, i), points,
                            "blue" if i != 1 else "cream", .010)
                h.beam(a, "folded_sail_rib_%s_%02d" % (side, i), points[0], points[2], .010, "gold")
            h.box(a, "fold_retaining_strap_" + side, (sign * .117, -.169, .235),
                  (.142, .019, .032), "wood", bevel=.004)
            h.box(a, "fold_retaining_clasp_" + side, (sign * .112, -.183, .235),
                  (.034, .013, .045), "gold", bevel=.003)
        else:
            # 六块闭合扇形帆组成柔和折线翼面，翼尖低于中央，轮廓像展开披风。
            hub = (sign * .070, -.065, .561)
            perimeter = [(sign * .390, -.036, .609), (sign * .715, -.090, .557),
                         (sign * .854, -.210, .378), (sign * .628, -.264, .172),
                         (sign * .331, -.200, .026), (sign * .061, -.137, .103)]
            for i, (start, end) in enumerate(zip(perimeter, perimeter[1:])):
                _sail_panel(h, a, "sail_panel_%s_%02d" % (side, i),
                            [hub, start, end], "cream" if i in (1, 3) else "blue", .009)
                h.beam(a, "radial_rib_%s_%02d" % (side, i), hub, start,
                       .018 if i < 2 else .010, "metal" if i < 2 else "wood")
                h.beam(a, "sail_hem_%s_%02d" % (side, i), start, end, .010, "gold")
            h.beam(a, "final_radial_rib_" + side, hub, perimeter[-1], .010, "wood")
            h.beam(a, "leading_spar_" + side, hub, perimeter[0], .027, "metal")
            h.beam(a, "leading_extension_" + side, perimeter[0], perimeter[1], .021, "wood")
            h.cylinder(a, "spar_knuckle_" + side, perimeter[0], .021, .036,
                       "gold", vertices=8, rotation=(pi / 2, 0, 0))
            h.ico(a, "wing_tip_cap_" + side, perimeter[2], (.020, .018, .021), "gold")
            # 拉索为实体细杆；不依赖 Curve／透明贴图，GLB 导出后保持可见。
            h.beam(a, "tension_wire_" + side, (sign * .052, -.075, .325),
                   perimeter[1], .005, "cream")
            _empty(a, "socket_wing_tip_" + side, perimeter[2])
    _empty(a, "socket_spine", (0, .063, .325))["bone_target"] = "spine"
    _empty(a, "socket_release_cord", (.116, .120, .270))
    return a


def build_equipment(h):
    """制作六类装备以及收拢披风变体，返回独立 Blender Asset 列表。"""
    assets = [_gloves(h), _grabber(h), _goat_boots(h), _spring_boots(h),
              _frame(h), _glider(h), _glider(h, folded=True)]
    # 独立资产按真实最低网格顶点落地，旋转后的薄杆也纳入计算。
    # 只移动根的直接子层级，左右子根和所有挂点一起移动，避免相对偏移失配。
    for a in assets:
        bpy.context.view_layer.update()
        geometry = [o for o in h.descendants(a.root) if o.type == "MESH"]
        # 镜像翼面和弯曲线圈的绕序不同，统一重算法线，确保 GLB 外表面朝外。
        for obj in geometry:
            editable = bmesh.new()
            editable.from_mesh(obj.data)
            bmesh.ops.recalc_face_normals(editable, faces=list(editable.faces))
            editable.to_mesh(obj.data)
            editable.free()
            obj.data.update()
        lowest = min((o.matrix_world @ v.co).z for o in geometry for v in o.data.vertices)
        for obj in a.root.children:
            obj.location.z -= lowest
        a.root["ground_adjustment_m"] = -lowest
    bpy.context.view_layer.update()
    return assets
