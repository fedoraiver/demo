"""Demo 的验收用例清单、设置事务、启动校验和菜单定位。"""

import argparse
from contextlib import contextmanager
import os
from pathlib import Path
import re
import tomllib

from bevy_acceptance.brp import PORT
from bevy_acceptance.driver import EnvironmentBlocked, Game as HeadlessGame, assert_that, run_suite
from bevy_acceptance.driver import TYPES as BEVY_TYPES

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
    **BEVY_TYPES,
    "app_state": "bevy_state::state::resources::State<demo_acceptance::game_flow::AppState>",
    "menu_state": "demo_acceptance::ui::MenuState",
    "menu_focus": "demo_acceptance::ui::MenuFocus",
    "menu_input_source": "demo_acceptance::ui::MenuInputSource",
    "menu_button": "demo_acceptance::ui::MenuButton",
    "settings_draft": "demo_acceptance::settings::draft::SettingsDraft",
    "game_settings": "demo_acceptance::settings::config::GameSettings",
    "session_log": "demo_acceptance::session_log::lifecycle::SessionLogInfo",
    "character": "demo_acceptance::character::components::Character",
    "character_intent": "demo_acceptance::character::components::CharacterIntent",
    "character_motion": "demo_acceptance::character::components::CharacterMotion",
    "position": "avian3d::physics_transform::transform::Position",
    "linear_velocity": "avian3d::dynamics::rigid_body::LinearVelocity",
    "item": "demo_acceptance::item_interaction::components::Item",
    "held_target": "demo_acceptance::item_interaction::components::HeldTarget",
    "first_person_camera": "demo_acceptance::first_person::FirstPersonCamera",
    "mouse_look_state": "demo_acceptance::first_person::MouseLookState",
}


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


class Game(HeadlessGame):
    def __init__(self, category, args, report, *, port=PORT):
        super().__init__(category, args, report, cwd=ROOT,
                         env={"BEVY_ASSET_ROOT": str(ROOT), "RUST_LOG": "info"}, port=port)
        self.settings = None
        self.session_id = None
        self.log_path = None

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

    def before_spawn(self):
        self.session_id = self.log_path = None
        try:
            prepared = self.settings.verify_prepared()
            master_volume = tomllib.loads(prepared.data.decode("utf-8"))["game"]["audio"]["master_volume"]
        except (OSError, RuntimeError, ValueError, KeyError, TypeError) as error:
            raise EnvironmentBlocked(f"Could not verify startup settings in {self.settings.path}: {error}") from error
        if type(master_volume) is not int or master_volume != 0:
            raise EnvironmentBlocked(f"Expected master_volume = 0 before launch in {self.settings.path}, got {master_volume!r}")
        self.startup_master_volume = master_volume

    def check_startup(self):
        session_log = self.resource(TYPES["session_log"])
        self.session_id = session_log["id"]
        self.log_path = (ROOT / session_log["path"]).resolve()
        assert_that(self.log_path.is_relative_to(ROOT / "logs"), "Session log is outside this worktree")
        self.session.update(session_id=self.session_id, session_log=str(self.log_path))

        live_master_volume = self.resource(TYPES["game_settings"])["audio"]["master_volume"]
        self.session["startup_master_volume"] = live_master_volume
        if type(live_master_volume) is not int or live_master_volume != self.startup_master_volume:
            raise EnvironmentBlocked(f"Game loaded master volume {live_master_volume!r}, "
                                     f"expected {self.startup_master_volume}")

    def button(self, action):
        matches = [row for row in self.query(TYPES["menu_button"], TYPES["computed_node"], TYPES["ui_global_transform"])
                   if row["components"][TYPES["menu_button"]]["action"] == action]
        assert_that(len(matches) <= 1, f"Expected one button for {action}; observed {len(matches)}")
        if matches and min(matches[0]["components"][TYPES["computed_node"]]["size"]) > 0:
            return matches[0]
        return None

    def click(self, action):
        row = self.wait(lambda: self.button(action), f"layout of {action}")
        physical = row["components"][TYPES["ui_global_transform"]][-2:]
        self.click_at(physical, entity=row["entity"])

    def cleanup(self):
        errors = super().cleanup()
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
    executable = "demo-acceptance.exe" if os.name == "nt" else "demo-acceptance"
    parser.add_argument("--exe", type=Path, default=ROOT / "target/debug" / executable)
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/automation")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    if not 0 < args.timeout < float("inf"):
        parser.error("--timeout must be a finite positive number")

    if not 1 <= args.port <= 65535:
        parser.error("--port must be in 1..65535")
    args.exe = args.exe.resolve()

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
    game = Game(category, args, report, port=args.port)
    (ROOT / "tmp").mkdir(exist_ok=True)
    try:
        with worktree_lock(ROOT / "tmp/acceptance.lock"):
            return run_suite(game, exercise, prepare=game.prepare_settings)
    except EnvironmentBlocked as error:
        # 并行启动时不覆盖持锁脚本正在写入的报告。
        print(str(error))
        return 1
