"""验收脚本共用的游戏进程、BRP 输入和逐项报告。"""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import time
import tomllib

from brp import BrpClient, HOST, PORT, ProcessMismatch, SCREENSHOT, UniformScreenshot, screenshot_png
from settings_file import SettingsBackup, shared_settings_path


ROOT = Path(__file__).resolve().parents[2]
ACCEPTANCE_DOCUMENT = ROOT / "docs/testing/app-acceptance.md"
STARTUP_SETTINGS = b"[game.audio]\nmaster_volume = 0\n"
CATEGORIES = {
    "menu": "菜单与暂停",
    "settings": "设置",
    "physics": "物理交互",
    "view": "人物移动与镜头",
    "session_log": "会话日志",
}
CASE_ROW = re.compile(r"^\| \*\*([A-Z]+-\d{2}\.[a-z0-9_]+)\*\* \| (脚本|待实现) \| (.+?) \|")
TYPES = {
    "app_state": "bevy_state::state::resources::State<demo::game_flow::AppState>",
    "menu_state": "demo::ui::MenuState",
    "menu_focus": "demo::ui::MenuFocus",
    "menu_input_source": "demo::ui::MenuInputSource",
    "menu_button": "demo::ui::MenuButton",
    "settings_draft": "demo::settings::draft::SettingsDraft",
    "game_settings": "demo::settings::config::GameSettings",
    "session_log": "demo::session_log::lifecycle::SessionLogInfo",
    "primary_window": "bevy_window::window::PrimaryWindow",
    "window": "bevy_window::window::Window",
    "cursor_options": "bevy_window::window::CursorOptions",
    "window_event": "bevy_window::event::WindowEvent",
    "window_close": "bevy_window::event::WindowCloseRequested",
    "computed_node": "bevy_ui::ui_node::ComputedNode",
    "ui_global_transform": "bevy_ui::ui_transform::UiGlobalTransform",
    "hovered": "bevy_picking::hover::Hovered",
    "keyboard_input": "bevy_input::keyboard::KeyboardInput",
    "mouse_button_input": "bevy_input::mouse::MouseButtonInput",
    "mouse_motion": "bevy_input::mouse::MouseMotion",
    "keys": "bevy_input::button_input::ButtonInput<bevy_input::keyboard::KeyCode>",
    "mouse_buttons": "bevy_input::button_input::ButtonInput<bevy_input::mouse::MouseButton>",
    "character": "demo::character::components::Character",
    "character_intent": "demo::character::components::CharacterIntent",
    "character_motion": "demo::character::components::CharacterMotion",
    "position": "avian3d::physics_transform::transform::Position",
    "linear_velocity": "avian3d::dynamics::rigid_body::LinearVelocity",
    "item": "demo::item_interaction::components::Item",
    "held_target": "demo::item_interaction::components::HeldTarget",
    "first_person_camera": "demo::first_person::FirstPersonCamera",
    "mouse_look_state": "demo::first_person::MouseLookState",
    "camera": "bevy_camera::camera::Camera",
    "render_target": "bevy_camera::camera::RenderTarget",
    "transform": "bevy_transform::components::transform::Transform",
    "name": "bevy_ecs::name::Name",
}


class EnvironmentBlocked(RuntimeError):
    pass


def assert_that(condition, message):
    if not condition:
        raise AssertionError(message)


def document_cases(document=ACCEPTANCE_DOCUMENT):
    """从验收表读取子项编号与状态，说明留在文档中维护。"""
    by_title = {title: name for name, title in CATEGORIES.items()}
    cases = {name: {} for name in CATEGORIES}
    seen = set()
    category = None
    for line in document.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            category = by_title.get(line[3:])
        match = CASE_ROW.match(line)
        if match:
            identifier, status, expected = match.groups()
            if category is None or identifier in seen:
                raise ValueError(f"Invalid acceptance document entry: {identifier}")
            cases[category][identifier] = (status, expected)
            seen.add(identifier)
    return cases


@contextmanager
def worktree_lock(path):
    # 五个脚本共享一个监听端口。进程退出时操作系统释放锁。
    with path.open("a+b") as lock:
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise EnvironmentBlocked("Another acceptance script is using this worktree") from error
        yield


class Game:
    def __init__(self, category, args, report):
        self.category = category
        self.args = args
        self.report = report
        self.output = args.output.resolve()
        self.process = None
        self.client = None
        self.window = None
        self.screenshot_target = None
        self.keys = set()
        self.buttons = set()
        self.settings = None
        self.session_id = None
        self.log_path = None
        self.session = None

    @property
    def pid(self):
        return self.process.pid

    @contextmanager
    def case(self, identifier):
        check = self.report["checks"][identifier]
        try:
            yield check["evidence"]
        except (EnvironmentBlocked, KeyboardInterrupt) as error:
            check.update(status="blocked", error=str(error) or type(error).__name__)
            raise
        except Exception as error:
            check.update(status="failed", error=f"{type(error).__name__}: {error}")
            raise
        else:
            check["status"] = "passed"

    def wait(self, predicate, description, timeout=None):
        deadline = time.monotonic() + (self.args.timeout if timeout is None else timeout)
        while True:
            result = predicate()
            if result:
                return result
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out waiting for {description}")
            time.sleep(0.03)

    def prepare_settings(self):
        try:
            path = shared_settings_path()
            backup = path.with_name("settings.acceptance-recovery.json")
            self.report["environment"]["settings_file"] = str(path)
            self.settings = SettingsBackup(path, backup)
            self.settings.stage(STARTUP_SETTINGS)
        except FileExistsError as error:
            raise EnvironmentBlocked(f"Settings recovery record already exists: {error.filename}") from error
        except (OSError, RuntimeError) as error:
            raise EnvironmentBlocked(f"Could not prepare shared settings: {error}") from error

    def start(self):
        if self.process is not None and self.process.poll() is None:
            raise RuntimeError("Game is already running")
        executable = self.args.exe.resolve()
        if not executable.is_file():
            raise EnvironmentBlocked(f"Missing acceptance-test executable: {executable}")
        try:
            prepared = self.settings.verify_prepared()
            master_volume = tomllib.loads(prepared.data.decode("utf-8"))["game"]["audio"]["master_volume"]
        except (OSError, RuntimeError, ValueError, KeyError, TypeError) as error:
            raise EnvironmentBlocked(f"Could not verify startup settings in {self.settings.path}: {error}") from error
        if type(master_volume) is not int or master_volume != 0:
            raise EnvironmentBlocked(f"Expected master_volume = 0 before launch in {self.settings.path}, got {master_volume!r}")
        self.window = self.screenshot_target = self.session_id = self.log_path = None
        environment = dict(os.environ, BEVY_ASSET_ROOT=str(ROOT), RUST_LOG="info")
        number = len(self.report["sessions"]) + 1
        output = self.output / f"{self.category}-process-{number}.log"
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        with output.open("wb") as console:
            self.process = subprocess.Popen([str(executable)], cwd=ROOT, env=environment,
                                            stdout=console, stderr=console, **options)
        self.client = BrpClient(self.process)
        self.session = {"pid": self.pid, "process_output": str(output), "command": [str(executable)]}
        self.report["sessions"].append(self.session)

        def connect():
            try:
                return self.resource(TYPES["session_log"])
            except ProcessMismatch as error:
                raise EnvironmentBlocked(str(error)) from error
            except (ConnectionError, TimeoutError):
                return None

        try:
            session_log = self.wait(connect, f"native BRP at {HOST}:{PORT}")
        except TimeoutError as error:
            raise EnvironmentBlocked(f"{error}; build the game with the acceptance-test feature") from error
        self.session_id = session_log["id"]
        self.log_path = (ROOT / session_log["path"]).resolve()
        assert_that(self.log_path.is_relative_to(ROOT / "logs"), "Session log is outside this worktree")
        self.session.update(session_id=self.session_id, session_log=str(self.log_path))
        windows = self.wait(lambda: self.query(TYPES["window"], with_=(TYPES["primary_window"],)),
                            "logical input window")
        assert_that(len(windows) == 1, f"Expected one logical input window; observed {len(windows)}")
        window = windows[0]["components"][TYPES["window"]]
        assert_that(not window["visible"] and window["focused"], "Expected a focused, invisible logical window")
        self.window = windows[0]["entity"]
        live_master_volume = self.resource(TYPES["game_settings"])["audio"]["master_volume"]
        self.session["startup_master_volume"] = live_master_volume
        if type(live_master_volume) is not int or live_master_volume != master_volume:
            raise EnvironmentBlocked(f"Game loaded master volume {live_master_volume!r}, expected {master_volume}")
        self.screenshot_target = self.wait(self.offscreen_target, "offscreen camera")
        resolution = window["resolution"]
        self.session["viewport"] = {key: resolution[key] for key in ("physical_width", "physical_height")}

    def offscreen_target(self):
        rows = self.query(TYPES["render_target"], with_=(TYPES["camera"],))
        targets = [row["components"][TYPES["render_target"]] for row in rows]
        if not targets or any("Image" not in target for target in targets):
            return None
        assert_that(all(target == targets[0] for target in targets), "Cameras use different offscreen targets")
        return targets[0]

    def call(self, method, params=None):
        return self.client.call(method, params)

    def query(self, *components, with_=(), strict=True):
        return self.call("world.query", {"data": {"components": list(components)},
                                         "filter": {"with": list(with_)}, "strict": strict})

    def get(self, entity, *components):
        return self.call("world.get_components", {"entity": entity, "components": list(components), "strict": True})

    def resource(self, type_path):
        return self.call("world.get_resources", {"resource": type_path})["value"]

    def _message(self, type_path, value):
        self.call("world.write_message", {"message": type_path, "value": value})

    def _window_value(self):
        return self.get(self.window, TYPES["window"])[TYPES["window"]]

    def _focused_window(self):
        window = self._window_value()
        if not window["focused"]:
            raise EnvironmentBlocked("The logical input window is unfocused")
        return window

    def _pressed(self, resource):
        return self.resource(resource)["pressed"]

    def _keyboard(self, code, state):
        text = code[-1].lower() if code.startswith("Key") else (" " if code == "Space" else None)
        logical = {"Character": text} if code.startswith("Key") else code
        self._message(TYPES["keyboard_input"], {"key_code": code, "logical_key": logical, "state": state,
                                                "text": text if state == "Pressed" else None,
                                                "repeat": False, "window": self.window})

    def key_down(self, code):
        self._focused_window()
        if code in self._pressed(TYPES["keys"]):
            raise EnvironmentBlocked(f"{code} was already held before injection")
        self.keys.add(code)
        self._keyboard(code, "Pressed")
        self.wait(lambda: code in self._pressed(TYPES["keys"]), f"{code} pressed")

    def key_up(self, code):
        self._keyboard(code, "Released")
        self.wait(lambda: code not in self._pressed(TYPES["keys"]), f"{code} released")
        self.keys.discard(code)

    @contextmanager
    def hold_key(self, code):
        already_owned = code in self.keys
        try:
            self.key_down(code)
            yield
        finally:
            # 按下请求发出后即由本脚本负责释放，即使未收到消费确认。
            if not already_owned and code in self.keys:
                self.key_up(code)

    def tap(self, code):
        self.key_down(code)
        self.key_up(code)

    def mouse_motion(self, delta):
        self._focused_window()
        self._message(TYPES["mouse_motion"], {"delta": list(delta)})

    def move_cursor(self, physical):
        resolution = self._focused_window()["resolution"]
        scale = resolution.get("scale_factor_override") or resolution["scale_factor"]
        self.call("world.mutate_components", {"entity": self.window, "component": TYPES["window"],
                                               "path": "internal.physical_cursor_position", "value": list(physical)})
        logical = [value / scale for value in physical]
        self._message(TYPES["window_event"], {"CursorMoved": {"window": self.window, "position": logical, "delta": None}})

    def button(self, action):
        matches = [row for row in self.query(TYPES["menu_button"], TYPES["computed_node"], TYPES["ui_global_transform"])
                   if row["components"][TYPES["menu_button"]]["action"] == action]
        assert_that(len(matches) <= 1, f"Expected one button for {action}; observed {len(matches)}")
        if matches and min(matches[0]["components"][TYPES["computed_node"]]["size"]) > 0:
            return matches[0]
        return None

    def _mouse_button(self, button, state):
        value = {"button": button, "state": state, "window": self.window}
        self._message(TYPES["mouse_button_input"], value)
        self._message(TYPES["window_event"], {"MouseButtonInput": value})

    def click(self, action):
        row = self.wait(lambda: self.button(action), f"layout of {action}")
        physical = row["components"][TYPES["ui_global_transform"]][-2:]
        self.move_cursor(physical)
        self.wait(lambda: self.get(row["entity"], TYPES["hovered"])[TYPES["hovered"]], f"hover on {action}")
        if "Left" in self._pressed(TYPES["mouse_buttons"]):
            raise EnvironmentBlocked("Left mouse button was already held before injection")
        self.buttons.add("Left")
        self._mouse_button("Left", "Pressed")
        self.wait(lambda: "Left" in self._pressed(TYPES["mouse_buttons"]), "Left button pressed")
        self._mouse_button("Left", "Released")
        self.wait(lambda: "Left" not in self._pressed(TYPES["mouse_buttons"]), "Left button released")
        self.buttons.discard("Left")

    def screenshot(self, name):
        deadline = time.monotonic() + self.args.timeout
        uniform_frames = 0
        with self.client.screenshot_events() as read:
            while time.monotonic() < deadline:
                entity = self.call("world.spawn_entity", {"components": {SCREENSHOT: self.screenshot_target}})["entity"]
                image = read(entity, deadline - time.monotonic())
                try:
                    png, dimensions = screenshot_png(image, require_content=True)
                except UniformScreenshot:
                    # 渲染管线仍在准备时，可能只能捕获清屏颜色。
                    uniform_frames += 1
                else:
                    break
            else:
                raise TimeoutError(f"No rendered content for {name} after {uniform_frames} uniform frames")
        path = self.output / name
        path.write_bytes(png)
        return {"path": str(path), "dimensions": dimensions, "entity": entity, "uniform_frames_skipped": uniform_frames}

    def close(self):
        if self.process.poll() is None:
            for code in sorted(self.keys):
                self.key_up(code)
            for button in sorted(self.buttons):
                self._mouse_button(button, "Released")
                self.wait(lambda: button not in self._pressed(TYPES["mouse_buttons"]), f"{button} released", 3)
                self.buttons.discard(button)
            self._message(TYPES["window_close"], {"window": self.window})
        code = self.process.wait(timeout=15)
        self.client.close()
        self.session["exit_code"] = code
        assert_that(code == 0, f"Game exited with code {code}")
        return code

    def cleanup(self):
        errors = []
        if self.process is not None:
            try:
                if self.process.poll() is None:
                    if self.window is None:
                        self.process.kill()
                        self.session["forced_termination"] = True
                    else:
                        self.close()
            except (Exception, KeyboardInterrupt) as error:
                errors.append(f"Closing game: {type(error).__name__}: {error}")
                if self.process.poll() is None:
                    self.process.kill()
                    self.session["forced_termination"] = True
            finally:
                self.client.close()
            try:
                self.session["exit_code"] = self.process.wait(timeout=15)
            except (Exception, KeyboardInterrupt) as error:
                errors.append(f"Waiting for game exit: {type(error).__name__}: {error}")
        if self.settings is not None:
            try:
                if self.process is not None and self.process.poll() is None:
                    raise RuntimeError("Game is still running")
                self.report["settings_restoration"] = {"status": "passed", **self.settings.restore()}
            except (Exception, KeyboardInterrupt) as error:
                errors.append(f"Restoring settings: {type(error).__name__}: {error}")
                self.report["settings_restoration"] = {"status": "failed", "backup": str(self.settings.backup)}
        return errors


def run(category, cases, exercise):
    """启动一个类别的验收，将每条断言及其证据写入报告。"""
    parser = argparse.ArgumentParser(description=CATEGORIES[category])
    executable = "demo.exe" if os.name == "nt" else "demo"
    parser.add_argument("--exe", type=Path, default=ROOT / "target/debug" / executable)
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/automation")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    if not 0 < args.timeout < float("inf"):
        parser.error("--timeout must be a finite positive number")

    documented = document_cases()[category]
    runnable = {name for name, (status, _) in documented.items() if status == "脚本"}
    if set(cases) != runnable:
        raise RuntimeError(f"Script and document disagree in {category}: {set(cases) ^ runnable}")
    report = {
        "category": category, "passed": False, "sessions": [],
        "environment": {"RUST_LOG": "info", "mode": "headless"},
        "checks": {name: {"status": "not_run", "expected": expected, "evidence": {}}
                   for name, expected in cases.items()},
    }
    report["checks"].update({name: {"status": "not_implemented", "expected": expected, "evidence": {}}
                             for name, (status, expected) in documented.items() if status == "待实现"})
    game = Game(category, args, report)
    game.output.mkdir(parents=True, exist_ok=True)
    (ROOT / "tmp").mkdir(exist_ok=True)
    try:
        with worktree_lock(ROOT / "tmp/acceptance.lock"):
            try:
                game.prepare_settings()
                game.start()
                exercise(game)
                game.close()
            except (EnvironmentBlocked, KeyboardInterrupt) as error:
                report.update(status="blocked", error=str(error) or type(error).__name__)
            except Exception as error:
                report.update(status="failed", error=f"{type(error).__name__}: {error}")
            finally:
                if errors := game.cleanup():
                    report.update(status="failed", cleanup_errors=errors)
                report["passed"] = "status" not in report and all(report["checks"][case]["status"] == "passed" for case in runnable)
                report.setdefault("status", "passed" if report["passed"] else "failed")
                report_path = game.output / f"{category}-acceptance.json"
                report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps({"status": report["status"], "report": str(report_path), "error": report.get("error")}))
    except EnvironmentBlocked as error:
        # 并行启动时不覆盖持锁脚本正在写入的报告。
        print(str(error))
        return 1
    return 0 if report["passed"] else 1
