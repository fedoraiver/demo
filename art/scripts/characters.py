"""低多边形岛屿居民：独立角色资产、可导出骨架和主角循环动作。"""

from itertools import product
from math import cos, pi, sin, sqrt

import bpy


def _armature(asset, name):
    """共用人体比例，但每个资产保留自己的骨架，便于单独导出。"""
    data = bpy.data.armatures.new(name + "_Skeleton")
    rig = bpy.data.objects.new(name + "_Rig", data)
    asset.collection.objects.link(rig)
    rig.parent = asset.root
    rig.show_in_front = True
    data.display_type = "STICK"
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")

    bones = [
        ("root", (0, 0, 0), (0, 0, 0.1), None),
        ("hips", (0, 0, 0.90), (0, 0, 1.02), "root"),
        ("spine", (0, 0, 1.02), (0, 0, 1.43), "hips"),
        ("neck", (0, 0, 1.43), (0, 0, 1.56), "spine"),
        ("head", (0, 0, 1.56), (0, 0, 1.89), "neck"),
    ]
    for side, sign in (("L", 1), ("R", -1)):
        bones.extend([
            ("upper_arm." + side, (sign * .215, 0, 1.395),
             (sign * .278, .012, 1.145), "spine"),
            ("forearm." + side, (sign * .278, .012, 1.145),
             (sign * .309, .026, .928), "upper_arm." + side),
            ("hand." + side, (sign * .309, .026, .928),
             (sign * .314, .035, .855), "forearm." + side),
            ("thigh." + side, (sign * .108, 0, .945),
             (sign * .116, .013, .548), "hips"),
            ("shin." + side, (sign * .116, .013, .548),
             (sign * .116, 0, .115), "thigh." + side),
            ("foot." + side, (sign * .116, 0, .115),
             (sign * .116, .155, .06), "shin." + side),
        ])
    for bone_name, head, tail, parent in bones:
        bone = data.edit_bones.new(bone_name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    rig.select_set(False)
    for bone in rig.pose.bones:
        bone.rotation_mode = "XYZ"
    rig["forward_axis"] = "+Y"
    rig["height_m"] = 1.9
    asset.root["rig_object"] = rig.name
    return rig


def _skin(obj, rig, bone_name):
    """刚性分段权重保留棱面风格；仍使用标准蒙皮，glTF 可导出关节动画。"""
    # glTF 用父级确定蒙皮骨架；统一层级并保留世界变换，防止实例匹配错误。
    world_matrix = obj.matrix_world.copy()
    obj.parent = rig
    obj.matrix_world = world_matrix
    group = obj.vertex_groups.new(name=bone_name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    modifier = obj.modifiers.new("Character skin", "ARMATURE")
    modifier.object = rig
    obj["bone_part"] = bone_name
    return obj


def _character(h, name, style):
    """通过服装、头饰和配色区分岗位，避免把包裹写死在人物资产中。"""
    a = h.asset(name, "characters")
    rig = _armature(a, name)
    bind = _skin
    shirt = style["shirt"]
    pants = style["pants"]
    skin = style.get("skin", "skin")

    # 主角沿用参考图的修长蓝制服，重心和脚底原点适合游戏控制器。
    bind(h.box(a, "Pelvis", (0, 0, .965), (.335, .22, .155), pants, bevel=.018), rig, "hips")
    bind(h.box(a, "Uniform torso", (0, 0, 1.215), (.408, .24, .438), shirt, bevel=.023), rig, "spine")
    bind(h.box(a, "Belt", (0, .009, 1.027), (.352, .237, .045), "navy", bevel=.007), rig, "hips")
    bind(h.box(a, "Belt buckle", (0, .135, 1.026), (.057, .018, .039), "gold", bevel=.004), rig, "hips")
    bind(h.cylinder(a, "Long neck", (0, 0, 1.482), .07, .158, skin, vertices=8), rig, "neck")

    # 领片、门襟、胸袋与铜扣在中距离也能读出职业信息。
    for sign in (-1, 1):
        bind(h.box(a, "Collar", (sign * .067, .131, 1.395),
                   (.102, .025, .082), style.get("collar", "blue_dark"),
                   bevel=.004, rotation=(0, sign * -.30, 0)), rig, "spine")
    bind(h.box(a, "Front placket", (0, .131, 1.21), (.026, .014, .292),
               style.get("collar", "blue_dark")), rig, "spine")
    for z in (1.31, 1.205, 1.11):
        bind(h.ico(a, "Uniform button", (0, .145, z), (.010, .007, .010), "gold"), rig, "spine")
    bind(h.box(a, "Breast pocket", (.113, .131, 1.288), (.086, .018, .086), shirt, bevel=.005), rig, "spine")
    bind(h.box(a, "Pocket flap", (.113, .144, 1.325), (.089, .018, .017),
               style.get("collar", "blue_dark")), rig, "spine")

    for side, sign in (("L", 1), ("R", -1)):
        upper = "upper_arm." + side
        fore = "forearm." + side
        hand = "hand." + side
        thigh = "thigh." + side
        shin = "shin." + side
        foot = "foot." + side
        bind(h.ico(a, "Shoulder " + side, (sign * .216, 0, 1.379), (.096, .103, .102), shirt), rig, upper)
        bind(h.beam(a, "Sleeve upper " + side, (sign * .220, 0, 1.378),
                    (sign * .278, .012, 1.151), .117, shirt), rig, upper)
        bind(h.ico(a, "Elbow " + side, (sign * .278, .012, 1.145), (.060, .060, .062), shirt), rig, fore)
        bind(h.beam(a, "Sleeve lower " + side, (sign * .278, .012, 1.145),
                    (sign * .305, .025, .963), .093, shirt), rig, fore)
        bind(h.box(a, "Cuff " + side, (sign * .306, .025, .962), (.100, .102, .036),
                   style.get("collar", "blue_dark"), bevel=.005), rig, fore)
        bind(h.ico(a, "Hand " + side, (sign * .314, .033, .897), (.050, .043, .071), skin, subdivisions=1), rig, hand)
        bind(h.ico(a, "Thumb " + side, (sign * .278, .059, .913), (.023, .027, .033), skin), rig, hand)
        bind(h.beam(a, "Trouser thigh " + side, (sign * .108, 0, .932),
                    (sign * .116, .013, .550), .145, pants), rig, thigh)
        bind(h.ico(a, "Knee " + side, (sign * .116, .013, .548), (.076, .073, .076), pants), rig, shin)
        bind(h.beam(a, "Trouser shin " + side, (sign * .116, .013, .548),
                    (sign * .116, 0, .125), .117, pants), rig, shin)
        bind(h.box(a, "Boot " + side, (sign * .116, .063, .079),
                   (.145, .265, .140), "ink", bevel=.024), rig, foot)
        bind(h.box(a, "Boot sole " + side, (sign * .116, .069, .015),
                   (.153, .272, .030), "navy", bevel=.008), rig, foot)
        bind(h.box(a, "Boot toe " + side, (sign * .116, .171, .069),
                   (.134, .045, .088), "navy", bevel=.014), rig, foot)

    # 低面数长脸搭配小比例的大眼睛，避免纯白眼球在侧面过度突出。
    bind(h.ico(a, "Head", (0, -.005, 1.703), (.153, .126, .207), skin, subdivisions=2), rig, "head")
    bind(h.ico(a, "Jaw", (0, .014, 1.599), (.119, .108, .083), skin, subdivisions=1), rig, "head")
    for sign in (-1, 1):
        bind(h.ico(a, "Ear", (sign * .151, -.012, 1.701), (.032, .035, .052), skin), rig, "head")
        bind(h.sphere(a, "Eye white", (sign * .061, .110, 1.747),
                      (.047, .033, .049), "white", segments=12, rings=8), rig, "head")
        bind(h.sphere(a, "Eye pupil", (sign * .061, .140, 1.748),
                      (.019, .007, .024), "ink", segments=10, rings=6), rig, "head")
        bind(h.ico(a, "Eye glint", (sign * .056, .147, 1.758), (.006, .003, .006), "white"), rig, "head")
        bind(h.box(a, "Eyebrow", (sign * .061, .124, 1.802), (.067, .017, .014),
                   "hair", bevel=.004, rotation=(0, sign * .10, 0)), rig, "head")
    bind(h.ico(a, "Nose", (0, .130, 1.678), (.031, .047, .041),
               style.get("nose", "skin_light")), rig, "head")
    for x1, x2, z1, z2 in ((-.037, 0, 1.617, 1.607), (0, .037, 1.607, 1.617)):
        bind(h.beam(a, "Smile", (x1, .114, z1), (x2, .114, z2), .008, "skin_dark"), rig, "head")
    bind(h.ico(a, "Hair back", (0, -.051, 1.795), (.154, .092, .112), "hair", subdivisions=1), rig, "head")

    if style.get("cap"):
        cap = style["cap"]
        bind(h.cone(a, "Cap crown", (0, -.006, 1.854), .163, .148, .090, cap, vertices=8), rig, "head")
        bind(h.box(a, "Cap band", (0, -.001, 1.814), (.329, .252, .038),
                   style.get("cap_band", "navy"), bevel=.012), rig, "head")
        bind(h.box(a, "Cap visor", (0, .151, 1.819), (.293, .137, .022),
                   style.get("cap_band", "navy"), bevel=.018, rotation=(-.11, 0, 0)), rig, "head")
        bind(h.ico(a, "Cap badge", (0, .135, 1.853), (.025, .008, .026), "gold"), rig, "head")
    else:
        for x, z in ((-.106, 1.846), (-.047, 1.873), (.018, 1.867), (.091, 1.836)):
            bind(h.ico(a, "Hair fringe", (x, .028, z), (.054, .10, .067),
                       style.get("hair", "hair")), rig, "head")

    role = style["role"]
    if role == "dispatcher":
        # 调度员的胸章和圆框眼镜可以从远处与主角区分。
        for x in (-.074, .074):
            bind(h.box(a, "Dispatcher epaulette", (x * 2.2, .010, 1.436),
                       (.078, .098, .019), "gold", bevel=.003), rig, "spine")
        bind(h.box(a, "Dispatch badge", (-.111, .148, 1.299),
                   (.059, .012, .074), "gold", bevel=.005), rig, "spine")
        for x in (-.061, .061):
            for start, end in (((x - .046, .151, 1.792), (x + .046, .151, 1.792)),
                               ((x - .046, .151, 1.700), (x + .046, .151, 1.700)),
                               ((x - .046, .151, 1.700), (x - .046, .151, 1.792)),
                               ((x + .046, .151, 1.700), (x + .046, .151, 1.792))):
                bind(h.beam(a, "Glasses frame", start, end, .007, "metal"), rig, "head")
        bind(h.beam(a, "Glasses bridge", (-.015, .153, 1.751), (.015, .153, 1.751), .009, "metal"), rig, "head")
        bind(h.box(a, "Dispatch tie", (0, .154, 1.313), (.034, .017, .115), "gold", bevel=.006), rig, "spine")
    elif role == "pizza":
        bind(h.box(a, "Pizza apron", (0, .145, 1.16), (.307, .027, .353), "cream", bevel=.013), rig, "spine")
        for sign in (-1, 1):
            bind(h.beam(a, "Apron strap", (sign * .105, .144, 1.409),
                        (sign * .094, .163, 1.295), .028, "cream"), rig, "spine")
        bind(h.box(a, "Apron pocket", (0, .166, 1.101), (.139, .025, .093), "red", bevel=.005), rig, "spine")
        # 腰前的三角切片徽章仅表达岗位，避免把食物当作角色固定装备。
        bind(h.mesh(a, "Pizza apron badge", [(-.039, .185, 1.249), (.039, .185, 1.249),
                                              (0, .186, 1.182)], [(0, 1, 2)], "gold"), rig, "spine")
    elif role == "music":
        for sign in (-1, 1):
            bind(h.box(a, "Vest panel", (sign * .134, .133, 1.223),
                       (.111, .027, .35), "purple", bevel=.011), rig, "spine")
            bind(h.ico(a, "Headphone pad", (sign * .175, -.010, 1.727), (.045, .056, .074), "ink"), rig, "head")
            bind(h.ico(a, "Headphone shell", (sign * .199, -.010, 1.727), (.024, .048, .057), "gold"), rig, "head")
        for start, end in (((-.17, -.025, 1.739), (-.154, -.025, 1.858)),
                           ((-.154, -.025, 1.858), (0, -.025, 1.921)),
                           ((0, -.025, 1.921), (.154, -.025, 1.858)),
                           ((.154, -.025, 1.858), (.17, -.025, 1.739))):
            bind(h.beam(a, "Headphone band", start, end, .027, "ink"), rig, "head")
        bind(h.ico(a, "Music pin", (-.128, .155, 1.313), (.022, .009, .022), "gold"), rig, "spine")
    elif role == "resident":
        bind(h.box(a, "Resident scarf", (0, .130, 1.424), (.207, .046, .049), "cream", bevel=.014), rig, "spine")
        bind(h.box(a, "Scarf tail", (-.097, .153, 1.322), (.055, .032, .173), "cream", bevel=.01), rig, "spine")
        for sign in (-1, 1):
            bind(h.box(a, "Jacket patch pocket", (sign * .122, .139, 1.124),
                       (.102, .023, .088), "coral", bevel=.008), rig, "spine")
        bind(h.ico(a, "Hair bun", (0, -.146, 1.805), (.081, .074, .083), "hair"), rig, "head")

    a.root["role"] = role
    a.root["height_m"] = 1.94 if role == "music" else 1.90
    a.root["asset_notes"] = "Low-poly character, Z-up, +Y forward, feet origin, skinned segments"
    return a, rig


def _walk_leg_angles(step):
    """腿部动画和接地计算使用同一组角度，避免以后调整步幅时产生偏差。"""
    return .39 * step, -.47 * max(0, -step), -.12 * step


def _rotate_about_bone(point, head, tail, angle):
    """纯数学重现零 roll 骨骼的局部 X 旋转，不读取 Blender 世界。"""
    direction = tuple(tail[i] - head[i] for i in range(3))
    length = sqrt(sum(value * value for value in direction))
    x, y, z = (value / length for value in direction)
    # 这里的骨骼均不朝向 -Y，零 roll 矩阵的局部 X 轴有稳定的闭式表达。
    # 使用骨骼局部轴，而非世界 X，才能保留左右腿轻微外展的真实运动。
    axis = (1 - x * x / (1 + y), -x, -x * z / (1 + y))
    relative = tuple(point[i] - head[i] for i in range(3))
    dot = sum(axis[i] * relative[i] for i in range(3))
    cross = (axis[1] * relative[2] - axis[2] * relative[1],
             axis[2] * relative[0] - axis[0] * relative[2],
             axis[0] * relative[1] - axis[1] * relative[0])
    c, s = cos(angle), sin(angle)
    return tuple(head[i] + relative[i] * c + cross[i] * s + axis[i] * dot * (1 - c)
                 for i in range(3))


def _beveled_box_points(center, size, bevel):
    """与鞋部一段 BEVEL 的角点对应，避免用未倒角包围盒高估接地补偿。"""
    for signs in product((-1, 1), repeat=3):
        for untrimmed in range(3):
            yield tuple(center[i] + signs[i] * (size[i] / 2 - (0 if i == untrimmed else bevel))
                        for i in range(3))


def _walk_foot_height(sign, angles):
    """计算一个脚的最低蒙皮顶点；髋部尚未平移，坐标保持 Z-up。"""
    thigh, shin, foot = angles
    joints = (
        ((sign * .116, 0, .115), (sign * .116, .155, .06), foot),
        ((sign * .116, .013, .548), (sign * .116, 0, .115), shin),
        ((sign * .108, 0, .945), (sign * .116, .013, .548), thigh),
    )
    shoe_parts = (
        ((sign * .116, .063, .079), (.145, .265, .140), .024),
        ((sign * .116, .069, .015), (.153, .272, .030), .008),
        ((sign * .116, .171, .069), (.134, .045, .088), .014),
    )
    lowest = float("inf")
    for center, size, bevel in shoe_parts:
        for point in _beveled_box_points(center, size, bevel):
            # 子骨骼先变换，再叠加父骨骼，等价于刚性权重的 FK 蒙皮。
            for head, tail, angle in joints:
                point = _rotate_about_bone(point, head, tail, angle)
            lowest = min(lowest, point[2])
    return lowest


def _walk_ground_offset(phase):
    """最低支撑脚距地约 4 mm；微小余量抵消采样帧之间的插值误差。"""
    floor = min(_walk_foot_height(sign, _walk_leg_angles(sin(phase + sign * pi / 2)))
                for sign in (1, -1))
    return .004 - floor


def _animations(rig):
    """用标准关键帧创建三个独立循环，不依赖旧版 Action.fcurves API。"""
    rig.animation_data_create()
    action_names = []
    definitions = (("Idle", (1, 7, 13, 19, 25)),
                   ("Walk", range(1, 26)),
                   ("Carry_Idle", (1, 7, 13, 19, 25)))
    for label, frames in definitions:
        action = bpy.data.actions.new(label)
        rig.animation_data.action = action
        action.use_fake_user = True
        for frame in frames:
            phase = 2 * pi * (frame - 1) / 24
            wave = sin(phase)
            for bone in rig.pose.bones:
                bone.rotation_euler = (0, 0, 0)
                bone.location = (0, 0, 0)
            if label == "Walk":
                for side, sign in (("L", 1), ("R", -1)):
                    step = sin(phase + sign * pi / 2)
                    thigh, shin, foot = _walk_leg_angles(step)
                    rig.pose.bones["thigh." + side].rotation_euler.x = thigh
                    rig.pose.bones["shin." + side].rotation_euler.x = shin
                    rig.pose.bones["foot." + side].rotation_euler.x = foot
                    rig.pose.bones["upper_arm." + side].rotation_euler.x = -.28 * step
                    rig.pose.bones["forearm." + side].rotation_euler.x = .12 + .07 * max(0, step)
                # 髋骨局部 +Y 对应世界 +Z；逐帧降低重心，使至少一个脚落地。
                rig.pose.bones["hips"].location.y = _walk_ground_offset(phase)
                rig.pose.bones["spine"].rotation_euler.y = .045 * wave
                rig.pose.bones["head"].rotation_euler.y = -.025 * wave
            elif label == "Carry_Idle":
                for side in ("L", "R"):
                    rig.pose.bones["upper_arm." + side].rotation_euler.x = 1.06 + .012 * wave
                    rig.pose.bones["forearm." + side].rotation_euler.x = .61
                    rig.pose.bones["hand." + side].rotation_euler.x = -.19
                rig.pose.bones["spine"].rotation_euler.x = -.035 + .012 * wave
                rig.pose.bones["head"].rotation_euler.x = .035 - .01 * wave
                rig.pose.bones["hips"].location.y = .008 * wave
            else:
                rig.pose.bones["spine"].rotation_euler.x = .018 * wave
                rig.pose.bones["head"].rotation_euler.z = .015 * wave
                for side in ("L", "R"):
                    rig.pose.bones["forearm." + side].rotation_euler.x = .065 + .01 * wave
            # 全部骨骼显式设键，切换动作时不会继承另一动作的未覆盖姿态。
            for bone in rig.pose.bones:
                bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=bone.name)
                bone.keyframe_insert(data_path="location", frame=frame, group=bone.name)
        action_names.append(action.name)
        track = rig.animation_data.nla_tracks.new()
        track.name = label
        strip = track.strips.new(label, 1, action)
        # 三轨作为导出容器，避免在 Blender 预览中把三个动作叠加计算。
        strip.mute = True
        strip.extrapolation = "NOTHING"
    rig.animation_data.action = bpy.data.actions[action_names[0]]
    rig["animation_clips"] = ",".join(action_names)
    rig.parent["animation_clips"] = ",".join(action_names)
    bpy.context.scene.frame_set(1)


def build_characters(h):
    """生成主角、总站调度员、两名店员和居民；返回可独立导出的资产。"""
    designs = [
        ("chr_courier", {"role": "courier", "shirt": "blue", "pants": "blue_dark", "cap": "blue"}),
        ("chr_dispatcher", {"role": "dispatcher", "shirt": "navy", "pants": "pants",
                            "cap": "navy", "cap_band": "blue_dark", "collar": "blue"}),
        ("chr_pizza_clerk", {"role": "pizza", "shirt": "red", "pants": "pants",
                             "cap": "red", "cap_band": "red", "collar": "cream"}),
        ("chr_music_clerk", {"role": "music", "shirt": "teal", "pants": "navy",
                             "collar": "teal", "skin": "skin_dark", "nose": "skin"}),
        ("chr_resident", {"role": "resident", "shirt": "coral", "pants": "olive",
                          "collar": "coral", "skin": "skin_light"}),
    ]
    assets = []
    for name, style in designs:
        asset, rig = _character(h, name, style)
        if name == "chr_courier":
            _animations(rig)
        assets.append(asset)
    return assets
