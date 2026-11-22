"""管理验收期间共享设置文件的备份、写入与恢复。"""

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


def windows_preferences_dir():
    # 与 Bevy 0.20.1 使用相同的 LocalAppData Known Folder API。
    import ctypes
    from uuid import UUID

    folder_id = (ctypes.c_ubyte * 16).from_buffer_copy(
        UUID("f1b32785-6fba-4fcf-9d55-7b8e7f157091").bytes_le
    )
    get_known_folder_path = ctypes.windll.shell32.SHGetKnownFolderPath
    get_known_folder_path.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p,
                                     ctypes.POINTER(ctypes.c_wchar_p)]
    get_known_folder_path.restype = ctypes.c_long
    free = ctypes.windll.ole32.CoTaskMemFree
    free.argtypes = [ctypes.c_void_p]
    free.restype = None
    result = ctypes.c_wchar_p()
    status = get_known_folder_path(ctypes.byref(folder_id), 0, None, ctypes.byref(result))
    try:
        if status != 0 or not result.value:
            raise OSError(f"Could not resolve Windows LocalAppData: HRESULT {status & 0xffffffff:#010x}")
        return Path(result.value)
    finally:
        free(result)


def shared_settings_path():
    if sys.platform == "win32":
        directory = windows_preferences_dir()
    elif sys.platform == "darwin":
        directory = Path.home() / "Library" / "Preferences"
    elif sys.platform == "linux":
        directory = Path(os.environ.get("XDG_CONFIG_HOME", ""))
        if not directory.is_absolute():
            directory = Path.home() / ".config"
    else:
        raise RuntimeError(f"Bevy does not provide a settings directory on {sys.platform}")
    if not directory.is_absolute():
        raise RuntimeError(f"Expected an absolute Bevy settings directory: {directory}")
    return directory / "io.github.fedoraiver.demo" / "settings.toml"


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
    # 原子替换需要将临时文件放在目标目录中。
    temp = tempfile.NamedTemporaryFile(prefix=f".{path.name}.", dir=path.parent, delete=False)
    staged = Path(temp.name)
    try:
        with temp:
            temp.write(data)
            temp.flush()
            os.fsync(temp.fileno())
        if mode is not None and os.name != "nt":
            staged.chmod(mode)
        identity = file_identity(staged.stat())[:4]
        if before_replace is not None:
            before_replace()
        os.replace(staged, path)
        return identity
    finally:
        staged.unlink(missing_ok=True)


class SettingsBackup:
    def __init__(self, path, backup):
        self.path = path
        self.backup = backup
        self.original = self._read_current()
        self.saved = None
        self.restored = False
        path.parent.mkdir(parents=True, exist_ok=True)
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

    def _read_current(self):
        pending = self.path.with_suffix(".toml.new")
        if os.path.lexists(pending):
            raise RuntimeError(f"A settings write is pending at {pending}; do not overwrite {self.path}")
        return FileVersion.read(self.path)

    def stage(self, data):
        """先保留备份，再原子写入脚本拥有的启动配置。"""
        if self.restored or self.saved is not None:
            raise RuntimeError(f"Settings fixture has already been prepared: {self.path}")
        mode = self.original.mode if self.original is not None else None
        identity = write_atomically(self.path, data, self.verify_prepared, mode)
        candidate = self._read_current()
        # 重命名可能改变 ctime。核对其余身份字段，避免把同内容的外部替换当作本次写入。
        if candidate is None or candidate.identity[:4] != identity or candidate.data != data:
            raise RuntimeError(f"Settings fixture changed after writing; backup retained at {self.backup}")
        self._remember(candidate)

    def verify_prepared(self):
        current = self._read_current()
        expected = self.saved if self.saved is not None else self.original
        if current != expected:
            raise RuntimeError(f"Settings ownership is uncertain; backup retained at {self.backup}")
        return current

    def confirm(self, live):
        candidate = self._read_current()
        previous = self.saved if self.saved is not None else self.original
        if candidate is None or candidate == previous:
            raise RuntimeError(f"Apply did not write {self.path}")
        document = tomllib.loads(candidate.data.decode("utf-8"))
        disk = document["game"]
        # JSON 与 TOML 序列化精度不同，用 Bevy 的 f32 表示核对同一个灵敏度。
        camera = dict(disk["camera"])
        camera["mouse_sensitivity"] = struct.pack("f", camera["mouse_sensitivity"])
        live_camera = dict(live["camera"])
        live_camera["mouse_sensitivity"] = struct.pack("f", live_camera["mouse_sensitivity"])
        if (set(document) != {"game"} or type(disk["max_fps"]) is not int
                or any(type(volume) is not int for volume in disk["audio"].values())
                or type(camera["invert_y"]) is not bool
                or dict(disk, camera=camera) != dict(live, camera=live_camera)):
            raise RuntimeError(f"Settings written to {self.path} differ from the live game settings")
        self._remember(candidate)
        return {"path": str(self.path), "max_fps": disk["max_fps"]}

    def _remember(self, candidate):
        self.saved = candidate
        write_atomically(self.backup, self._record())

    def restore(self):
        """游戏退出后调用；未知修改保留在磁盘上，备份供恢复。"""
        if self.restored:
            return {"path": str(self.path), "originally_missing": self.original is None}
        if self.saved is not None:
            if self.original is None:
                self.verify_prepared()
                self.path.unlink()
            else:
                write_atomically(self.path, self.original.data, self.verify_prepared, self.original.mode)
        else:
            self.verify_prepared()
        actual = self._read_current()
        expected = self.original.data if self.original is not None else None
        if (actual.data if actual is not None else None) != expected:
            raise RuntimeError(f"Settings restoration could not be verified; backup retained at {self.backup}")
        self.backup.unlink()
        self.restored = True
        return {"path": str(self.path), "originally_missing": self.original is None}
