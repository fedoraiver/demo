//! 使用独立 BRP 工具运行无窗游戏验收。

use bevy::{log::LogPlugin, prelude::*};
use bevy_acceptance_test::{AcceptanceCamera, AcceptancePlugin};
use bevy_enhanced_input::EnhancedInputPlugin;

#[path = "../../../src/audio/mod.rs"]
mod audio;
#[path = "../../../src/character/mod.rs"]
mod character;
#[path = "../../../src/first_person/mod.rs"]
mod first_person;
#[path = "../../../src/game_flow/mod.rs"]
mod game_flow;
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

fn main() -> AppExit {
    let acceptance = match AcceptancePlugin::from_env() {
        Ok(acceptance) => acceptance,
        Err(error) => {
            eprintln!("demo-acceptance: {error}");
            return AppExit::error();
        }
    };
    let input_window = acceptance.input_window_plugin();
    let runner = acceptance.runner_plugin();

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
            // 远程插件先于渲染子应用，只向主世界开放 BRP。
            .add_after::<LogPlugin>(acceptance)
            .add_after::<AcceptancePlugin>(runner)
            .disable::<bevy::audio::AudioPlugin>()
            .disable::<bevy::winit::WinitPlugin>()
            .disable::<bevy::gilrs::GilrsPlugin>()
            .set(input_window),
    );
    // 菜单和游戏交替创建默认 UI 相机，验收工具捕获当前相机。
    app.register_required_components_with::<IsDefaultUiCamera, AcceptanceCamera>(|| {
        AcceptanceCamera
    });
    app.insert_resource(Time::<Fixed>::from_hz(game_flow::FIXED_SIMULATION_HZ))
        .add_plugins(EnhancedInputPlugin);
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
