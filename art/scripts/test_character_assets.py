"""真实主角 GLB 的离线契约与破坏性对照；只修改内存副本，不启动 Blender 或游戏。"""

from copy import deepcopy
import math
from pathlib import Path
import unittest

from validate_assets import Glb, InvalidGlb


BASE = Path(__file__).resolve().parents[2]


class CourierAssetTests(unittest.TestCase):
    """以运行资产为样本，确认常见导出退化确实被验证器拒绝。"""

    @classmethod
    def setUpClass(cls):
        cls.original = Glb(BASE / "assets/models/characters/chr_courier.glb")
        for index in range(len(cls.original.document["accessors"])):
            cls.original.accessor(index)

    def model(self):
        return deepcopy(self.original)

    def animation(self, model, name):
        return next(animation for animation in model.document["animations"] if animation["name"] == name)

    def output(self, model, animation, bone, path):
        """隔离共享访问器与采样器，保证坏样本只破坏指定动作中的单一通道。"""
        index = next(index for index, node in enumerate(model.document["nodes"]) if node.get("name") == bone)
        channel = next(channel for channel in animation["channels"] if channel["target"] == {"node": index, "path": path})
        sampler = deepcopy(animation["samplers"][channel["sampler"]])
        animation["samplers"].append(sampler)
        channel["sampler"] = len(animation["samplers"]) - 1
        accessor = sampler["output"]
        isolated = len(model.document["accessors"])
        model.document["accessors"].append(deepcopy(model.document["accessors"][accessor]))
        model.cache[isolated] = deepcopy(model.accessor(accessor))
        sampler["output"] = isolated
        return model.cache[isolated]

    def test_real_courier_satisfies_directional_animation_contract(self):
        result = self.original.check()
        self.assertEqual(len(result["courier_animation_contract"]["clips"]), 16)
        self.assertEqual(result["courier_animation_contract"]["clips"]["Jump"]["playback"], "once")
        self.assertEqual(result["courier_animation_contract"]["clips"]["Fall"]["playback"], "loop")

    def test_static_jump_cannot_pass_as_a_one_shot(self):
        model = self.model()
        animation = self.animation(model, "Jump")
        # 全部通道改成首帧常量，确认缺失收腿动作会被明确拦截。
        for channel in list(animation["channels"]):
            target = channel["target"]
            bone = model.document["nodes"][target["node"]]["name"]
            values = self.output(model, animation, bone, target["path"])
            values[:] = [values[0]] * len(values)
        with self.assertRaisesRegex(InvalidGlb, "one-shot animation lacks distinct endpoint poses"):
            model.check_courier_animations()

    def test_landing_skinning_detects_ground_penetration(self):
        model = self.model()
        for name in ("Land", "Carry_Land"):
            values = self.output(model, self.animation(model, name), "hips", "translation")
            for index, row in enumerate(values):
                values[index] = (row[0], row[1] - 0.1, row[2])
        with self.assertRaisesRegex(InvalidGlb, "shoe penetrates ground"):
            model.check_courier_animations()

    def test_missing_direction_is_rejected(self):
        model = self.model()
        model.document["animations"].remove(self.animation(model, "Walk_Left"))
        with self.assertRaisesRegex(InvalidGlb, "animation names do not match"):
            model.check_courier_animations()

    def test_missing_bone_channel_is_rejected(self):
        model = self.model()
        animation = self.animation(model, "Walk")
        channel = next(channel for channel in animation["channels"] if channel["target"]["path"] == "translation")
        animation["channels"].remove(channel)
        with self.assertRaisesRegex(InvalidGlb, "lacks full-bone coverage"):
            model.check_courier_animations()

    def test_nonzero_animation_start_is_rejected(self):
        model = self.model()
        animation = self.animation(model, "Walk")
        sampler = animation["samplers"][animation["channels"][0]["sampler"]]
        original = sampler["input"]
        accessor = len(model.document["accessors"])
        model.document["accessors"].append(deepcopy(model.document["accessors"][original]))
        model.cache[accessor] = [(row[0] + 1 / 30,) for row in model.accessor(original)]
        sampler["input"] = accessor
        with self.assertRaisesRegex(InvalidGlb, "duration must be 0.8 seconds"):
            model.check_courier_animations()

    def test_contact_marker_detached_from_foot_is_rejected(self):
        model = self.model()
        index = next(index for index, node in enumerate(model.document["nodes"]) if node.get("name") == "Courier_Sole_L_0")
        model.parents[index] = next(index for index, node in enumerate(model.document["nodes"]) if node.get("name") == "root")
        with self.assertRaisesRegex(InvalidGlb, "sole contact marker has wrong parent"):
            model.check_courier_animations()

    def test_open_loop_is_rejected(self):
        model = self.model()
        values = self.output(model, self.animation(model, "Walk"), "root", "translation")
        values[-1] = (values[-1][0] + 0.01, *values[-1][1:])
        with self.assertRaisesRegex(InvalidGlb, "animation loop is open"):
            model.check_courier_animations()

    def test_closed_loop_root_displacement_is_rejected(self):
        model = self.model()
        values = self.output(model, self.animation(model, "Walk"), "root", "translation")
        for index, row in enumerate(values):
            values[index] = (row[0] + 0.01, *row[1:])
        with self.assertRaisesRegex(InvalidGlb, "root motion"):
            model.check_courier_animations()

    def test_scaling_deformation_is_rejected(self):
        model = self.model()
        values = self.output(model, self.animation(model, "Walk"), "spine", "scale")
        for index, row in enumerate(values):
            values[index] = tuple(value * 1.1 for value in row)
        with self.assertRaisesRegex(InvalidGlb, "scale deformation"):
            model.check_courier_animations()

    def test_hip_cannot_bypass_static_root_with_horizontal_motion(self):
        model = self.model()
        values = self.output(model, self.animation(model, "Walk"), "hips", "translation")
        for index, row in enumerate(values):
            values[index] = (row[0] + 0.05, row[1], row[2])
        with self.assertRaisesRegex(InvalidGlb, "horizontal hip root motion"):
            model.check_courier_animations()

    def test_carry_lower_body_phase_change_is_rejected(self):
        model = self.model()
        values = self.output(model, self.animation(model, "Carry_Walk"), "thigh.L", "rotation")
        for index, row in enumerate(values):
            row = (row[0] + 0.025, *row[1:])
            length = math.sqrt(sum(value * value for value in row))
            values[index] = tuple(value / length for value in row)
        with self.assertRaisesRegex(InvalidGlb, "Carry lower-body phase differs"):
            model.check_courier_animations()

    def test_renamed_forward_clip_is_not_a_directional_action(self):
        model = self.model()
        walk, left = self.animation(model, "Walk"), self.animation(model, "Walk_Left")
        left["channels"], left["samplers"] = deepcopy(walk["channels"]), deepcopy(walk["samplers"])
        # 保持对应持箱动作也同步，避免先被持箱一致性检查拦住。
        carry_walk, carry_left = self.animation(model, "Carry_Walk"), self.animation(model, "Carry_Left")
        carry_left["channels"], carry_left["samplers"] = deepcopy(carry_walk["channels"]), deepcopy(carry_walk["samplers"])
        with self.assertRaisesRegex(InvalidGlb, "identical lower-body motion"):
            model.check_courier_animations()

    def test_skinning_detects_ground_penetration(self):
        model = self.model()
        # 本地 hips +Y 对应导出世界 +Y；空手与持箱都下移，单独检验鞋底几何。
        for name in ("Walk", "Carry_Walk"):
            values = self.output(model, self.animation(model, name), "hips", "translation")
            for index, row in enumerate(values):
                values[index] = (row[0], row[1] - 0.1, row[2])
        with self.assertRaisesRegex(InvalidGlb, "shoe penetrates ground"):
            model.check_courier_animations()


if __name__ == "__main__":
    unittest.main()
