//! 将帧率设置交给 Bevy 原生窗口循环，不更改固定步时钟。

use super::GameSettings;
use bevy::{
    prelude::*,
    winit::{UpdateMode, WinitSettings},
};
use std::{num::NonZeroU32, time::Duration};

pub(super) fn register(app: &mut App) {
    app.init_resource::<WinitSettings>()
        .add_systems(Startup, log_simulation_timestep)
        // Last 能读取本帧已应用的设置，窗口循环随后直接采用新的更新间隔。
        .add_systems(Last, apply_frame_rate_limit);
}

/// 记录模拟频率，直接读取应用配置的固定时间步，不初始化或覆盖它。
fn log_simulation_timestep(time: Res<Time<Fixed>>) {
    info!(
        target: "demo::settings",
        simulation_hz = 1.0 / time.timestep().as_secs_f64(),
        "Fixed simulation timestep initialized"
    );
}

/// 只同步更新策略；计时与等待由 Winit 执行，Local 仅保存已应用值以去重和记录变更。
fn apply_frame_rate_limit(
    settings: Res<GameSettings>,
    mut winit: ResMut<WinitSettings>,
    mut applied_max_fps: Local<Option<NonZeroU32>>,
) {
    if *applied_max_fps == Some(settings.max_fps) {
        return;
    }

    let mode = UpdateMode::Reactive {
        wait: Duration::from_nanos(1_000_000_000_u64.div_ceil(u64::from(settings.max_fps.get()))),
        // 输入仍缓冲到下一次更新；不让鼠标等事件提前触发额外帧。
        react_to_device_events: false,
        react_to_user_events: false,
        react_to_window_events: false,
    };
    winit.focused_mode = mode;
    winit.unfocused_mode = mode;
    info!(
        target: "demo::settings",
        max_fps_before = ?applied_max_fps.map(NonZeroU32::get),
        max_fps_after = settings.max_fps.get(),
        reason = if applied_max_fps.is_some() {
            "settings_changed"
        } else {
            "initialization"
        },
        "Frame rate limit applied"
    );
    *applied_max_fps = Some(settings.max_fps);
}
