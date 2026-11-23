//! 用独立子进程验证 Bevy 的全局日志配置和文件隔离。

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use bevy::{
    log::{LogPlugin, debug, info},
    prelude::App,
};
use uuid::Uuid;

use super::add_logging;

const CHILD_ENV: &str = "DEMO_LOG_FILE_TEST_CHILD";

#[test]
fn native_log_plugin_writes_separate_files_with_shared_filter() {
    if std::env::var_os(CHILD_ENV).is_some() {
        let mut app = App::new();
        add_logging(&mut app).unwrap();
        assert!(app.is_plugin_added::<LogPlugin>());
        info!(target: "demo::file_test", entity_id = 42, reason = "pickup", "Test event recorded");
        info!(target: "demo::quiet", "Other info event");
        debug!(target: "demo::file_test", "Optional debug event");
        return;
    }

    let directory = Path::new(env!("DEMO_WORKSPACE_ROOT"))
        .join("tmp")
        .join(format!("log-file-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    let logs = directory.join("logs");

    let first = run_child(&directory, None);
    let paths = log_paths(&logs);
    assert_eq!(paths.len(), 1);
    let first_path = &paths[0];
    let first_text = read_log(first_path);
    let first_stderr = String::from_utf8_lossy(&first.stderr);
    for output in [first_text.as_str(), first_stderr.as_ref()] {
        assert!(output.contains("Test event recorded"));
        assert!(output.contains("Other info event"));
        assert!(!output.contains("Optional debug event"));
    }

    let second = run_child(&directory, Some("warn,demo::file_test=debug"));
    let paths = log_paths(&logs);
    assert_eq!(paths.len(), 2);
    let second_path = paths.iter().find(|path| *path != first_path).unwrap();
    assert_eq!(read_log(first_path), first_text);
    let second_text = read_log(second_path);
    let second_stderr = String::from_utf8_lossy(&second.stderr);
    for output in [second_text.as_str(), second_stderr.as_ref()] {
        assert!(output.contains("Test event recorded"));
        assert!(output.contains("Optional debug event"));
        assert!(!output.contains("Other info event"));
        assert!(!output.contains('\u{1b}'));
    }

    for path in paths {
        fs::remove_file(path).unwrap();
    }
    fs::remove_dir(logs).unwrap();
    fs::remove_dir(directory).unwrap();
}

fn run_child(directory: &Path, filter: Option<&str>) -> Output {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "tests::native_log_plugin_writes_separate_files_with_shared_filter",
            "--nocapture",
        ])
        .env(CHILD_ENV, "1")
        .env_remove("RUST_LOG")
        .env_remove("NO_COLOR")
        .current_dir(directory);
    if let Some(filter) = filter {
        command.env("RUST_LOG", filter).env("NO_COLOR", "1");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("running 1 test"));
    output
}

fn log_paths(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}

fn read_log(path: &Path) -> String {
    let stem = path.file_stem().unwrap().to_str().unwrap();
    let (timestamp, id) = stem.strip_prefix("unix-").unwrap().split_once('_').unwrap();
    let (seconds, nanos) = timestamp.split_once('-').unwrap();
    assert_eq!(path.extension().unwrap(), "log");
    assert!(seconds.parse::<u64>().is_ok());
    assert_eq!(nanos.len(), 9);
    assert!(nanos.parse::<u32>().is_ok());
    assert!(Uuid::parse_str(id).is_ok());

    let contents = fs::read_to_string(path).unwrap();
    assert!(!contents.contains('\u{1b}'));
    let event = contents
        .lines()
        .find(|line| line.contains("Test event recorded"))
        .unwrap();
    let (time, event) = event.split_once(' ').unwrap();
    assert!(time.contains('T') && time.ends_with('Z'));
    assert!(
        event
            .trim_start()
            .starts_with("INFO demo::file_test: Test event recorded")
    );
    assert!(event.ends_with("entity_id=42 reason=\"pickup\""));
    contents
}
