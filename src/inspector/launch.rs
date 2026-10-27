//! 在装配引擎前识别诊断命令，参数错误不能意外进入游戏。

use std::ffi::OsString;
#[cfg(feature = "debugdump")]
use std::path::PathBuf;

/// 主入口选择的运行方式；帮助和参数错误不初始化引擎或会话日志。
#[derive(Debug, PartialEq, Eq)]
pub enum LaunchMode {
    Game,
    Help,
    #[cfg(feature = "debugdump")]
    DumpSchedules(PathBuf),
}

/// 解析程序名之后的参数，保留导出路径的原生平台编码。
pub fn parse_launch_mode(args: impl IntoIterator<Item = OsString>) -> Result<LaunchMode, String> {
    let mut args = args.into_iter();
    let Some(command) = args.next() else {
        return Ok(LaunchMode::Game);
    };
    let mode = match command.to_str() {
        Some("--help" | "-h") => LaunchMode::Help,
        Some("--dump-schedules") => {
            #[cfg(not(feature = "debugdump"))]
            return Err("Schedule export requires the 'debugdump' Cargo feature. Run cargo run --locked --features debugdump -- --dump-schedules <directory>.".into());

            #[cfg(feature = "debugdump")]
            {
                let directory = args
                    .next()
                    .ok_or("Missing directory after --dump-schedules.")?;
                if directory.is_empty() || directory.to_string_lossy().starts_with('-') {
                    return Err("Expected an output directory after --dump-schedules.".into());
                }
                LaunchMode::DumpSchedules(PathBuf::from(directory))
            }
        }
        _ => {
            return Err(format!(
                "Unknown argument: {}. Use --help for usage.",
                command.to_string_lossy()
            ));
        }
    };
    if let Some(argument) = args.next() {
        return Err(format!(
            "Unexpected argument: {}.",
            argument.to_string_lossy()
        ));
    }
    Ok(mode)
}

/// 显示帮助而不创建窗口、设备或会话文件。
pub fn print_help() {
    println!(
        "Usage: demo [--help] [--dump-schedules <directory>]\n\n  --dump-schedules <directory>  Export registered schedules as DOT (requires Cargo feature 'debugdump').\n  --help, -h                    Show this help."
    );
}
