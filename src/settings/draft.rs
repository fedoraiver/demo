//! 草稿保留合法自定义值，只有实际编辑字段时采用菜单步进范围。

use bevy::prelude::*;
use std::{io, num::NonZeroU32};

use super::{AudioSettings, CameraSettings, GameSettings, MAX_AUDIO_VOLUME};

// 菜单步进与范围只作用于实际编辑的字段，不参与 JSON 持久化校验。
const MENU_MOUSE_SENSITIVITY_STEP: f32 = 0.0005;
const MENU_MOUSE_SENSITIVITY_MIN: f32 = 0.0005;
const MENU_MOUSE_SENSITIVITY_MAX: f32 = 0.02;
const VOLUME_STEP: i16 = 5;

/// 设置草稿中的可修改字段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingKey {
    FrameRate,
    MouseSensitivity,
    InvertY,
    MasterVolume,
    SfxVolume,
    UiVolume,
}

/// 菜单独立编辑的草稿；音量可以临时预览，只有应用成功才替换已保存设置。
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct SettingsDraft {
    pub max_fps: u32,
    pub mouse_sensitivity: f32,
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
            mouse_sensitivity: settings.camera.mouse_sensitivity,
            invert_y: settings.camera.invert_y,
            audio: settings.audio,
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
            audio: self.audio,
        };
        settings.validate()?;
        Ok(settings)
    }

    /// 返回可调整音量的百分比；其他设置字段没有音量值。
    pub fn volume(&self, key: SettingKey) -> Option<u8> {
        match key {
            SettingKey::MasterVolume => Some(self.audio.master_volume),
            SettingKey::SfxVolume => Some(self.audio.sfx_volume),
            SettingKey::UiVolume => Some(self.audio.ui_volume),
            _ => None,
        }
    }

    /// 鼠标拖动与方向步进共用写入边界，夹到 100 并返回是否发生实际变化。
    pub fn set_volume(&mut self, key: SettingKey, value: u8) -> bool {
        let volume = match key {
            SettingKey::MasterVolume => &mut self.audio.master_volume,
            SettingKey::SfxVolume => &mut self.audio.sfx_volume,
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
            SettingKey::MouseSensitivity => {
                if direction != 0 {
                    self.mouse_sensitivity = (self.mouse_sensitivity
                        + MENU_MOUSE_SENSITIVITY_STEP * f32::from(direction.signum()))
                    .clamp(MENU_MOUSE_SENSITIVITY_MIN, MENU_MOUSE_SENSITIVITY_MAX);
                }
            }
            SettingKey::InvertY => self.invert_y = !self.invert_y,
            key @ (SettingKey::MasterVolume | SettingKey::SfxVolume | SettingKey::UiVolume) => {
                let value = i16::from(self.volume(key).unwrap())
                    + VOLUME_STEP * i16::from(direction.signum());
                self.set_volume(key, value.clamp(0, i16::from(MAX_AUDIO_VOLUME)) as u8);
            }
        }
    }
}
