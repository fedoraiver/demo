use bevy::{
    log::{
        tracing::{self, Level},
        tracing_subscriber::{self, fmt::MakeWriter},
    },
    reflect::{
        TypeRegistry,
        serde::{TypedReflectDeserializer, TypedReflectSerializer},
    },
};
use serde::de::DeserializeSeed;
use serde_json::{Value, json};
use std::{
    any::TypeId,
    sync::{Arc, Mutex},
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
    assert_eq!(draft.to_settings().unwrap().camera.mouse_sensitivity, 0.03);
    draft.adjust(SettingKey::FrameRate, 0);
    assert_eq!(draft.max_fps, 75);
    assert_eq!(draft.to_settings().unwrap().camera.mouse_sensitivity, 0.03);

    draft.adjust(SettingKey::FrameRate, 1);
    assert_eq!(draft.max_fps, 90);
    draft.adjust(SettingKey::FrameRate, -1);
    assert_eq!(draft.max_fps, 60);
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
fn sensitivity_percentage_preserves_custom_values_and_validates_input() {
    for sensitivity in [
        f32::from_bits(1),
        f32::MIN_POSITIVE,
        0.00001234567,
        0.003,
        0.0041,
        0.03,
        1000.0,
        f32::MAX,
    ] {
        let mut settings = GameSettings::default();
        settings.camera.mouse_sensitivity = sensitivity;
        let draft = SettingsDraft::from_settings(&settings);
        assert_eq!(
            draft.to_settings().unwrap().camera.mouse_sensitivity,
            sensitivity
        );
    }
    let mut draft = SettingsDraft::default();
    for invalid in ["", ".", "-1", "0", "NaN", "inf", "1e100", "1e-100", "1.2.3"] {
        draft.mouse_sensitivity_percent = invalid.into();
        assert!(draft.to_settings().is_err(), "{invalid}");
    }
    for (input, expected) in [("123.45", 0.0037035), ("1000", 0.03), ("1e2", 0.003)] {
        draft.mouse_sensitivity_percent = input.into();
        assert!((draft.to_settings().unwrap().camera.mouse_sensitivity - expected).abs() < 1e-8);
    }
    draft.mouse_sensitivity_percent = "123.45".into();
    assert_eq!(
        SettingsDraft::from_settings(&draft.to_settings().unwrap()).mouse_sensitivity_percent,
        "123.45"
    );
}
