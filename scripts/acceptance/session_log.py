"""核对本次真实进程的正式会话日志、正常退出与重启隔离。"""

import math
from pathlib import Path
import re

from driver import TYPES, assert_that, run
from menu import pause
from physics import start_session, state


CASES = {
    "LOG-01.session_start": "会话日志开始记录中的 ID、路径和版本对应本次进程。",
    "LOG-04.two_scene_assemblies": "开始和重新开始各记录一次场景与三个不同方块，暂停恢复无额外装配。",
    "LOG-02.initialization_once": "玩法、固定时步和帧率的初始化各记录一次，验收构建不注册检查器。",
    "LOG-03.fixed_configuration": "固定模拟启动日志为约 60 Hz，帧率日志对应当前设置。",
    "LOG-10.normal_exit_record": "优雅关闭返回 0，日志完整刷新且最后一条记录为本次会话的正常退出。",
    "LOG-06.restart_file_isolation": "再次启动使用新会话 ID 和新日志文件，原有会话文件字节不变。",
}

LOG_LINE = re.compile(r"^(\S+)\s+([A-Z]+)\s+(\S+):\s+(.*)$")


def read_events(path):
    contents = path.read_text(encoding="utf-8")
    events = []
    for number, line in enumerate(contents.splitlines(), 1):
        match = LOG_LINE.match(line)
        if match:
            timestamp, level, target, message = match.groups()
            events.append({"line": number, "timestamp": timestamp, "level": level, "target": target, "body": message})
    return contents, events


def select(events, target, message):
    return [event for event in events if event["target"] == target
            and (event["body"] == message or event["body"].startswith(message + " "))]


def field(event, name):
    value = re.search(rf'(?:^|\s){re.escape(name)}=(?:"([^"\n]*)"|(\S+))', event["body"])
    return (value[1] if value[1] is not None else value[2]) if value else None


def verify_normal_exit(events, contents, session_id, exit_code):
    matches = select(events, "demo::session_log", "Session exited normally")
    assert_that(exit_code == 0 and len(matches) == 1, "缺少唯一的正常退出记录或进程退出异常")
    event = matches[0]
    assert_that(field(event, "session_id") == session_id and field(event, "reason") == "AppExit::Success",
                "退出记录中的会话 ID 或退出原因错误")
    assert_that(event["line"] == len(contents.splitlines()) and contents.endswith("\n"),
                "退出记录后还有内容，或日志尾部没有完整刷新")
    return event


def exercise(game):
    first_path, first_id, first_pid = game.log_path, game.session_id, game.pid

    with game.case("LOG-01.session_start") as evidence:
        def opened():
            contents, events = read_events(first_path)
            starts = select(events, "demo::session_log", "Session started")
            return (contents, starts) if starts else None

        contents, starts = game.wait(opened, "正式会话日志已记录启动")
        evidence.update(path=str(first_path), pid=first_pid, session_id=first_id, entries=starts)
        assert_that(len(starts) == 1 and starts[0]["level"] == "INFO" and "\x1b[" not in contents,
                    "日志启动记录缺失、重复或含颜色控制字符")
        start = starts[0]
        logged_path = re.search(r"\spath=(.*?)\sversion=", start["body"])
        assert_that(field(start, "session_id") == first_id and field(start, "version")
                    and field(start, "bevy_version") and logged_path
                    and Path(logged_path[1]).name == first_path.name,
                    "日志开始记录中的会话 ID、路径或版本与运行不符")

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
        first_exit = game.close()
        first_text, first_events = read_events(first_path)
        evidence.update(first_scene=first, second_scene=second, path=str(first_path))

        assemblies = select(first_events, "demo::scene", "Greybox session spawned")
        cubes = select(first_events, "demo::scene", "Greybox cube spawned")
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
        gameplay = select(first_events, "demo::gameplay", "Prototype gameplay initialized")
        clock = select(first_events, "demo::settings", "Fixed simulation timestep initialized")
        limiter = [item for item in select(first_events, "demo::settings", "Frame rate limit applied")
                   if field(item, "reason") == "initialization"]
        inspector = select(first_events, "demo::inspector", "World inspector enabled")
        evidence.update(gameplay=gameplay, clock=clock, limiter=limiter, inspector=inspector)
        assert_that(all(len(entries) == 1 and entries[0]["level"] == "INFO"
                        for entries in (gameplay, clock, limiter)) and not inspector,
                    "玩法、设置或检查器的初始化记录与验收构建不符")

    with game.case("LOG-03.fixed_configuration") as evidence:
        frequency = field(clock[0], "simulation_hz")
        limit = field(limiter[0], "max_fps_after")
        evidence.update(logged_hz=frequency, active_max_fps=expected_fps, logged_max_fps=limit,
                        source_lines=[clock[0]["line"], limiter[0]["line"]])
        assert_that(frequency is not None and math.isclose(float(frequency), 60.0, abs_tol=0.01)
                    and limit == str(expected_fps), "固定时步或 FPS 日志与当前配置不符")

    with game.case("LOG-10.normal_exit_record") as evidence:
        event = verify_normal_exit(first_events, first_text, first_id, first_exit)
        evidence.update(path=str(first_path), exit_code=first_exit, entry=event)

    with game.case("LOG-06.restart_file_isolation") as evidence:
        original_bytes = first_path.read_bytes()
        game.start()
        second_path, second_id, second_pid = game.log_path, game.session_id, game.pid
        second_exit = game.close()
        second_text, second_events = read_events(second_path)
        evidence.update(first={"path": str(first_path), "id": first_id, "pid": first_pid},
                        second={"path": str(second_path), "id": second_id, "pid": second_pid})
        assert_that(second_path != first_path and second_id != first_id, "重启时复用了旧会话日志")
        assert_that(first_path.read_bytes() == original_bytes, "后续会话改写了旧日志")
        starts = select(second_events, "demo::session_log", "Session started")
        assert_that(len(starts) == 1 and field(starts[0], "session_id") == second_id,
                    "新日志未记录新进程的会话 ID")
        evidence["second_exit"] = verify_normal_exit(second_events, second_text, second_id, second_exit)


if __name__ == "__main__":
    raise SystemExit(run("session_log", CASES, exercise))
