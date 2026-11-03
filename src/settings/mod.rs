//! 玩家设置与共享原型参数；配置、草稿和渲染限帧在同一功能边界注册。

mod config;
mod draft;
mod frame_pacing;
mod prototype;

use bevy::prelude::*;

pub use config::{
    AudioSettings, CameraSettings, DEFAULT_MOUSE_SENSITIVITY, GameSettings, MAX_AUDIO_VOLUME,
    SettingsFile,
};
pub use draft::{SettingKey, SettingsDraft};
pub use prototype::PrototypeConfig;

/// 注册设置资源、原型参数反射与渲染限帧，不覆盖调用方已提供的配置或固定时间步。
pub struct SettingsPlugin;

impl Plugin for SettingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GameSettings>()
            .init_resource::<SettingsFile>()
            .init_resource::<PrototypeConfig>()
            .register_type::<PrototypeConfig>();
        frame_pacing::register(app);
    }
}

#[cfg(test)]
mod tests;
