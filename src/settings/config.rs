//! 原生设置组和数值范围转换。

use std::{convert::Infallible, num::NonZeroU32};

use bevy::{
    prelude::*,
    settings::{ReflectSettingsGroup, SettingsGroup},
};
use serde::{Deserialize, Serialize};

/// 默认渲染帧率上限。
const DEFAULT_FPS_LIMIT: u32 = 60;

/// 配置支持的最低渲染帧率上限。
const MIN_FPS_LIMIT: u32 = 60;

/// 默认每像素旋转弧度，也是菜单灵敏度百分比的显示基准。
pub const DEFAULT_MOUSE_SENSITIVITY: f32 = 0.003;

/// 音量整数百分比上限，默认值、校验、菜单和混音共用此边界。
pub const MAX_AUDIO_VOLUME: u8 = 100;

/// 原生设置存储使用的应用标识，各 worktree 共享同一玩家配置。
pub const SETTINGS_APP_NAME: &str = "io.github.fedoraiver.demo";

/// 渲染帧率上限。Bevy 逐字段加载设置，通过此类型调用 Serde 并保留 TOML 整数格式。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Reflect)]
#[reflect(opaque, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "u32")]
pub struct FpsLimit {
    value: NonZeroU32,
}

impl FpsLimit {
    /// 草稿必须提供受支持的帧率上限。
    pub fn new(value: u32) -> Option<Self> {
        NonZeroU32::new(value)
            .filter(|value| value.get() >= MIN_FPS_LIMIT)
            .map(|value| Self { value })
    }

    /// 返回每秒最多更新的次数。
    pub fn get(self) -> u32 {
        self.value.get()
    }
}

impl Default for FpsLimit {
    fn default() -> Self {
        Self::new(DEFAULT_FPS_LIMIT).unwrap()
    }
}

impl TryFrom<i64> for FpsLimit {
    type Error = Infallible;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        Ok(u32::try_from(value)
            .ok()
            .and_then(Self::new)
            .unwrap_or_else(|| {
                warn!(target: "demo::settings", setting = "max_fps", value,
                    default = DEFAULT_FPS_LIMIT, "Invalid setting value; using default");
                Self::default()
            }))
    }
}

impl From<FpsLimit> for u32 {
    fn from(limit: FpsLimit) -> Self {
        limit.get()
    }
}

/// 全局玩家设置，由 Bevy 原生插件加载与保存。
#[derive(Resource, Clone, Debug, Default, PartialEq, Reflect, SettingsGroup)]
#[reflect(Resource, SettingsGroup, Default)]
#[settings_group(group = "game")]
pub struct GameSettings {
    /// 渲染循环每秒最多更新的次数，不影响 `Time<Fixed>`。
    pub max_fps: FpsLimit,
    /// 自由视角的鼠标灵敏度与纵轴方向。
    pub camera: CameraSettings,
    /// 音频总音量及已接入的分类音量，均为整数百分比。
    pub audio: AudioSettings,
}

/// 音频混音设置，默认采用完整音量。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Reflect)]
#[reflect(Serialize, Deserialize)]
#[serde(try_from = "AudioSettingsInput")]
pub struct AudioSettings {
    pub master_volume: u8,
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

#[derive(Deserialize)]
struct AudioSettingsInput {
    master_volume: Option<i64>,
    ui_volume: Option<i64>,
}

impl TryFrom<AudioSettingsInput> for AudioSettings {
    type Error = Infallible;

    fn try_from(input: AudioSettingsInput) -> Result<Self, Self::Error> {
        Ok(Self {
            master_volume: volume_or_default("audio.master_volume", input.master_volume),
            ui_volume: volume_or_default("audio.ui_volume", input.ui_volume),
        })
    }
}

fn volume_or_default(setting: &str, value: Option<i64>) -> u8 {
    let Some(value) = value else {
        return MAX_AUDIO_VOLUME;
    };
    u8::try_from(value)
        .ok()
        .filter(|&value| value <= MAX_AUDIO_VOLUME)
        .unwrap_or_else(|| {
            warn!(target: "demo::settings", setting, value,
                default = MAX_AUDIO_VOLUME, "Invalid setting value; using default");
            MAX_AUDIO_VOLUME
        })
}

/// 自由视角配置，省略节或字段时使用默认值。
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize, Reflect)]
#[reflect(Serialize, Deserialize)]
#[serde(try_from = "CameraSettingsInput")]
pub struct CameraSettings {
    /// 每像素对应的旋转弧度，必须是有限的正数。
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

#[derive(Deserialize)]
struct CameraSettingsInput {
    mouse_sensitivity: Option<f64>,
    #[serde(default)]
    invert_y: bool,
}

impl TryFrom<CameraSettingsInput> for CameraSettings {
    type Error = Infallible;

    fn try_from(input: CameraSettingsInput) -> Result<Self, Self::Error> {
        let value = input
            .mouse_sensitivity
            .unwrap_or(f64::from(DEFAULT_MOUSE_SENSITIVITY));
        let sensitivity = value as f32;
        let mouse_sensitivity = if is_valid_mouse_sensitivity(sensitivity) {
            sensitivity
        } else {
            warn!(target: "demo::settings", setting = "camera.mouse_sensitivity", value,
                default = DEFAULT_MOUSE_SENSITIVITY, "Invalid setting value; using default");
            DEFAULT_MOUSE_SENSITIVITY
        };
        Ok(Self {
            mouse_sensitivity,
            invert_y: input.invert_y,
        })
    }
}

pub(super) fn is_valid_mouse_sensitivity(value: f32) -> bool {
    value.is_finite() && value > 0.0
}
