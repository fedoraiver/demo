//! 原生设置组、完整输入校验与保存事务；不覆盖读取失败的原文件。

use std::{
    fs, io,
    num::NonZeroU32,
    path::{Path, PathBuf},
};

use bevy::{
    prelude::*,
    settings::{ReflectSettingsGroup, SaveSettingsSync, SettingsGroup, SettingsPlugin},
};
use serde::{Deserialize, Deserializer, Serialize, de::Error};

/// 缺省配置采用的渲染帧率上限。
const DEFAULT_FPS_LIMIT: u32 = 60;

/// 配置支持的最低渲染帧率上限；不限制固定模拟频率。
const MIN_FPS_LIMIT: u32 = 60;

/// 默认每像素旋转弧度，也是菜单灵敏度倍率 1.00 的基准。
pub const DEFAULT_MOUSE_SENSITIVITY: f32 = 0.003;

/// 灵敏度倍率上限，菜单、草稿与持久化边界共用。
pub const MAX_MOUSE_SENSITIVITY_MULTIPLIER: f32 = 10.0;

/// 倍率交互每单位的离散步数，滑条、方向步进和草稿规范化共用。
pub const MOUSE_SENSITIVITY_STEPS_PER_UNIT: u16 = 100;

/// 倍率交互的最小步长。
pub const MOUSE_SENSITIVITY_STEP: f32 = 1.0 / MOUSE_SENSITIVITY_STEPS_PER_UNIT as f32;

/// 相机灵敏度上限，单位为弧度／像素；0 表示不随鼠标转向。
pub const MAX_MOUSE_SENSITIVITY: f32 = DEFAULT_MOUSE_SENSITIVITY * MAX_MOUSE_SENSITIVITY_MULTIPLIER;

/// 音量整数百分比上限，默认值、校验、菜单和混音共用此边界。
pub const MAX_AUDIO_VOLUME: u8 = 100;

/// 全局玩家设置；非零类型保证帧率上限始终能够转换为等待间隔。
#[derive(Resource, Clone, Debug, PartialEq, Deserialize, Serialize, Reflect, SettingsGroup)]
#[reflect(Resource, SettingsGroup, Default)]
#[settings_group(group = "game")]
#[serde(default, deny_unknown_fields)]
pub struct GameSettings {
    /// 渲染循环每秒最多更新的次数，默认 60，配置值不得低于 60；不影响 `Time<Fixed>`。
    #[serde(deserialize_with = "deserialize_max_fps")]
    pub max_fps: NonZeroU32,
    /// 自由视角的鼠标灵敏度与纵轴方向。
    pub camera: CameraSettings,
    /// 音频总音量及已接入的分类音量，均为整数百分比。
    pub audio: AudioSettings,
}

impl Default for GameSettings {
    fn default() -> Self {
        Self {
            max_fps: default_max_fps(),
            camera: CameraSettings::default(),
            audio: AudioSettings::default(),
        }
    }
}

/// 音频混音设置，缺省字段采用完整音量。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Reflect)]
#[reflect(Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AudioSettings {
    #[serde(deserialize_with = "deserialize_volume")]
    pub master_volume: u8,
    #[serde(deserialize_with = "deserialize_volume")]
    pub ui_volume: u8,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            master_volume: MAX_AUDIO_VOLUME,
            ui_volume: MAX_AUDIO_VOLUME,
        }
    }
}

/// 自由视角配置；省略节或字段时使用默认值。
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize, Reflect)]
#[reflect(Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CameraSettings {
    /// 每像素对应的旋转弧度，必须在有限的 0..=MAX_MOUSE_SENSITIVITY 内。
    #[serde(deserialize_with = "deserialize_mouse_sensitivity")]
    pub mouse_sensitivity: f32,
    /// 是否反转鼠标纵向移动对应的俯仰方向。
    pub invert_y: bool,
}

impl Default for CameraSettings {
    fn default() -> Self {
        Self {
            mouse_sensitivity: DEFAULT_MOUSE_SENSITIVITY,
            invert_y: false,
        }
    }
}

/// 原生设置存储使用的应用标识；各 worktree 共享同一玩家配置。
pub const SETTINGS_APP_NAME: &str = "io.github.fedoraiver.demo";

/// 设置文件的保存位置；测试可覆盖该资源而不触及玩家的真实配置。
#[derive(Resource, Debug)]
pub struct SettingsFile {
    pub path: PathBuf,
}

impl Default for SettingsFile {
    fn default() -> Self {
        Self {
            path: bevy::platform::dirs::preferences_dir()
                .unwrap_or_else(|| PathBuf::from("tmp/unavailable-preferences"))
                .join(SETTINGS_APP_NAME)
                .join("settings.toml"),
        }
    }
}

fn default_max_fps() -> NonZeroU32 {
    NonZeroU32::new(DEFAULT_FPS_LIMIT).unwrap()
}

fn deserialize_volume<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u8::deserialize(deserializer)?;
    if value > MAX_AUDIO_VOLUME {
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
    if value.get() < MIN_FPS_LIMIT {
        return Err(D::Error::custom("max_fps must be at least 60"));
    }
    Ok(value)
}

fn deserialize_mouse_sensitivity<'de, D>(deserializer: D) -> Result<f32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f32::deserialize(deserializer)?;
    // 加载边界与保存校验采用同一实际角速度范围，0 是有效的停转设置。
    if !value.is_finite() || !(0.0..=MAX_MOUSE_SENSITIVITY).contains(&value) {
        return Err(D::Error::custom(format!(
            "camera mouse_sensitivity must be finite and between 0 and {MAX_MOUSE_SENSITIVITY}",
        )));
    }
    Ok(value)
}

impl GameSettings {
    pub(super) fn validate(&self) -> io::Result<()> {
        if self.max_fps.get() < MIN_FPS_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "max_fps must be at least 60",
            ));
        }
        if !self.camera.mouse_sensitivity.is_finite()
            || !(0.0..=MAX_MOUSE_SENSITIVITY).contains(&self.camera.mouse_sensitivity)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "camera mouse_sensitivity must be finite and between 0 and {MAX_MOUSE_SENSITIVITY}"
                ),
            ));
        }
        if self.audio.master_volume > MAX_AUDIO_VOLUME || self.audio.ui_volume > MAX_AUDIO_VOLUME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "audio volume must be between 0 and 100",
            ));
        }
        Ok(())
    }

    /// 使用原生设置插件保存并回读校验，成功替换目标后才允许调用方应用草稿。
    pub fn save(&self, path: &Path) -> io::Result<()> {
        self.validate()?;
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent)?;
        // 原生同步保存不返回结果，因此隔离资源与文件，回读成功后才提交。
        // 事务文件必须与用户配置同卷；仓库内测试目标仍全部位于根 tmp。
        let staging_directory = parent.join(format!(".settings-save-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging_directory)?;
        let result = (|| -> io::Result<()> {
            let mut storage = native_settings_app(&staging_directory)?;
            storage.insert_resource(self.clone());
            SaveSettingsSync::Always.apply(storage.world_mut());
            let staging_path = staging_directory.join("settings.toml");
            if read_settings(&staging_path)? != *self {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "saved settings did not match the draft",
                ));
            }
            // 原生插件已关闭句柄，刷新后在同一文件系统内原子替换；不先删除旧文件。
            fs::OpenOptions::new()
                .write(true)
                .open(&staging_path)?
                .sync_all()?;
            fs::rename(&staging_path, path)
        })();
        // 只删除本次独占目录中两个固定的原生产物，不递归清理其他配置。
        for name in ["settings.toml", "settings.toml.new"] {
            let file = staging_directory.join(name);
            if let Err(error) = fs::remove_file(&file)
                && error.kind() != io::ErrorKind::NotFound
            {
                warn!(target: "demo::settings", path = %file.display(), %error,
                    reason = "settings_staging_cleanup_failed", "Failed to remove settings staging file");
            }
        }
        if let Err(error) = fs::remove_dir(&staging_directory) {
            warn!(target: "demo::settings", path = %staging_directory.display(), %error,
                reason = "settings_staging_cleanup_failed", "Failed to remove settings staging directory");
        }
        match result {
            Ok(()) => {
                info!(target: "demo::settings", path = %path.display(), max_fps = self.max_fps.get(),
                    camera_mouse_sensitivity = self.camera.mouse_sensitivity,
                    camera_invert_y = self.camera.invert_y,
                    audio_master_volume = self.audio.master_volume, audio_ui_volume = self.audio.ui_volume,
                    reason = "settings_saved", "Game settings saved");
                Ok(())
            }
            Err(error) => {
                warn!(target: "demo::settings", operation = "save_settings", path = %path.display(),
                    %error, reason = "settings_save_failed", "Failed to save game settings");
                Err(error)
            }
        }
    }
}

/// 原生插件只公开应用名；0.20 的存储通过 preferences_dir.join(app_name) 解析。
/// 绝对路径让独立保存事务与无窗口测试使用指定目录，不修改进程环境或主世界。
pub(super) fn native_settings_app(directory: &Path) -> io::Result<App> {
    let directory = std::path::absolute(directory)?;
    let directory = directory.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "settings directory is not UTF-8",
        )
    })?;
    let mut app = App::new();
    app.register_type::<GameSettings>()
        .add_plugins(SettingsPlugin::new(directory));
    Ok(app)
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct StoredSettings {
    game: GameSettings,
}

pub(crate) fn read_settings(path: &Path) -> io::Result<GameSettings> {
    parse_settings(&fs::read_to_string(path)?)
}

pub(super) fn parse_settings(contents: &str) -> io::Result<GameSettings> {
    toml::from_str::<StoredSettings>(contents)
        .map(|stored| stored.game)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// 原生加载后补充完整输入校验；缺失或无效文件采用默认值。
pub fn validate_loaded_settings(app: &mut App) {
    validate_loaded_settings_from(app, SettingsFile::default());
}

pub(super) fn validate_loaded_settings_from(app: &mut App, file: SettingsFile) {
    let path = &file.path;
    let settings = match read_settings(path) {
        Ok(expected) => {
            // 原生加载按字段容错；项目要求整个文件有效且不能丢失自定义值。
            if app.world().get_resource::<GameSettings>() == Some(&expected) {
                expected
            } else {
                warn!(target: "demo::settings", path = %path.display(), reason = "native_settings_mismatch",
                    "Native settings did not match the validated file; using defaults");
                GameSettings::default()
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            info!(target: "demo::settings", path = %path.display(), reason = "settings_file_missing",
                "Using default game settings");
            GameSettings::default()
        }
        Err(error) => {
            warn!(target: "demo::settings", operation = "load_settings", path = %path.display(), %error,
                reason = "settings_load_failed", fallback_max_fps = DEFAULT_FPS_LIMIT,
                "Failed to load game settings; using defaults");
            GameSettings::default()
        }
    };
    info!(target: "demo::settings", path = %path.display(), max_fps = settings.max_fps.get(),
        camera_mouse_sensitivity = settings.camera.mouse_sensitivity, camera_invert_y = settings.camera.invert_y,
        audio_master_volume = settings.audio.master_volume, audio_ui_volume = settings.audio.ui_volume,
        "Game settings initialized");
    app.insert_resource(settings).insert_resource(file);
}
