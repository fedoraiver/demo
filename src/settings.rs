//! 加载玩家设置，并通过帧间等待限制渲染循环；不改变固定步模拟频率。

use std::{
    fs, io,
    num::NonZeroU32,
    path::Path,
    time::{Duration, Instant},
};

use bevy::{prelude::*, time::TimeSystems};
use serde::Deserialize;

/// 全局玩家设置；非零类型保证帧率上限始终能够转换为等待间隔。
#[derive(Resource, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GameSettings {
    /// 渲染循环每秒最多更新的次数，不影响 `Time<Fixed>`。
    pub max_fps: NonZeroU32,
}

impl Default for GameSettings {
    fn default() -> Self {
        Self {
            max_fps: NonZeroU32::new(120).unwrap(),
        }
    }
}

impl GameSettings {
    /// 读取 JSON 设置；缺失或读取、解析失败时记录原因并使用默认值，不覆盖原文件。
    pub fn load(path: &Path) -> Self {
        let settings = match read_settings(path) {
            Ok(settings) => settings,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                info!(
                    target: "demo::settings",
                    path = %path.display(),
                    reason = "settings_file_missing",
                    "Using default game settings"
                );
                Self::default()
            }
            Err(error) => {
                warn!(
                    target: "demo::settings",
                    operation = "load_settings",
                    path = %path.display(),
                    %error,
                    fallback_max_fps = 120,
                    reason = "settings_load_failed",
                    "Failed to load game settings; using defaults"
                );
                Self::default()
            }
        };
        info!(
            target: "demo::settings",
            path = %path.display(),
            max_fps = settings.max_fps.get(),
            "Game settings initialized"
        );
        settings
    }
}

/// 注册帧率限制系统；设置资源也可由后续设置界面在运行期间修改。
pub struct SettingsPlugin;

impl Plugin for SettingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GameSettings>()
            .add_systems(Startup, log_simulation_timestep)
            // 等待在时间与业务系统之前完成；固定步仍由引擎时钟驱动，不改写模拟时间步。
            .add_systems(First, limit_frame_rate.before(TimeSystems));
    }
}

/// 等待和日志去重只属于帧率系统，使用 Local 而非共享的游戏状态。
#[derive(Default)]
struct FramePacing {
    last_started: Option<Instant>,
    applied_max_fps: Option<NonZeroU32>,
}

fn read_settings(path: &Path) -> io::Result<GameSettings> {
    let contents = fs::read_to_string(path)?;
    serde_json::from_str(&contents)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn log_simulation_timestep(time: Res<Time<Fixed>>) {
    info!(
        target: "demo::settings",
        simulation_hz = 1.0 / time.timestep().as_secs_f64(),
        "Fixed simulation timestep initialized"
    );
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

fn remaining_frame_time(elapsed: Duration, max_fps: NonZeroU32) -> Duration {
    // 向上取整到纳秒，避免舍入使允许的间隔略短于帧率上限要求。
    let interval = Duration::from_nanos(1_000_000_000_u64.div_ceil(u64::from(max_fps.get())));
    interval.saturating_sub(elapsed)
}

#[cfg(test)]
mod tests {
    use bevy::time::{TimePlugin, TimeUpdateStrategy};
    use uuid::Uuid;

    use super::*;

    #[test]
    fn defaults_and_json_validate_frame_rate_limit() {
        assert_eq!(GameSettings::default().max_fps.get(), 120);
        let omitted: GameSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(omitted.max_fps.get(), 120);
        let custom: GameSettings = serde_json::from_str(r#"{"max_fps": 144}"#).unwrap();
        assert_eq!(custom.max_fps.get(), 144);
        for invalid in [
            r#"{"max_fps": 0}"#,
            r#"{"max_fps": -60}"#,
            r#"{"max_fps": 60.5}"#,
            r#"{"max_fps": "120"}"#,
            r#"{"max_fp": 120}"#,
        ] {
            assert!(serde_json::from_str::<GameSettings>(invalid).is_err());
        }
    }

    #[test]
    fn settings_file_and_failure_fallback_preserve_original_contents() {
        let path = std::env::temp_dir().join(format!("demo-settings-{}.json", Uuid::new_v4()));
        assert_eq!(GameSettings::load(&path).max_fps.get(), 120);
        assert!(!path.exists());
        fs::write(&path, r#"{"max_fps": 240}"#).unwrap();
        assert_eq!(GameSettings::load(&path).max_fps.get(), 240);
        let invalid = r#"{"max_fps": 0}"#;
        fs::write(&path, invalid).unwrap();
        assert_eq!(GameSettings::load(&path).max_fps.get(), 120);
        assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn pacing_waits_only_for_remaining_time_and_never_catches_up() {
        let limit = NonZeroU32::new(120).unwrap();
        assert_eq!(
            remaining_frame_time(Duration::from_millis(3), limit),
            Duration::from_nanos(5_333_334)
        );
        assert_eq!(
            remaining_frame_time(Duration::from_millis(20), limit),
            Duration::ZERO
        );
        assert_eq!(
            remaining_frame_time(Duration::from_millis(3), NonZeroU32::new(60).unwrap()),
            Duration::from_nanos(13_666_667)
        );
    }

    #[test]
    fn changing_render_limit_preserves_fixed_simulation_timestep() {
        // 只运行最小 App；手动推进时间，不加载窗口、渲染器或完整游戏。
        let mut app = App::new();
        app.add_plugins(TimePlugin)
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
                20,
            )))
            .add_plugins(SettingsPlugin);
        app.update();
        let timestep = app.world().resource::<Time<Fixed>>().timestep();
        app.world_mut().resource_mut::<GameSettings>().max_fps = NonZeroU32::new(30).unwrap();
        app.update();
        let fixed = app.world().resource::<Time<Fixed>>();
        assert_eq!(fixed.timestep(), timestep);
        assert!((1.0 / fixed.timestep().as_secs_f64() - 60.0).abs() < 0.001);
        assert!(fixed.elapsed() >= timestep);
    }
}
