//! 玩家配置的 JSON 边界、验证与原子替换；不覆盖读取失败的原文件。

use std::{
    fs,
    io::{self, Write},
    num::NonZeroU32,
    path::{Path, PathBuf},
};

use bevy::prelude::*;
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
    /// 全局音量及 UI、玩法音效分类音量；百分比以现有混音基准为上限。
    pub audio: AudioSettings,
}

impl Default for GameSettings {
    fn default() -> Self {
        Self {
            max_fps: NonZeroU32::new(60).unwrap(),
            camera: CameraSettings::default(),
            audio: AudioSettings::default(),
        }
    }
}

/// 音量采用整数百分比，旧配置缺少本节或字段时保持原有响度。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AudioSettings {
    #[serde(deserialize_with = "deserialize_volume")]
    pub master_volume: u8,
    #[serde(deserialize_with = "deserialize_volume")]
    pub sfx_volume: u8,
    #[serde(deserialize_with = "deserialize_volume")]
    pub ui_volume: u8,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            master_volume: 100,
            sfx_volume: 100,
            ui_volume: 100,
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
pub struct SettingsFile {
    pub path: PathBuf,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            path: PathBuf::from("settings.json"),
        }
    }
}

fn deserialize_volume<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u8::deserialize(deserializer)?;
    if value > 100 {
        return Err(D::Error::custom("audio volume must be between 0 and 100"));
    }
    Ok(value)
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
    pub(super) fn validate(&self) -> io::Result<()> {
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
        if [
            self.audio.master_volume,
            self.audio.sfx_volume,
            self.audio.ui_volume,
        ]
        .into_iter()
        .any(|value| value > 100)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "audio volume must be between 0 and 100",
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
                    fallback_audio_master_volume = AudioSettings::default().master_volume,
                    fallback_audio_sfx_volume = AudioSettings::default().sfx_volume,
                    fallback_audio_ui_volume = AudioSettings::default().ui_volume,
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
            audio_master_volume = settings.audio.master_volume,
            audio_sfx_volume = settings.audio.sfx_volume,
            audio_ui_volume = settings.audio.ui_volume,
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
            audio_master_volume = self.audio.master_volume,
            audio_sfx_volume = self.audio.sfx_volume,
            audio_ui_volume = self.audio.ui_volume,
            "Game settings saved");
        Ok(())
    }
}

pub(super) fn read_settings(path: &Path) -> io::Result<GameSettings> {
    let contents = fs::read_to_string(path)?;
    serde_json::from_str(&contents)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
