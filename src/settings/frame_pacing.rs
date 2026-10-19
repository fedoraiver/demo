//! 渲染限帧只补足当前间隔，不更改固定步时钟。

use super::GameSettings;
use bevy::{prelude::*, time::TimeSystems};
use std::{
    num::NonZeroU32,
    time::{Duration, Instant},
};

pub(super) fn register(app: &mut App) {
    app.add_systems(Startup, log_simulation_timestep)
        .add_systems(First, limit_frame_rate.before(TimeSystems));
}

/// 记录模拟频率，直接读取应用配置的固定时间步，不初始化或覆盖它。
fn log_simulation_timestep(time: Res<Time<Fixed>>) {
    info!(
        target: "demo::settings",
        simulation_hz = 1.0 / time.timestep().as_secs_f64(),
        "Fixed simulation timestep initialized"
    );
}

/// 等待和日志去重只属于帧率系统，使用 Local 而非共享的游戏状态。
#[derive(Default)]
struct FramePacing {
    last_started: Option<Instant>,
    applied_max_fps: Option<NonZeroU32>,
}

/// 只补足上一帧起点以来剩余的间隔；计算本身已超时时立即继续，不叠加等待。
fn limit_frame_rate(settings: Res<GameSettings>, mut pacing: Local<FramePacing>) {
    if pacing.applied_max_fps != Some(settings.max_fps) {
        info!(
            target: "demo::settings",
            max_fps_before = ?pacing.applied_max_fps.map(NonZeroU32::get),
            max_fps_after = settings.max_fps.get(),
            reason = if pacing.applied_max_fps.is_some() {
                "settings_changed"
            } else {
                "initialization"
            },
            "Frame rate limit applied"
        );
        pacing.applied_max_fps = Some(settings.max_fps);
    }

    if let Some(last_started) = pacing.last_started {
        let wait = remaining_frame_time(last_started.elapsed(), settings.max_fps);
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
    }
    // 卡顿后从实际起点重新计时，避免为了追赶期限连续提交超出上限的帧。
    pacing.last_started = Some(Instant::now());
}

pub(super) fn remaining_frame_time(elapsed: Duration, max_fps: NonZeroU32) -> Duration {
    // 向上取整到纳秒，避免舍入使允许的间隔略短于帧率上限要求。
    let interval = Duration::from_nanos(1_000_000_000_u64.div_ceil(u64::from(max_fps.get())));
    interval.saturating_sub(elapsed)
}
