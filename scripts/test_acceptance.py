"""原生 BRP 驱动、设置恢复和文档编号的无窗口回归。"""

from email.message import Message
import importlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import zlib


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/acceptance"))

import brp
import driver
from settings_file import SettingsBackup


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
        transaction.verify_original()
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
        self.path.write_bytes(b"external edit")
        with self.assertRaisesRegex(RuntimeError, "before Apply"):
            transaction.verify_original()
        with self.assertRaisesRegex(RuntimeError, "ownership"):
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
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            transaction.restore()
        self.assertEqual(self.path.read_bytes(), self.saved)
        self.assertTrue(self.recovery.exists())

    def test_pending_backup_cannot_be_overwritten(self):
        SettingsBackup(self.path, self.recovery)
        before = self.recovery.read_bytes()
        with self.assertRaises(FileExistsError):
            SettingsBackup(self.path, self.recovery)
        self.assertEqual(self.recovery.read_bytes(), before)


class AcceptanceDocumentTests(unittest.TestCase):
    def test_each_runnable_condition_has_one_matching_script(self):
        documented = driver.document_cases()
        for category, rows in documented.items():
            with self.subTest(category=category):
                script = importlib.import_module(category)
                self.assertEqual(set(script.CASES), {key for key, (status, _) in rows.items() if status == "脚本"})
                self.assertTrue(script.CASES)
