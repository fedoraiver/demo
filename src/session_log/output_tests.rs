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

use super::{lifecycle::create_session_file, output::*, test_support::*};

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
    assert!(synced.find("Prior state change").unwrap() < synced.find("Session panicked").unwrap());
    worker.shutdown().unwrap();
}
