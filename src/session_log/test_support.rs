//! 故障输出设备与根 tmp 下的独立测试目录。

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use uuid::Uuid;

use super::output::LogSink;

#[derive(Clone, Copy)]
pub(super) enum Fault {
    Write,
    Flush,
    Sync,
    Panic,
}

pub(super) struct FaultSink(pub(super) Fault);

impl Write for FaultSink {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self.0 {
            Fault::Write => Err(io::Error::new(io::ErrorKind::StorageFull, "Test disk full")),
            Fault::Panic => panic!("Test writer panic"),
            _ => Ok(buffer.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.0 {
            Fault::Flush => Err(io::Error::other("Test flush failure")),
            _ => Ok(()),
        }
    }
}

impl LogSink for FaultSink {
    fn sync(&mut self) -> io::Result<()> {
        match self.0 {
            Fault::Sync => Err(io::Error::other("Test sync failure")),
            _ => self.flush(),
        }
    }
}

pub(super) fn test_directory() -> PathBuf {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tmp")
        .join(format!("session-log-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    directory
}

pub(super) fn remove_test_directory(directory: PathBuf) {
    // Windows 删除文件成功后，目录项仍可能短暂处于待删除状态；只重试非递归清理。
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match fs::remove_dir(&directory) {
            Err(error)
                if error.kind() == io::ErrorKind::DirectoryNotEmpty
                    && std::time::Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            result => {
                result.unwrap();
                return;
            }
        }
    }
}
