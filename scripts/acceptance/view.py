"""以主窗口的键鼠消息验证观察方向、移动和离开平地。"""

import math

from driver import TYPES, assert_that, run
from physics import camera_view, motion, position, session_entities, start_session, state


CASES = {
    "PHYS-02.relative_yaw_pitch": "相对鼠标位移按当前灵敏度和纵轴配置改变偏航与俯仰。",
    "PHYS-02.pitch_limits": "向两侧持续输入时，俯仰分别止于 +85° 和 -85°。",
    "VIEW-01.wasd": "W、A、S、D 分别沿观察方向前进、左移、后退、右移，松键后停止。",
    "VIEW-05.fall_and_restart": "角色越过平地边缘后下落，回主菜单并重新开局后恢复初始场景。",
}


def exercise(game):
    with game.case("PHYS-02.relative_yaw_pitch") as evidence:
        original_scene = start_session(game)
        character, camera = original_scene["character"][0], original_scene["camera"][0]
        original_items = sorted(position(game, item) for item in original_scene["items"])
        before = camera_view(game, camera)
        camera_settings = game.resource(TYPES["game_settings"])["camera"]
        sensitivity = camera_settings["mouse_sensitivity"]
        pitch_sign = -1 if camera_settings["invert_y"] else 1
        delta = [0.16 / sensitivity, 0.11 / sensitivity]
        expected_yaw = (before["yaw"] - delta[0] * sensitivity) % math.tau
        expected_pitch = before["pitch"] + pitch_sign * delta[1] * sensitivity
        evidence.update(before=before, relative_motion=delta, camera_settings=camera_settings,
                        expected_angles=[expected_yaw, expected_pitch])
        game.mouse_motion(delta)

        def turned():
            current = camera_view(game, camera)
            yaw_error = abs(math.remainder(current["yaw"] - expected_yaw, math.tau))
            if yaw_error < 0.005 and abs(current["pitch"] - expected_pitch) < 0.005:
                return current
            return None

        evidence["after"] = game.wait(turned, "鼠标输入后的偏航和俯仰符合设置")

    with game.case("PHYS-02.pitch_limits") as evidence:
        limit = math.radians(85)
        evidence["observed"] = []
        for target in (limit, -limit):
            direction = math.copysign(1, target)
            large_motion = [0.0, direction * pitch_sign * (2 * limit + 0.1) / sensitivity]
            game.mouse_motion(large_motion)

            def clamped():
                current = camera_view(game, camera)
                return current if abs(current["pitch"] - target) < 0.001 else None

            observed = game.wait(clamped, f"俯仰停在 {math.degrees(target):.0f}°")
            game.mouse_motion(large_motion)
            # BRP 的消息写入在帧末处理，下一次客户端请求才能观察到输入消费后的值。
            final = camera_view(game, camera)
            evidence["observed"].append({"target": target, "first": observed, "repeated": final})
            assert_that(abs(final["pitch"] - target) < 0.001,
                        "继续向边界输入改变了俯仰限制")

    with game.case("VIEW-01.wasd") as evidence:
        yaw = camera_view(game, camera)["yaw"]
        forward = (-math.sin(yaw), -math.cos(yaw))
        right = (math.cos(yaw), -math.sin(yaw))
        directions = {
            "KeyW": forward,
            "KeyA": (-right[0], -right[1]),
            "KeyS": (-forward[0], -forward[1]),
            "KeyD": right,
        }
        evidence.update(yaw=yaw, movement={})
        for key, (x_direction, z_direction) in directions.items():
            start = motion(game, character)["position"]

            def moves_in_direction():
                current = motion(game, character)
                horizontal = (current["position"][0] - start[0], current["position"][2] - start[2])
                projected = horizontal[0] * x_direction + horizontal[1] * z_direction
                perpendicular = abs(horizontal[0] * z_direction - horizontal[1] * x_direction)
                evidence["movement"][key] = {
                    "start": start, "observed": current, "projection": projected,
                    "perpendicular": perpendicular,
                }
                return projected >= 0.22 and perpendicular < projected * 0.35

            game.key_down(key)
            try:
                game.wait(moves_in_direction, f"{key} 沿正确水平方向位移", timeout=4)
            finally:
                game.key_up(key)

            def stopped():
                current = motion(game, character)
                return current if math.hypot(current["velocity"][0], current["velocity"][2]) < 0.10 else None

            evidence["movement"][key]["stopped"] = game.wait(stopped, f"松开 {key} 后停下", timeout=4)
        final_yaw = camera_view(game, camera)["yaw"]
        assert_that(abs(math.remainder(final_yaw - yaw, math.tau)) < 0.01,
                    "移动键改变了镜头偏航")

    with game.case("VIEW-05.fall_and_restart") as evidence:
        start = motion(game, character)["position"]

        def below_ground():
            current = motion(game, character)
            evidence["last_position"] = current
            p = current["position"]
            return current if (max(abs(p[0]), abs(p[2])) > 20 and p[1] < start[1] - 0.5
                               and current["velocity"][1] < -0.5) else None

        game.key_down("KeyS")
        try:
            evidence["fall"] = game.wait(below_ground, "走出地面边缘并下落", timeout=15)
        finally:
            game.key_up("KeyS")
        game.tap("Escape")
        game.wait(lambda: state(game, "Paused"), "越出场景后仍可暂停")
        game.click("ReturnToMenu")
        game.wait(lambda: state(game, "MainMenu"), "回到主菜单")
        assert_that(not any(session_entities(game).values()), "离开后仍存在旧场景实体")
        new_scene = start_session(game)
        new_character, new_camera = new_scene["character"][0], new_scene["camera"][0]
        recreated = motion(game, new_character)
        new_view = camera_view(game, new_camera)
        new_items = sorted(position(game, item) for item in new_scene["items"])
        evidence.update(original_scene=original_scene, new_scene=new_scene, position=recreated["position"],
                        original_items=original_items, new_items=new_items, camera=new_view)
        assert_that(all(set(new_scene[kind]).isdisjoint(ids) for kind, ids in original_scene.items()),
                    "重开场景沿用了旧实体")
        assert_that(math.dist(recreated["position"], [0.0, 0.03, 2.0]) < 0.15
                    and all(math.dist(before, after) < 0.15 for before, after in zip(original_items, new_items))
                    and abs(new_view["pitch"]) < 0.001
                    and abs(math.remainder(new_view["yaw"], math.tau)) < 0.001,
                    "重开场景没有恢复角色出生位置、方块布局和初始镜头")


if __name__ == "__main__":
    raise SystemExit(run("view", CASES, exercise))
