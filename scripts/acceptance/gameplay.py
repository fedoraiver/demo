"""验收脚本共用的玩法场景、输入操作和状态读取。"""

import math

from driver import TYPES, assert_that


def entities(game, kind, *, strict=True):
    return [row["entity"] for row in game.query(with_=(TYPES[kind],), strict=strict)]


def state(game, wanted):
    return game.resource(TYPES["app_state"]) == wanted


def session_entities(game, *, strict=True):
    return {
        "character": entities(game, "character", strict=strict),
        "items": entities(game, "item", strict=strict),
        "camera": entities(game, "first_person_camera", strict=strict),
        "ground": [
            row["entity"] for row in game.query(TYPES["name"])
            if row["components"][TYPES["name"]] == "Greybox ground"
        ],
    }


def camera_view(game, entity):
    return game.get(entity, TYPES["first_person_camera"])[TYPES["first_person_camera"]]


def camera_sample(game, camera):
    components = game.get(camera, TYPES["first_person_camera"], TYPES["transform"])
    transform = components[TYPES["transform"]]
    x, y, z, w = transform["rotation"]
    # Bevy 相机沿局部 -Z 观察，使用实际旋转四元数计算世界方向。
    forward = [-2 * (x * z + w * y), 2 * (w * x - y * z), 2 * (x * x + y * y) - 1]
    return {"view": components[TYPES["first_person_camera"]], "forward": forward,
            "translation": transform["translation"]}


def look_relative(game, camera, delta, *, reached, description, timeout=None):
    """发送相对鼠标位移，等待调用方指定的镜头状态。"""
    game.mouse_motion(delta)

    def observed():
        sample = camera_sample(game, camera)
        return sample if reached(sample) else None

    return game.wait(observed, description, timeout=timeout)


def position(game, entity):
    return game.get(entity, TYPES["position"])[TYPES["position"]]


def motion(game, character, *, include_intent=False):
    types = [TYPES["character_motion"], TYPES["position"], TYPES["linear_velocity"]]
    if include_intent:
        types.append(TYPES["character_intent"])
    components = game.get(character, *types)
    sample = _motion(components)
    if include_intent:
        sample["movement"] = components[TYPES["character_intent"]]["movement"]
    return sample


def _motion(components):
    return {
        "grounded": components[TYPES["character_motion"]]["grounded"],
        "position": components[TYPES["position"]],
        "velocity": components[TYPES["linear_velocity"]],
    }


def start_session(game):
    game.click("StartGame")
    game.wait(lambda: state(game, "Running"), "进入玩法")
    scene = session_entities(game)
    counts = {kind: len(entity_ids) for kind, entity_ids in scene.items()}
    assert_that(counts == {"character": 1, "items": 3, "camera": 1, "ground": 1},
                f"实际场景实体数量 {counts}")
    camera = scene["camera"][0]

    def capture_active():
        capture = game.get(camera, TYPES["mouse_look_state"])[TYPES["mouse_look_state"]]
        return capture["active"] and not capture["skip_motion"]

    game.wait(capture_active, "玩法捕获鼠标")
    return scene


def prepare_edge_start(game, character, evidence):
    """将已停稳角色移到平地正 Z 边缘内侧，等物理状态和呈现位置同步。"""
    fixture = {"method": "world.insert_components", "entity": character}
    evidence["fixture"] = fixture

    def settled(label, target=None):
        components = game.get(
            character, TYPES["character_motion"], TYPES["position"],
            TYPES["linear_velocity"], TYPES["transform"],
        )
        sample = _motion(components)
        sample["translation"] = components[TYPES["transform"]]["translation"]
        fixture[label] = sample
        if (sample["grounded"] and math.hypot(*sample["velocity"]) < 0.10
                and math.dist(sample["translation"], sample["position"]) < 0.05
                and (target is None or math.dist(sample["position"], target) < 0.05)):
            return sample
        return None

    before = game.wait(lambda: settled("before"), "角色接地并在场景内停稳")
    target = [0.0, before["position"][1], 18.5]
    velocity = [0.0, 0.0, 0.0]
    fixture["target"] = {"position": target, "velocity": velocity}
    # 只设置物理初始条件，由固定模拟与插值更新接地和呈现位置。
    game.call(fixture["method"], {
        "entity": character,
        "components": {TYPES["position"]: target, TYPES["linear_velocity"]: velocity},
    })
    return game.wait(lambda: settled("readback", target), "角色在平地边缘内侧接地并停稳")
