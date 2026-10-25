//! 无窗口验证真实日志插件、会话隔离、过滤和异常落盘。

use std::{fs, io::Write};

use bevy::log::{error, info, tracing_subscriber};

use self::test_support::*;
use super::output::LogWorker;
use super::*;

#[test]
fn log_plugin_records_session_lifecycle() {
    // 子进程只运行本测试并注册真实会话插件，隔离全局 subscriber 和 panic hook。
    // 不注册窗口、渲染或玩法插件，也不调用 App::run。
    if std::env::var_os("DEMO_LOG_TEST_CHILD").is_some() {
        let mut app = App::new();
        let (logging, guard) = SessionLogPlugin::prepare().unwrap();
        app.add_plugins(logging);
        // 不推进 Startup：后续插件构建阶段的事件也必须进入同一会话文件。
        struct BuildLogProbe;
        impl Plugin for BuildLogProbe {
            fn build(&self, app: &mut App) {
                assert!(app.is_plugin_added::<SessionLogPlugin>());
                info!(target: "demo::test", reason = "plugin_build", "Feature plugin built after session logging");
            }
        }
        app.add_plugins(BuildLogProbe);
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("running 1 test"),
        "Unexpected child test selection: {stdout}"
    );
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
        "Feature plugin built after session logging",
        "reason=\"plugin_build\"",
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
    assert_eq!(contents.matches("Session started").count(), 1);
    assert!(
        contents.find("Session started").unwrap()
            < contents
                .find("Feature plugin built after session logging")
                .unwrap()
    );
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
        let (logging, guard) = SessionLogPlugin::prepare().unwrap();
        app.add_plugins(logging);
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("running 1 test"),
        "Unexpected child test selection: {stdout}"
    );
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
        let (mut logging, mut guard) = SessionLogPlugin::prepare().unwrap();
        // 保留真实文件与 panic hook，只用可控 Write 故障替换控制台设备。
        guard.console_worker.shutdown().unwrap();
        guard.console_worker = LogWorker::spawn(
            Box::new(FaultSink(Fault::Write)),
            "controlled-failed-console".to_owned(),
            "demo-log-test-failed-console",
        )
        .unwrap();
        guard.console = ConsoleWriter(guard.console_worker.writer.clone());
        logging.console = guard.console.clone();
        app.add_plugins(logging);
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("running 1 test"),
        "Unexpected child test selection: {stdout}"
    );
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

mod output_tests {
    //! 验证慢设备隔离、关闭排空、首个故障与同步屏障。

    use std::{
        fs::{self, File},
        io::{self, Write},
        sync::{Arc, Mutex, mpsc},
        thread,
        time::Duration,
    };

    use bevy::log::{error, info, tracing_subscriber};
    use tracing_subscriber::prelude::*;

    use super::super::{lifecycle::create_session_file, output::*};
    use super::test_support::*;

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
}

mod test_support {
    //! 故障输出设备与根 tmp 下的独立测试目录。

    use std::{
        fs,
        io::{self, Write},
        path::{Path, PathBuf},
        thread,
        time::Duration,
    };
    use uuid::Uuid;

    use super::super::output::LogSink;

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
}
