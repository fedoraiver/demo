//! 加载、编辑与保存玩家设置，并限制渲染循环；不改变固定步模拟频率。

use std::{
    fs,
    io::{self, Write},
    num::NonZeroU32,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use bevy::{prelude::*, time::TimeSystems};
use serde::{Deserialize, Deserializer, Serialize, de::Error};

/// 全局玩家设置；非零类型保证帧率上限始终能够转换为等待间隔。
#[derive(Resource, Clone, Debug, Deserialize, Serialize)]
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
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
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

/// 设置文件的保存位置；测试可覆盖该资源而不触及玩家的真实配置。
#[derive(Resource, Debug)]
pub struct SettingsFile(pub PathBuf);

impl Default for SettingsFile {
    fn default() -> Self {
        Self(PathBuf::from("settings.json"))
    }
}

/// 菜单独立编辑的草稿；只有应用成功后才替换正在使用的设置资源。
#[derive(Resource, Clone, Debug)]
pub struct SettingsDraft {
    pub max_fps: u32,
    pub mouse_sensitivity: f32,
    pub invert_y: bool,
}

impl Default for SettingsDraft {
    fn default() -> Self {
        Self::from_settings(&GameSettings::default())
    }
}

impl SettingsDraft {
    /// 原样复制设置，打开菜单时保留文件中的有效自定义值。
    pub fn from_settings(settings: &GameSettings) -> Self {
        Self {
            max_fps: settings.max_fps.get(),
            mouse_sensitivity: settings.camera.mouse_sensitivity,
            invert_y: settings.camera.invert_y,
        }
    }

    /// 在应用边界校验草稿；文件允许的有效范围不受菜单步进范围限制。
    pub fn to_settings(&self) -> io::Result<GameSettings> {
        let max_fps = NonZeroU32::new(self.max_fps).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "max_fps must be at least 60")
        })?;
        let settings = GameSettings {
            max_fps,
            camera: CameraSettings {
                mouse_sensitivity: self.mouse_sensitivity,
                invert_y: self.invert_y,
            },
        };
        settings.validate()?;
        Ok(settings)
    }

    /// 左右调整当前字段；自定义值只在用户实际调整该字段后进入菜单范围。
    pub fn adjust(&mut self, key: crate::ui::SettingKey, direction: i8) {
        match key {
            crate::ui::SettingKey::FrameRate => {
                const OPTIONS: [u32; 6] = [60, 90, 120, 144, 165, 240];
                if direction > 0 {
                    self.max_fps = OPTIONS
                        .into_iter()
                        .find(|&fps| fps > self.max_fps)
                        .unwrap_or(240);
                } else if direction < 0 {
                    self.max_fps = OPTIONS
                        .into_iter()
                        .rev()
                        .find(|&fps| fps < self.max_fps)
                        .unwrap_or(60);
                }
            }
            crate::ui::SettingKey::MouseSensitivity => {
                if direction != 0 {
                    self.mouse_sensitivity = (self.mouse_sensitivity
                        + 0.0005 * f32::from(direction.signum()))
                    .clamp(0.0005, 0.02);
                }
            }
            crate::ui::SettingKey::InvertY => self.invert_y = !self.invert_y,
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
    fn validate(&self) -> io::Result<()> {
        if self.max_fps.get() < 60 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "max_fps must be at least 60",
            ));
        }
        if !self.camera.mouse_sensitivity.is_finite() || self.camera.mouse_sensitivity <= 0.0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "camera mouse_sensitivity must be finite and greater than zero",
            ));
        }
        Ok(())
    }

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

    /// 校验并保存完整 JSON；替换成功前不修改原文件，失败时返回原始 I/O 错误。
    pub fn save(&self, path: &Path) -> io::Result<()> {
        self.validate()?;
        let mut contents = serde_json::to_vec_pretty(self)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        contents.push(b'\n');

        // 临时产物统一写入工作目录根 tmp；跨文件系统的 rename 失败时保留原配置。
        let staging_directory = Path::new("tmp").join("settings-save");
        fs::create_dir_all(&staging_directory)?;
        let staging_path = staging_directory.join(format!("{}.json", uuid::Uuid::new_v4()));
        let saved = (|| -> io::Result<()> {
            let mut file = fs::File::create_new(&staging_path)?;
            file.write_all(&contents)?;
            file.sync_all()?;
            // Windows 替换前关闭临时文件句柄；rename 不先删除旧文件，错误时原文件仍完整。
            drop(file);
            fs::rename(&staging_path, path)
        })();
        if let Err(error) = saved {
            if let Err(cleanup_error) = fs::remove_file(&staging_path)
                && cleanup_error.kind() != io::ErrorKind::NotFound
            {
                warn!(target: "demo::settings", operation = "remove_settings_staging_file",
                    path = %staging_path.display(), error = %cleanup_error,
                    reason = "settings_staging_cleanup_failed", "Failed to remove settings staging file");
            }
            warn!(target: "demo::settings", operation = "save_settings", path = %path.display(),
                %error, reason = "settings_save_failed", "Failed to save game settings");
            return Err(error);
        }
        info!(target: "demo::settings", path = %path.display(), max_fps = self.max_fps.get(),
            camera_mouse_sensitivity = self.camera.mouse_sensitivity,
            camera_invert_y = self.camera.invert_y, reason = "settings_saved",
            "Game settings saved");
        Ok(())
    }
}

/// 注册帧率限制系统；设置资源也可由后续设置界面在运行期间修改。
pub struct SettingsPlugin;

impl Plugin for SettingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GameSettings>()
            .init_resource::<SettingsFile>()
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

    fn settings_test_path() -> PathBuf {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("tmp/settings-tests");
        fs::create_dir_all(&directory).unwrap();
        directory.join(format!("{}.json", Uuid::new_v4()))
    }

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
        let path = settings_test_path();
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
        let path = settings_test_path();
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
    fn save_creates_and_replaces_complete_settings_json() {
        let path = settings_test_path();
        GameSettings::default().save(&path).unwrap();
        let draft = SettingsDraft {
            max_fps: 165,
            mouse_sensitivity: 0.0065,
            invert_y: true,
        };
        draft.to_settings().unwrap().save(&path).unwrap();

        let loaded = GameSettings::load(&path);
        assert_eq!(loaded.max_fps.get(), 165);
        assert_eq!(loaded.camera.mouse_sensitivity, 0.0065);
        assert!(loaded.camera.invert_y);
        assert!(fs::read_to_string(&path).unwrap().ends_with('\n'));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_settings_cannot_replace_existing_file() {
        let path = settings_test_path();
        let original = r#"{"max_fps": 90}"#;
        fs::write(&path, original).unwrap();
        let defaults = SettingsDraft::default();
        for invalid_fps in [0, 1, 59] {
            let invalid = SettingsDraft {
                max_fps: invalid_fps,
                ..defaults.clone()
            };
            assert_eq!(
                invalid.to_settings().unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
        let mut settings = GameSettings::default();
        settings.max_fps = NonZeroU32::new(59).unwrap();
        assert!(settings.save(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        settings.max_fps = NonZeroU32::new(60).unwrap();
        for invalid_sensitivity in [0.0, -0.003, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let invalid = SettingsDraft {
                mouse_sensitivity: invalid_sensitivity,
                ..defaults.clone()
            };
            assert_eq!(
                invalid.to_settings().unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
            settings.camera.mouse_sensitivity = invalid_sensitivity;
            assert!(settings.save(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
        fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn failed_file_replacement_preserves_original_settings() {
        use std::os::windows::fs::OpenOptionsExt;

        let path = settings_test_path();
        let original = r#"{"max_fps": 144}"#;
        fs::write(&path, original).unwrap();
        // Windows 的独占句柄阻止替换，检验失败时不会先删除或截断原配置。
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let draft = SettingsDraft {
            max_fps: 240,
            ..default()
        };
        assert!(draft.to_settings().unwrap().save(&path).is_err());
        assert_eq!(draft.max_fps, 240);
        drop(locked);
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn draft_preserves_custom_values_until_their_field_is_adjusted() {
        use crate::ui::SettingKey;

        let custom: GameSettings =
            serde_json::from_str(r#"{"max_fps": 75, "camera": {"mouse_sensitivity": 0.03}}"#)
                .unwrap();
        let mut draft = SettingsDraft::from_settings(&custom);
        let converted = draft.to_settings().unwrap();
        assert_eq!(converted.max_fps.get(), 75);
        assert_eq!(converted.camera.mouse_sensitivity, 0.03);
        draft.adjust(SettingKey::InvertY, 0);
        assert!(draft.invert_y);
        assert_eq!(draft.max_fps, 75);
        assert_eq!(draft.mouse_sensitivity, 0.03);
        draft.adjust(SettingKey::FrameRate, 0);
        draft.adjust(SettingKey::MouseSensitivity, 0);
        assert_eq!(draft.max_fps, 75);
        assert_eq!(draft.mouse_sensitivity, 0.03);

        draft.adjust(SettingKey::FrameRate, 1);
        assert_eq!(draft.max_fps, 90);
        draft.adjust(SettingKey::FrameRate, -1);
        assert_eq!(draft.max_fps, 60);
        draft.adjust(SettingKey::MouseSensitivity, -1);
        assert_eq!(draft.mouse_sensitivity, 0.02);
        draft.adjust(SettingKey::InvertY, -1);
        assert!(!draft.invert_y);
    }

    #[test]
    fn draft_adjustments_remain_within_menu_limits() {
        use crate::ui::SettingKey;

        let mut draft = SettingsDraft::default();
        for fps in [90, 120, 144, 165, 240, 240] {
            draft.adjust(SettingKey::FrameRate, 1);
            assert_eq!(draft.max_fps, fps);
        }
        for fps in [165, 144, 120, 90, 60, 60] {
            draft.adjust(SettingKey::FrameRate, -1);
            assert_eq!(draft.max_fps, fps);
        }
        draft.adjust(SettingKey::MouseSensitivity, 1);
        assert!((draft.mouse_sensitivity - 0.0035).abs() < 0.000001);
        for _ in 0..100 {
            draft.adjust(SettingKey::MouseSensitivity, 1);
        }
        assert_eq!(draft.mouse_sensitivity, 0.02);
        for _ in 0..100 {
            draft.adjust(SettingKey::MouseSensitivity, -1);
        }
        assert_eq!(draft.mouse_sensitivity, 0.0005);
        assert!(draft.to_settings().is_ok());
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
