"""以主窗口的键鼠消息验证观察方向、移动和离开平地。"""

import math

from driver import TYPES, assert_that, run
from gameplay import (
    camera_sample, camera_view, look_relative, motion, position, prepare_edge_start,
    session_entities, start_session, state,
)


CASES = {
    "PHYS-02.relative_yaw_pitch": "单轴鼠标位移按当前灵敏度和纵轴配置改变视角及相机实际朝向。",
    "PHYS-02.pitch_limits": "两侧俯仰分别止于 +85° 和 -85°，确认重复输入被消费后仍在边界。",
    "VIEW-01.wasd": "W、A、S、D 产生对应移动意图及相对视线的水平位移，松键后停止。",
    "VIEW-05.fall_and_restart": "从 BRP 准备的边缘内侧走出平地，下落后经菜单重开并恢复初始场景。",
}

ANGLE_TOLERANCE = 0.005
PITCH_LIMIT_TOLERANCE = 0.001
CAPTURE_POSITION_TOLERANCE_M = 0.05
BELOW_FLOOR_MARGIN_M = 0.25


def yaw_matches(actual, expected):
    return abs(math.remainder(actual - expected, math.tau)) < ANGLE_TOLERANCE


def reaches_angles(sample, yaw, pitch):
    view = sample["view"]
    return yaw_matches(view["yaw"], yaw) and abs(view["pitch"] - pitch) < ANGLE_TOLERANCE


def capture_observation(game, evidence, name, *, expected, read_state, stable, trigger=None):
    """记录截取窗口画面前后的状态，供逐张核对关键画面。"""
    observation = {"expected": expected, "capture_status": "unavailable", "review_status": "unverified"}
    if trigger is not None:
        observation["trigger"] = trigger
    evidence.setdefault("visual_observations", {})[name] = observation
    try:
        observation["before"] = read_state()
        observation["screenshot"] = game.screenshot(f"view-{name}.png")
        observation["after"] = read_state()
    except (Exception, KeyboardInterrupt) as error:
        observation["error"] = str(error) or type(error).__name__
        raise
    if stable(observation["before"], observation["after"]):
        observation.update(capture_status="ready", review_status="pending")
    else:
        observation["capture_status"] = "unstable"


def stable_view(before, after):
    from_camera, to_camera = before["camera"], after["camera"]
    from_body, to_body = before["character"], after["character"]
    return (before["app_state"] == after["app_state"]
            and before["window_focused"] and after["window_focused"]
            and math.dist(from_camera["forward"], to_camera["forward"]) < ANGLE_TOLERANCE
            and math.dist(from_camera["translation"], to_camera["translation"]) < CAPTURE_POSITION_TOLERANCE_M
            and math.dist(from_body["position"], to_body["position"]) < CAPTURE_POSITION_TOLERANCE_M
            and from_body["grounded"] == to_body["grounded"]
            and from_body["movement"] == to_body["movement"] == [0, 0])


def observe_view(game, character, camera, evidence, name, *, expected, view, app_state="Running", trigger=None):
    def read_state():
        window = game.get(game.window, TYPES["window"])[TYPES["window"]]
        return {
            "window_focused": window["focused"],
            "app_state": game.resource(TYPES["app_state"]),
            "camera": {"entity": camera, **camera_sample(game, camera)},
            "character": {"entity": character, **motion(game, character, include_intent=True)},
        }

    def matches_checkpoint(before, after):
        return (before["app_state"] == app_state
                and reaches_angles(before["camera"], view["yaw"], view["pitch"])
                and reaches_angles(after["camera"], view["yaw"], view["pitch"])
                and stable_view(before, after))

    capture_observation(game, evidence, name, expected=expected, read_state=read_state,
                        stable=matches_checkpoint, trigger=trigger)


def wait_for_standing(game, character):
    def standing():
        current = motion(game, character)
        return current["grounded"] and math.hypot(*current["velocity"]) < 0.10

    game.wait(standing, "截图前角色接地停稳")


def check_relative_look(game, character, camera, sensitivity, pitch_sign, evidence):
    wait_for_standing(game, character)
    aim(game, camera, 0.0, 0.0, sensitivity, pitch_sign)
    observe_view(game, character, camera, evidence, "look-before",
                 expected="默认平视下，地平线和至少一只灰盒箱体可见。",
                 view={"yaw": 0.0, "pitch": 0.0})
    before = camera_sample(game, camera)
    evidence["motions"] = steps = []
    shots = (
        ("look-horizontal", 0.16 / sensitivity, 0.0, "水平输入后，箱体在画面中向左移动，地平线高度保持。"),
        ("look-vertical", 0.0, 0.11 / sensitivity,
         f"垂直输入后，地平线随相机俯仰向{'上' if pitch_sign > 0 else '下'}移动。"),
    )
    for name, dx, dy, expected in shots:
        yaw = (before["view"]["yaw"] - dx * sensitivity) % math.tau
        pitch = before["view"]["pitch"] + dy * sensitivity * pitch_sign
        forward = [-math.sin(yaw) * math.cos(pitch), -math.sin(pitch), -math.cos(yaw) * math.cos(pitch)]
        step = {"before": before, "delta": [dx, dy], "expected_angles": [yaw, pitch],
                "expected_forward": forward}
        steps.append(step)

        def reached(sample):
            step["observed"] = sample
            return reaches_angles(sample, yaw, pitch)

        after = look_relative(game, camera, [dx, dy], reached=reached,
                              description="单轴鼠标位移改变对应视角")
        assert_that(math.dist(after["forward"], forward) < ANGLE_TOLERANCE,
                    "相机实际朝向与鼠标输入对应的角度不一致")
        observe_view(game, character, camera, evidence, name, expected=expected, view=after["view"],
                     trigger={"mouse_delta": [dx, dy]})
        before = after


def check_pitch_limits(game, camera, sensitivity, pitch_sign, evidence):
    limit = math.radians(85)
    evidence["observed"] = steps = []
    for target in (limit, -limit):
        dy = math.copysign(2 * limit + 0.1, target) * pitch_sign / sensitivity
        step = {"target": target, "first_delta": [0.0, dy], "repeated_delta": [0.03 / sensitivity, dy]}
        steps.append(step)

        def clamped(sample):
            step["first"] = sample
            return abs(sample["view"]["pitch"] - target) < PITCH_LIMIT_TOLERANCE

        observed = look_relative(
            game, camera, step["first_delta"], reached=clamped,
            description=f"俯仰停在 {math.degrees(target):.0f}°",
        )
        expected_yaw = (observed["view"]["yaw"] - 0.03) % math.tau

        # BRP 可以在同一帧处理写入和读取。用同一条消息带来的偏航变化确认二次输入已消费。
        def repeated_motion_applied(sample):
            step["repeated"] = sample
            return yaw_matches(sample["view"]["yaw"], expected_yaw)

        final = look_relative(
            game, camera, step["repeated_delta"], reached=repeated_motion_applied,
            description="边界处的重复鼠标输入已经消费",
        )
        assert_that(abs(final["view"]["pitch"] - target) < PITCH_LIMIT_TOLERANCE,
                    "继续向边界输入改变了俯仰限制")


def aim(game, camera, yaw, pitch, sensitivity, pitch_sign):
    before = camera_view(game, camera)
    dx = math.remainder(before["yaw"] - yaw, math.tau) / sensitivity
    dy = (pitch - before["pitch"]) * pitch_sign / sensitivity
    return look_relative(game, camera, [dx, dy], reached=lambda sample: reaches_angles(sample, yaw, pitch),
                         description="鼠标转向达到目标角度")


def check_wasd(game, character, camera, facing, evidence):
    yaw = facing["view"]["yaw"]
    forward = (-math.sin(yaw), -math.cos(yaw))
    right = (math.cos(yaw), -math.sin(yaw))
    directions = {
        "KeyW": ([0, 1], forward),
        "KeyA": ([-1, 0], (-right[0], -right[1])),
        "KeyS": ([0, -1], (-forward[0], -forward[1])),
        "KeyD": ([1, 0], right),
    }
    appearances = {
        "KeyW": ("wasd-w-stopped", "沿视线前进后，靠近的可见箱体变大，俯仰保持。"),
        "KeyA": ("wasd-a-stopped", "向左横移后，箱体相对上一张画面向右移动，镜头朝向保持。"),
    }
    evidence.update(facing=facing, movement={})
    observe_view(game, character, camera, evidence, "wasd-before",
                 expected="移动前，斜向平地中可见可用来比较位移的箱体。", view=facing["view"])
    for key, (intent, (x_direction, z_direction)) in directions.items():
        start = motion(game, character)["position"]
        step = {"start": start, "expected_intent": intent, "expected_direction": [x_direction, z_direction]}
        evidence["movement"][key] = step

        def moves_in_direction():
            current = motion(game, character, include_intent=True)
            dx = current["position"][0] - start[0]
            dz = current["position"][2] - start[2]
            projected = dx * x_direction + dz * z_direction
            perpendicular = abs(dx * z_direction - dz * x_direction)
            step.update(observed=current, projection=projected, perpendicular=perpendicular)
            return current["movement"] == intent and projected >= 0.22 and perpendicular < projected * 0.35

        with game.hold_key(key):
            game.wait(moves_in_direction, f"{key} 产生对应意图及水平位移", timeout=4)

        def stopped():
            current = motion(game, character, include_intent=True)
            step["after_release"] = current
            x_velocity, _, z_velocity = current["velocity"]
            return current["movement"] == [0, 0] and math.hypot(x_velocity, z_velocity) < 0.10

        game.wait(stopped, f"松开 {key} 后意图归零并停止", timeout=4)
        step["yaw_after_release"] = camera_view(game, camera)["yaw"]
        assert_that(yaw_matches(step["yaw_after_release"], yaw), f"{key} 改变了镜头偏航")
        if key in appearances:
            name, expected = appearances[key]
            observe_view(game, character, camera, evidence, name, expected=expected, view=facing["view"],
                         trigger={"key": key})


def fall_from_edge(game, character, evidence, *, before_walk=None):
    start = prepare_edge_start(game, character, evidence)["position"]
    if before_walk is not None:
        before_walk()

    def below_ground():
        current = motion(game, character)
        evidence["last_position"] = current
        _, height, z_position = current["position"]
        if z_position > 20.0 and height <= start[1] - 0.5 and current["velocity"][1] < -0.5:
            return current
        return None

    with game.hold_key("KeyS"):
        evidence["fall"] = game.wait(below_ground, "走出地面边缘并下落", timeout=15)


def pause_below_floor(game, character, camera, evidence):
    floor_height = evidence["fixture"]["readback"]["position"][1]

    def below_floor():
        current = camera_sample(game, camera)
        evidence["camera_during_fall"] = current
        return current["translation"][1] < floor_height - BELOW_FLOOR_MARGIN_M

    game.wait(below_floor, "实际镜头降到地面以下", timeout=5)
    game.tap("Escape")
    game.wait(lambda: state(game, "Paused"), "越出场景后仍可暂停")
    observe_view(game, character, camera, evidence, "fall-paused",
                 expected="暂停覆盖层下方可见平台侧面或边缘，镜头已经低于平台顶面。",
                 view=evidence["facing"]["view"], app_state="Paused",
                 trigger={"movement": "KeyS", "pause": "Escape"})


def exercise(game):
    with game.case("PHYS-02.relative_yaw_pitch") as evidence:
        original_scene = start_session(game)
        character, camera = original_scene["character"][0], original_scene["camera"][0]
        original_items = sorted(position(game, item) for item in original_scene["items"])
        camera_settings = game.resource(TYPES["game_settings"])["camera"]
        sensitivity = camera_settings["mouse_sensitivity"]
        pitch_sign = -1 if camera_settings["invert_y"] else 1
        evidence["camera_settings"] = camera_settings
        check_relative_look(game, character, camera, sensitivity, pitch_sign, evidence)

    with game.case("PHYS-02.pitch_limits") as evidence:
        check_pitch_limits(game, camera, sensitivity, pitch_sign, evidence)

    with game.case("VIEW-01.wasd") as evidence:
        facing = aim(game, camera, 0.6, 0.25, sensitivity, pitch_sign)
        check_wasd(game, character, camera, facing, evidence)

    with game.case("VIEW-05.fall_and_restart") as evidence:
        evidence["facing"] = aim(game, camera, 0.0, 0.0, sensitivity, pitch_sign)

        def observe_edge():
            observe_view(game, character, camera, evidence, "fall-edge",
                         expected="角色在接地的场地边缘内侧面向场内，灰盒地面在视线下方。",
                         view=evidence["facing"]["view"],
                         trigger={"fixture": "world.insert_components"})

        fall_from_edge(game, character, evidence, before_walk=observe_edge)
        pause_below_floor(game, character, camera, evidence)
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
        wait_for_standing(game, new_character)
        observe_view(game, new_character, new_camera, evidence, "fall-restarted",
                     expected="重回默认出生视角，地平线和灰盒箱体恢复，暂停覆盖层消失。",
                     view=new_view,
                     trigger={"actions": ["ReturnToMenu", "StartGame"]})


if __name__ == "__main__":
    raise SystemExit(run("view", CASES, exercise))
