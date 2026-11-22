"""通过设置界面验证草稿、验收配置写入和退出后恢复。"""

from driver import TYPES, assert_that, run
from menu import button_layout, menu_page


CASES = {
    "MENU-03.tabs": "设置的四个分类都可通过鼠标切换，保留 Apply 和 Back 控件。",
    "MENU-04.frame_rate_discard": "帧率调整只改变草稿，返回再打开时恢复当前生效值，配置文件未改动。",
    "MENU-04.frame_rate_apply": "Apply 更新生效的帧率和验收 TOML，提示 Settings applied.，保留其他设置。",
    "MENU-04.settings_restored": "游戏正常退出后恢复玩家设置文件原始字节，原文件缺失时恢复为缺失。",
}

FRAME_RATES = (60, 90, 120, 144, 165, 240)


def tab_open(game, tab):
    current = game.resource(TYPES["menu_state"])
    return current["page"] == "Settings" and current["tab"] == tab


def open_settings(game):
    game.click("OpenSettings")
    game.wait(lambda: tab_open(game, "Graphics"), "打开 Graphics 设置页")


def frame_rate_draft(game):
    return game.resource(TYPES["settings_draft"])["max_fps"]


def adjust_frame_rate(game, previous):
    # 用键盘聚焦当前页面里的真实按钮，短窗口由菜单滚动系统把控件移入视区。
    layout = button_layout(game)
    target = next(button for button in layout if button["action"] == {"Adjust": ["FrameRate", -1]})
    number_of_slots = max(button["index"] for button in layout) + 1
    current = game.resource(TYPES["menu_focus"])["index"]
    for _ in range((target["index"] - current) % number_of_slots):
        expected_focus = (current + 1) % number_of_slots
        game.tap("ArrowDown")
        game.wait(lambda: game.resource(TYPES["menu_focus"])["index"] == expected_focus,
                  "移动焦点到帧率控件")
        current = expected_focus

    higher = [fps for fps in FRAME_RATES if fps > previous]
    if higher:
        expected_fps, key = higher[0], "ArrowRight"
    else:
        expected_fps, key = max(fps for fps in FRAME_RATES if fps < previous), "ArrowLeft"
    game.tap(key)
    game.wait(lambda: frame_rate_draft(game) == expected_fps, f"草稿帧率切换到 {expected_fps}")
    return expected_fps


def exercise(game):
    with game.case("MENU-03.tabs") as evidence:
        open_settings(game)
        evidence["tabs"] = []
        for tab in ("Audio", "Controls", "Accessibility", "Graphics"):
            game.click({"SelectTab": tab})
            game.wait(lambda: tab_open(game, tab), f"切换到 {tab}")
            buttons = button_layout(game)
            apply_and_back = [button for button in buttons if button["action"] in ("ApplySettings", "Back")]
            evidence["tabs"].append({"tab": tab, "footer": apply_and_back})
            assert_that(len(apply_and_back) == 2 and all(min(button["size"]) > 0 for button in apply_and_back),
                        f"{tab} 页缺少完成布局的 Apply 或 Back")

    with game.case("MENU-04.frame_rate_discard") as evidence:
        original = game.resource(TYPES["game_settings"])
        original_fps = original["max_fps"]
        assert_that(frame_rate_draft(game) == original_fps, "打开设置后草稿与生效帧率不同")
        adjusted_fps = adjust_frame_rate(game, original_fps)
        after_adjust = game.resource(TYPES["game_settings"])
        evidence.update(initial_fps=original_fps, draft_fps=adjusted_fps, live_after_adjust=after_adjust["max_fps"])
        assert_that(after_adjust == original, "草稿调整改动了生效设置")
        game.tap("Escape")
        game.wait(lambda: menu_page(game, "Main"), "放弃草稿回到主菜单")
        open_settings(game)
        evidence["draft_after_reopen"] = frame_rate_draft(game)
        assert_that(evidence["draft_after_reopen"] == original_fps, "重新开设置时保留了未应用的草稿")
        game.settings.verify_prepared()

    with game.case("MENU-04.frame_rate_apply") as evidence:
        expected_fps = adjust_frame_rate(game, original_fps)
        game.settings.verify_prepared()
        evidence["target_fps"] = expected_fps
        game.click("ApplySettings")

        def applied():
            live = game.resource(TYPES["game_settings"])
            status = game.resource(TYPES["menu_state"])["status"]
            evidence.update(live=live, status=status)
            if live["max_fps"] == expected_fps and status == "Settings applied.":
                return live
            return None

        live = game.wait(applied, "生效帧率和 Apply 提示已更新")
        # 确认磁盘版本后再作业务字段断言，有失败也能按确实写出的版本收尾。
        evidence["saved"] = game.settings.confirm(live)
        expected = dict(original, max_fps=expected_fps)
        assert_that(live == expected, "应用帧率草稿改动了其他生效设置")

    with game.case("MENU-04.settings_restored") as evidence:
        evidence["exit_code"] = game.close()
        evidence["restoration"] = game.settings.restore()
        assert_that(evidence["exit_code"] == 0, "恢复配置前游戏未正常退出")


if __name__ == "__main__":
    raise SystemExit(run("settings", CASES, exercise))
