//! 使用简易资产启动移动、跳跃和木箱拾取原型。

mod camera;
mod gameplay;
mod input;
mod scene;
mod session_log;
mod settings;
mod startup_log;

use bevy::{log::LogPlugin, prelude::*, window::PresentMode};
use bevy_inspector_egui::{bevy_egui::EguiPlugin, quick::WorldInspectorPlugin};
use camera::CameraControlPlugin;
use gameplay::GameplayPlugin;
use input::PlayerInputPlugin;
use scene::PrototypeScenePlugin;
use settings::{GameSettings, SettingsPlugin};
use startup_log::StartupLogPlugin;

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
            .set(LogPlugin {
                custom_layer: session_log::file_layer,
                ..default()
            })
            .set(WindowPlugin {
                primary_window: Some(Window {
                    // 避免垂直同步把玩家设置的帧率上限额外限制为显示器的刷新率。
                    present_mode: PresentMode::AutoNoVsync,
                    ..default()
                }),
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
            // 检查器复用同一主窗口与相机，Egui 必须先于世界检查器注册。
            EguiPlugin::default(),
            WorldInspectorPlugin::new(),
            SettingsPlugin,
            GameplayPlugin,
            PlayerInputPlugin,
            CameraControlPlugin,
            PrototypeScenePlugin,
            StartupLogPlugin,
        ))
        .run();

    if let Err(error) = session.record_exit(&exit) {
        eprintln!("Failed to flush session log on exit: {error}");
        return AppExit::error();
    }
    exit
}
