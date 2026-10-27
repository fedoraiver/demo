use bevy::{
    time::{TimePlugin, TimeUpdateStrategy},
    winit::{UpdateMode, WinitSettings},
};
use uuid::Uuid;

use super::config::read_settings;
use super::*;
use std::{
    fs, io,
    num::NonZeroU32,
    path::{Path, PathBuf},
    time::Duration,
};

fn settings_test_path() -> PathBuf {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("tmp/settings-tests");
    fs::create_dir_all(&directory).unwrap();
    directory.join(format!("{}.json", Uuid::new_v4()))
}

#[test]
fn defaults_and_json_validate_frame_rate_limit() {
    assert_eq!(GameSettings::default().max_fps.get(), 60);
    let omitted: GameSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(omitted.max_fps.get(), 60);
    for max_fps in [60, 120, 144] {
        let json = format!(r#"{{"max_fps": {max_fps}}}"#);
        let custom: GameSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(custom.max_fps.get(), max_fps);
    }
    for invalid in [
        r#"{"max_fps": 0}"#,
        r#"{"max_fps": 1}"#,
        r#"{"max_fps": 30}"#,
        r#"{"max_fps": 59}"#,
        r#"{"max_fps": -60}"#,
        r#"{"max_fps": 60.5}"#,
        r#"{"max_fps": "120"}"#,
        r#"{"max_fp": 120}"#,
    ] {
        assert!(serde_json::from_str::<GameSettings>(invalid).is_err());
    }
}

#[test]
fn camera_settings_default_legacy_and_custom_values() {
    let defaults = GameSettings::default();
    assert_eq!(defaults.camera.mouse_sensitivity, 0.003);
    assert!(!defaults.camera.invert_y);
    for legacy in ["{}", r#"{"max_fps": 144}"#, r#"{"camera": {}}"#] {
        let settings: GameSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(settings.camera.mouse_sensitivity, 0.003);
        assert!(!settings.camera.invert_y);
    }
    let custom: GameSettings =
        serde_json::from_str(r#"{"camera": {"mouse_sensitivity": 0.006, "invert_y": true}}"#)
            .unwrap();
    assert_eq!(custom.camera.mouse_sensitivity, 0.006);
    assert!(custom.camera.invert_y);
    let partial: GameSettings = serde_json::from_str(r#"{"camera": {"invert_y": true}}"#).unwrap();
    assert_eq!(partial.camera.mouse_sensitivity, 0.003);
    assert!(partial.camera.invert_y);
}

#[test]
fn audio_settings_support_legacy_partial_and_custom_files() {
    assert_eq!(GameSettings::default().audio, AudioSettings::default());
    for legacy in [
        "{}",
        r#"{"max_fps": 144, "camera": {"invert_y": true}}"#,
        r#"{"audio": {}}"#,
    ] {
        let settings: GameSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(settings.audio, AudioSettings::default());
    }
    let partial: GameSettings = serde_json::from_str(r#"{"audio": {"ui_volume": 0}}"#).unwrap();
    assert_eq!(partial.audio.master_volume, 100);
    assert_eq!(partial.audio.sfx_volume, 100);
    assert_eq!(partial.audio.ui_volume, 0);
    let custom: GameSettings = serde_json::from_str(
        r#"{"audio": {"master_volume": 73, "sfx_volume": 0, "ui_volume": 100}}"#,
    )
    .unwrap();
    assert_eq!(SettingsDraft::from_settings(&custom).audio, custom.audio);
    assert_eq!(custom.audio.master_volume, 73);
    assert_eq!(custom.audio.sfx_volume, 0);
    assert_eq!(custom.audio.ui_volume, 100);
}

#[test]
fn invalid_audio_settings_fall_back_and_never_replace_existing_file() {
    let path = settings_test_path();
    for field in ["master_volume", "sfx_volume", "ui_volume"] {
        for value in ["101", "255", "256", "-1", "50.5", "null", "true", "\"NaN\""] {
            let json = format!(r#"{{"max_fps": 144, "audio": {{"{field}": {value}}}}}"#);
            assert!(serde_json::from_str::<GameSettings>(&json).is_err());
            fs::write(&path, &json).unwrap();
            let fallback = GameSettings::load(&path);
            assert_eq!(fallback.max_fps.get(), 60);
            assert_eq!(fallback.audio, AudioSettings::default());
            assert_eq!(fs::read_to_string(&path).unwrap(), json);
        }
    }
    assert!(serde_json::from_str::<GameSettings>(r#"{"audio": {"music_volume": 50}}"#).is_err());
    let original = r#"{"audio": {"master_volume": 75}}"#;
    fs::write(&path, original).unwrap();
    for audio in [
        AudioSettings {
            master_volume: 101,
            ..default()
        },
        AudioSettings {
            sfx_volume: 101,
            ..default()
        },
        AudioSettings {
            ui_volume: 101,
            ..default()
        },
    ] {
        let draft = SettingsDraft { audio, ..default() };
        assert!(draft.to_settings().is_err());
        let settings = GameSettings { audio, ..default() };
        assert_eq!(
            settings.save(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }
    fs::remove_file(path).unwrap();
}

#[test]
fn invalid_camera_settings_fall_back_without_overwriting_file() {
    let path = settings_test_path();
    for invalid in [
        r#"{"max_fps": 240, "camera": {"mouse_sensitivity": 0}}"#,
        r#"{"max_fps": 240, "camera": {"mouse_sensitivity": -0.003}}"#,
        r#"{"max_fps": 240, "camera": {"mouse_sensitivity": 1e39}}"#,
        r#"{"max_fps": 240, "camera": {"mouse_sensitivity": "NaN"}}"#,
        r#"{"max_fps": 240, "camera": {"invert_y": 1}}"#,
        r#"{"max_fps": 240, "camera": {"sensitivity": 0.003}}"#,
    ] {
        assert!(serde_json::from_str::<GameSettings>(invalid).is_err());
        fs::write(&path, invalid).unwrap();
        let settings = GameSettings::load(&path);
        assert_eq!(settings.max_fps.get(), 60);
        assert_eq!(settings.camera.mouse_sensitivity, 0.003);
        assert!(!settings.camera.invert_y);
        assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
    }
    fs::remove_file(path).unwrap();
}

#[test]
fn settings_file_and_failure_fallback_preserve_original_contents() {
    let path = settings_test_path();
    assert_eq!(GameSettings::load(&path).max_fps.get(), 60);
    assert!(!path.exists());
    fs::write(&path, r#"{"max_fps": 240}"#).unwrap();
    assert_eq!(GameSettings::load(&path).max_fps.get(), 240);
    for invalid in [
        r#"{"max_fps": 0}"#,
        r#"{"max_fps": 1}"#,
        r#"{"max_fps": 30}"#,
        r#"{"max_fps": 59}"#,
    ] {
        fs::write(&path, invalid).unwrap();
        assert_eq!(
            read_settings(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(GameSettings::load(&path).max_fps.get(), 60);
        assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
    }
    fs::remove_file(path).unwrap();
}

#[test]
fn save_creates_and_replaces_complete_settings_json() {
    let path = settings_test_path();
    GameSettings::default().save(&path).unwrap();
    let draft = SettingsDraft {
        max_fps: 165,
        mouse_sensitivity: 0.0065,
        invert_y: true,
        audio: AudioSettings {
            master_volume: 75,
            sfx_volume: 0,
            ui_volume: 33,
        },
    };
    draft.to_settings().unwrap().save(&path).unwrap();

    let loaded = GameSettings::load(&path);
    assert_eq!(loaded.max_fps.get(), 165);
    assert_eq!(loaded.camera.mouse_sensitivity, 0.0065);
    assert!(loaded.camera.invert_y);
    assert_eq!(loaded.audio, draft.audio);
    assert!(fs::read_to_string(&path).unwrap().ends_with('\n'));
    fs::remove_file(path).unwrap();
}

#[test]
fn invalid_settings_cannot_replace_existing_file() {
    let path = settings_test_path();
    let original = r#"{"max_fps": 90}"#;
    fs::write(&path, original).unwrap();
    let defaults = SettingsDraft::default();
    for invalid_fps in [0, 1, 59] {
        let invalid = SettingsDraft {
            max_fps: invalid_fps,
            ..defaults.clone()
        };
        assert_eq!(
            invalid.to_settings().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
    let mut settings = GameSettings::default();
    settings.max_fps = NonZeroU32::new(59).unwrap();
    assert!(settings.save(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    settings.max_fps = NonZeroU32::new(60).unwrap();
    for invalid_sensitivity in [0.0, -0.003, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let invalid = SettingsDraft {
            mouse_sensitivity: invalid_sensitivity,
            ..defaults.clone()
        };
        assert_eq!(
            invalid.to_settings().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        settings.camera.mouse_sensitivity = invalid_sensitivity;
        assert!(settings.save(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }
    fs::remove_file(path).unwrap();
}

#[cfg(windows)]
#[test]
fn failed_file_replacement_preserves_original_settings() {
    use std::os::windows::fs::OpenOptionsExt;

    let path = settings_test_path();
    let original = r#"{"max_fps": 144}"#;
    fs::write(&path, original).unwrap();
    // Windows 的独占句柄阻止替换，检验失败时不会先删除或截断原配置。
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let draft = SettingsDraft {
        max_fps: 240,
        ..default()
    };
    assert!(draft.to_settings().unwrap().save(&path).is_err());
    assert_eq!(draft.max_fps, 240);
    drop(locked);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
}

#[test]
fn draft_preserves_custom_values_until_their_field_is_adjusted() {
    let custom: GameSettings =
        serde_json::from_str(r#"{"max_fps": 75, "camera": {"mouse_sensitivity": 0.03}}"#).unwrap();
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
fn audio_draft_adjustments_preserve_custom_values_and_clamp_only_edited_field() {
    let custom: GameSettings = serde_json::from_str(
        r#"{"max_fps": 75, "audio": {"master_volume": 73, "sfx_volume": 3, "ui_volume": 97}}"#,
    )
    .unwrap();
    let mut draft = SettingsDraft::from_settings(&custom);
    assert_eq!(draft.to_settings().unwrap().audio, custom.audio);
    assert_eq!(draft.volume(SettingKey::FrameRate), None);
    assert!(!draft.set_volume(SettingKey::FrameRate, 20));
    draft.adjust(SettingKey::MasterVolume, 0);
    assert_eq!(draft.audio, custom.audio);
    draft.adjust(SettingKey::MasterVolume, 1);
    assert_eq!(draft.audio.master_volume, 78);
    assert_eq!(draft.audio.sfx_volume, 3);
    assert_eq!(draft.audio.ui_volume, 97);
    draft.adjust(SettingKey::SfxVolume, -1);
    assert_eq!(draft.audio.sfx_volume, 0);
    draft.adjust(SettingKey::UiVolume, 1);
    assert_eq!(draft.audio.ui_volume, 100);
    assert!(!draft.set_volume(SettingKey::UiVolume, 255));
    assert!(draft.set_volume(SettingKey::MasterVolume, 255));
    assert_eq!(draft.audio.master_volume, 100);
    for key in [
        SettingKey::MasterVolume,
        SettingKey::SfxVolume,
        SettingKey::UiVolume,
    ] {
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
                max_fps: NonZeroU32::new(fps).unwrap(),
                ..default()
            })
            .insert_resource(WinitSettings::continuous())
            .add_plugins(SettingsPlugin);
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
        .add_plugins(SettingsPlugin);
    app.update();
    let timestep = app.world().resource::<Time<Fixed>>().timestep();
    // 模拟菜单在 PreUpdate 应用配置，确认本帧结束时窗口循环已能读取新策略。
    app.add_systems(PreUpdate, |mut settings: ResMut<GameSettings>| {
        settings.max_fps = NonZeroU32::new(120).unwrap();
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
