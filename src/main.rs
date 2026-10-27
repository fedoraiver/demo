mod audio;
mod bounds_recovery;
mod character;
mod character_animation;
mod first_person;
mod game_flow;
mod inspector;
mod item_interaction;
mod physics;
mod scene_assembly;
mod session_log;
mod settings;
mod ui;
mod window_policy;

use audio::GameAudioPlugin;
use bounds_recovery::BoundsRecoveryPlugin;
use character::CharacterPlugin;
use character_animation::CharacterAnimationPlugin;
use first_person::FirstPersonPlugin;
use game_flow::GameFlowPlugin;
use inspector::{InspectorPlugin, LaunchMode};
use item_interaction::ItemInteractionPlugin;
use physics::GamePhysicsPlugin;
use scene_assembly::SceneAssemblyPlugin;
use session_log::SessionLogPlugin;
use settings::{GameSettings, SettingsPlugin};
use ui::GameUiPlugin;
use window_policy::WindowPolicyPlugin;

use bevy::{log::LogPlugin, prelude::*};
use bevy_enhanced_input::EnhancedInputPlugin;

fn main() -> AppExit {
    let launch_mode = match inspector::parse_launch_mode(std::env::args_os().skip(1)) {
        Ok(LaunchMode::Help) => {
            inspector::print_help();
            return AppExit::Success;
        }
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("{error}");
            return AppExit::error();
        }
    };
    let mut app = App::new();
    let (logging, session) = match SessionLogPlugin::prepare() {
        Ok(prepared) => prepared,
        Err(error) => {
            eprintln!("Failed to initialize session logging; game startup aborted: {error}");
            return AppExit::error();
        }
    };
    // 日志先于引擎其他插件安装，构建阶段的事件也进入本次会话。
    app.add_plugins(logging);
    app.add_plugins(
        DefaultPlugins
            .build()
            .disable::<LogPlugin>()
            // 设备输出统一由 Kira 管理。
            .disable::<bevy::audio::AudioPlugin>()
            .set(WindowPlugin {
                primary_window: Some(window_policy::primary_window()),
                ..default()
            }),
    );

    app.insert_resource(GameSettings::load(std::path::Path::new("settings.json")))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .add_plugins((
            EnhancedInputPlugin,
            InspectorPlugin,
            WindowPolicyPlugin,
            GameFlowPlugin,
            SettingsPlugin,
            GamePhysicsPlugin,
            CharacterPlugin,
            ItemInteractionPlugin,
            FirstPersonPlugin,
            CharacterAnimationPlugin,
            BoundsRecoveryPlugin,
            SceneAssemblyPlugin,
            GameUiPlugin,
            GameAudioPlugin,
        ));

    let exit = match launch_mode {
        LaunchMode::Game => app.run(),
        LaunchMode::Help => unreachable!("help returns before app initialization"),
        #[cfg(feature = "debugdump")]
        LaunchMode::DumpSchedules(directory) => {
            match inspector::dump_schedules(&mut app, &directory) {
                Ok(_) => AppExit::Success,
                Err(error) => {
                    error!(target: "demo::inspector", directory = %directory.display(), %error,
                    "Schedule export failed");
                    AppExit::error()
                }
            }
        }
    };
    drop(app);

    if let Err(error) = session.record_exit(&exit) {
        eprintln!("Failed to flush session log on exit: {error}");
        return AppExit::error();
    }
    exit
}
