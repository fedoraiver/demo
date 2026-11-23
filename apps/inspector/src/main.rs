//! 构建普通窗口游戏并接入世界检查器。

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use bevy::{
    log::{LogPlugin, tracing_subscriber},
    prelude::*,
    render::RenderApp,
    winit::WinitSettings,
};
use bevy_enhanced_input::EnhancedInputPlugin;
use bevy_framepace::FramepacePlugin;
use tracing_subscriber::prelude::*;
use uuid::Uuid;

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
#[path = "../../../src/settings/mod.rs"]
mod settings;
#[path = "../../../src/ui/mod.rs"]
mod ui;
#[path = "../../../src/window_policy/mod.rs"]
mod window_policy;

fn main() -> AppExit {
    let mut app = App::new();
    if let Err(error) = add_logging(&mut app) {
        eprintln!("Failed to initialize log file: {error}");
        return AppExit::error();
    }
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

fn add_logging(app: &mut App) -> io::Result<()> {
    #[derive(Resource)]
    struct PendingLogFile {
        file: File,
    }

    let directory = Path::new("logs");
    fs::create_dir_all(directory).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Failed to create log directory {}: {error}",
                directory.display()
            ),
        )
    })?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    let id = Uuid::new_v4();
    let path = directory.join(format!(
        "unix-{}-{:09}_{id}.log",
        timestamp.as_secs(),
        timestamp.subsec_nanos(),
    ));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("Failed to create log file {}: {error}", path.display()),
            )
        })?;

    app.insert_resource(PendingLogFile { file });
    app.add_plugins(LogPlugin {
        custom_layer: |app| {
            // 构建时把文件交给格式层，整条日志持锁写入。
            let pending = app
                .world_mut()
                .remove_resource::<PendingLogFile>()
                .expect("Log file must be prepared before adding LogPlugin");
            Some(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(Mutex::new(pending.file))
                    .log_internal_errors(true)
                    .boxed(),
            )
        },
        ..default()
    });
    Ok(())
}
