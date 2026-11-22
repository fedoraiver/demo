"""使用 Bevy 原生 HTTP BRP，控制请求绑定到已核对的游戏进程。"""

from contextlib import contextmanager
from http.client import HTTPConnection
import json
import struct
import time
import zlib


HOST = "127.0.0.1"
PORT = 15702
SCREENSHOT = "bevy_render::view::window::screenshot::Screenshot"
CAPTURED = f"{SCREENSHOT}Captured"


class BrpError(RuntimeError):
    pass


class ProcessMismatch(BrpError):
    pass


class UniformScreenshot(RuntimeError):
    pass


class BrpClient:
    def __init__(self, process):
        self.process = process
        self.connection = None
        self.request_id = 0

    def _check_process(self):
        if self.process.poll() is not None:
            raise BrpError(f"Game exited with code {self.process.returncode}")

    def _request(self, connection, method, params=None):
        self._check_process()
        self.request_id += 1
        request = {"jsonrpc": "2.0", "id": self.request_id, "method": method}
        if params is not None:
            request["params"] = params
        connection.request("POST", "/", json.dumps(request), {"Content-Type": "application/json"})
        response = connection.getresponse()
        pids = [value for key, value in response.getheaders() if key.lower() == "x-bevy-pid"]
        if pids != [str(self.process.pid)]:
            response.close()
            raise ProcessMismatch(f"Expected game PID {self.process.pid}; received {pids!r}")
        if response.status != 200:
            response.close()
            raise BrpError(f"{method}: HTTP {response.status} {response.reason}")
        return response, request["id"]

    @staticmethod
    def _result(payload, request_id, method):
        envelope = json.loads(payload)
        if envelope.get("jsonrpc") != "2.0" or envelope.get("id") != request_id:
            raise BrpError(f"{method}: unexpected JSON-RPC envelope")
        if "error" in envelope:
            raise BrpError(f"{method}: {envelope['error']}")
        return envelope["result"]

    def _exchange(self, connection, method, params=None):
        response, request_id = self._request(connection, method, params)
        with response:
            return self._result(response.read(), request_id, method)

    def _verified_connection(self):
        self._check_process()
        connection = HTTPConnection(HOST, PORT, timeout=3)
        try:
            connection.connect()
            # 禁止 http.client 在已核对的连接断开后悄悄建立新连接。
            connection.auto_open = False
            self._exchange(connection, "world.list_resources")
            if connection.sock is None:
                raise BrpError("BRP closed the connection after the PID check")
            return connection
        except BaseException:
            connection.close()
            raise

    def call(self, method, params=None):
        if self.connection is None or self.connection.sock is None:
            self.close()
            self.connection = self._verified_connection()
        try:
            return self._exchange(self.connection, method, params)
        except BaseException:
            self.close()
            raise

    @contextmanager
    def screenshot_events(self):
        connection = self._verified_connection()
        method = "world.observe+watch"
        try:
            response, request_id = self._request(connection, method, {"event": CAPTURED})
            with response:
                if response.headers.get_content_type() != "text/event-stream":
                    raise BrpError("Expected an SSE response for screenshot events")

                def read(entity, timeout):
                    deadline = time.monotonic() + timeout
                    while (remaining := deadline - time.monotonic()) > 0:
                        connection.sock.settimeout(remaining)
                        line = response.readline()
                        if not line:
                            raise BrpError("Screenshot event stream closed")
                        if line.startswith(b"data:"):
                            events = self._result(line[5:], request_id, method)
                            for event in events:
                                if event.get("event") == CAPTURED:
                                    raise BrpError("Bevy could not serialize the screenshot")
                                if event.get("entity") == entity:
                                    return event["image"]
                    raise TimeoutError(f"Timed out waiting for screenshot entity {entity}")

                yield read
        finally:
            connection.close()

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None


def screenshot_png(image, *, require_content=False):
    """校验 Bevy 传来的窗口像素，返回 PNG 字节和物理尺寸。"""
    descriptor = image["texture_descriptor"]
    width = descriptor["size"]["width"]
    height = descriptor["size"]["height"]
    if type(width) is not int or type(height) is not int or min(width, height) <= 0:
        raise ValueError("Invalid screenshot dimensions")
    pixel_format = descriptor["format"]
    if pixel_format not in ("rgba8unorm", "rgba8unorm-srgb", "bgra8unorm", "bgra8unorm-srgb"):
        raise ValueError(f"Unsupported screenshot format: {pixel_format}")
    data = image["data"]
    if not isinstance(data, list) or len(data) != width * height * 4:
        raise ValueError("Screenshot pixel length does not match its dimensions")
    pixels = bytearray(data)
    if require_content and pixels == pixels[:4] * (width * height):
        raise UniformScreenshot("The entire screenshot is one color")
    if pixel_format.startswith("bgra"):
        pixels[0::4], pixels[2::4] = pixels[2::4], pixels[0::4]

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    stride = width * 4
    rows = b"".join(b"\0" + pixels[start:start + stride] for start in range(0, len(pixels), stride))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    return png, [width, height]
