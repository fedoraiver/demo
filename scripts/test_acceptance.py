"""原生 BRP 驱动、截图证据、设置恢复和文档编号的无窗口回归。"""

from contextlib import nullcontext
from email.message import Message
import importlib
import io
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import Mock, call, patch
import zlib


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/acceptance"))

import brp
import driver
from settings_file import SettingsBackup
import view


class Response(io.BytesIO):
    status = 200
    reason = "OK"

    def __init__(self, data, pid=123, content_type="application/json"):
        super().__init__(data)
        self.headers = Message()
        self.headers["X-Bevy-Pid"] = str(pid)
        self.headers["Content-Type"] = content_type

    def getheaders(self):
        return self.headers.items()


def response_data(request_id, result):
    return json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}).encode()


def fake_connection(*responses):
    connection = Mock()
    connection.getresponse.side_effect = responses
    return connection


class NativeClientTests(unittest.TestCase):
    def setUp(self):
        self.client = brp.BrpClient(Mock(pid=123, **{"poll.return_value": None}))
        self.addCleanup(self.client.close)

    def test_pid_probe_precedes_control_on_same_connection(self):
        connection = fake_connection(Response(response_data(1, [])), Response(response_data(2, None)))
        with patch.object(brp, "HTTPConnection", return_value=connection):
            self.client.call("world.write_message", {"message": "Foo"})
        self.assertEqual([json.loads(call.args[2])["method"] for call in connection.request.call_args_list],
                         ["world.list_resources", "world.write_message"])
        self.assertFalse(connection.auto_open)

    def test_wrong_pid_receives_only_read_only_request(self):
        connection = fake_connection(Response(response_data(1, []), pid=456))
        with patch.object(brp, "HTTPConnection", return_value=connection):
            with self.assertRaises(brp.ProcessMismatch):
                self.client.call("world.write_message")
        self.assertEqual(connection.request.call_count, 1)
        connection.close.assert_called_once()

    def test_unconfirmed_control_is_not_retried(self):
        connection = fake_connection(Response(response_data(1, [])), ConnectionResetError())
        with patch.object(brp, "HTTPConnection", return_value=connection) as make_connection:
            with self.assertRaises(ConnectionResetError):
                self.client.call("world.write_message")
        make_connection.assert_called_once()
        self.assertEqual(connection.request.call_count, 2)

    def test_watch_matches_the_capture_entity(self):
        event = [{"entity": 5, "image": "other"}, {"entity": 7, "image": "expected"}]
        connection = fake_connection(Response(response_data(1, [])),
                                     Response(b"data: " + response_data(2, event) + b"\n\n", content_type="text/event-stream"))
        with patch.object(brp, "HTTPConnection", return_value=connection):
            with self.client.screenshot_events() as read:
                self.assertEqual(read(7, 1), "expected")
        self.assertEqual(json.loads(connection.request.call_args.args[2])["params"], {"event": brp.CAPTURED})


class HeadlessDriverTests(unittest.TestCase):
    def test_runs_use_and_reserve_the_shared_settings_file(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tmp") as temp:
            root = Path(temp)
            path = root / "settings.toml"
            original = b"# player settings\r\n[game.audio]\r\nmaster_volume = 65\r\n"
            path.write_bytes(original)
            report = {"environment": {}}
            first = driver.Game("settings", Mock(output=root), report)
            second = driver.Game("view", Mock(output=root), {"environment": {}})
            with patch.object(driver, "shared_settings_path", return_value=path):
                first.prepare_settings()
                with self.assertRaisesRegex(driver.EnvironmentBlocked, "recovery record already exists"):
                    second.prepare_settings()
                self.assertEqual(second.cleanup(), [])
                self.assertEqual(tomllib.loads(path.read_text(encoding="utf-8")),
                                 {"game": {"audio": {"master_volume": 0}}})
                self.assertEqual(first.cleanup(), [])
                second.prepare_settings()
                self.assertEqual(second.cleanup(), [])
            self.assertEqual(report["environment"]["settings_file"], str(path))
            self.assertEqual(first.settings.path, second.settings.path)
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse(first.settings.backup.exists())

    def test_restart_rejects_changed_master_volume_before_spawning(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tmp") as temp:
            root = Path(temp)
            (root / "tmp").mkdir()
            exe = root / "demo.exe"
            exe.touch()
            path = root / "settings.toml"
            game = driver.Game("view", Mock(output=root, exe=exe), {"environment": {}, "sessions": []})
            with patch.object(driver, "shared_settings_path", return_value=path):
                game.prepare_settings()
            game.process = Mock(**{"poll.return_value": 0})
            with patch.object(driver.subprocess, "Popen") as spawn:
                for content in (b"[game.audio]\nmaster_volume = 25\n",
                                b"[game.audio]\nmaster_volume = false\n", b"broken TOML"):
                    with self.subTest(content=content):
                        path.write_bytes(content)
                        with self.assertRaisesRegex(driver.EnvironmentBlocked, "startup settings"):
                            game.start()
                spawn.assert_not_called()
            self.assertEqual(game.report["sessions"], [])

    def test_game_start_checks_and_records_loaded_master_volume(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tmp") as temp:
            root = Path(temp)
            (root / "tmp").mkdir()
            exe = root / "demo.exe"
            exe.touch()
            report = {"environment": {}, "sessions": []}
            game = driver.Game("view", Mock(output=root, exe=exe, timeout=1), report)
            game.resource = Mock(side_effect=[{"id": "test", "path": "logs/session.log"},
                                              {"audio": {"master_volume": 100}}])
            game.query = Mock(return_value=[{"entity": 4, "components": {
                driver.TYPES["window"]: {"visible": False, "focused": True},
            }}])
            game.offscreen_target = Mock()
            with patch.object(driver, "ROOT", root), patch.object(driver, "BrpClient"), \
                    patch.object(driver, "shared_settings_path", return_value=root / "settings.toml"), \
                    patch.object(driver.subprocess, "Popen") as spawn:
                game.prepare_settings()
                with self.assertRaisesRegex(driver.EnvironmentBlocked, "loaded master volume 100, expected 0"):
                    game.start()
            self.assertEqual(spawn.call_args.kwargs["cwd"], root)
            self.assertEqual(report["sessions"][0]["startup_master_volume"], 100)
            game.offscreen_target.assert_not_called()

    def test_capture_uses_the_shared_image_target_from_brp(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tmp") as temp:
            game = driver.Game("view", Mock(output=Path(temp), timeout=1), {})
            target = {"Image": {"handle": {"Uuid": "90f84289-3b0e-4450-966f-8342d0e3f011"}, "scale_factor": 1}}
            game.query = Mock(return_value=[{"components": {driver.TYPES["render_target"]: target}}])
            game.screenshot_target = game.offscreen_target()
            game.call = Mock(return_value={"entity": 7})
            capture = Mock()
            game.client = Mock()
            game.client.screenshot_events.return_value = nullcontext(capture)
            with patch.object(driver, "screenshot_png", return_value=(b"pixels", [1920, 1080])):
                result = game.screenshot("headless.png")

            game.call.assert_called_once_with("world.spawn_entity", {"components": {brp.SCREENSHOT: target}})
            self.assertEqual(capture.call_args.args[0], 7)
            self.assertEqual(result["dimensions"], [1920, 1080])


class GameplayTests(unittest.TestCase):
    def test_held_key_is_released_when_action_raises(self):
        game = driver.Game("view", Mock(output=ROOT / "tmp", timeout=1), {})
        game._focused_window = Mock()
        game._pressed = Mock(side_effect=[[], ["KeyW"], []])
        game._keyboard = Mock()

        with self.assertRaisesRegex(RuntimeError, "movement failed"):
            with game.hold_key("KeyW"):
                self.assertIn("KeyW", game.keys)
                raise RuntimeError("movement failed")

        self.assertEqual(game._keyboard.call_args_list, [call("KeyW", "Pressed"), call("KeyW", "Released")])
        self.assertEqual(game.keys, set())

    def test_press_confirmation_timeout_still_releases_owned_key(self):
        game = driver.Game("view", Mock(output=ROOT / "tmp"), {})
        game._focused_window = Mock()
        game._pressed = Mock(return_value=[])
        game._keyboard = Mock()
        game.wait = Mock(side_effect=[TimeoutError("press confirmation"), True])

        with self.assertRaisesRegex(TimeoutError, "press confirmation"):
            with game.hold_key("KeyS"):
                self.fail("The action ran without a confirmed press")

        self.assertEqual(game._keyboard.call_args_list, [call("KeyS", "Pressed"), call("KeyS", "Released")])
        self.assertEqual(game.keys, set())

    @staticmethod
    def poll(predicate, description, **_options):
        for _ in range(5):
            if result := predicate():
                return result
        raise TimeoutError(description)

    def test_repeated_pitch_limit_input_waits_for_yaw_change(self):
        def components(yaw, pitch):
            return {
                driver.TYPES["first_person_camera"]: {"yaw": yaw, "pitch": pitch},
                driver.TYPES["transform"]: {"rotation": [0, 0, 0, 1], "translation": [0, 0, 0]},
            }

        limit = math.radians(85)
        game = Mock()
        game.wait.side_effect = self.poll
        game.get.side_effect = [
            components(0.16, limit), components(0.16, limit), components(0.13, limit),
            components(0.13, -limit), components(0.13, -limit), components(0.10, -limit),
        ]
        evidence = {}

        view.check_pitch_limits(game, 7, 0.002, 1, evidence)

        repeats = [step["repeated"]["view"] for step in evidence["observed"]]
        self.assertEqual(repeats, [{"yaw": 0.13, "pitch": limit}, {"yaw": 0.10, "pitch": -limit}])
        self.assertEqual(game.get.call_count, 6)

    def test_edge_walk_starts_after_fixture_is_presented_and_grounded(self):
        def body(position, translation, *, grounded=True, velocity=(0, 0, 0)):
            return {
                driver.TYPES["character_motion"]: {"grounded": grounded},
                driver.TYPES["position"]: position,
                driver.TYPES["linear_velocity"]: list(velocity),
                driver.TYPES["transform"]: {"translation": translation},
            }

        start = [0, 0.03, 2]
        target = [0, 0.03, 18.5]
        fallen = [0, -0.6, 21]
        game = Mock()
        game.wait.side_effect = self.poll
        game.get.side_effect = [
            body(start, start), body(target, start), body(target, target, grounded=False),
            body(target, target), body(fallen, fallen, grounded=False, velocity=(0, -3, 4)),
        ]

        evidence = {}

        def observe_fixture():
            self.assertEqual(game.get.call_count, 4)
            self.assertEqual(evidence["fixture"]["readback"]["translation"], target)

        before_walk = Mock(side_effect=observe_fixture)

        def hold_after_readback(_code):
            self.assertEqual(game.get.call_count, 4)
            before_walk.assert_called_once()
            return nullcontext()

        game.hold_key.side_effect = hold_after_readback
        view.fall_from_edge(game, 7, evidence, before_walk=before_walk)

        game.call.assert_called_once_with("world.insert_components", {
            "entity": 7,
            "components": {driver.TYPES["position"]: target, driver.TYPES["linear_velocity"]: [0, 0, 0]},
        })
        game.hold_key.assert_called_once_with("KeyS")
        self.assertEqual(evidence["fixture"]["before"]["position"], start)
        self.assertEqual(evidence["fixture"]["readback"]["translation"], target)
        self.assertEqual(evidence["fall"]["position"], fallen)


class ScreenshotTests(unittest.TestCase):
    def image(self, pixel_format, data):
        return {"texture_descriptor": {"size": {"width": 1, "height": 1}, "format": pixel_format}, "data": data}

    def test_rgba_and_bgra_produce_the_same_png(self):
        rgba = brp.screenshot_png(self.image("rgba8unorm", [12, 34, 56, 255]))
        bgra = brp.screenshot_png(self.image("bgra8unorm-srgb", [56, 34, 12, 255]))
        self.assertEqual(rgba, bgra)
        self.assertEqual(rgba[1], [1, 1])
        png = rgba[0]
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        size = struct.unpack_from(">I", png, 33)[0]
        self.assertEqual(png[37:41], b"IDAT")
        self.assertEqual(zlib.decompress(png[41:41 + size]), b"\x00\x0c\x22\x38\xff")

    def test_unsupported_format_and_bad_length_fail(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            brp.screenshot_png(self.image("rgba16float", [0, 0, 0, 0]))
        with self.assertRaisesRegex(ValueError, "pixel length"):
            brp.screenshot_png(self.image("rgba8unorm", [0, 0, 0]))

    def test_render_readiness_can_reject_a_uniform_frame(self):
        with self.assertRaises(brp.UniformScreenshot):
            brp.screenshot_png(self.image("rgba8unorm", [42, 42, 42, 255]), require_content=True)

    def test_visual_observation_brackets_screenshot_with_state_reads(self):
        actions = Mock()
        before = {"position": [0, 0, 2]}
        after = {"position": [0, 0.0001, 2]}
        screenshot = {"path": "view-move-w.png", "dimensions": [1920, 1080], "entity": 10}
        actions.read_state.side_effect = [before, after]
        actions.game.screenshot.return_value = screenshot
        actions.stable.return_value = True
        evidence = {}

        view.capture_observation(actions.game, evidence, "move-w", expected="观察移动后画面",
                                 read_state=actions.read_state, stable=actions.stable, trigger="松开 W")

        self.assertEqual(actions.mock_calls, [
            call.read_state(), call.game.screenshot("view-move-w.png"), call.read_state(),
            call.stable(before, after),
        ])
        record = evidence["visual_observations"]["move-w"]
        self.assertEqual(record["expected"], "观察移动后画面")
        self.assertEqual(record["trigger"], "松开 W")
        self.assertEqual(record["before"], before)
        self.assertEqual(record["screenshot"], screenshot)
        self.assertEqual(record["after"], after)
        self.assertEqual(record["capture_status"], "ready")
        self.assertEqual(record["review_status"], "pending")

    def test_visual_observation_retains_png_when_state_changed(self):
        game = Mock()
        screenshot = {"path": "view-after-look.png", "dimensions": [1920, 1080], "entity": 11}
        game.screenshot.return_value = screenshot
        before, after = {"yaw": 0.2}, {"yaw": 0.3}
        evidence = {}

        view.capture_observation(game, evidence, "after-look", expected="观察转向后的场景",
                                 read_state=Mock(side_effect=[before, after]),
                                 stable=lambda first, second: first == second)

        record = evidence["visual_observations"]["after-look"]
        self.assertEqual(record["capture_status"], "unstable")
        self.assertEqual(record["screenshot"], screenshot)
        self.assertEqual(record["before"], before)
        self.assertEqual(record["after"], after)

    def test_failed_visual_capture_retains_evidence_and_original_exception(self):
        game = Mock()
        failure = driver.EnvironmentBlocked("capture interrupted")
        game.screenshot.side_effect = failure
        before = {"grounded": True}
        read_state = Mock(return_value=before)
        stable = Mock()
        evidence = {}

        with self.assertRaises(driver.EnvironmentBlocked) as raised:
            view.capture_observation(game, evidence, "restart", expected="观察重开后的场景",
                                     read_state=read_state, stable=stable)

        self.assertIs(raised.exception, failure)
        record = evidence["visual_observations"]["restart"]
        self.assertEqual(record["capture_status"], "unavailable")
        self.assertEqual(record["before"], before)
        self.assertIn("capture interrupted", record["error"])
        read_state.assert_called_once_with()
        stable.assert_not_called()


class SettingsBackupTests(unittest.TestCase):
    original = b"# untouched comment\r\n[game]\r\nmax_fps = 240\r\n"
    saved = b"[game]\nmax_fps = 60\n[game.camera]\nmouse_sensitivity = 0.002\ninvert_y = false\n[game.audio]\nmaster_volume = 20\nui_volume = 30\n"
    live = {"max_fps": 60, "camera": {"mouse_sensitivity": 0.002, "invert_y": False},
            "audio": {"master_volume": 20, "ui_volume": 30}}

    def setUp(self):
        (ROOT / "tmp").mkdir(exist_ok=True)
        temp = tempfile.TemporaryDirectory(dir=ROOT / "tmp")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.path = folder / "settings.toml"
        self.recovery = folder / "settings-recovery.json"

    def confirm(self, transaction):
        transaction.stage(driver.STARTUP_SETTINGS)
        transaction.verify_prepared()
        self.path.write_bytes(self.saved)
        transaction.confirm(self.live)

    def test_restores_original_bytes_after_game_exit(self):
        self.path.write_bytes(self.original)
        transaction = SettingsBackup(self.path, self.recovery)
        self.confirm(transaction)
        self.assertEqual(transaction.restore(), {"path": str(self.path), "originally_missing": False})
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertFalse(self.recovery.exists())

    def test_restores_originally_missing_profile(self):
        transaction = SettingsBackup(self.path, self.recovery)
        self.confirm(transaction)
        self.assertTrue(transaction.restore()["originally_missing"])
        self.assertFalse(self.path.exists())
        self.assertFalse(self.recovery.exists())

    def test_cleanup_after_interrupted_case_restores_confirmed_write(self):
        self.path.write_bytes(self.original)
        transaction = SettingsBackup(self.path, self.recovery)
        self.confirm(transaction)
        report = {}
        game = driver.Game("settings", Mock(output=self.path.parent), report)
        game.settings = transaction
        game.process = Mock(**{"poll.return_value": 0, "wait.return_value": 0})
        game.session = {}
        game.client = Mock()
        self.assertEqual(game.cleanup(), [])
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(report["settings_restoration"]["status"], "passed")

    def test_external_edit_and_uncertain_write_preserve_file_and_backup(self):
        self.path.write_bytes(self.original)
        transaction = SettingsBackup(self.path, self.recovery)
        transaction.stage(driver.STARTUP_SETTINGS)
        self.path.write_bytes(b"external edit")
        with self.assertRaisesRegex(RuntimeError, "Settings"):
            transaction.verify_prepared()
        with self.assertRaisesRegex(RuntimeError, "Settings"):
            transaction.restore()
        self.assertEqual(self.path.read_bytes(), b"external edit")
        self.assertTrue(self.recovery.exists())

    def test_external_replacement_after_confirm_is_not_overwritten(self):
        self.path.write_bytes(self.original)
        transaction = SettingsBackup(self.path, self.recovery)
        self.confirm(transaction)
        other = self.path.with_suffix(".other")
        other.write_bytes(self.saved)
        other.replace(self.path)
        with self.assertRaisesRegex(RuntimeError, "Settings"):
            transaction.restore()
        self.assertEqual(self.path.read_bytes(), self.saved)
        self.assertTrue(self.recovery.exists())

    def test_pending_backup_cannot_be_overwritten(self):
        SettingsBackup(self.path, self.recovery)
        before = self.recovery.read_bytes()
        with self.assertRaises(FileExistsError):
            SettingsBackup(self.path, self.recovery)
        self.assertEqual(self.recovery.read_bytes(), before)

    def test_pending_game_write_preserves_original_and_recovery(self):
        self.path.write_bytes(self.original)
        transaction = SettingsBackup(self.path, self.recovery)
        pending = self.path.with_suffix(".toml.new")
        pending.write_bytes(b"other writer")
        with self.assertRaisesRegex(RuntimeError, r"settings\.toml\.new"):
            transaction.stage(driver.STARTUP_SETTINGS)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(pending.read_bytes(), b"other writer")
        self.assertTrue(self.recovery.exists())

    def test_apply_does_not_claim_unrelated_external_preferences(self):
        self.path.write_bytes(self.original)
        transaction = SettingsBackup(self.path, self.recovery)
        transaction.stage(driver.STARTUP_SETTINGS)
        external = self.saved + b"[other]\nvalue = 1\n"
        self.path.write_bytes(external)
        with self.assertRaises(RuntimeError):
            transaction.confirm(self.live)
        with self.assertRaises(RuntimeError):
            transaction.restore()
        self.assertEqual(self.path.read_bytes(), external)
        self.assertTrue(self.recovery.exists())


class AcceptanceDocumentTests(unittest.TestCase):
    def test_each_runnable_condition_has_one_matching_script(self):
        documented = driver.document_cases()
        for category, rows in documented.items():
            with self.subTest(category=category):
                script = importlib.import_module(category)
                self.assertEqual(set(script.CASES), {key for key, (status, _) in rows.items() if status == "脚本"})
                self.assertTrue(script.CASES)
