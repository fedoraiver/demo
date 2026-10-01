//! 为每次游玩保留独立会话文件，并将文件和控制台 I/O 移出游戏线程。

use std::{
    cell::Cell,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle, ThreadId},
    time::{SystemTime, UNIX_EPOCH},
};

use bevy::{
    app::{App, AppExit},
    ecs::resource::Resource,
    log::{BoxedFmtLayer, BoxedLayer, error, info, tracing_subscriber},
};
use tracing_subscriber::{fmt::MakeWriter, prelude::*};
use uuid::Uuid;

/// 保留会话文件到应用退出，并负责退出时刷新日志。
pub struct SessionLogGuard {
    writer: SessionWriter,
    console: ConsoleWriter,
    file_worker: LogWorker,
    console_worker: LogWorker,
    session_id: Uuid,
}

/// 准备会话文件并暂存写入器；创建目录或文件失败时返回错误。
///
/// 必须在添加 `LogPlugin` 前调用，并将返回值保留到退出记录写入后。
pub fn prepare(app: &mut App) -> io::Result<SessionLogGuard> {
    let guard = create_session_file(Path::new("logs"))?;
    app.insert_resource(guard.writer.clone());
    app.insert_resource(guard.console.clone());
    // 先安装异常记录，覆盖 LogPlugin 就绪后其他引擎插件的初始化过程。
    guard.install_panic_hook();
    Ok(guard)
}

/// 为 `LogPlugin::custom_layer` 提供文件输出，沿用 Bevy 的统一日志过滤。
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
            // 格式层不得绕过队列同步回退 stderr；写入错误由退出/关闭屏障反馈。
            .log_internal_errors(false)
            .boxed(),
    )
}

/// 覆盖 Bevy 默认的同步 stderr 格式层，格式与过滤保持不变。
pub fn console_layer(app: &mut App) -> Option<BoxedFmtLayer> {
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
    fn install_panic_hook(&self) {
        let previous_hook = std::panic::take_hook();
        let panic_writer = self.writer.clone();
        let session_id = self.session_id;
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

    /// 记录 Bevy 返回的退出状态，并排空两路输出；应在 `App::run` 返回后调用。
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
struct SessionWriter {
    output: QueuedWriter,
    path: Arc<PathBuf>,
}

impl SessionWriter {
    fn flush_file(&self) -> io::Result<()> {
        self.output.flush_output()
    }

    fn sync(&self) -> io::Result<()> {
        self.output.barrier(Barrier::Sync)
    }
}

trait LogSink: Write + Send {
    fn sync(&mut self) -> io::Result<()> {
        self.flush()
    }
}

impl LogSink for File {
    fn sync(&mut self) -> io::Result<()> {
        self.flush()?;
        self.sync_data()
    }
}

impl LogSink for io::Stderr {}

#[derive(Clone, Resource)]
struct ConsoleWriter(QueuedWriter);

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

thread_local! {
    static IN_LOG_WORKER: Cell<bool> = const { Cell::new(false) };
}

#[derive(Clone, Copy)]
enum Barrier {
    Flush,
    Sync,
    Shutdown,
}

enum OutputCommand {
    Record(Vec<u8>),
    Barrier(Barrier, mpsc::Sender<io::Result<()>>),
}

#[derive(Clone)]
struct OutputFailure {
    kind: io::ErrorKind,
    message: String,
}

impl OutputFailure {
    fn error(&self) -> io::Error {
        io::Error::new(self.kind, self.message.clone())
    }
}

// 锁只保护首个 I/O 错误；工作线程执行 Write 时不持锁，生产线程不会等待慢设备。
type FailureState = Arc<Mutex<Option<OutputFailure>>>;

#[derive(Clone)]
struct QueuedWriter {
    queue: Arc<Mutex<OutputQueue>>,
    failure: FailureState,
    worker_id: ThreadId,
    label: Arc<str>,
}

struct OutputQueue {
    sender: mpsc::Sender<OutputCommand>,
    closing: bool,
}

impl QueuedWriter {
    fn failure(&self) -> io::Result<()> {
        failure_result(&self.failure)
    }

    fn disconnected(&self) -> io::Error {
        self.failure().err().unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("Log worker disconnected: {}", self.label),
            )
        })
    }

    fn barrier(&self, barrier: Barrier) -> io::Result<()> {
        if thread::current().id() == self.worker_id {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Log worker cannot wait on its own queue",
            ));
        }
        let (sender, receiver) = mpsc::channel();
        self.enqueue(OutputCommand::Barrier(barrier, sender))?;
        receiver.recv().map_err(|_| self.disconnected())?
    }

    fn enqueue(&self, command: OutputCommand) -> io::Result<()> {
        // 提交与关闭共用短锁，避免 Shutdown 后仍返回写入成功却遗失尾部记录。
        // 此锁不跨越设备 I/O 或屏障等待，因此控制台/文件堵塞不会传回生产线程。
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if queue.closing {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("Log output is closed: {}", self.label),
            ));
        }
        if matches!(command, OutputCommand::Barrier(Barrier::Shutdown, _)) {
            queue.closing = true;
        }
        queue.sender.send(command).map_err(|_| self.disconnected())
    }

    fn flush_output(&self) -> io::Result<()> {
        self.barrier(Barrier::Flush)
    }
}

impl<'a> MakeWriter<'a> for QueuedWriter {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl Write for QueuedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.failure()?;
        // 无界队列保留每条关键状态，不使用丢弃或等待慢设备的有界队列。
        self.enqueue(OutputCommand::Record(buffer.to_vec()))?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_output()
    }
}

struct LogWorker {
    writer: QueuedWriter,
    thread: Option<JoinHandle<()>>,
}

impl LogWorker {
    fn spawn(mut sink: Box<dyn LogSink>, label: String, name: &str) -> io::Result<Self> {
        let (sender, receiver) = mpsc::channel();
        let failure: FailureState = Arc::new(Mutex::new(None));
        let worker_failure = failure.clone();
        let label: Arc<str> = label.into();
        let worker_label = label.clone();
        let thread = thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                IN_LOG_WORKER.with(|flag| flag.set(true));
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    while let Ok(command) = receiver.recv() {
                        match command {
                            OutputCommand::Record(bytes) => {
                                // 每条记录仍及时刷新；I/O 由独立线程执行，阻塞控制台不拖住文件。
                                if let Err(error) =
                                    sink.write_all(&bytes).and_then(|()| sink.flush())
                                {
                                    record_failure(&worker_failure, &worker_label, error);
                                }
                            }
                            OutputCommand::Barrier(barrier, reply) => {
                                let result = match barrier {
                                    Barrier::Sync => sink.sync(),
                                    Barrier::Flush | Barrier::Shutdown => sink.flush(),
                                };
                                if let Err(error) = result {
                                    record_failure(&worker_failure, &worker_label, error);
                                }
                                let _ = reply.send(failure_result(&worker_failure));
                                if matches!(barrier, Barrier::Shutdown) {
                                    break;
                                }
                            }
                        }
                    }
                }));
                if let Err(payload) = result {
                    let message = payload
                        .downcast_ref::<&str>()
                        .copied()
                        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
                        .unwrap_or("Unknown panic payload");
                    record_failure(
                        &worker_failure,
                        &worker_label,
                        io::Error::other(format!("Log worker panicked: {message}")),
                    );
                }
            })?;
        Ok(Self {
            writer: QueuedWriter {
                queue: Arc::new(Mutex::new(OutputQueue {
                    sender,
                    closing: false,
                })),
                failure,
                worker_id: thread.thread().id(),
                label,
            },
            thread: Some(thread),
        })
    }

    fn shutdown(&mut self) -> io::Result<()> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        let drained = self.writer.barrier(Barrier::Shutdown);
        let joined = thread
            .join()
            .map_err(|_| io::Error::other("Failed to join log worker"));
        drained.and(joined)
    }
}

impl Drop for LogWorker {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            eprintln!("Failed to close log worker {}: {error}", self.writer.label);
        }
    }
}

fn record_failure(failure: &FailureState, label: &str, error: io::Error) {
    let mut failure = failure
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if failure.is_none() {
        *failure = Some(OutputFailure {
            kind: error.kind(),
            message: format!("Failed to write or flush log output {label}: {error}"),
        });
    }
}

fn failure_result(failure: &FailureState) -> io::Result<()> {
    let failure = failure
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match failure.as_ref() {
        Some(failure) => Err(failure.error()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};

    struct BlockedSink {
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        contents: Arc<Mutex<Vec<u8>>>,
        first_write: bool,
    }

    impl Write for BlockedSink {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.first_write {
                self.first_write = false;
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
            }
            self.contents.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl LogSink for BlockedSink {}

    #[test]
    fn blocked_sink_does_not_block_tracing_producer() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let contents = Arc::new(Mutex::new(Vec::new()));
        let mut worker = LogWorker::spawn(
            Box::new(BlockedSink {
                entered: entered_tx,
                release: release_rx,
                contents: contents.clone(),
                first_write: true,
            }),
            "controlled-test-sink".to_owned(),
            "demo-log-test",
        )
        .unwrap();
        let writer = worker.writer.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(writer.clone())
            .finish();
        let dispatch = bevy::log::tracing::Dispatch::new(subscriber);
        let initial_dispatch = dispatch.clone();
        let initial = thread::spawn(move || {
            bevy::log::tracing::dispatcher::with_default(&initial_dispatch, || {
                info!(target: "demo::test", "Blocking sink entered");
            });
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let producer = thread::spawn(move || {
            bevy::log::tracing::dispatcher::with_default(&dispatch, || {
                info!(target: "demo::gameplay", grounded_after = true, "Character grounded state changed");
                info!(target: "demo::gameplay", "Character landed");
            });
            done_tx.send(()).unwrap();
        });
        // 门闩尚未释放时确认生产线程返回；超时只用于检测死锁，不比较硬件耗时。
        let completed_while_blocked = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        release_tx.send(()).unwrap();
        initial.join().unwrap();
        producer.join().unwrap();
        writer.flush_output().unwrap();
        worker.shutdown().unwrap();
        let contents = String::from_utf8(contents.lock().unwrap().clone()).unwrap();
        assert!(contents.contains("Blocking sink entered"));
        assert!(
            contents.find("grounded state changed").unwrap()
                < contents.find("Character landed").unwrap()
        );
        assert!(
            completed_while_blocked,
            "Tracing producer waited for blocked log I/O"
        );
    }

    #[test]
    fn blocked_console_does_not_block_file_or_producer() {
        let directory = test_directory();
        let path = directory.join("independent-workers.log");
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let console_contents = Arc::new(Mutex::new(Vec::new()));
        let mut file = LogWorker::spawn(
            Box::new(File::create(&path).unwrap()),
            path.display().to_string(),
            "demo-log-test-file",
        )
        .unwrap();
        let mut console = LogWorker::spawn(
            Box::new(BlockedSink {
                entered: entered_tx,
                release: release_rx,
                contents: console_contents.clone(),
                first_write: true,
            }),
            "controlled-console".to_owned(),
            "demo-log-test-console",
        )
        .unwrap();
        let subscriber = tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(file.writer.clone()),
            )
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(console.writer.clone()),
            );
        let dispatch = bevy::log::tracing::Dispatch::new(subscriber);
        let initial_dispatch = dispatch.clone();
        let initial = thread::spawn(move || {
            bevy::log::tracing::dispatcher::with_default(&initial_dispatch, || {
                info!(target: "demo::test", "Blocking console entered");
            });
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let file_writer = file.writer.clone();
        let producer = thread::spawn(move || {
            bevy::log::tracing::dispatcher::with_default(&dispatch, || {
                info!(target: "demo::gameplay", grounded_after = true, "Character grounded state changed");
                info!(target: "demo::gameplay", "Character landed");
                info!(target: "demo::session_log", "Session exited normally");
            });
            done_tx.send(file_writer.flush_output()).unwrap();
        });
        // 控制台门闩保持关闭时，生产与文件刷新都必须完成。
        let completed = done_rx.recv_timeout(Duration::from_secs(2));
        let file_contents = fs::read_to_string(&path).unwrap();
        release_tx.send(()).unwrap();
        initial.join().unwrap();
        producer.join().unwrap();
        file.shutdown().unwrap();
        console.shutdown().unwrap();
        let console_contents = String::from_utf8(console_contents.lock().unwrap().clone()).unwrap();
        fs::remove_file(&path).unwrap();
        remove_test_directory(directory);

        completed
            .expect("Blocked console stalled file or producer")
            .unwrap();
        for contents in [file_contents, console_contents] {
            let mut previous = 0;
            for expected in [
                "Blocking console entered",
                "Character grounded state changed",
                "Character landed",
                "Session exited normally",
            ] {
                let offset = contents.find(expected).unwrap();
                assert!(offset >= previous, "Log order changed: {contents}");
                previous = offset;
                assert_eq!(contents.matches(expected).count(), 1);
            }
        }
    }

    #[test]
    fn shutdown_drains_all_queued_records() {
        let directory = test_directory();
        let guard = create_session_file(&directory).unwrap();
        let path = guard.writer.path.as_ref().clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(guard.writer.clone())
            .finish();
        bevy::log::tracing::subscriber::with_default(subscriber, || {
            for sequence in 0..1_000 {
                info!(target: "demo::test", sequence, "Queued state change");
            }
        });
        // 不提前刷新，直接析构必须排空所有已提交记录并关闭文件。
        drop(guard);
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 1_000);
        for (sequence, line) in contents.lines().enumerate() {
            assert!(line.ends_with(&format!("sequence={sequence}")));
        }
        fs::remove_file(path).unwrap();
        remove_test_directory(directory);
    }

    #[test]
    fn shutdown_rejects_new_records_and_drains_accepted_records() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (closed_tx, closed_rx) = mpsc::channel();
        let contents = Arc::new(Mutex::new(Vec::new()));
        let mut worker = LogWorker::spawn(
            Box::new(BlockedSink {
                entered: entered_tx,
                release: release_rx,
                contents: contents.clone(),
                first_write: true,
            }),
            "controlled-close-sink".to_owned(),
            "demo-log-test-close",
        )
        .unwrap();
        worker.writer.write_all(b"Accepted record\n").unwrap();
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut writer = worker.writer.clone();
        let closing = thread::spawn(move || {
            let result = worker.shutdown();
            closed_tx.send(result).unwrap();
        });
        // 等到关闭命令入队；设备仍在门闩中，所以不能依赖 join 已完成才检测拒收。
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut closed = false;
        while std::time::Instant::now() < deadline {
            closed = writer.queue.lock().unwrap().closing;
            if closed {
                break;
            }
            thread::yield_now();
        }
        let rejected = writer.write_all(b"Rejected record\n");
        let waiting_for_drain = matches!(closed_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
        release_tx.send(()).unwrap();
        closing.join().unwrap();
        closed_rx.recv().unwrap().unwrap();
        assert!(closed, "Shutdown was not queued");
        assert!(
            waiting_for_drain,
            "Shutdown did not wait for the accepted record"
        );
        assert_eq!(rejected.unwrap_err().kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(*contents.lock().unwrap(), b"Accepted record\n");
    }

    #[derive(Clone, Copy)]
    enum Fault {
        Write,
        Flush,
        Sync,
        Panic,
    }

    struct FaultSink(Fault);

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

    #[test]
    fn output_failures_are_reported_and_workers_join() {
        for (fault, expected) in [
            (Fault::Write, "Test disk full"),
            (Fault::Flush, "Test flush failure"),
            (Fault::Sync, "Test sync failure"),
            (Fault::Panic, "Test writer panic"),
        ] {
            let mut worker = LogWorker::spawn(
                Box::new(FaultSink(fault)),
                "controlled-failed-sink".to_owned(),
                "demo-log-test-failure",
            )
            .unwrap();
            worker.writer.write_all(b"Critical state change\n").unwrap();
            let error = worker.writer.barrier(Barrier::Sync).unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
            assert!(error.to_string().contains("controlled-failed-sink"));
            assert!(worker.writer.write_all(b"Next state\n").is_err());
            assert!(
                worker
                    .shutdown()
                    .unwrap_err()
                    .to_string()
                    .contains(expected)
            );
            assert!(worker.thread.is_none());
        }
    }

    struct SyncSink {
        contents: Arc<Mutex<Vec<u8>>>,
        synced_contents: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for SyncSink {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            // 模拟短写，确认后台使用 write_all 而不是忽略未写完的尾部。
            let length = buffer.len().min(7);
            self.contents
                .lock()
                .unwrap()
                .extend_from_slice(&buffer[..length]);
            Ok(length)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl LogSink for SyncSink {
        fn sync(&mut self) -> io::Result<()> {
            *self.synced_contents.lock().unwrap() = self.contents.lock().unwrap().clone();
            Ok(())
        }
    }

    #[test]
    fn sync_barrier_waits_for_complete_prior_records() {
        let contents = Arc::new(Mutex::new(Vec::new()));
        let synced_contents = Arc::new(Mutex::new(Vec::new()));
        let mut worker = LogWorker::spawn(
            Box::new(SyncSink {
                contents,
                synced_contents: synced_contents.clone(),
            }),
            "controlled-sync-sink".to_owned(),
            "demo-log-test-sync",
        )
        .unwrap();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(worker.writer.clone())
            .finish();
        bevy::log::tracing::subscriber::with_default(subscriber, || {
            info!(target: "demo::test", "Prior state change");
            error!(target: "demo::session_log", "Session panicked");
        });
        worker.writer.barrier(Barrier::Sync).unwrap();
        let synced = String::from_utf8(synced_contents.lock().unwrap().clone()).unwrap();
        assert_eq!(synced.lines().count(), 2);
        assert!(
            synced.find("Prior state change").unwrap() < synced.find("Session panicked").unwrap()
        );
        worker.shutdown().unwrap();
    }

    #[test]
    fn log_plugin_records_session_lifecycle() {
        // 子进程只运行本测试并注册 LogPlugin，隔离全局 subscriber 和 panic hook。
        // 不注册窗口、渲染或玩法插件，也不调用 App::run。
        if std::env::var_os("DEMO_LOG_TEST_CHILD").is_some() {
            let mut app = App::new();
            let guard = prepare(&mut app).unwrap();
            app.add_plugins(bevy::log::LogPlugin {
                custom_layer: file_layer,
                fmt_layer: console_layer,
                ..Default::default()
            });
            guard.start();
            info!(target: "bevy::test", "Test engine initialized");
            info!(target: "demo::test", entity_id = 42, reason = "pickup", "Test event recorded");
            bevy::log::debug!(target: "demo::test", "Filtered debug event");
            bevy::log::warn!(target: "wgpu", "Filtered graphics warning");
            assert!(std::panic::catch_unwind(|| panic!("Test panic context")).is_err());
            // panic hook 返回前已同步文件，不能依赖随后退出时的刷新才看到异常。
            let contents = fs::read_to_string(guard.writer.path.as_ref()).unwrap();
            assert!(contents.contains("Session panicked"));
            assert!(contents.contains("Test panic context"));
            // 安装真实 Session hook 后，日志工作线程自身异常仍能结束，不能自等 Sync。
            let mut failed_worker = LogWorker::spawn(
                Box::new(FaultSink(Fault::Panic)),
                "controlled-hook-panic".to_owned(),
                "demo-log-test-hook-panic",
            )
            .unwrap();
            failed_worker.writer.write_all(b"Worker panic\n").unwrap();
            assert!(failed_worker.writer.flush_output().is_err());
            assert!(failed_worker.shutdown().is_err());
            guard.record_exit(&AppExit::Success).unwrap();
            guard.record_exit(&AppExit::error()).unwrap();
            return;
        }

        let directory = test_directory();
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
        remove_test_directory(directory.join("logs"));
        remove_test_directory(directory);
    }

    #[test]
    fn log_plugin_preserves_explicit_rust_log_filter() {
        if std::env::var_os("DEMO_LOG_FILTER_TEST_CHILD").is_some() {
            let mut app = App::new();
            let guard = prepare(&mut app).unwrap();
            app.add_plugins(bevy::log::LogPlugin {
                custom_layer: file_layer,
                fmt_layer: console_layer,
                ..Default::default()
            });
            guard.start();
            info!(target: "demo::quiet", "Filtered explicit info event");
            bevy::log::debug!(target: "demo::test", "Enabled explicit debug event");
            bevy::log::warn!(target: "wgpu", "Enabled explicit graphics warning");
            guard.record_exit(&AppExit::Success).unwrap();
            return;
        }

        // 子进程避免注册全局 subscriber；两路格式层应共享同一 Bevy EnvFilter。
        let directory = test_directory();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session_log::tests::log_plugin_preserves_explicit_rust_log_filter",
                "--nocapture",
            ])
            .env("DEMO_LOG_FILTER_TEST_CHILD", "1")
            .env(
                "RUST_LOG",
                "warn,demo::test=debug,demo::session_log=info,wgpu=warn",
            )
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
        for contents in [&contents, stderr.as_ref()] {
            assert!(contents.contains("Enabled explicit debug event"));
            assert!(contents.contains("Enabled explicit graphics warning"));
            assert!(contents.contains("Session exited normally"));
            assert!(!contents.contains("Filtered explicit info event"));
        }
        fs::remove_file(&paths[0]).unwrap();
        remove_test_directory(directory.join("logs"));
        remove_test_directory(directory);
    }

    #[test]
    fn failed_console_does_not_fallback_to_synchronous_stderr_or_block_panic_file_sync() {
        if std::env::var_os("DEMO_LOG_FAILED_CONSOLE_TEST_CHILD").is_some() {
            let mut app = App::new();
            let mut guard = prepare(&mut app).unwrap();
            // 保留真实文件与 panic hook，只用可控 Write 故障替换控制台设备。
            guard.console_worker.shutdown().unwrap();
            guard.console_worker = LogWorker::spawn(
                Box::new(FaultSink(Fault::Write)),
                "controlled-failed-console".to_owned(),
                "demo-log-test-failed-console",
            )
            .unwrap();
            guard.console = ConsoleWriter(guard.console_worker.writer.clone());
            app.insert_resource(guard.console.clone());
            app.add_plugins(bevy::log::LogPlugin {
                custom_layer: file_layer,
                fmt_layer: console_layer,
                ..Default::default()
            });
            guard.start();
            assert!(guard.console.0.flush_output().is_err());
            // 已知设备故障后仍走实际格式化路径，文件必须收到完整事件。
            info!(target: "demo::test", "Info event after console failure");
            error!(target: "demo::test", "Error event after console failure");
            assert!(std::panic::catch_unwind(|| panic!("Panic after console failure")).is_err());
            let contents = fs::read_to_string(guard.writer.path.as_ref()).unwrap();
            for expected in [
                "Info event after console failure",
                "Error event after console failure",
                "Session panicked",
                "Panic after console failure",
            ] {
                assert!(
                    contents.contains(expected),
                    "Missing {expected}: {contents}"
                );
            }
            // 故障保持可观察，不能为避免同步回退而把关闭结果误报为成功。
            let error = guard.record_exit(&AppExit::Success).unwrap_err();
            assert!(error.to_string().contains("controlled-failed-console"));
            return;
        }

        let directory = test_directory();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session_log::tests::failed_console_does_not_fallback_to_synchronous_stderr_or_block_panic_file_sync",
                "--nocapture",
            ])
            .env("DEMO_LOG_FAILED_CONSOLE_TEST_CHILD", "1")
            .env_remove("RUST_LOG")
            .current_dir(&directory)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stderr}");
        assert!(!stderr.contains("[tracing-subscriber]"), "{stderr}");
        assert!(!stderr.contains("Unable to write"), "{stderr}");
        assert!(
            stderr.contains("Failed to close console logging"),
            "{stderr}"
        );
        assert!(stderr.contains("Test disk full"), "{stderr}");
        let paths: Vec<_> = fs::read_dir(directory.join("logs"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(paths.len(), 1);
        let contents = fs::read_to_string(&paths[0]).unwrap();
        assert!(contents.contains("Session exited normally"));
        fs::remove_file(&paths[0]).unwrap();
        remove_test_directory(directory.join("logs"));
        remove_test_directory(directory);
    }

    #[test]
    fn independent_sessions_preserve_previous_logs() {
        let directory = test_directory();
        let first = create_session_file(&directory).unwrap();
        let mut first_writer = first.writer.clone();
        first_writer.write_all(b"first session\n").unwrap();
        first_writer.flush().unwrap();
        let second = create_session_file(&directory).unwrap();

        assert_ne!(first.session_id, second.session_id);
        assert_ne!(first.writer.path, second.writer.path);
        // 刷新屏障保证磁盘已收到记录，后续会话也不会覆盖前次内容。
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
        remove_test_directory(directory);
    }

    #[test]
    fn tracing_events_include_time_level_target_and_fields() {
        let directory = test_directory();
        let guard = create_session_file(&directory).unwrap();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(guard.writer.clone())
            .finish();
        // 局部 subscriber 不修改进程级日志设施，也不创建游戏 App 或窗口。
        bevy::log::tracing::subscriber::with_default(subscriber, || {
            info!(target: "demo::test", entity_id = 42, reason = "pickup", "Test event recorded");
        });
        guard.writer.flush_file().unwrap();
        let contents = fs::read_to_string(guard.writer.path.as_ref()).unwrap();
        assert!(contents.contains("INFO"));
        assert!(contents.contains("demo::test"));
        assert!(contents.contains("entity_id=42"));
        assert!(contents.contains("pickup"));
        assert!(contents.contains('T') && contents.contains('Z'));

        let path = guard.writer.path.as_ref().clone();
        drop(guard);
        fs::remove_file(path).unwrap();
        remove_test_directory(directory);
    }

    fn test_directory() -> PathBuf {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tmp")
            .join(format!("session-log-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn remove_test_directory(directory: PathBuf) {
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
}
