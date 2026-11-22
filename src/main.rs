#[cfg(feature = "acceptance-test")]
mod acceptance;
mod audio;
mod character;
mod first_person;
mod game_flow;
#[cfg(any(feature = "inspector", feature = "debugdump", test))]
mod inspector;
mod item_interaction;
mod launch;
mod physics;
mod scene_assembly;
mod session_log;
mod settings;
mod ui;
mod window_policy;

use audio::GameAudioPlugin;
use character::CharacterPlugin;
use first_person::FirstPersonPlugin;
use game_flow::{FIXED_SIMULATION_HZ, GameFlowPlugin};
#[cfg(feature = "inspector")]
use inspector::InspectorPlugin;
use item_interaction::ItemInteractionPlugin;
use launch::LaunchMode;
use physics::GamePhysicsPlugin;
use scene_assembly::SceneAssemblyPlugin;
use session_log::SessionLogPlugin;
use settings::GameSettingsPlugin;
use ui::GameUiPlugin;
use window_policy::WindowPolicyPlugin;

use std::time::Duration;

use bevy::{
    app::ScheduleRunnerPlugin, log::LogPlugin, prelude::*, render::RenderApp, winit::WinitSettings,
};
use bevy_enhanced_input::EnhancedInputPlugin;
use bevy_framepace::FramepacePlugin;

fn main() -> AppExit {
    let launch_mode = match launch::parse_launch_mode(std::env::args_os().skip(1)) {
        Ok(LaunchMode::Help) => {
            launch::print_help();
            return AppExit::Success;
        }
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("{error}");
            return AppExit::error();
        }
    };
    let acceptance_run =
        cfg!(feature = "acceptance-test") && matches!(launch_mode, LaunchMode::Game);
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
    #[cfg(feature = "acceptance-test")]
    if acceptance_run {
        app.add_plugins(acceptance::AcceptancePlugin);
    }
    let mut engine = DefaultPlugins
        .build()
        .disable::<LogPlugin>()
        // 设备输出统一由 Kira 管理。
        .disable::<bevy::audio::AudioPlugin>();
    #[cfg(feature = "acceptance-test")]
    if acceptance_run {
        engine = engine
            .disable::<bevy::winit::WinitPlugin>()
            .disable::<bevy::gilrs::GilrsPlugin>()
            .set(acceptance::input_window_plugin());
    }
    if !acceptance_run {
        engine = engine.set(WindowPlugin {
            primary_window: Some(window_policy::primary_window()),
            ..default()
        });
    }
    app.add_plugins(engine);

    if acceptance_run {
        app.add_plugins(ScheduleRunnerPlugin::run_loop(Duration::from_secs_f64(
            1.0 / 60.0,
        )));
    } else if app.get_sub_app(RenderApp).is_some() {
        // 渲染插件负责帧间等待，前后台窗口循环采用相同的连续更新模式。
        app.insert_resource(WinitSettings::continuous())
            .add_plugins(FramepacePlugin);
    }

    app.insert_resource(Time::<Fixed>::from_hz(FIXED_SIMULATION_HZ))
        .add_plugins(EnhancedInputPlugin);
    if !acceptance_run {
        #[cfg(feature = "inspector")]
        app.add_plugins(InspectorPlugin);
        app.add_plugins(WindowPolicyPlugin);
    }
    app.add_plugins((
        GameFlowPlugin,
        GameSettingsPlugin,
        GamePhysicsPlugin,
        CharacterPlugin,
        ItemInteractionPlugin,
        FirstPersonPlugin,
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
