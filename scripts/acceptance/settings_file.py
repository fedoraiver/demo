"""复用 Bevy 的配置路径，记录并恢复验收修改过的原始设置。"""

from base64 import b64encode
from dataclasses import dataclass
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import tomllib
from uuid import UUID


def user_settings_path():
    if sys.platform == "win32":
        from ctypes import POINTER, byref, c_long, c_ubyte, c_ulong, c_void_p, c_wchar_p, windll

        # Bevy 使用 FOLDERID_LocalAppData，环境变量可能指向其他目录。
        folder_id = (c_ubyte * 16).from_buffer_copy(UUID("f1b32785-6fba-4fcf-9d55-7b8e7f157091").bytes_le)
        native_path = c_wchar_p()
        lookup = windll.shell32.SHGetKnownFolderPath
        lookup.argtypes = [POINTER(c_ubyte), c_ulong, c_void_p, POINTER(c_wchar_p)]
        lookup.restype = c_long
        status = lookup(folder_id, 0, None, byref(native_path))
        if status != 0:
            raise OSError(f"Unable to locate LocalAppData: HRESULT 0x{status & 0xffffffff:08X}")
        try:
            base = Path(native_path.value)
        finally:
            free = windll.ole32.CoTaskMemFree
            free.argtypes = [c_void_p]
            free.restype = None
            free(native_path)
    elif sys.platform == "darwin":
        base = Path.home() / "Library/Preferences"
    elif sys.platform.startswith("linux"):
        candidate = Path(os.environ.get("XDG_CONFIG_HOME", ""))
        base = candidate if candidate.is_absolute() else Path.home() / ".config"
    else:
        raise OSError(f"Settings path is unavailable on {sys.platform}")
    return base / "io.github.fedoraiver.demo/settings.toml"


def file_identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


@dataclass(frozen=True)
class FileVersion:
    data: bytes
    identity: tuple
    mode: int

    @classmethod
    def read(cls, path):
        try:
            initial = path.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(initial.st_mode):
            raise RuntimeError(f"Expected a regular file at {path}")
        identity = file_identity(initial)
        with path.open("rb") as source:
            data = source.read()
            if file_identity(os.fstat(source.fileno())) != identity:
                raise RuntimeError(f"File changed while reading {path}")
        if file_identity(path.lstat()) != identity:
            raise RuntimeError(f"File changed while reading {path}")
        return cls(data, identity, stat.S_IMODE(initial.st_mode))

    def as_json(self):
        return {"bytes_base64": b64encode(self.data).decode("ascii"), "identity": self.identity, "mode": self.mode}


def write_atomically(path, data, before_replace=None, mode=None):
    # 配置目录可能和 worktree 不在同一卷，替换必须使用目标旁的临时文件。
    temp = tempfile.NamedTemporaryFile(prefix=f".{path.name}.", dir=path.parent, delete=False)
    staged = Path(temp.name)
    try:
        with temp:
            temp.write(data)
            temp.flush()
            os.fsync(temp.fileno())
        if mode is not None and os.name != "nt":
            staged.chmod(mode)
        if before_replace is not None:
            before_replace()
        os.replace(staged, path)
    finally:
        staged.unlink(missing_ok=True)


class SettingsBackup:
    def __init__(self, path, backup):
        self.path = path
        self.backup = backup
        self.original = FileVersion.read(path)
        self.saved = None
        self.restored = False
        with os.fdopen(os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as record:
            record.write(self._record())
            record.flush()
            os.fsync(record.fileno())

    def _record(self):
        return json.dumps({
            "path": str(self.path),
            "original": self.original.as_json() if self.original is not None else None,
            "saved": self.saved.as_json() if self.saved is not None else None,
        }).encode("utf-8")

    def verify_original(self):
        if FileVersion.read(self.path) != self.original or os.path.lexists(self.path.with_suffix(".toml.new")):
            raise RuntimeError(f"Settings changed before Apply: {self.path}")

    def confirm(self, live):
        candidate = FileVersion.read(self.path)
        if candidate is None or candidate == self.original:
            raise RuntimeError(f"Apply did not write {self.path}")
        disk = tomllib.loads(candidate.data.decode("utf-8"))["game"]
        # JSON 与 TOML 序列化精度不同，用 Bevy 的 f32 表示核对同一个灵敏度。
        camera = dict(disk["camera"])
        camera["mouse_sensitivity"] = struct.pack("f", camera["mouse_sensitivity"])
        live_camera = dict(live["camera"])
        live_camera["mouse_sensitivity"] = struct.pack("f", live_camera["mouse_sensitivity"])
        if (type(disk["max_fps"]) is not int or disk["max_fps"] != live["max_fps"]
                or disk["audio"] != live["audio"] or camera != live_camera):
            raise RuntimeError(f"Settings written to {self.path} differ from the live game settings")
        self.saved = candidate
        write_atomically(self.backup, self._record())
        return {"path": str(self.path), "max_fps": disk["max_fps"]}

    def _require_saved(self):
        if FileVersion.read(self.path) != self.saved:
            raise RuntimeError(f"Settings ownership is uncertain; backup retained at {self.backup}")

    def restore(self):
        """游戏退出后调用；未知修改保留在磁盘上，备份供恢复。"""
        if self.restored:
            return {"path": str(self.path), "originally_missing": self.original is None}
        if self.saved is not None:
            if self.original is None:
                self._require_saved()
                self.path.unlink()
            else:
                write_atomically(self.path, self.original.data, self._require_saved, self.original.mode)
        elif FileVersion.read(self.path) != self.original:
            raise RuntimeError(f"Settings ownership is uncertain; backup retained at {self.backup}")
        actual = FileVersion.read(self.path)
        expected = self.original.data if self.original is not None else None
        if (actual.data if actual is not None else None) != expected:
            raise RuntimeError(f"Settings restoration could not be verified; backup retained at {self.backup}")
        self.backup.unlink()
        self.restored = True
        return {"path": str(self.path), "originally_missing": self.original is None}
