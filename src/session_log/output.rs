//! 文件与控制台各自排队；同步屏障和关闭反馈保留首个后台错误。

use std::{
    cell::Cell,
    fs::File,
    io::{self, Write},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle, ThreadId},
};

use bevy::log::tracing_subscriber;
use tracing_subscriber::fmt::MakeWriter;

thread_local! {
    pub(super) static IN_LOG_WORKER: Cell<bool> = const { Cell::new(false) };
}

pub(super) trait LogSink: Write + Send {
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

#[derive(Clone, Copy)]
pub(super) enum Barrier {
    Flush,
    Sync,
    Shutdown,
}

pub(super) enum OutputCommand {
    Record(Vec<u8>),
    Barrier(Barrier, mpsc::Sender<io::Result<()>>),
}

#[derive(Clone)]
pub(super) struct OutputFailure {
    pub(super) kind: io::ErrorKind,
    pub(super) message: String,
}

impl OutputFailure {
    pub(super) fn error(&self) -> io::Error {
        io::Error::new(self.kind, self.message.clone())
    }
}

// 锁只保护首个 I/O 错误；工作线程执行 Write 时不持锁，生产线程不会等待慢设备。
pub(super) type FailureState = Arc<Mutex<Option<OutputFailure>>>;

#[derive(Clone)]
pub(super) struct QueuedWriter {
    pub(super) queue: Arc<Mutex<OutputQueue>>,
    pub(super) failure: FailureState,
    pub(super) worker_id: ThreadId,
    pub(super) label: Arc<str>,
}

pub(super) struct OutputQueue {
    pub(super) sender: mpsc::Sender<OutputCommand>,
    pub(super) closing: bool,
}

impl QueuedWriter {
    pub(super) fn failure(&self) -> io::Result<()> {
        failure_result(&self.failure)
    }

    pub(super) fn disconnected(&self) -> io::Error {
        self.failure().err().unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                format!("Log worker disconnected: {}", self.label),
            )
        })
    }

    pub(super) fn barrier(&self, barrier: Barrier) -> io::Result<()> {
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

    pub(super) fn enqueue(&self, command: OutputCommand) -> io::Result<()> {
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

    pub(super) fn flush_output(&self) -> io::Result<()> {
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

pub(super) struct LogWorker {
    pub(super) writer: QueuedWriter,
    pub(super) thread: Option<JoinHandle<()>>,
}

impl LogWorker {
    pub(super) fn spawn(mut sink: Box<dyn LogSink>, label: String, name: &str) -> io::Result<Self> {
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

    pub(super) fn shutdown(&mut self) -> io::Result<()> {
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
