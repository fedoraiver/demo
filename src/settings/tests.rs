use bevy::{
    log::{
        tracing::{self, Level},
        tracing_subscriber::{self, fmt::MakeWriter},
    },
    reflect::{
        TypeRegistry,
        serde::{TypedReflectDeserializer, TypedReflectSerializer},
    },
    settings::SaveSettingsSync,
};
use serde::de::DeserializeSeed;
use serde_json::{Value, json};
use std::{
    any::TypeId,
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use super::{config::FpsLimit, *};

fn settings_types() -> TypeRegistry {
    let mut types = TypeRegistry::new();
    types.register_derived_types();
    types
}

#[test]
fn bevy_settings_load_and_save_game_configuration() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tmp")
        .join(format!("settings-test-{}", uuid::Uuid::new_v4()));
    let file = directory.join("settings.toml");
    // 文件回归使用原生存储的独立测试目录，避免改写实际玩家设置。
    let new_app = || {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_plugins(SettingsPlugin::new(directory.to_str().unwrap()));
        app
    };
    let mut app = new_app();
    assert_eq!(
        *app.world().resource::<GameSettings>(),
        GameSettings::default()
    );
    app.world_mut().resource_mut::<GameSettings>().max_fps = FpsLimit::new(120).unwrap();
    app.world_mut().commands().queue(SaveSettingsSync::Always);
    app.world_mut().flush();

    let reload = new_app();
    let saved_fps = reload.world().resource::<GameSettings>().max_fps.get();

    std::fs::remove_file(file).unwrap();
    std::fs::remove_dir(directory).unwrap();
    assert_eq!(saved_fps, 120);
}

// 使用与 SettingsPlugin 相同的类型注册和字段反序列化入口，测试数据留在内存。
fn deserialize_field<T: 'static>(types: &TypeRegistry, value: Value) -> T {
    let registration = types.get(TypeId::of::<T>()).unwrap();
    *TypedReflectDeserializer::new(registration, types)
        .deserialize(value)
        .unwrap()
        .try_downcast::<T>()
        .unwrap()
}

#[test]
fn reflected_settings_preserve_scalar_fps_and_default_missing_fields() {
    let types = settings_types();
    let settings = GameSettings {
        max_fps: deserialize_field(&types, json!(75)),
        camera: deserialize_field(&types, json!({ "invert_y": true })),
        audio: deserialize_field(&types, json!({ "ui_volume": 0 })),
    };
    assert_eq!(settings.max_fps.get(), 75);
    assert_eq!(settings.camera.mouse_sensitivity, DEFAULT_MOUSE_SENSITIVITY);
    assert!(settings.camera.invert_y);
    assert_eq!(settings.audio.master_volume, MAX_AUDIO_VOLUME);
    assert_eq!(settings.audio.ui_volume, 0);
    assert_eq!(
        serde_json::to_value(TypedReflectSerializer::new(&settings, &types)).unwrap(),
        json!({
            "max_fps": 75,
            "camera": {
                "mouse_sensitivity": settings.camera.mouse_sensitivity,
                "invert_y": true,
            },
            "audio": { "master_volume": MAX_AUDIO_VOLUME, "ui_volume": 0 },
        })
    );
    for fps in [60, u32::MAX] {
        assert_eq!(deserialize_field::<FpsLimit>(&types, json!(fps)).get(), fps);
    }
}

#[derive(Clone, Default)]
struct WarningOutput {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl<'a> MakeWriter<'a> for WarningOutput {
    type Writer = <Mutex<Vec<u8>> as MakeWriter<'a>>::Writer;

    fn make_writer(&'a self) -> Self::Writer {
        self.bytes.as_ref().make_writer()
    }
}

#[test]
fn invalid_reflected_values_warn_and_only_replace_the_affected_field() {
    let types = settings_types();
    let defaults = GameSettings::default();
    let output = WarningOutput::default();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .without_time()
        .with_max_level(Level::WARN)
        .with_writer(output.clone())
        .finish();

    tracing::subscriber::with_default(subscriber, || {
        for invalid_fps in [-1, 0, 59, i64::from(u32::MAX) + 1] {
            assert_eq!(
                deserialize_field::<FpsLimit>(&types, json!(invalid_fps)),
                defaults.max_fps
            );
        }

        for invalid_sensitivity in [-1.0, -0.0, 0.0, 0.00000749, 0.0076, 1e39] {
            let camera: CameraSettings = deserialize_field(
                &types,
                json!({ "mouse_sensitivity": invalid_sensitivity, "invert_y": true }),
            );
            assert_eq!(camera.mouse_sensitivity, defaults.camera.mouse_sensitivity);
            assert!(camera.invert_y);
        }

        let audio: AudioSettings =
            deserialize_field(&types, json!({ "master_volume": -1, "ui_volume": 31 }));
        assert_eq!(audio.master_volume, defaults.audio.master_volume);
        assert_eq!(audio.ui_volume, 31);

        for invalid_volume in [101, 256] {
            let audio: AudioSettings = deserialize_field(
                &types,
                json!({ "master_volume": 73, "ui_volume": invalid_volume }),
            );
            assert_eq!(audio.master_volume, 73);
            assert_eq!(audio.ui_volume, defaults.audio.ui_volume);
        }
    });

    let output = output.bytes.lock().unwrap();
    let warnings = std::str::from_utf8(&output).unwrap();
    for (field, value, fallback) in [
        ("max_fps", 59.0, f64::from(defaults.max_fps.get())),
        (
            "camera.mouse_sensitivity",
            -1.0,
            f64::from(defaults.camera.mouse_sensitivity),
        ),
        (
            "camera.mouse_sensitivity",
            1e39,
            f64::from(defaults.camera.mouse_sensitivity),
        ),
        (
            "audio.master_volume",
            -1.0,
            f64::from(defaults.audio.master_volume),
        ),
        (
            "audio.ui_volume",
            256.0,
            f64::from(defaults.audio.ui_volume),
        ),
    ] {
        assert!(
            warnings.lines().any(|line| {
                line.contains("WARN")
                    && line.contains("demo::settings")
                    && line.contains(field)
                    && warning_number(line, "value=") == Some(value)
                    && warning_number(line, "default=") == Some(fallback)
            }),
            "{field}: {warnings}"
        );
    }
}

fn warning_number(line: &str, field_prefix: &str) -> Option<f64> {
    line.split_whitespace()
        .find_map(|part| part.strip_prefix(field_prefix))?
        .parse()
        .ok()
}

#[test]
fn invalid_drafts_are_rejected_instead_of_applying_defaults() {
    for draft in [
        SettingsDraft {
            max_fps: 59,
            ..default()
        },
        SettingsDraft {
            audio: AudioSettings {
                master_volume: 101,
                ..default()
            },
            ..default()
        },
    ] {
        assert!(draft.to_settings().is_err());
    }
}

#[test]
fn draft_preserves_unedited_sensitivity_precision_while_other_fields_change() {
    let custom = GameSettings {
        max_fps: FpsLimit::new(75).unwrap(),
        camera: CameraSettings {
            mouse_sensitivity: 0.0037407,
            ..default()
        },
        ..default()
    };
    let mut draft = SettingsDraft::from_settings(&custom);
    assert_eq!(draft.mouse_sensitivity_text, "4.99");
    assert_eq!(draft.to_settings().unwrap(), custom);
    assert!(!draft.set_sensitivity_text(draft.mouse_sensitivity_text.clone()));
    draft.adjust(SettingKey::MouseSensitivity, 0);
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        0.0037407
    );
    draft.adjust(SettingKey::InvertY, 0);
    assert!(draft.invert_y);
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        0.0037407
    );
    draft.adjust(SettingKey::FrameRate, 1);
    assert_eq!(draft.max_fps, 90);
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        0.0037407
    );
    draft.adjust(SettingKey::MasterVolume, -1);
    assert_eq!(draft.audio.master_volume, 95);
    draft.set_volume(SettingKey::UiVolume, 73);
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        0.0037407
    );
    assert!(draft.normalize_sensitivity());
    assert_eq!(draft.mouse_sensitivity_text, "4.99");
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        0.0037407
    );

    let mut draft = SettingsDraft::from_settings(&custom);
    assert!(draft.set_sensitivity_multiplier(1.25));
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        1.25 * MOUSE_SENSITIVITY_PER_UNIT
    );
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "1.26");
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        1.26 * MOUSE_SENSITIVITY_PER_UNIT
    );
    let mut below_minimum = custom;
    below_minimum.camera.mouse_sensitivity = MIN_MOUSE_SENSITIVITY * 0.9;
    let draft = SettingsDraft::from_settings(&below_minimum);
    assert_eq!(draft.mouse_sensitivity_text, "0.01");
    assert_eq!(
        draft.to_settings().unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
}

#[test]
fn draft_adjustments_remain_within_menu_limits() {
    let mut draft = SettingsDraft::default();
    for fps in [90, 120, 144, 165, 240, 240] {
        draft.adjust(SettingKey::FrameRate, 1);
        assert_eq!(draft.max_fps, fps);
    }
    for fps in [165, 144, 120, 90, 60, 60] {
        draft.adjust(SettingKey::FrameRate, -1);
        assert_eq!(draft.max_fps, fps);
    }
    assert!(draft.to_settings().is_ok());
}

#[test]
fn ui_audio_draft_adjustments_preserve_values_and_clamp_only_edited_fields() {
    let custom = GameSettings {
        max_fps: FpsLimit::new(75).unwrap(),
        audio: AudioSettings {
            master_volume: 73,
            ui_volume: 97,
        },
        ..default()
    };
    let mut draft = SettingsDraft::from_settings(&custom);
    assert_eq!(draft.to_settings().unwrap().audio, custom.audio);
    assert_eq!(draft.volume(SettingKey::FrameRate), None);
    assert_eq!(draft.volume(SettingKey::MouseSensitivity), None);
    assert!(!draft.set_volume(SettingKey::FrameRate, 20));
    draft.adjust(SettingKey::MasterVolume, 0);
    assert_eq!(draft.audio, custom.audio);
    draft.adjust(SettingKey::MasterVolume, 1);
    assert_eq!(draft.audio.master_volume, 78);
    assert_eq!(draft.audio.ui_volume, 97);
    draft.adjust(SettingKey::UiVolume, 1);
    assert_eq!(draft.audio.ui_volume, 100);
    assert!(!draft.set_volume(SettingKey::UiVolume, 255));
    assert!(draft.set_volume(SettingKey::MasterVolume, 255));
    for key in [SettingKey::MasterVolume, SettingKey::UiVolume] {
        for _ in 0..22 {
            draft.adjust(key, -1);
        }
        assert_eq!(draft.volume(key), Some(0));
        for _ in 0..22 {
            draft.adjust(key, 1);
        }
        assert_eq!(draft.volume(key), Some(100));
    }
    assert_eq!(draft.max_fps, 75);
}

// 插件在原生平台的 Update 读取帧间隔。空的 RenderApp 不执行渲染调度。
#[cfg(not(target_arch = "wasm32"))]
mod frame_pacing {
    use super::*;
    use bevy::{
        app::SubApp,
        render::RenderApp,
        time::{TimePlugin, TimeUpdateStrategy},
    };
    use bevy_framepace::{FramepacePlugin, FrametimeLimit};
    use std::time::Duration;

    fn test_app() -> App {
        let mut app = App::new();
        app.insert_sub_app(RenderApp, SubApp::new());
        app.add_plugins((TimePlugin, FramepacePlugin))
            .init_resource::<GameSettings>();
        register_frame_pacing(&mut app);
        app
    }

    fn frametime_limit(app: &App) -> Duration {
        *app.world().resource::<FrametimeLimit>().0.lock().unwrap()
    }

    #[test]
    fn frame_rate_limit_rounds_up_from_default_and_custom_values() {
        let mut app = test_app();
        app.update();
        assert_eq!(frametime_limit(&app), Duration::from_nanos(16_666_667));

        for (fps, interval_ns) in [(75, 13_333_334), (144, 6_944_445), (u32::MAX, 1)] {
            app.world_mut().resource_mut::<GameSettings>().max_fps = FpsLimit::new(fps).unwrap();
            app.update();
            assert_eq!(
                frametime_limit(&app),
                Duration::from_nanos(interval_ns),
                "{fps} FPS"
            );
        }
    }

    #[test]
    fn changing_render_limit_takes_effect_within_update_and_preserves_fixed_timestep() {
        let mut app = test_app();
        app.insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
                20,
            )));
        app.update();
        let timestep = app.world().resource::<Time<Fixed>>().timestep();

        // 模拟菜单在 PreUpdate 应用配置，确认插件在同一帧读取新的间隔。
        app.add_systems(PreUpdate, |mut settings: ResMut<GameSettings>| {
            settings.max_fps = FpsLimit::new(120).unwrap();
        });
        app.update();
        assert_eq!(frametime_limit(&app), Duration::from_nanos(8_333_334));

        let fixed = app.world().resource::<Time<Fixed>>();
        assert_eq!(fixed.timestep(), timestep);
        assert!((1.0 / fixed.timestep().as_secs_f64() - 60.0).abs() < 0.001);
        assert!(fixed.elapsed() >= timestep);
    }
}

#[test]
fn sensitivity_multiplier_validates_raw_text_before_quantizing_and_normalizing() {
    let mut draft = SettingsDraft::default();
    assert_eq!(draft.mouse_sensitivity_text, "5.00");
    assert_eq!(MOUSE_SENSITIVITY_PER_UNIT, 0.003 * 0.25);
    assert!((draft.to_settings().unwrap().camera.mouse_sensitivity - 0.00375).abs() < 1e-9);
    assert!((MAX_MOUSE_SENSITIVITY - 0.0075).abs() < 1e-9);
    for (input, expected, normalized) in [
        ("0.01", 0.01, "0.01"),
        ("10", 10.0, "10.00"),
        ("1", 1.0, "1.00"),
        ("5", 5.0, "5.00"),
        ("1.23", 1.23, "1.23"),
        ("1.234", 1.23, "1.23"),
        ("1.236", 1.24, "1.24"),
        (" 2.5 ", 2.5, "2.50"),
        ("1e-2", 0.01, "0.01"),
    ] {
        draft.set_sensitivity_text(input.into());
        assert_eq!(draft.mouse_sensitivity_text, input);
        assert_eq!(draft.sensitivity_multiplier(), Some(expected), "{input}");
        assert_eq!(
            draft.to_settings().unwrap().camera.mouse_sensitivity,
            expected * MOUSE_SENSITIVITY_PER_UNIT
        );
        assert!(draft.normalize_sensitivity());
        assert_eq!(draft.mouse_sensitivity_text, normalized);
        assert!(draft.normalize_sensitivity());
        assert!(!draft.set_sensitivity_multiplier(expected));
    }
    for invalid in [
        "",
        ".",
        "-",
        "1e",
        "-0.001",
        "0",
        "-0",
        "-0.0",
        "0.001",
        "0.009",
        "0.0099999999",
        "10.001",
        "10.0000001",
        "NaN",
        "inf",
        "-inf",
        "1e100",
        "1.2.3",
    ] {
        draft.set_sensitivity_text(invalid.into());
        assert_eq!(draft.sensitivity_multiplier(), None, "{invalid}");
        assert!(!draft.normalize_sensitivity(), "{invalid}");
        assert_eq!(draft.mouse_sensitivity_text, invalid);
        assert_eq!(
            draft.to_settings().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
    draft.set_sensitivity_multiplier(1.23);
    for invalid in [
        0.0,
        -0.0,
        0.009,
        -0.01,
        10.001,
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
    ] {
        assert!(!draft.set_sensitivity_multiplier(invalid));
        assert_eq!(draft.mouse_sensitivity_text, "1.23");
    }
}

#[test]
fn sensitivity_step_clamps_to_limits_and_replaces_invalid_text_from_default() {
    let mut draft = SettingsDraft::default();
    assert!(draft.set_sensitivity_multiplier(MIN_MOUSE_SENSITIVITY_UNITS as f32));
    draft.adjust(SettingKey::MouseSensitivity, -1);
    assert_eq!(draft.mouse_sensitivity_text, "0.01");
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "0.02");
    draft.set_sensitivity_multiplier(10.0);
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "10.00");
    draft.adjust(SettingKey::MouseSensitivity, -1);
    assert_eq!(draft.mouse_sensitivity_text, "9.99");
    draft.set_sensitivity_text("1e".into());
    draft.adjust(SettingKey::MouseSensitivity, 0);
    assert_eq!(draft.mouse_sensitivity_text, "1e");
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "5.01");
}

#[test]
fn reflected_sensitivity_round_trip_preserves_bounds_and_custom_precision() {
    let types = settings_types();
    for (sensitivity, display) in [
        (MIN_MOUSE_SENSITIVITY, "0.01"),
        (MOUSE_SENSITIVITY_PER_UNIT, "1.00"),
        (DEFAULT_MOUSE_SENSITIVITY, "5.00"),
        (MAX_MOUSE_SENSITIVITY, "10.00"),
        (0.0037407, "4.99"),
    ] {
        let mut settings = GameSettings::default();
        settings.camera.mouse_sensitivity = sensitivity;
        let saved =
            serde_json::to_value(TypedReflectSerializer::new(&settings.camera, &types)).unwrap();
        assert_eq!(saved["mouse_sensitivity"], json!(sensitivity));
        assert_eq!(
            deserialize_field::<CameraSettings>(&types, saved),
            settings.camera
        );
        let draft = SettingsDraft::from_settings(&settings);
        assert_eq!(
            draft.to_settings().unwrap().camera.mouse_sensitivity,
            sensitivity
        );
        assert_eq!(draft.mouse_sensitivity_text, display);
    }
}
