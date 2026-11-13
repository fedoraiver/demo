//! 玩家设置与共享原型参数；配置、草稿和渲染限帧在同一功能边界注册。

mod config;
mod draft;
mod prototype;

use std::time::Duration;

use bevy::{prelude::*, settings::SettingsPlugin};
use bevy_framepace::{FramepaceSettings, Limiter};
use config::{FpsLimit, SETTINGS_APP_NAME};

#[cfg(test)]
pub(crate) use config::MAX_MOUSE_SENSITIVITY;
pub use config::{
    AudioSettings, CameraSettings, DEFAULT_MOUSE_SENSITIVITY, GameSettings, MAX_AUDIO_VOLUME,
    MAX_MOUSE_SENSITIVITY_MULTIPLIER, MOUSE_SENSITIVITY_STEP, MOUSE_SENSITIVITY_STEPS_PER_UNIT,
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
        register_frame_pacing(app);
    }
}

fn register_frame_pacing(app: &mut App) {
    app.init_resource::<FramepaceSettings>()
        .add_systems(Startup, log_simulation_timestep)
        // 菜单在 PreUpdate 应用设置，插件在 Update 同步到渲染世界。
        .add_systems(
            RunFixedMainLoop,
            apply_frame_rate_limit.in_set(RunFixedMainLoopSystems::BeforeFixedMainLoop),
        );
}

/// 记录应用配置的固定模拟频率。
fn log_simulation_timestep(time: Res<Time<Fixed>>) {
    info!(
        target: "demo::settings",
        simulation_hz = 1.0 / time.timestep().as_secs_f64(),
        "Fixed simulation timestep initialized"
    );
}

fn apply_frame_rate_limit(
    settings: Res<GameSettings>,
    mut framepace: ResMut<FramepaceSettings>,
    mut applied_max_fps: Local<Option<FpsLimit>>,
) {
    if *applied_max_fps == Some(settings.max_fps) {
        return;
    }

    let max_fps = settings.max_fps.get();
    // 向上取整到纳秒，使所有合法 FPS 都有正帧间隔。
    let interval = Duration::from_nanos(1_000_000_000_u64.div_ceil(u64::from(max_fps)));
    framepace.limiter = Limiter::Manual(interval);
    info!(
        target: "demo::settings",
        max_fps_before = ?applied_max_fps.map(FpsLimit::get),
        max_fps_after = max_fps,
        reason = if applied_max_fps.is_some() {
            "settings_changed"
        } else {
            "initialization"
        },
        "Frame rate limit applied"
    );
    *applied_max_fps = Some(settings.max_fps);
}

#[cfg(test)]
mod tests;
