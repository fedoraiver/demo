"""核对验收进程输出中的配置、玩法初始化和场景装配日志。"""

import math
from pathlib import Path
import re

from driver import TYPES, assert_that, run
from gameplay import start_session, state
from menu import pause


CASES = {
    "LOG-04.two_scene_assemblies": "开始和重新开始各记录一次场景与三个不同方块，暂停恢复无额外装配。",
    "LOG-02.initialization_once": "玩法、固定时步和帧率的初始化各记录一次。",
    "LOG-03.fixed_configuration": "固定模拟启动日志为约 60 Hz，帧率日志对应当前设置。",
}

LOG_LINE = re.compile(r"^(\S+)\s+([A-Z]+)\s+(\S+):\s+(.*)$")


def read_events(path):
    contents = path.read_text(encoding="utf-8", errors="replace")
    events = []
    for number, line in enumerate(contents.splitlines(), 1):
        match = LOG_LINE.match(line)
        if match:
            timestamp, level, target, message = match.groups()
            events.append({"line": number, "timestamp": timestamp, "level": level, "target": target, "body": message})
    return events


def select(events, target, message):
    return [event for event in events if event["target"] == target
            and (event["body"] == message or event["body"].startswith(message + " "))]


def field(event, name):
    value = re.search(rf'(?:^|\s){re.escape(name)}=(?:"([^"\n]*)"|(\S+))', event["body"])
    return (value[1] if value[1] is not None else value[2]) if value else None


def exercise(game):
    log_path = Path(game.session["process_output"])

    with game.case("LOG-04.two_scene_assemblies") as evidence:
        first = start_session(game)
        pause(game)
        game.click("Resume")
        game.wait(lambda: state(game, "Running"), "恢复同一场景")
        pause(game)
        game.click("ReturnToMenu")
        game.wait(lambda: state(game, "MainMenu"), "返回主菜单等待再开始")
        second = start_session(game)
        expected_fps = game.resource(TYPES["game_settings"])["max_fps"]
        game.close()
        events = read_events(log_path)
        evidence.update(first_scene=first, second_scene=second, path=str(log_path))

        assemblies = select(events, "demo::scene", "Greybox session spawned")
        cubes = select(events, "demo::scene", "Greybox cube spawned")
        evidence.update(assemblies=assemblies, cubes=cubes)
        assert_that(len(assemblies) == 2 and len(cubes) == 6, "两次场景装配的记录数量不符")
        after = 0
        for assembly in assemblies:
            members = [cube for cube in cubes if after < cube["line"] < assembly["line"]]
            items = {field(cube, "item") for cube in members}
            assert_that(len(members) == 3 and len(items) == 3 and None not in items
                        and all(field(assembly, name) for name in ("ground", "character", "camera", "controller"))
                        and field(assembly, "reason") == "session_started",
                        "装配记录缺少三个不同方块或关键场景实体")
            after = assembly["line"]

    with game.case("LOG-02.initialization_once") as evidence:
        gameplay = select(events, "demo::gameplay", "Prototype gameplay initialized")
        clock = select(events, "demo::settings", "Fixed simulation timestep initialized")
        limiter = [item for item in select(events, "demo::settings", "Frame rate limit applied")
                   if field(item, "reason") == "initialization"]
        evidence.update(gameplay=gameplay, clock=clock, limiter=limiter)
        assert_that(all(len(entries) == 1 and entries[0]["level"] == "INFO"
                        for entries in (gameplay, clock, limiter)),
                    "玩法、固定时步或限帧的初始化记录与验收构建不符")

    with game.case("LOG-03.fixed_configuration") as evidence:
        frequency = field(clock[0], "simulation_hz")
        limit = field(limiter[0], "max_fps_after")
        evidence.update(logged_hz=frequency, active_max_fps=expected_fps, logged_max_fps=limit,
                        source_lines=[clock[0]["line"], limiter[0]["line"]])
        assert_that(frequency is not None and math.isclose(float(frequency), 60.0, abs_tol=0.01)
                    and limit == str(expected_fps), "固定时步或 FPS 日志与当前配置不符")


if __name__ == "__main__":
    raise SystemExit(run("session_log", CASES, exercise))
