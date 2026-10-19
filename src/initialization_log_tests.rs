//! 通过实际功能插件的无窗口装配验证启动日志的归属、内容和一次性生命周期。

use std::{fs, sync::Arc, time::Duration};

use bevy::{
    asset::AssetPlugin,
    ecs::schedule::SingleThreadedExecutor,
    input::InputPlugin,
    log::{tracing, tracing_subscriber},
    prelude::*,
    render::RenderApp,
    shader::Shader,
    time::TimeUpdateStrategy,
    window::ExitCondition,
};
use bevy_inspector_egui::{bevy_egui::EguiPlugin, quick::WorldInspectorPlugin};
use uuid::Uuid;

use crate::{
    app_flow::AppState,
    camera::CameraControlPlugin,
    gameplay::{GameplayPlugin, PrototypeConfig},
    inspector::ProjectInspectorPlugin,
    settings::SettingsPlugin,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Feature {
    Gameplay,
    Settings,
    Camera,
    Inspector,
}

#[test]
fn startup_logs_preserve_targets_and_config_and_run_once() {
    let contents = capture_initialization_logs(None);
    assert_initialization_logs(&contents, None);
}

#[test]
fn absent_feature_plugins_do_not_report_initialization() {
    for omitted in [
        Feature::Gameplay,
        Feature::Settings,
        Feature::Camera,
        Feature::Inspector,
    ] {
        let contents = capture_initialization_logs(Some(omitted));
        assert_initialization_logs(&contents, Some(omitted));
    }
}

/// 只安装必要的时间、输入消息和资产存储；WindowPlugin 不生成窗口，也不安装原生后端。
fn test_app(omitted: Option<Feature>) -> App {
    let mut app = App::new();
    app.insert_resource(PrototypeConfig {
        move_speed: 7.0,
        ..default()
    })
    .insert_resource(Time::<Fixed>::from_seconds(0.5))
    .add_plugins((
        MinimalPlugins,
        TransformPlugin,
        InputPlugin,
        AssetPlugin::default(),
        WindowPlugin {
            primary_window: None,
            exit_condition: ExitCondition::DontExit,
            ..default()
        },
    ))
    .init_asset::<Image>()
    .init_asset::<Shader>()
    // 启动日志不受菜单状态限制；停用逐帧玩法可独立测试缺少任一功能插件的装配。
    .insert_resource(State::new(AppState::MainMenu))
    .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));

    if omitted != Some(Feature::Gameplay) {
        app.add_plugins(GameplayPlugin);
    }
    if omitted != Some(Feature::Settings) {
        app.add_plugins(SettingsPlugin);
    }
    if omitted != Some(Feature::Camera) {
        app.add_plugins(CameraControlPlugin);
    }
    if omitted != Some(Feature::Inspector) {
        app.add_plugins(ProjectInspectorPlugin);
        assert!(app.is_plugin_added::<EguiPlugin>());
        assert!(app.is_plugin_added::<WorldInspectorPlugin>());
    } else {
        assert!(!app.is_plugin_added::<EguiPlugin>());
        assert!(!app.is_plugin_added::<WorldInspectorPlugin>());
    }

    // 功能注册保留已有资源，Startup 则必须读取注册完成后的最终资源值。
    assert_eq!(app.world().resource::<PrototypeConfig>().move_speed, 7.0);
    assert_eq!(
        app.world().resource::<Time<Fixed>>().timestep(),
        Duration::from_millis(500)
    );
    app.insert_resource(custom_config())
        .insert_resource(Time::<Fixed>::from_seconds(0.25))
        .edit_schedule(Startup, |schedule| {
            // 局部 subscriber 只覆盖当前线程，启动系统显式串行以完整捕获记录。
            schedule.set_executor(SingleThreadedExecutor::new());
        });
    app.finish();
    app.cleanup();
    assert!(app.get_sub_app(RenderApp).is_none());
    assert!(!app.is_plugin_added::<bevy::winit::WinitPlugin>());
    app
}

fn custom_config() -> PrototypeConfig {
    PrototypeConfig {
        move_speed: 9.0,
        acceleration: 36.0,
        character_mass: 75.0,
        parcel_mass: 3.0,
        ..default()
    }
}

/// 不直接调用日志函数：注册真实插件并执行多次完整 update，检查不会提前或重复输出。
fn capture_initialization_logs(omitted: Option<Feature>) -> String {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tmp/initialization-log-tests");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{}.log", Uuid::new_v4()));
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(Arc::new(fs::File::create_new(&path).unwrap()))
        .finish();

    tracing::subscriber::with_default(subscriber, || {
        let mut app = test_app(omitted);
        let before_startup = fs::read_to_string(&path).unwrap();
        for message in [
            "Prototype gameplay initialized",
            "Fixed simulation timestep initialized",
            "Camera pose synchronization configured",
            "World inspector enabled",
        ] {
            assert!(!before_startup.contains(message), "{before_startup}");
        }
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(
            app.world_mut().query::<&Window>().iter(app.world()).count(),
            0
        );
        assert_eq!(
            app.world_mut().query::<&Camera>().iter(app.world()).count(),
            0
        );
    });

    let contents = fs::read_to_string(&path).unwrap();
    fs::remove_file(path).unwrap();
    contents
}

fn assert_initialization_logs(contents: &str, omitted: Option<Feature>) {
    for (feature, target, message, fields) in [
        (
            Feature::Gameplay,
            "demo::gameplay",
            "Prototype gameplay initialized",
            vec![
                // ?config 格式化的是 Res 包装；逐项核对配置，避免假设包装的 Debug 外观。
                "config=",
                "PrototypeConfig",
                "move_speed: 9.0",
                "acceleration: 36.0",
                "braking_acceleration: 45.0",
                "air_acceleration: 6.0",
                "jump_speed: 5.0",
                "gravity: 9.81",
                "pickup_radius: 1.8",
                "hold_offset: Vec3(0.0, 1.0, -0.9)",
                "ground_y: 0.0",
                "parcel_half_height: 0.3",
                "character_mass: 75.0",
                "character_height: 1.9",
                "character_radius: 0.32",
                "parcel_mass: 3.0",
                "physics_engine=\"avian3d\"",
                "physics_version=\"0.7.0\"",
                "character_body=\"dynamic\"",
                "parcel_body=\"dynamic_free_shared_held\"",
                "grip_mode=\"shared_body\"",
                "release_mode=\"preserve_velocity\"",
            ],
        ),
        (
            Feature::Settings,
            "demo::settings",
            "Fixed simulation timestep initialized",
            vec!["simulation_hz=4"],
        ),
        (
            Feature::Camera,
            "demo::camera",
            "Camera pose synchronization configured",
            vec![
                "simulation_schedule=\"FixedUpdate\"",
                "carry_schedule=\"FixedUpdate\"",
                "grip_mode=\"shared_body\"",
                "physics_schedule=\"FixedPostUpdate\"",
                "presentation_schedule=\"RunFixedMainLoop\"",
                "presentation_order=\"interpolation_character_facing_carry_pose_camera_visibility\"",
                "reason=\"initialization\"",
            ],
        ),
        (
            Feature::Inspector,
            "demo::inspector",
            "World inspector enabled",
            vec![
                "plugin=\"WorldInspectorPlugin\"",
                "reason=\"initialization\"",
            ],
        ),
    ] {
        let records: Vec<_> = contents
            .lines()
            .filter(|line| line.contains(message))
            .collect();
        let expected_count = usize::from(omitted != Some(feature));
        assert_eq!(
            records.len(),
            expected_count,
            "Unexpected {feature:?} startup log count: {contents}"
        );
        if expected_count == 0 {
            continue;
        }
        let record = records[0];
        assert!(
            record.contains("INFO") && record.contains(target),
            "{record}"
        );
        for field in fields {
            assert!(record.contains(field), "Missing {field}: {record}");
        }
    }
}
