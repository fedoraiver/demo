//! 玩家设置与共享原型参数；配置、草稿和渲染限帧在同一功能边界注册。

mod config;
mod draft;
mod frame_pacing;
mod prototype;

use bevy::{prelude::*, settings::SettingsPlugin};
use config::SETTINGS_APP_NAME;

pub use config::{
    AudioSettings, CameraSettings, DEFAULT_MOUSE_SENSITIVITY, GameSettings, MAX_AUDIO_VOLUME,
};
pub use draft::{SettingKey, SettingsDraft};
pub use prototype::PrototypeConfig;

/// 加载玩家设置并注册原型参数反射和渲染限帧。
pub struct GameSettingsPlugin;

impl Plugin for GameSettingsPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<GameSettings>()
            .add_plugins(SettingsPlugin::new(SETTINGS_APP_NAME))
            .init_resource::<PrototypeConfig>()
            .register_type::<PrototypeConfig>();

        let settings = app.world().resource::<GameSettings>();
        info!(target: "demo::settings", max_fps = settings.max_fps.get(),
            camera_mouse_sensitivity = settings.camera.mouse_sensitivity,
            camera_invert_y = settings.camera.invert_y,
            audio_master_volume = settings.audio.master_volume,
            audio_ui_volume = settings.audio.ui_volume,
            "Game settings initialized");
        frame_pacing::register(app);
    }
}

#[cfg(test)]
mod tests;
