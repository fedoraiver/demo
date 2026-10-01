//! 加载玩家设置，并通过帧间等待限制渲染循环；不改变固定步模拟频率。

use std::{
    fs, io,
    num::NonZeroU32,
    path::Path,
    time::{Duration, Instant},
};

use bevy::{prelude::*, time::TimeSystems};
use serde::{Deserialize, Deserializer, de::Error};

/// 全局玩家设置；非零类型保证帧率上限始终能够转换为等待间隔。
#[derive(Resource, Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GameSettings {
    /// 渲染循环每秒最多更新的次数，默认 60，配置值不得低于 60；不影响 `Time<Fixed>`。
    #[serde(deserialize_with = "deserialize_max_fps")]
    pub max_fps: NonZeroU32,
    /// 自由视角的鼠标灵敏度与纵轴方向。
    pub camera: CameraSettings,
}

impl Default for GameSettings {
    fn default() -> Self {
        Self {
            max_fps: NonZeroU32::new(60).unwrap(),
            camera: CameraSettings::default(),
        }
    }
}

/// 自由视角配置；旧配置缺少本节或字段时使用默认值。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CameraSettings {
    /// 每像素对应的旋转弧度，必须是有限的正数。
    #[serde(deserialize_with = "deserialize_mouse_sensitivity")]
    pub mouse_sensitivity: f32,
    /// 是否反转鼠标纵向移动对应的俯仰方向。
    pub invert_y: bool,
}

impl Default for CameraSettings {
    fn default() -> Self {
        Self {
            mouse_sensitivity: 0.003,
            invert_y: false,
        }
    }
}

fn deserialize_max_fps<'de, D>(deserializer: D) -> Result<NonZeroU32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = NonZeroU32::deserialize(deserializer)?;
    // 在加载边界检查下限，避免低于支持范围的配置进入限帧系统。
    if value.get() < 60 {
        return Err(D::Error::custom("max_fps must be at least 60"));
    }
    Ok(value)
}

fn deserialize_mouse_sensitivity<'de, D>(deserializer: D) -> Result<f32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f32::deserialize(deserializer)?;
    // 在加载边界拒绝无效角速度，避免非有限值进入 Transform 的旋转计算。
    if !value.is_finite() || value <= 0.0 {
        return Err(D::Error::custom(
            "camera mouse_sensitivity must be finite and greater than zero",
        ));
    }
    Ok(value)
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
                    fallback_max_fps = Self::default().max_fps.get(),
                    fallback_camera_mouse_sensitivity = CameraSettings::default().mouse_sensitivity,
                    fallback_camera_invert_y = CameraSettings::default().invert_y,
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
            camera_mouse_sensitivity = settings.camera.mouse_sensitivity,
            camera_invert_y = settings.camera.invert_y,
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
        assert_eq!(GameSettings::default().max_fps.get(), 60);
        let omitted: GameSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(omitted.max_fps.get(), 60);
        for max_fps in [60, 120, 144] {
            let json = format!(r#"{{"max_fps": {max_fps}}}"#);
            let custom: GameSettings = serde_json::from_str(&json).unwrap();
            assert_eq!(custom.max_fps.get(), max_fps);
        }
        for invalid in [
            r#"{"max_fps": 0}"#,
            r#"{"max_fps": 1}"#,
            r#"{"max_fps": 30}"#,
            r#"{"max_fps": 59}"#,
            r#"{"max_fps": -60}"#,
            r#"{"max_fps": 60.5}"#,
            r#"{"max_fps": "120"}"#,
            r#"{"max_fp": 120}"#,
        ] {
            assert!(serde_json::from_str::<GameSettings>(invalid).is_err());
        }
    }

    #[test]
    fn camera_settings_default_legacy_and_custom_values() {
        let defaults = GameSettings::default();
        assert_eq!(defaults.camera.mouse_sensitivity, 0.003);
        assert!(!defaults.camera.invert_y);
        for legacy in ["{}", r#"{"max_fps": 144}"#, r#"{"camera": {}}"#] {
            let settings: GameSettings = serde_json::from_str(legacy).unwrap();
            assert_eq!(settings.camera.mouse_sensitivity, 0.003);
            assert!(!settings.camera.invert_y);
        }
        let custom: GameSettings =
            serde_json::from_str(r#"{"camera": {"mouse_sensitivity": 0.006, "invert_y": true}}"#)
                .unwrap();
        assert_eq!(custom.camera.mouse_sensitivity, 0.006);
        assert!(custom.camera.invert_y);
        let partial: GameSettings =
            serde_json::from_str(r#"{"camera": {"invert_y": true}}"#).unwrap();
        assert_eq!(partial.camera.mouse_sensitivity, 0.003);
        assert!(partial.camera.invert_y);
    }

    #[test]
    fn invalid_camera_settings_fall_back_without_overwriting_file() {
        let path =
            std::env::temp_dir().join(format!("demo-camera-settings-{}.json", Uuid::new_v4()));
        for invalid in [
            r#"{"max_fps": 240, "camera": {"mouse_sensitivity": 0}}"#,
            r#"{"max_fps": 240, "camera": {"mouse_sensitivity": -0.003}}"#,
            r#"{"max_fps": 240, "camera": {"mouse_sensitivity": 1e39}}"#,
            r#"{"max_fps": 240, "camera": {"mouse_sensitivity": "NaN"}}"#,
            r#"{"max_fps": 240, "camera": {"invert_y": 1}}"#,
            r#"{"max_fps": 240, "camera": {"sensitivity": 0.003}}"#,
        ] {
            assert!(serde_json::from_str::<GameSettings>(invalid).is_err());
            fs::write(&path, invalid).unwrap();
            let settings = GameSettings::load(&path);
            assert_eq!(settings.max_fps.get(), 60);
            assert_eq!(settings.camera.mouse_sensitivity, 0.003);
            assert!(!settings.camera.invert_y);
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        }
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn settings_file_and_failure_fallback_preserve_original_contents() {
        let path = std::env::temp_dir().join(format!("demo-settings-{}.json", Uuid::new_v4()));
        assert_eq!(GameSettings::load(&path).max_fps.get(), 60);
        assert!(!path.exists());
        fs::write(&path, r#"{"max_fps": 240}"#).unwrap();
        assert_eq!(GameSettings::load(&path).max_fps.get(), 240);
        for invalid in [
            r#"{"max_fps": 0}"#,
            r#"{"max_fps": 1}"#,
            r#"{"max_fps": 30}"#,
            r#"{"max_fps": 59}"#,
        ] {
            fs::write(&path, invalid).unwrap();
            assert_eq!(
                read_settings(&path).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            assert_eq!(GameSettings::load(&path).max_fps.get(), 60);
            assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
        }
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
        app.world_mut().resource_mut::<GameSettings>().max_fps = NonZeroU32::new(120).unwrap();
        app.update();
        let fixed = app.world().resource::<Time<Fixed>>();
        assert_eq!(fixed.timestep(), timestep);
        assert!((1.0 / fixed.timestep().as_secs_f64() - 60.0).abs() < 0.001);
        assert!(fixed.elapsed() >= timestep);
    }
}
