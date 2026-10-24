//! 会话文件、统一日志 layer、异常同步与退出守卫。

use std::{
    cell::Cell,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use bevy::{
    app::{App, AppExit},
    ecs::resource::Resource,
    log::{BoxedFmtLayer, BoxedLayer, error, info, tracing_subscriber},
};
use tracing_subscriber::{fmt::MakeWriter, prelude::*};
use uuid::Uuid;

use super::output::{Barrier, IN_LOG_WORKER, LogWorker, QueuedWriter};

/// 保留会话文件到应用退出，并负责退出时刷新日志。
pub(crate) struct SessionLogGuard {
    pub(super) writer: SessionWriter,
    pub(super) console: ConsoleWriter,
    pub(super) file_worker: LogWorker,
    pub(super) console_worker: LogWorker,
    pub(super) session_id: Uuid,
}

/// 为 `LogPlugin::custom_layer` 提供文件输出，沿用 Bevy 的统一日志过滤。
///
/// 插件必须已暂存写入器；写入器已被取走时 panic。
pub(super) fn file_layer(app: &mut App) -> Option<BoxedLayer> {
    // 写入器只在插件构建时传递，随后由日志 layer 持有，不占用玩法资源。
    let writer = app
        .world_mut()
        .remove_resource::<SessionWriter>()
        .expect("Session log must be prepared before adding LogPlugin");
    Some(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(writer)
            // 格式层不得绕过队列同步回退 stderr；写入错误由退出/关闭屏障反馈。
            .log_internal_errors(false)
            .boxed(),
    )
}

/// 覆盖 Bevy 默认的同步 stderr 格式层，格式与过滤保持不变。
pub(super) fn console_layer(app: &mut App) -> Option<BoxedFmtLayer> {
    let writer = app
        .world_mut()
        .remove_resource::<ConsoleWriter>()
        .expect("Session log must be prepared before adding LogPlugin");
    // 返回 Some 才会覆盖默认 stderr；None 会使 Bevy 恢复同步控制台输出。
    Some(Box::new(
        tracing_subscriber::fmt::layer()
            .with_writer(writer)
            // 控制台故障也不能阻塞普通日志或 panic 的文件同步。
            .log_internal_errors(false),
    ))
}

impl SessionLogGuard {
    /// 记录 Bevy 返回的退出状态，并排空两路输出；应在 `App::run` 返回后调用。
    pub(crate) fn record_exit(&self, exit: &AppExit) -> io::Result<()> {
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
        let file = self.writer.flush_file();
        let console = self.console.0.flush_output();
        file.and(console)
    }
}

impl Drop for SessionLogGuard {
    fn drop(&mut self) {
        // 全局日志 layer 仍持有 sender，必须显式停止线程，不能依赖 sender 的析构。
        if let Err(err) = self.file_worker.shutdown() {
            eprintln!("Failed to close log {}: {err}", self.writer.path.display());
        }
        if let Err(err) = self.console_worker.shutdown() {
            eprintln!("Failed to close console logging: {err}");
        }
    }
}

pub(super) fn create_session_file(directory: &Path) -> io::Result<SessionLogGuard> {
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
    let file_worker =
        LogWorker::spawn(Box::new(file), path.display().to_string(), "demo-log-file")?;
    let console_worker = LogWorker::spawn(
        Box::new(io::stderr()),
        "stderr".to_owned(),
        "demo-log-console",
    )?;
    Ok(SessionLogGuard {
        writer: SessionWriter {
            output: file_worker.writer.clone(),
            path: Arc::new(path),
        },
        console: ConsoleWriter(console_worker.writer.clone()),
        file_worker,
        console_worker,
        session_id,
    })
}

#[derive(Clone, Resource)]
pub(super) struct SessionWriter {
    pub(super) output: QueuedWriter,
    pub(super) path: Arc<PathBuf>,
}

impl SessionWriter {
    pub(super) fn flush_file(&self) -> io::Result<()> {
        self.output.flush_output()
    }

    pub(super) fn sync(&self) -> io::Result<()> {
        self.output.barrier(Barrier::Sync)
    }
}

#[derive(Clone, Resource)]
pub(super) struct ConsoleWriter(pub(super) QueuedWriter);

impl<'a> MakeWriter<'a> for ConsoleWriter {
    type Writer = QueuedWriter;

    fn make_writer(&'a self) -> Self::Writer {
        self.0.clone()
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
        self.output.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_file()
    }
}

pub(super) fn install_panic_hook(panic_writer: SessionWriter, session_id: Uuid) {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        // 工作线程异常由其 catch_unwind 保存并在写入/刷新时反馈，不能等待自己排空。
        if IN_LOG_WORKER.with(Cell::get) {
            return;
        }
        error!(
            target: "demo::session_log",
            %session_id,
            path = %panic_writer.path.display(),
            error = %panic_info,
            "Session panicked"
        );
        // 优先排空文件队列并 sync_data；控制台阻塞不能影响异常上下文落盘。
        if let Err(err) = panic_writer.sync() {
            eprintln!("Failed to sync log {}: {err}", panic_writer.path.display());
        }
        previous_hook(panic_info);
    }));
}

/// 在 `LogPlugin` 初始化后写入会话开始信息。
pub(super) fn log_session_start(writer: &SessionWriter, session_id: Uuid) {
    info!(
        target: "demo::session_log",
        session_id = %session_id,
        path = %writer.path.display(),
        version = env!("CARGO_PKG_VERSION"),
        bevy_version = "0.20.0",
        state_before = "not_started",
        state_after = "initializing",
        reason = "user_started_program",
        "Session started"
    );
}
