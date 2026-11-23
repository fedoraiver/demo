//! 为 Bevy 的日志插件准备每次启动独立的文件输出。

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use bevy::{
    log::{BoxedLayer, LogPlugin, tracing_subscriber},
    prelude::*,
};
use tracing_subscriber::prelude::*;
use uuid::Uuid;

#[cfg(test)]
mod tests;

#[derive(Resource)]
struct LogFile {
    file: File,
}

/// 在注册引擎插件前创建日志文件，使打开失败能由入口报告。
pub(crate) fn prepare(app: &mut App) -> io::Result<LogPlugin> {
    let directory = Path::new("logs");
    fs::create_dir_all(directory).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Failed to create log directory {}: {error}",
                directory.display()
            ),
        )
    })?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let id = Uuid::new_v4();
    let path = directory.join(format!(
        "unix-{}-{:09}_{id}.log",
        timestamp.as_secs(),
        timestamp.subsec_nanos(),
    ));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Failed to create log file {}: {error}", path.display()),
            )
        })?;
    app.insert_resource(LogFile { file });
    Ok(LogPlugin {
        custom_layer: file_layer,
        ..default()
    })
}

fn file_layer(app: &mut App) -> Option<BoxedLayer> {
    // 构建时把文件交给格式层，整条日志的写入持有同一把锁。
    let log_file = app
        .world_mut()
        .remove_resource::<LogFile>()
        .expect("Log file must be prepared before adding LogPlugin");
    Some(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(Mutex::new(log_file.file))
            .log_internal_errors(true)
            .boxed(),
    )
}
