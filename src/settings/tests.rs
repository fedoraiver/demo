use bevy::{
    log::{
        tracing::{self, Level},
        tracing_subscriber::{self, fmt::MakeWriter},
    },
    reflect::{
        TypeRegistry,
        serde::{TypedReflectDeserializer, TypedReflectSerializer},
    },
    time::{TimePlugin, TimeUpdateStrategy},
    winit::{UpdateMode, WinitSettings},
};
use serde::de::DeserializeSeed;
use serde_json::{Value, json};
use std::{
    any::TypeId,
    sync::{Arc, Mutex},
    time::Duration,
};

use super::{config::FpsLimit, *};

fn settings_types() -> TypeRegistry {
    let mut types = TypeRegistry::new();
    types.register::<GameSettings>();
    types
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

        for invalid_sensitivity in [0.0, -1.0, 1e39] {
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
            0.0,
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
            mouse_sensitivity: f32::NAN,
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
fn draft_preserves_custom_values_until_their_field_is_adjusted() {
    let custom = GameSettings {
        max_fps: FpsLimit::new(75).unwrap(),
        camera: CameraSettings {
            mouse_sensitivity: 0.03,
            ..default()
        },
        ..default()
    };
    let mut draft = SettingsDraft::from_settings(&custom);
    let converted = draft.to_settings().unwrap();
    assert_eq!(converted.max_fps.get(), 75);
    assert_eq!(converted.camera.mouse_sensitivity, 0.03);
    draft.adjust(SettingKey::InvertY, 0);
    assert!(draft.invert_y);
    assert_eq!(draft.max_fps, 75);
    assert_eq!(draft.mouse_sensitivity, 0.03);
    draft.adjust(SettingKey::FrameRate, 0);
    draft.adjust(SettingKey::MouseSensitivity, 0);
    assert_eq!(draft.max_fps, 75);
    assert_eq!(draft.mouse_sensitivity, 0.03);

    draft.adjust(SettingKey::FrameRate, 1);
    assert_eq!(draft.max_fps, 90);
    draft.adjust(SettingKey::FrameRate, -1);
    assert_eq!(draft.max_fps, 60);
    draft.adjust(SettingKey::MouseSensitivity, -1);
    assert_eq!(draft.mouse_sensitivity, 0.02);
    draft.adjust(SettingKey::InvertY, -1);
    assert!(!draft.invert_y);
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
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert!((draft.mouse_sensitivity - 0.0035).abs() < 0.000001);
    for _ in 0..100 {
        draft.adjust(SettingKey::MouseSensitivity, 1);
    }
    assert_eq!(draft.mouse_sensitivity, 0.02);
    for _ in 0..100 {
        draft.adjust(SettingKey::MouseSensitivity, -1);
    }
    assert_eq!(draft.mouse_sensitivity, 0.0005);
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

#[test]
fn frame_rate_limit_configures_native_runner_for_both_focus_modes() {
    for (fps, interval_ns) in [(60, 16_666_667), (75, 13_333_334), (144, 6_944_445)] {
        let mut app = App::new();
        app.add_plugins(TimePlugin)
            .insert_resource(GameSettings {
                max_fps: FpsLimit::new(fps).unwrap(),
                ..default()
            })
            .insert_resource(WinitSettings::continuous());
        frame_pacing::register(&mut app);
        app.update();

        let winit = app.world().resource::<WinitSettings>();
        for focused in [true, false] {
            assert_eq!(
                winit.update_mode(focused),
                UpdateMode::Reactive {
                    wait: Duration::from_nanos(interval_ns),
                    react_to_device_events: false,
                    react_to_user_events: false,
                    react_to_window_events: false,
                }
            );
        }
    }
}

#[test]
fn changing_render_limit_preserves_fixed_simulation_timestep() {
    // 只运行最小 App；手动推进时间，不加载窗口、渲染器或完整游戏。
    let mut app = App::new();
    app.add_plugins(TimePlugin)
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
            20,
        )))
        .init_resource::<GameSettings>();
    frame_pacing::register(&mut app);
    app.update();
    let timestep = app.world().resource::<Time<Fixed>>().timestep();
    // 模拟菜单在 PreUpdate 应用配置，确认本帧结束时窗口循环已能读取新策略。
    app.add_systems(PreUpdate, |mut settings: ResMut<GameSettings>| {
        settings.max_fps = FpsLimit::new(120).unwrap();
    });
    app.update();
    let winit = app.world().resource::<WinitSettings>();
    for focused in [true, false] {
        assert_eq!(
            winit.update_mode(focused),
            UpdateMode::Reactive {
                wait: Duration::from_nanos(8_333_334),
                react_to_device_events: false,
                react_to_user_events: false,
                react_to_window_events: false,
            }
        );
    }
    let fixed = app.world().resource::<Time<Fixed>>();
    assert_eq!(fixed.timestep(), timestep);
    assert!((1.0 / fixed.timestep().as_secs_f64() - 60.0).abs() < 0.001);
    assert!(fixed.elapsed() >= timestep);
}
