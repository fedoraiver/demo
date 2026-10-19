//! 组装英文菜单、美术海岛、物理搬运与音效，并覆盖完整会话的文件日志。

mod app_flow;
mod art_assets;
mod audio;
mod audio_events;
mod camera;
mod carry;
#[cfg(test)]
mod carry_frame_tests;
mod carry_rotation;
mod character_animation;
mod gameplay;
#[cfg(test)]
mod initialization_log_tests;
mod input;
mod inspector;
mod island_recovery;
mod physics;
#[cfg(test)]
mod physics_tests;
mod scene;
mod session_log;
mod settings;
mod ui;
mod window_policy;

use app_flow::AppFlowPlugin;
use art_assets::ArtAssetsPlugin;
use audio::GameAudioPlugin;
use bevy::{log::LogPlugin, prelude::*};
use camera::CameraControlPlugin;
use character_animation::CharacterAnimationPlugin;
use gameplay::GameplayPlugin;
use input::PlayerInputPlugin;
use inspector::ProjectInspectorPlugin;
use island_recovery::IslandRecoveryPlugin;
use scene::PrototypeScenePlugin;
use settings::{GameSettings, SettingsPlugin};
use ui::GameUiPlugin;
use window_policy::WindowPolicyPlugin;

fn main() -> AppExit {
    let mut app = App::new();
    // 先准备会话文件，再交给 LogPlugin 安装日志；守护对象保留到退出记录写入后。
    let session = match session_log::prepare(&mut app) {
        Ok(session) => session,
        Err(error) => {
            eprintln!("Failed to initialize session logging; game startup aborted: {error}");
            return AppExit::error();
        }
    };

    app.add_plugins(
        DefaultPlugins
            .build()
            // 播放统一交给 Kira，避免两套音频插件同时打开输出设备。
            .disable::<bevy::audio::AudioPlugin>()
            .set(LogPlugin {
                custom_layer: session_log::file_layer,
                fmt_layer: session_log::console_layer,
                ..default()
            })
            .set(WindowPlugin {
                primary_window: Some(window_policy::primary_window()),
                ..default()
            }),
    );
    // LogPlugin 已完成初始化，此后的会话与玩法日志会同时写入控制台和文件。
    session.start();

    let exit = app
        .insert_resource(GameSettings::load(std::path::Path::new("settings.json")))
        // 统一由玩家上限限速，避免失焦时再被默认的 60 Hz 更新策略限制。
        .insert_resource(bevy::winit::WinitSettings::continuous())
        // 固定步只控制移动、重力和交互模拟，独立于玩家设置的渲染上限。
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .add_plugins((
            ProjectInspectorPlugin,
            WindowPolicyPlugin,
            AppFlowPlugin,
            SettingsPlugin,
            GameplayPlugin,
            GameAudioPlugin,
            PlayerInputPlugin,
            CameraControlPlugin,
            ArtAssetsPlugin,
            CharacterAnimationPlugin,
            IslandRecoveryPlugin,
            PrototypeScenePlugin,
            GameUiPlugin,
        ))
        .run();

    if let Err(error) = session.record_exit(&exit) {
        eprintln!("Failed to flush session log on exit: {error}");
        return AppExit::error();
    }
    exit
}
