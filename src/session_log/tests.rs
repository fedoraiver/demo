//! 无窗口验证真实日志插件、会话隔离、过滤和异常落盘。

use std::{fs, io::Write};

use bevy::log::{error, info, tracing_subscriber};

use super::*;
use super::{output::LogWorker, test_support::*};

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
