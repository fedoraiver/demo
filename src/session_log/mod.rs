//! 在引擎其他插件构建前安装统一文件与后台控制台日志。

mod lifecycle;
mod output;
#[cfg(test)]
mod output_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use std::{io, path::Path};

use bevy::{log::LogPlugin, prelude::*};

pub(crate) use lifecycle::SessionLogGuard;
use lifecycle::{ConsoleWriter, SessionWriter, console_layer, create_session_file, file_layer};

/// 提前准备可失败的文件与线程；插件构建后，守卫仍由主入口持有到退出刷新完成。
pub(crate) struct SessionLogPlugin {
    writer: SessionWriter,
    console: ConsoleWriter,
    session_id: uuid::Uuid,
}

impl SessionLogPlugin {
    /// 创建独立会话输出；失败时尚未安装全局 logger，可由主入口中止启动。
    pub(crate) fn prepare() -> io::Result<(Self, SessionLogGuard)> {
        let guard = create_session_file(Path::new("logs"))?;
        let plugin = Self {
            writer: guard.writer.clone(),
            console: guard.console.clone(),
            session_id: guard.session_id,
        };
        Ok((plugin, guard))
    }
}

impl Plugin for SessionLogPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(self.writer.clone());
        app.insert_resource(self.console.clone());
        // hook 必须先于 LogPlugin，覆盖其后所有引擎和功能插件的初始化异常。
        lifecycle::install_panic_hook(self.writer.clone(), self.session_id);
        app.add_plugins(LogPlugin {
            custom_layer: file_layer,
            fmt_layer: console_layer,
            ..default()
        });
        lifecycle::log_session_start(&self.writer, self.session_id);
    }
}
