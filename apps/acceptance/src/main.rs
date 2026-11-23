//! 使用独立 BRP 工具运行无窗游戏验收。

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
};
use bevy_acceptance_test::{AcceptanceCamera, AcceptancePlugin};
use bevy_enhanced_input::EnhancedInputPlugin;
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
#[path = "../../../src/item_interaction/mod.rs"]
mod item_interaction;
#[path = "../../../src/physics/mod.rs"]
mod physics;
#[path = "../../../src/scene_assembly/mod.rs"]
mod scene_assembly;
#[path = "../../../src/settings/mod.rs"]
mod settings;
#[cfg(test)]
mod tests;
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
    if let Err(error) = add_logging(&mut app) {
        eprintln!("Failed to initialize log file: {error}");
        return AppExit::error();
    }
    // 远程插件先于渲染子应用，只向主世界开放 BRP。
    app.add_plugins((acceptance, runner)).add_plugins(
        DefaultPlugins
            .build()
            .disable::<LogPlugin>()
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
