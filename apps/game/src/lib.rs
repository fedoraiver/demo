//! 普通窗口游戏与架构导出共用的应用装配。

use std::io;

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

/// 构建普通游戏的应用供架构导出器读取，应用持有日志守卫至导出结束。
///
/// # Panics
///
/// 无法初始化会话日志时 panic。
#[must_use]
pub fn build_app() -> App {
    let (mut app, session) = prepare_app().expect("Failed to initialize session logging");
    app.world_mut().insert_non_send(session);
    app
}

/// 运行普通游戏并在退出时刷新会话日志。
#[must_use]
pub fn run() -> AppExit {
    let (mut app, session) = match prepare_app() {
        Ok(prepared) => prepared,
        Err(error) => {
            eprintln!("Failed to initialize session logging: {error}");
            return AppExit::error();
        }
    };
    let exit = app.run();
    drop(app);
    if let Err(error) = session.record_exit(&exit) {
        eprintln!("Failed to flush session log on exit: {error}");
        return AppExit::error();
    }
    exit
}

fn prepare_app() -> io::Result<(App, session_log::SessionLogGuard)> {
    let (logging, session) = session_log::SessionLogPlugin::prepare()?;
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
    Ok((app, session))
}
