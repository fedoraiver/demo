//! 构建普通窗口游戏并接入世界检查器。

use bevy::{prelude::*, render::RenderApp, winit::WinitSettings};
use bevy_enhanced_input::EnhancedInputPlugin;
use bevy_framepace::FramepacePlugin;

#[path = "../../../src/audio/mod.rs"]
mod audio;
#[path = "../../../src/character/mod.rs"]
mod character;
#[path = "../../../src/first_person/mod.rs"]
mod first_person;
#[path = "../../../src/game_flow/mod.rs"]
mod game_flow;
#[path = "../../../src/inspector/mod.rs"]
mod inspector;
#[path = "../../../src/item_interaction/mod.rs"]
mod item_interaction;
#[path = "../../log_file/mod.rs"]
mod log_file;
#[path = "../../../src/physics/mod.rs"]
mod physics;
#[path = "../../../src/scene_assembly/mod.rs"]
mod scene_assembly;
#[path = "../../../src/settings/mod.rs"]
mod settings;
#[path = "../../../src/ui/mod.rs"]
mod ui;
#[path = "../../../src/window_policy/mod.rs"]
mod window_policy;

fn main() -> AppExit {
    let mut app = App::new();
    let logging = match log_file::prepare(&mut app) {
        Ok(logging) => logging,
        Err(error) => {
            eprintln!("Failed to initialize log file: {error}");
            return AppExit::error();
        }
    };
    app.add_plugins(
        DefaultPlugins
            .build()
            .set(logging)
            .disable::<bevy::audio::AudioPlugin>()
            .set(WindowPlugin {
                primary_window: Some(window_policy::primary_window()),
                ..default()
            }),
    );
    if app.get_sub_app(RenderApp).is_some() {
        // 渲染插件负责帧间等待，窗口循环使用连续更新。
        app.insert_resource(WinitSettings::continuous())
            .add_plugins(FramepacePlugin);
    }
    app.insert_resource(Time::<Fixed>::from_hz(game_flow::FIXED_SIMULATION_HZ))
        .add_plugins(EnhancedInputPlugin);
    app.add_plugins((
        inspector::InspectorPlugin,
        window_policy::WindowPolicyPlugin,
    ));
    app.add_plugins((
        game_flow::GameFlowPlugin,
        settings::GameSettingsPlugin,
        physics::GamePhysicsPlugin,
        character::CharacterPlugin,
        item_interaction::ItemInteractionPlugin,
        first_person::FirstPersonPlugin,
        scene_assembly::SceneAssemblyPlugin,
        ui::GameUiPlugin,
        audio::GameAudioPlugin,
    ));
    app.run()
}
