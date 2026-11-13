//! 草稿保留自定义值与输入文本，在应用边界统一校验。

use bevy::prelude::*;
use std::{io, num::NonZeroU32};

use super::{
    AudioSettings, CameraSettings, DEFAULT_MOUSE_SENSITIVITY_UNITS, GameSettings, MAX_AUDIO_VOLUME,
    MAX_MOUSE_SENSITIVITY_MULTIPLIER, MIN_MOUSE_SENSITIVITY_UNITS, MOUSE_SENSITIVITY_PER_UNIT,
    MOUSE_SENSITIVITY_STEP, MOUSE_SENSITIVITY_STEPS_PER_UNIT,
};

// 菜单步进只作用于离散调整字段，不参与持久化校验。
const VOLUME_STEP: i16 = 5;

/// 设置草稿中的可修改字段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingKey {
    FrameRate,
    MouseSensitivity,
    InvertY,
    MasterVolume,
    UiVolume,
}

/// 菜单独立编辑的草稿，音量供临时预览，应用成功后替换已保存设置。
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct SettingsDraft {
    pub max_fps: u32,
    /// 原始倍率文本保留空值与未完成编辑，不能在应用时悄悄使用上一个合法数值。
    pub mouse_sensitivity_text: String,
    /// 未主动编辑时保留原始角速度，避免两位显示精度反向改写已有配置。
    pub(super) original_mouse_sensitivity: Option<f32>,
    pub invert_y: bool,
    pub audio: AudioSettings,
}

impl Default for SettingsDraft {
    fn default() -> Self {
        Self::from_settings(&GameSettings::default())
    }
}

impl SettingsDraft {
    /// 两位倍率仅用于显示；未主动编辑灵敏度时保留原始角速度。
    pub fn from_settings(settings: &GameSettings) -> Self {
        Self {
            max_fps: settings.max_fps.get(),
            mouse_sensitivity_text: sensitivity_text(settings.camera.mouse_sensitivity),
            original_mouse_sensitivity: Some(settings.camera.mouse_sensitivity),
            invert_y: settings.camera.invert_y,
            audio: settings.audio,
        }
    }

    /// 统一校验草稿；未编辑的灵敏度保留原值，主动编辑后按 0.01 倍率转换为角速度。
    pub fn to_settings(&self) -> io::Result<GameSettings> {
        let multiplier = self.sensitivity_multiplier().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Mouse sensitivity multiplier must be finite and between 0.01 and 10.",
            )
        })?;
        let sensitivity = self
            .unedited_sensitivity()
            .unwrap_or(multiplier * MOUSE_SENSITIVITY_PER_UNIT);
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

    /// 校验原始输入后返回 0.01 精度的倍率；未完成、非有限或越界文本不产生数值。
    pub fn sensitivity_multiplier(&self) -> Option<f32> {
        let value = self.mouse_sensitivity_text.trim().parse::<f64>().ok()?;
        if !value.is_finite()
            || !(MIN_MOUSE_SENSITIVITY_UNITS..=f64::from(MAX_MOUSE_SENSITIVITY_MULTIPLIER))
                .contains(&value)
        {
            return None;
        }
        Some(quantized_sensitivity_multiplier(value))
    }

    /// 原生输入值实际变化时放弃原值基准，保留尚未完成的原始文本。
    pub fn set_sensitivity_text(&mut self, text: String) -> bool {
        if self.mouse_sensitivity_text == text {
            return false;
        }
        self.original_mouse_sensitivity = None;
        self.mouse_sensitivity_text = text;
        true
    }

    /// 滑条与方向步进共用倍率写入；无效输入不改变草稿，合法数值规范为两位小数。
    pub fn set_sensitivity_multiplier(&mut self, value: f32) -> bool {
        if !value.is_finite()
            || !(MIN_MOUSE_SENSITIVITY_UNITS as f32..=MAX_MOUSE_SENSITIVITY_MULTIPLIER)
                .contains(&value)
        {
            return false;
        }
        let value = quantized_sensitivity_multiplier(f64::from(value));
        let text = format!("{value:.2}");
        let changed = self.mouse_sensitivity_text != text
            || self
                .unedited_sensitivity()
                .is_some_and(|original| original != value * MOUSE_SENSITIVITY_PER_UNIT);
        self.original_mouse_sensitivity = None;
        self.mouse_sensitivity_text = text;
        changed
    }

    /// 提交或失焦时只规范合法文本；返回是否合法，而不是是否发生文本变化。
    pub fn normalize_sensitivity(&mut self) -> bool {
        let Some(value) = self.sensitivity_multiplier() else {
            return false;
        };
        self.set_sensitivity_multiplier(value);
        true
    }

    /// 文本仍是原值的显示形式时，才能继续复用未编辑的精确角速度。
    fn unedited_sensitivity(&self) -> Option<f32> {
        self.original_mouse_sensitivity
            .filter(|original| self.mouse_sensitivity_text == sensitivity_text(*original))
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
            SettingKey::MouseSensitivity => {
                if direction != 0 {
                    let value = self
                        .sensitivity_multiplier()
                        .unwrap_or(DEFAULT_MOUSE_SENSITIVITY_UNITS)
                        + MOUSE_SENSITIVITY_STEP * f32::from(direction.signum());
                    self.set_sensitivity_multiplier(value.clamp(
                        MIN_MOUSE_SENSITIVITY_UNITS as f32,
                        MAX_MOUSE_SENSITIVITY_MULTIPLIER,
                    ));
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

/// 调用方按输入数值类型校验边界后，再量化为交互步数。
fn quantized_sensitivity_multiplier(value: f64) -> f32 {
    let steps = (value * f64::from(MOUSE_SENSITIVITY_STEPS_PER_UNIT)).round() as u16;
    f32::from(steps) / f32::from(MOUSE_SENSITIVITY_STEPS_PER_UNIT)
}

fn sensitivity_text(sensitivity: f32) -> String {
    let multiplier = sensitivity / MOUSE_SENSITIVITY_PER_UNIT;
    let multiplier = if multiplier == 0.0 { 0.0 } else { multiplier };
    format!("{multiplier:.2}")
}
