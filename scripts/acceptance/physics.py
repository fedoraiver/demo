"""以实际游戏输入验证灰盒场景、起跳和拿放。"""

import math
import time

from driver import TYPES, assert_that, run
from gameplay import camera_view, motion, position, start_session


CASES = {
    "PHYS-01.initial_scene": "一块地面、一名接地角色、三个方块和一个第一人称相机，初始眼位高于脚底 1.65 m。",
    "PHYS-04.single_jump": "长按空格，从地面起跳一次，随后落地并保持接地。",
    "PHYS-05.pickup": "按 E 后仅最近的初始方块建立持有目标并被抬起。",
    "PHYS-06.release": "松开再按 E 后同一方块解除持有并落回地面。",
}


def exercise(game):
    with game.case("PHYS-01.initial_scene") as evidence:
        scene = start_session(game)
        character, camera = scene["character"][0], scene["camera"][0]

        def on_ground():
            current = motion(game, character)
            return current if current["grounded"] else None

        standing = game.wait(on_ground, "初始角色接地")
        evidence.update(scene=scene, standing=standing)
        transforms = [game.get(entity, TYPES["transform"])[TYPES["transform"]]
                      for entity in (character, camera)]
        eye_height = transforms[1]["translation"][1] - transforms[0]["translation"][1]
        view = camera_view(game, camera)
        evidence.update(eye_height=eye_height, yaw=view["yaw"], pitch=view["pitch"])
        assert_that(math.isclose(eye_height, 1.65, abs_tol=0.02)
                    and math.isclose(view["eye_height"], 1.65, abs_tol=0.0001),
                    f"相机眼位高度为 {eye_height:.3f} m")
        assert_that(abs(view["yaw"]) < 0.001 and abs(view["pitch"]) < 0.001,
                    f"初始相机角度为 {view}")
        evidence["screenshot"] = game.screenshot("game.png")

    with game.case("PHYS-04.single_jump") as evidence:
        def rising():
            current = motion(game, character)
            return current if (not current["grounded"] and current["velocity"][1] > 0.5
                               and current["position"][1] > standing["position"][1] + 0.08) else None

        game.key_down("Space")
        try:
            evidence["rise"] = game.wait(rising, "观察起跳和向上速度")
            landing = game.wait(on_ground, "保持空格按下并落地")
            evidence["landing"] = landing
            held_until = time.monotonic() + 0.28
            while time.monotonic() < held_until:
                after = motion(game, character)
                evidence["after_landing"] = after
                assert_that(after["grounded"] and after["velocity"][1] < 0.5
                            and abs(after["position"][1] - landing["position"][1]) < 0.04,
                            "持续按住空格时落地后再次离开地面")
        finally:
            game.key_up("Space")

    with game.case("PHYS-05.pickup") as evidence:
        item_positions = {item: position(game, item) for item in scene["items"]}
        player_position = position(game, character)
        nearest = min(item_positions, key=lambda item: math.dist(player_position, item_positions[item]))
        original = item_positions[nearest]
        evidence.update(entity=nearest, original=original)
        game.tap("KeyE")

        def lifted_item():
            held = game.query(TYPES["held_target"], TYPES["position"], with_=(TYPES["item"],))
            if len(held) == 1 and held[0]["entity"] == nearest:
                values = held[0]["components"]
                if values[TYPES["position"]][1] > original[1] + 0.10:
                    return values
            return None

        evidence["held"] = game.wait(lifted_item, "初始最近方块建立持有并被抬高")

    with game.case("PHYS-06.release") as evidence:
        held_position = position(game, nearest)
        evidence.update(entity=nearest, from_position=held_position)
        game.tap("KeyE")

        def landed_item():
            if game.query(TYPES["held_target"], with_=(TYPES["item"],)):
                return None
            values = game.get(nearest, TYPES["position"], TYPES["linear_velocity"])
            current = values[TYPES["position"]]
            velocity = values[TYPES["linear_velocity"]]
            if current[1] < held_position[1] - 0.10 and abs(velocity[1]) < 0.08:
                return {"position": current, "velocity": velocity}
            return None

        evidence["released"] = game.wait(landed_item, "释放方块后自然下落并停止竖向运动")


if __name__ == "__main__":
    raise SystemExit(run("physics", CASES, exercise))
