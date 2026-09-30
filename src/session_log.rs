//! 扩展 Bevy LogPlugin 的文件输出，保证每次游玩都有独立的会话日志。

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use bevy::{
    app::{App, AppExit},
    ecs::resource::Resource,
    log::{BoxedLayer, error, info, tracing_subscriber},
};
use tracing_subscriber::{fmt::MakeWriter, prelude::*};
use uuid::Uuid;

/// 保留会话文件到应用退出，并负责退出时刷新日志。
pub struct SessionLogGuard {
    writer: SessionWriter,
    session_id: Uuid,
}

/// 准备会话文件并暂存写入器；创建目录或文件失败时返回错误。
///
/// 必须在添加 `LogPlugin` 前调用，并将返回值保留到退出记录写入后。
pub fn prepare(app: &mut App) -> io::Result<SessionLogGuard> {
    let guard = create_session_file(Path::new("logs"))?;
    app.insert_resource(guard.writer.clone());
    // 先安装异常记录，覆盖 LogPlugin 就绪后其他引擎插件的初始化过程。
    guard.install_panic_hook();
    Ok(guard)
}

/// 为 `LogPlugin::custom_layer` 提供文件输出，沿用 Bevy 的过滤和控制台配置。
///
/// 若未调用 `prepare` 或写入器已被取走，则 panic。
pub fn file_layer(app: &mut App) -> Option<BoxedLayer> {
    // 写入器只在插件构建时传递，随后由日志 layer 持有，不占用玩法资源。
    let writer = app
        .world_mut()
        .remove_resource::<SessionWriter>()
        .expect("Session log must be prepared before adding LogPlugin");
    Some(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(writer)
            .boxed(),
    )
}

impl SessionLogGuard {
    fn install_panic_hook(&self) {
        let previous_hook = std::panic::take_hook();
        let panic_writer = self.writer.clone();
        let session_id = self.session_id;
        std::panic::set_hook(Box::new(move |panic_info| {
            error!(
                target: "demo::session_log",
                %session_id,
                path = %panic_writer.path.display(),
                error = %panic_info,
                "Session panicked"
            );
            // 尽量同步异常退出前的记录，再保留原有的控制台错误上下文。
            if let Err(err) = panic_writer.sync() {
                eprintln!("Failed to sync log {}: {err}", panic_writer.path.display());
            }
            previous_hook(panic_info);
        }));
    }

    /// 在 `LogPlugin` 初始化后写入会话开始信息。
    pub fn start(&self) {
        info!(
            target: "demo::session_log",
            session_id = %self.session_id,
            path = %self.writer.path.display(),
            version = env!("CARGO_PKG_VERSION"),
            bevy_version = "0.19.1",
            state_before = "not_started",
            state_after = "initializing",
            reason = "user_started_program",
            "Session started"
        );
    }

    /// 记录 Bevy 返回的退出状态，并刷新文件；应在 `App::run` 返回后调用。
    pub fn record_exit(&self, exit: &AppExit) -> io::Result<()> {
        match exit {
            AppExit::Success => info!(
                target: "demo::session_log",
                session_id = %self.session_id,
                state_before = "running",
                state_after = "exited",
                reason = "AppExit::Success",
                "Session exited normally"
            ),
            AppExit::Error(code) => error!(
                target: "demo::session_log",
                session_id = %self.session_id,
                state_before = "running",
                state_after = "exited",
                exit_code = code.get(),
                reason = "AppExit::Error",
                "Session exited with an error"
            ),
        }
        self.writer.flush_file()
    }
}

impl Drop for SessionLogGuard {
    fn drop(&mut self) {
        if let Err(err) = self.writer.flush_file() {
            eprintln!("Failed to flush log {}: {err}", self.writer.path.display());
        }
    }
}

fn create_session_file(directory: &Path) -> io::Result<SessionLogGuard> {
    fs::create_dir_all(directory).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!(
                "Failed to create log directory {}: {err}",
                directory.display()
            ),
        )
    })?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let session_id = Uuid::new_v4();
    // 文件名使用 Unix 时间戳；每条日志的时间由 tracing 格式化为可读的 UTC 时间。
    let path = directory.join(format!(
        "unix-{}-{:09}_{session_id}.log",
        timestamp.as_secs(),
        timestamp.subsec_nanos()
    ));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|err| {
            io::Error::new(
                err.kind(),
                format!("Failed to create session log {}: {err}", path.display()),
            )
        })?;
    Ok(SessionLogGuard {
        writer: SessionWriter {
            file: Arc::new(Mutex::new(file)),
            path: Arc::new(path),
        },
        session_id,
    })
}

/// 此锁仅保护外部文件 I/O，不参与游戏状态或 ECS 数据访问。
#[derive(Clone, Resource)]
struct SessionWriter {
    file: Arc<Mutex<File>>,
    path: Arc<PathBuf>,
}

impl SessionWriter {
    fn flush_file(&self) -> io::Result<()> {
        self.file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .flush()
    }

    fn sync(&self) -> io::Result<()> {
        let mut file = self
            .file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        file.flush()?;
        file.sync_data()
    }
}

impl<'a> MakeWriter<'a> for SessionWriter {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl Write for SessionWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut file = self
            .file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        file.write_all(buffer).map_err(|err| {
            io::Error::new(
                err.kind(),
                format!("Failed to write log {}: {err}", self.path.display()),
            )
        })?;
        // 原型日志量较小，逐条刷新避免仅在正常退出时才保存关键状态。
        file.flush()?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_plugin_records_session_lifecycle() {
        // 子进程只运行本测试并注册 LogPlugin，隔离全局 subscriber 和 panic hook。
        // 不注册窗口、渲染或玩法插件，也不调用 App::run。
        if std::env::var_os("DEMO_LOG_TEST_CHILD").is_some() {
            let mut app = App::new();
            let guard = prepare(&mut app).unwrap();
            app.add_plugins(bevy::log::LogPlugin {
                custom_layer: file_layer,
                ..Default::default()
            });
            guard.start();
            info!(target: "bevy::test", "Test engine initialized");
            info!(target: "demo::test", entity_id = 42, reason = "pickup", "Test event recorded");
            bevy::log::debug!(target: "demo::test", "Filtered debug event");
            bevy::log::warn!(target: "wgpu", "Filtered graphics warning");
            assert!(std::panic::catch_unwind(|| panic!("Test panic context")).is_err());
            guard.record_exit(&AppExit::Success).unwrap();
            guard.record_exit(&AppExit::error()).unwrap();
            return;
        }

        let directory = std::env::temp_dir().join(format!("demo-log-test-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session_log::tests::log_plugin_records_session_lifecycle",
                "--nocapture",
            ])
            .env("DEMO_LOG_TEST_CHILD", "1")
            .env_remove("RUST_LOG")
            .current_dir(&directory)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stderr}");
        let paths: Vec<_> = fs::read_dir(directory.join("logs"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(paths.len(), 1);
        let contents = fs::read_to_string(&paths[0]).unwrap();
        for expected in [
            "Session started",
            "version=",
            "bevy_version=",
            "session_id=",
            "Test engine initialized",
            "entity_id=42",
            "reason=\"pickup\"",
            "Session panicked",
            "Test panic context",
            "Session exited normally",
            "Session exited with an error",
            "exit_code=1",
        ] {
            assert!(
                contents.contains(expected),
                "Missing {expected}: {contents}"
            );
        }
        assert!(!contents.contains("Filtered debug event"));
        assert!(!contents.contains("Filtered graphics warning"));
        assert!(!contents.contains('\u{1b}'));
        assert!(stderr.contains("Session started"));
        assert!(stderr.contains("Test event recorded"));
        assert!(!stderr.contains("Could not set global"));

        fs::remove_file(&paths[0]).unwrap();
        fs::remove_dir(directory.join("logs")).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn independent_sessions_preserve_previous_logs() {
        let directory = std::env::temp_dir().join(format!("demo-log-test-{}", Uuid::new_v4()));
        let first = create_session_file(&directory).unwrap();
        let mut first_writer = first.writer.clone();
        first_writer.write_all(b"first session\n").unwrap();
        let second = create_session_file(&directory).unwrap();

        assert_ne!(first.session_id, second.session_id);
        assert_ne!(first.writer.path, second.writer.path);
        // guard 仍然存活时已能从磁盘读到记录，后续会话也不会覆盖前次内容。
        assert_eq!(
            fs::read_to_string(first.writer.path.as_ref()).unwrap(),
            "first session\n"
        );
        assert!(
            first
                .writer
                .path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("unix-")
        );

        let first_path = first.writer.path.as_ref().clone();
        let second_path = second.writer.path.as_ref().clone();
        drop(first_writer);
        drop(first);
        drop(second);
        fs::remove_file(first_path).unwrap();
        fs::remove_file(second_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn tracing_events_include_time_level_target_and_fields() {
        let directory = std::env::temp_dir().join(format!("demo-log-test-{}", Uuid::new_v4()));
        let guard = create_session_file(&directory).unwrap();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(guard.writer.clone())
            .finish();
        // 局部 subscriber 不修改进程级日志设施，也不创建游戏 App 或窗口。
        bevy::log::tracing::subscriber::with_default(subscriber, || {
            info!(target: "demo::test", entity_id = 42, reason = "pickup", "Test event recorded");
        });
        let contents = fs::read_to_string(guard.writer.path.as_ref()).unwrap();
        assert!(contents.contains("INFO"));
        assert!(contents.contains("demo::test"));
        assert!(contents.contains("entity_id=42"));
        assert!(contents.contains("pickup"));
        assert!(contents.contains('T') && contents.contains('Z'));

        let path = guard.writer.path.as_ref().clone();
        drop(guard);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
