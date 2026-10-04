"""低多边形岛屿居民：独立角色资产、可导出骨架和主角循环动作。"""


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


def _animations(rig):
    """主角动作由统一接触约束工具生成，完整重建与单角色导出共用同一来源。"""
    from courier_actions import add_sole_markers, build_actions
    add_sole_markers(rig)
    build_actions(rig)


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
