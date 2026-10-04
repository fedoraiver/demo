"""快递员全方向原地动作：烘焙接触约束，运行时只需标准 glTF 骨骼动画。"""

from math import cos, pi, sin, sqrt

import bpy
from mathutils import Matrix, Vector


CLIPS = (
    "Idle", "Walk", "Walk_Backward", "Walk_Left", "Walk_Right",
    "Carry_Idle", "Carry_Walk", "Carry_Backward", "Carry_Left", "Carry_Right",
    "Jump", "Fall", "Carry_Jump", "Carry_Fall", "Land", "Carry_Land",
)
ONE_SHOT_CLIPS = {"Jump", "Carry_Jump", "Land", "Carry_Land"}
FPS = 30
CYCLE_FRAMES = 24
GROUND_CLEARANCE = .012


def add_sole_markers(rig):
    """四角保守包住鞋底，导出骨骼子节点供 ECS 在混合求值后做同帧接地补偿。"""
    rig.animation_data_create()
    rig.animation_data.action = None
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    for obj in list(rig.children):
        if obj.name.startswith("Courier_Sole_"):
            bpy.data.objects.remove(obj, do_unlink=True)
    collection = rig.parent.users_collection[0]
    for side, sign in (("L", 1), ("R", -1)):
        for index, (x, y) in enumerate(((-.0765, -.067), (-.0765, .205),
                                        (.0765, -.067), (.0765, .205))):
            marker = bpy.data.objects.new(f"Courier_Sole_{side}_{index}", None)
            collection.objects.link(marker)
            marker.parent = rig
            marker.parent_type = "BONE"
            marker.parent_bone = "foot." + side
            marker.empty_display_size = .015
            bpy.context.view_layer.update()
            marker.matrix_world = rig.matrix_world @ Matrix.Translation((sign * .116 + x, y, 0))
            bpy.context.view_layer.update()


def _bone_matrix(bone, head, tail):
    """沿骨骼原轴旋转，不拉伸刚性蒙皮；局部 roll 保持与源骨架一致。"""
    rest_direction = bone.tail_local - bone.head_local
    rotation = rest_direction.rotation_difference(tail - head).to_matrix()
    result = (rotation @ bone.matrix_local.to_3x3()).to_4x4()
    result.translation = head
    return result


def _leg(rig, side, ankle, hip_offset):
    """解析双骨链，将鞋底保持水平；膝盖朝人物前方，避免侧步反折。"""
    thigh = rig.data.bones["thigh." + side]
    shin = rig.data.bones["shin." + side]
    foot = rig.data.bones["foot." + side]
    hip = thigh.head_local + Vector((0, 0, hip_offset))
    delta = ankle - hip
    distance = delta.length
    length_a, length_b = thigh.length, shin.length
    if distance >= length_a + length_b:
        raise ValueError(f"Unreachable foot target: {side}, distance={distance:.5f}")
    direction = delta.normalized()
    pole = Vector((0, 1, 0))
    bend = (pole - direction * pole.dot(direction)).normalized()
    along = (length_a**2 - length_b**2 + distance**2) / (2 * distance)
    knee = hip + direction * along + bend * sqrt(max(0, length_a**2 - along**2))
    rig.pose.bones[thigh.name].matrix = _bone_matrix(thigh, hip, knee)
    bpy.context.view_layer.update()
    rig.pose.bones[shin.name].matrix = _bone_matrix(shin, knee, ankle)
    bpy.context.view_layer.update()
    # 足部保持静止姿态的世界旋转；真正抬脚只在摆动相，不把脚尖压入地面。
    matrix = foot.matrix_local.copy()
    matrix.translation = ankle
    rig.pose.bones[foot.name].matrix = matrix
    bpy.context.view_layer.update()


def _foot_path(progress, stride):
    """支撑半周期匀速后撤，摆动半周期平滑回摆；左右脚相差半个循环。"""
    if progress < .5:
        return stride * (.5 - 2 * progress), 0.0
    swing = (progress - .5) * 2
    return -stride * .5 * cos(pi * swing), .105 * sin(pi * swing)**2


def _pose(rig, label, progress):
    phase = 2 * pi * progress
    wave = sin(phase)
    carry = label.startswith("Carry_")
    motion = label.removeprefix("Carry_")
    moving = motion in ("Walk", "Backward", "Left", "Right", "Walk_Backward", "Walk_Left", "Walk_Right")
    backward = motion in ("Backward", "Walk_Backward")
    lateral = motion in ("Left", "Right", "Walk_Left", "Walk_Right")
    airborne = motion in ("Jump", "Fall")
    landing = motion == "Land"
    ease = progress * progress * (3 - 2 * progress)
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    # 站立呼吸不移动髋部，防止鞋底随呼吸上下穿地。所有持箱动作复用下肢。
    hip_offset = -.11 if lateral else (-.075 if moving else 0.0)
    if landing:
        # 落地从屈膝缓冲逐渐回到站姿；足部 IK 保证下蹲时鞋底仍贴近地面。
        hip_offset = GROUND_CLEARANCE - .12 * (1 - ease)
    elif airborne:
        hip_offset = GROUND_CLEARANCE
    rig.pose.bones["hips"].location.y = hip_offset
    bpy.context.view_layer.update()
    if moving:
        direction = Vector((0, -1 if backward else 1, 0))
        if lateral:
            direction = Vector((-1 if motion.endswith("Left") else 1, 0, 0))
        targets = []
        for side, sign, offset in (("L", 1, 0), ("R", -1, .5)):
            travel, lift = _foot_path((progress + offset) % 1, .44 if lateral else .60)
            ankle = Vector((sign * (.23 if lateral else .116), 0, .115 + GROUND_CLEARANCE + lift))
            ankle += direction * travel
            targets.append((side, ankle))
        # 侧移时保留鞋宽间隙；斜向融合也使用同一左右脚相位，不交叉换脚。
        if lateral and targets[0][1].x - targets[1][1].x < .18:
            center = (targets[0][1].x + targets[1][1].x) / 2
            targets[0][1].x, targets[1][1].x = center + .09, center - .09
        for side, ankle in targets:
            _leg(rig, side, ankle, hip_offset)
    elif landing:
        for side, sign in (("L", 1), ("R", -1)):
            _leg(rig, side, Vector((sign * .116, 0, .115 + GROUND_CLEARANCE)), hip_offset)
    elif airborne:
        # Jump 是一次性的伸展→收腿→放松，不循环重播收腿；Fall 维持准备触地的轻动态姿态。
        tuck = sin(pi * progress)**2 if motion == "Jump" else 0.0
        for side, sign in (("L", 1), ("R", -1)):
            rig.pose.bones["thigh." + side].rotation_euler.x = (
                .16 * ease + .30 * tuck if motion == "Jump" else .16 + .015 * wave)
            rig.pose.bones["shin." + side].rotation_euler.x = (
                -.28 * ease - .38 * tuck if motion == "Jump" else -.28 - .02 * wave)
            rig.pose.bones["foot." + side].rotation_euler.x = -.08 * (ease if motion == "Jump" else 1)
    else:
        # 与步行接地余量一致，混入站立时鞋底不会下沉。
        rig.pose.bones["hips"].location.y = GROUND_CLEARANCE
    if carry:
        # 上身稳定，双手不会随步相位大幅摆动，箱体仍由原物理持握控制。
        for side in ("L", "R"):
            rig.pose.bones["upper_arm." + side].rotation_euler.x = 1.06
            rig.pose.bones["forearm." + side].rotation_euler.x = .61
            rig.pose.bones["hand." + side].rotation_euler.x = -.19
        body_bend = -.018 * (1 - ease) if landing else 0.0
        rig.pose.bones["spine"].rotation_euler.x = -.035 + body_bend + (.004 * wave if not landing else 0)
        rig.pose.bones["head"].rotation_euler.x = .035 - body_bend - (.004 * wave if not landing else 0)
    else:
        for side, sign in (("L", 1), ("R", -1)):
            step = cos(phase + (0 if sign == 1 else pi))
            arm = -.24 * step * (-1 if backward else 1) if moving else 0.0
            if motion == "Jump":
                arm = .25 * ease + .12 * tuck
            elif motion == "Fall":
                arm = .25 + .025 * wave
            elif landing:
                arm = .18 * (1 - ease)
            rig.pose.bones["upper_arm." + side].rotation_euler.x = arm
            rig.pose.bones["forearm." + side].rotation_euler.x = .10 + (.04 * max(0, step) if moving else .01 * wave)
        body_bend = -.055 * (1 - ease) if landing else 0.0
        rig.pose.bones["spine"].rotation_euler.x = -.025 if moving else body_bend + (.012 * wave if not landing else 0)
        rig.pose.bones["head"].rotation_euler.x = .025 if moving else -body_bend - (.006 * wave if not landing else 0)


def build_actions(rig):
    """替换此骨架的动作；步行和下落循环闭环，起跳与落地保持各自的终点姿态。"""
    old_actions = set()
    if rig.animation_data:
        if rig.animation_data.action:
            old_actions.add(rig.animation_data.action)
        for track in rig.animation_data.nla_tracks:
            old_actions.update(strip.action for strip in track.strips if strip.action)
    rig.animation_data_clear()
    for action in old_actions:
        if action.users <= int(action.use_fake_user):
            bpy.data.actions.remove(action)
    rig.animation_data_create()
    for bone in rig.pose.bones:
        bone.rotation_mode = "XYZ"
    bpy.context.scene.render.fps = FPS
    bpy.context.scene.render.fps_base = 1
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = CYCLE_FRAMES + 1
    actions = []
    for label in CLIPS:
        action = bpy.data.actions.new(label)
        action.use_fake_user = True
        rig.animation_data.action = action
        for frame in range(1, CYCLE_FRAMES + 2):
            # 求骨骼矩阵时禁用半成品 Action，避免 depsgraph 回放首帧并覆盖刚写入的髋部姿态。
            rig.animation_data.action = None
            progress = (frame - 1) / CYCLE_FRAMES
            if label not in ONE_SHOT_CLIPS:
                progress %= 1
            _pose(rig, label, progress)
            rig.animation_data.action = action
            for bone in rig.pose.bones:
                bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=bone.name)
                bone.keyframe_insert(data_path="location", frame=frame, group=bone.name)
                bone.keyframe_insert(data_path="scale", frame=frame, group=bone.name)
        # Action 槽 API 兼容当前 Blender；线性键防止 Bezier 在接地相过冲。
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"
        track = rig.animation_data.nla_tracks.new()
        track.name = label
        strip = track.strips.new(label, 1, action)
        strip.mute = True
        strip.extrapolation = "NOTHING"
        actions.append(action)
    rig.animation_data.action = actions[0]
    rig["animation_clips"] = ",".join(CLIPS)
    rig.parent["animation_clips"] = ",".join(CLIPS)
    rig["locomotion_cycle_seconds"] = CYCLE_FRAMES / FPS
    rig["forward_reference_speed_mps"] = 1.5
    rig["lateral_reference_speed_mps"] = 1.1
    bpy.context.scene.frame_set(1)
    return actions
