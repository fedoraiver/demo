//! 草稿保留自定义值与输入文本，在应用边界统一校验。

use bevy::prelude::*;
use std::{io, num::NonZeroU32};

use super::{
    AudioSettings, CameraSettings, DEFAULT_MOUSE_SENSITIVITY, GameSettings, MAX_AUDIO_VOLUME,
};

// 菜单步进只作用于离散调整字段，不参与持久化校验。
const VOLUME_STEP: i16 = 5;

/// 设置草稿中的可修改字段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingKey {
    FrameRate,
    InvertY,
    MasterVolume,
    UiVolume,
}

/// 菜单独立编辑的草稿，音量供临时预览，应用成功后替换已保存设置。
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct SettingsDraft {
    pub max_fps: u32,
    /// 原始百分比文本保留空值与未完成编辑，不能在应用时悄悄使用上一个合法数值。
    pub mouse_sensitivity_percent: String,
    pub invert_y: bool,
    pub audio: AudioSettings,
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
            mouse_sensitivity_percent: sensitivity_percentage(settings.camera.mouse_sensitivity),
            invert_y: settings.camera.invert_y,
            audio: settings.audio,
        }
    }

    /// 在应用边界校验草稿；文件允许的有效范围不受菜单步进范围限制。
    pub fn to_settings(&self) -> io::Result<GameSettings> {
        let percent = self
            .mouse_sensitivity_percent
            .trim()
            .parse::<f64>()
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Mouse sensitivity must be a finite positive percentage.",
                )
            })?;
        let sensitivity = (percent / 100.0 * f64::from(DEFAULT_MOUSE_SENSITIVITY)) as f32;
        let max_fps = NonZeroU32::new(self.max_fps).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "max_fps must be at least 60")
        })?;
        let settings = GameSettings {
            max_fps,
            camera: CameraSettings {
                mouse_sensitivity: sensitivity,
                invert_y: self.invert_y,
            },
            audio: self.audio,
        };
        settings.validate()?;
        Ok(settings)
    }

    /// 返回可调整音量的百分比，其他设置字段没有音量值。
    pub fn volume(&self, key: SettingKey) -> Option<u8> {
        match key {
            SettingKey::MasterVolume => Some(self.audio.master_volume),
            SettingKey::UiVolume => Some(self.audio.ui_volume),
            _ => None,
        }
    }

    /// 鼠标拖动与方向步进共用写入边界，返回是否发生实际变化。
    pub fn set_volume(&mut self, key: SettingKey, value: u8) -> bool {
        let volume = match key {
            SettingKey::MasterVolume => &mut self.audio.master_volume,
            SettingKey::UiVolume => &mut self.audio.ui_volume,
            _ => return false,
        };
        let value = value.min(MAX_AUDIO_VOLUME);
        if *volume == value {
            return false;
        }
        *volume = value;
        true
    }

    /// 左右调整当前字段；自定义值只在用户实际调整该字段后进入菜单范围。
    pub fn adjust(&mut self, key: SettingKey, direction: i8) {
        match key {
            SettingKey::FrameRate => {
                const OPTIONS: [u32; 6] = [60, 90, 120, 144, 165, 240];
                if direction > 0 {
                    self.max_fps = OPTIONS
                        .into_iter()
                        .find(|&fps| fps > self.max_fps)
                        .unwrap_or(OPTIONS[OPTIONS.len() - 1]);
                } else if direction < 0 {
                    self.max_fps = OPTIONS
                        .into_iter()
                        .rev()
                        .find(|&fps| fps < self.max_fps)
                        .unwrap_or(OPTIONS[0]);
                }
            }
            SettingKey::InvertY => self.invert_y = !self.invert_y,
            key @ (SettingKey::MasterVolume | SettingKey::UiVolume) => {
                let value = i16::from(self.volume(key).unwrap())
                    + VOLUME_STEP * i16::from(direction.signum());
                self.set_volume(key, value.clamp(0, i16::from(MAX_AUDIO_VOLUME)) as u8);
            }
        }
    }
}

/// 优先显示能往返回同一 f32 的短小数，避免重开页面后暴露浮点换算尾数。
fn sensitivity_percentage(sensitivity: f32) -> String {
    let percent = f64::from(sensitivity) / f64::from(DEFAULT_MOUSE_SENSITIVITY) * 100.0;
    for precision in 0..=8 {
        let text = format!("{percent:.precision$}");
        let restored =
            (text.parse::<f64>().unwrap() / 100.0 * f64::from(DEFAULT_MOUSE_SENSITIVITY)) as f32;
        if restored == sensitivity {
            return text;
        }
    }
    percent.to_string()
}
