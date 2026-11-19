"""验证真实菜单输入、暂停隔离和游戏会话切换。"""

import math

from driver import TYPES, assert_that, run
from physics import camera_view, entities, motion, position, session_entities, start_session, state


CASES = {
    "MENU-01.main_menu_ready": "启动时只有主菜单相机，四个可操作按钮已完成布局，玩法实体尚未创建。",
    "MENU-02.keyboard_navigation": "方向键改变菜单焦点，Enter 打开所选帮助页，Esc 返回。",
    "MENU-02.mouse_help_and_back": "鼠标点击打开帮助页和返回主菜单，保存实际帮助页截图。",
    "MENU-07.start_game_scene": "点击开始后，主菜单相机消失，生成一名角色、三个方块、一块地面和一台玩法相机。",
    "MENU-07.pause_input_isolation": "腾空时暂停释放光标，按键和鼠标位移不改变角色、镜头或方块状态。",
    "MENU-08.resume_session": "从暂停页打开帮助后返回，恢复原场景并继续模拟与鼠标捕获。",
    "MENU-09.restart_session": "回到主菜单清理旧场景，再次开始生成一套全新场景。",
}


def menu_page(game, expected):
    return game.resource(TYPES["menu_state"])["page"] == expected


def button_layout(game):
    rows = game.query(TYPES["menu_button"], TYPES["computed_node"])
    return [
        {
            "entity": row["entity"],
            "action": row["components"][TYPES["menu_button"]]["action"],
            "index": row["components"][TYPES["menu_button"]]["index"],
            "size": row["components"][TYPES["computed_node"]]["size"],
        }
        for row in rows
    ]


def pause(game):
    game.tap("Escape")
    game.wait(lambda: state(game, "Paused") and menu_page(game, "Pause"), "暂停页已打开")


def exercise(game):
    with game.case("MENU-01.main_menu_ready") as evidence:
        game.wait(lambda: state(game, "MainMenu") and menu_page(game, "Main"), "主菜单出现")
        expected_actions = {"StartGame", "OpenSettings", "OpenHelp", "Quit"}

        def laid_out():
            layout = button_layout(game)
            return layout if (len(layout) == 4 and {item["action"] for item in layout} == expected_actions
                              and all(min(item["size"]) > 0 for item in layout)) else None

        main_buttons = game.wait(laid_out, "主菜单四个按钮具备可点击布局")
        menu_cameras = entities(game, "camera")
        # 实体首次生成前，部分反射组件还没有注册进 World 的组件表。
        scene = session_entities(game, strict=False)
        evidence.update(buttons=main_buttons, menu_cameras=menu_cameras, scene=scene)
        assert_that(len(menu_cameras) == 1 and not any(scene.values()), "主菜单已有玩法实体或相机叠加")

    with game.case("MENU-02.keyboard_navigation") as evidence:
        target = next(button["index"] for button in main_buttons if button["action"] == "OpenHelp")
        current = game.resource(TYPES["menu_focus"])["index"]
        evidence["focus_indices"] = [current]
        # 启动时鼠标恰好位于帮助按钮上，也要经过一次完整的键盘导航。
        steps = (target - current) % len(main_buttons) or len(main_buttons)
        for _ in range(steps):
            expected = (current + 1) % len(main_buttons)
            game.tap("ArrowDown")
            game.wait(lambda: game.resource(TYPES["menu_focus"])["index"] == expected
                      and game.resource(TYPES["menu_input_source"]) == "Navigation", "方向键改变焦点")
            current = expected
            evidence["focus_indices"].append(current)
        game.tap("Enter")
        game.wait(lambda: menu_page(game, "Help"), "Enter 打开帮助页")
        game.tap("Escape")
        game.wait(lambda: menu_page(game, "Main"), "Esc 返回主菜单")

    with game.case("MENU-02.mouse_help_and_back") as evidence:
        game.click("OpenHelp")
        game.wait(lambda: menu_page(game, "Help"), "鼠标点击打开帮助页")
        evidence["screenshot"] = game.screenshot("help.png")
        game.click("Back")
        game.wait(lambda: menu_page(game, "Main"), "鼠标点击返回主菜单")

    with game.case("MENU-07.start_game_scene") as evidence:
        original = start_session(game)
        evidence["scene"] = original
        assert_that(entities(game, "camera") == original["camera"], "主菜单相机在玩法场景中残留")
        character, camera = original["character"][0], original["camera"][0]

    with game.case("MENU-07.pause_input_isolation") as evidence:
        game.wait(lambda: motion(game, character)["grounded"], "角色接地后准备起跳")
        game.tap("Space")

        def rising():
            current = motion(game, character)
            return not current["grounded"] and current["velocity"][1] > 0.2

        game.wait(rising, "起跳后腾空")
        pause(game)
        frozen = motion(game, character)
        before_view = camera_view(game, camera)
        before_items = {item: position(game, item) for item in original["items"]}
        evidence.update(before=frozen, before_view=before_view, before_items=before_items)
        assert_that(not frozen["grounded"], "暂停时角色已落地")
        assert_that(game.get(game.window, TYPES["cursor_options"])[TYPES["cursor_options"]]["visible"],
                    "暂停时光标未显示")
        game.key_down("KeyW")
        try:
            game.tap("Space")
            game.tap("KeyE")
            game.mouse_motion([37.0, -23.0])
            current = motion(game, character)
            current_view = camera_view(game, camera)
            current_items = {item: position(game, item) for item in original["items"]}
            held = entities(game, "held_target")
            evidence.update(after=current, after_view=current_view, after_items=current_items, held_items=held)
            assert_that(current == frozen and current_view == before_view and current_items == before_items
                        and not held and state(game, "Paused"), "暂停时游戏输入改变了玩法状态")
        finally:
            game.key_up("KeyW")
        evidence["screenshot"] = game.screenshot("pause.png")

    with game.case("MENU-08.resume_session") as evidence:
        game.click("OpenHelp")
        game.wait(lambda: menu_page(game, "Help"), "从暂停打开帮助页")
        game.tap("Escape")
        game.wait(lambda: state(game, "Paused") and menu_page(game, "Pause"), "从帮助返回暂停")
        assert_that(session_entities(game) == original and motion(game, character) == frozen,
                    "帮助往返改变了暂停场景")
        game.click("Resume")
        game.wait(lambda: state(game, "Running"), "恢复玩法")

        def captured_and_landed():
            captured = game.get(camera, TYPES["mouse_look_state"])[TYPES["mouse_look_state"]]["active"]
            current = motion(game, character)
            return current if captured and current["grounded"] else None

        landed = game.wait(captured_and_landed, "恢复鼠标捕获并继续模拟直至落地")
        view_after = camera_view(game, camera)
        evidence.update(scene=session_entities(game), landed=landed, view_after=view_after)
        assert_that(evidence["scene"] == original, "恢复时替换了旧场景实体")
        assert_that(abs(math.remainder(view_after["yaw"] - before_view["yaw"], math.tau)) < 0.01
                    and abs(view_after["pitch"] - before_view["pitch"]) < 0.01,
                    "恢复时消费了暂停期间的鼠标位移")

    with game.case("MENU-09.restart_session") as evidence:
        pause(game)
        game.click("ReturnToMenu")
        game.wait(lambda: state(game, "MainMenu") and menu_page(game, "Main"), "回到主菜单")
        after_cleanup = session_entities(game)
        evidence["after_cleanup"] = after_cleanup
        assert_that(not any(after_cleanup.values()) and len(entities(game, "camera")) == 1,
                    "返回主菜单后仍存在旧场景实体或相机")
        second = start_session(game)
        evidence.update(first_scene=original, second_scene=second)
        assert_that(all(set(second[kind]).isdisjoint(previous) for kind, previous in original.items()),
                    "再次开始时保留了旧场景的实体")


if __name__ == "__main__":
    raise SystemExit(run("menu", CASES, exercise))
