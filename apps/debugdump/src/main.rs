//! 导出普通窗口游戏实际装配的 Bevy 调度。

use std::path::{Path, PathBuf};

use bevy::{log::LogPlugin, prelude::*, render::RenderApp, winit::WinitSettings};
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
#[path = "../../../src/physics/mod.rs"]
mod physics;
#[path = "../../../src/scene_assembly/mod.rs"]
mod scene_assembly;
#[path = "../../../src/session_log/mod.rs"]
mod session_log;
#[path = "../../../src/settings/mod.rs"]
mod settings;
#[path = "../../../src/ui/mod.rs"]
mod ui;
#[path = "../../../src/window_policy/mod.rs"]
mod window_policy;

fn main() -> AppExit {
    let directory = std::env::args_os()
        .skip(1)
        .skip_while(|argument| argument != "--output")
        .nth(1)
        .filter(|directory| !directory.is_empty())
        .map_or_else(
            || Path::new(env!("DEMO_WORKSPACE_ROOT")).join("tmp/schedules"),
            PathBuf::from,
        );

    let (logging, session) = match session_log::SessionLogPlugin::prepare() {
        Ok(session) => session,
        Err(error) => {
            eprintln!("Failed to initialize session logging: {error}");
            return AppExit::error();
        }
    };
    let mut app = App::new();
    // 日志先于引擎插件安装，记录插件构建阶段的事件。
    app.add_plugins(logging);
    app.add_plugins(
        DefaultPlugins
            .build()
            .disable::<LogPlugin>()
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
    app.add_plugins(window_policy::WindowPolicyPlugin);
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
    let exit = match inspector::dump_schedules(&mut app, &directory) {
        Ok(_) => AppExit::Success,
        Err(error) => {
            error!(target: "demo::debugdump", directory = %directory.display(), %error,
                "Schedule export failed");
            AppExit::error()
        }
    };
    drop(app);
    if let Err(error) = session.record_exit(&exit) {
        eprintln!("Failed to flush session log on exit: {error}");
        return AppExit::error();
    }
    exit
}
