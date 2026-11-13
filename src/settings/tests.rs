use bevy::{
    time::{TimePlugin, TimeUpdateStrategy},
    winit::{UpdateMode, WinitSettings},
};
use uuid::Uuid;

use super::config::{
    native_settings_app, parse_settings, read_settings, validate_loaded_settings_from,
};
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
    directory.join(format!("{}.toml", Uuid::new_v4()))
}

#[test]
fn native_toml_defaults_partial_fields_and_custom_values() {
    assert_eq!(parse_settings("").unwrap(), GameSettings::default());
    for (contents, fps, sensitivity, invert_y, master, ui) in [
        ("[game]\nmax_fps = 75", 75, 0.003, false, 100, 100),
        ("[game.camera]\ninvert_y = true", 60, 0.003, true, 100, 100),
        (
            "[game.camera]\nmouse_sensitivity = 0.0",
            60,
            0.0,
            false,
            100,
            100,
        ),
        (
            "[game.camera]\nmouse_sensitivity = 0.01234567",
            60,
            0.01234567,
            false,
            100,
            100,
        ),
        ("[game.audio]\nui_volume = 0", 60, 0.003, false, 100, 0),
        (
            "[game.audio]\nmaster_volume = 73\nui_volume = 31",
            60,
            0.003,
            false,
            73,
            31,
        ),
    ] {
        let settings = parse_settings(contents).unwrap();
        assert_eq!(settings.max_fps.get(), fps);
        assert_eq!(settings.camera.mouse_sensitivity, sensitivity);
        assert_eq!(settings.camera.invert_y, invert_y);
        assert_eq!(settings.audio.master_volume, master);
        assert_eq!(settings.audio.ui_volume, ui);
    }
}

#[test]
fn invalid_native_file_falls_back_as_a_whole_without_overwriting() {
    let path = settings_test_path();
    for invalid in [
        "broken = [",
        "[game]\nmax_fps = 59",
        "[game]\nmax_fps = 0",
        "[game]\nmax_fps = -60",
        "[game]\nmax_fps = 60.5",
        "[game]\nmax_fps = \"120\"",
        "[game]\nmax_fps = 120\nmax_fps = 144",
        "[game]\nunknown = true",
        "[other]\nenabled = true",
        "[game.camera]\nsensitivity = 0.003",
        "[game.camera]\nmouse_sensitivity = 0.0301",
        "[game.camera]\nmouse_sensitivity = -0.003",
        "[game.camera]\nmouse_sensitivity = nan",
        "[game.camera]\nmouse_sensitivity = inf",
        "[game.camera]\nmouse_sensitivity = 1e39",
        "[game.camera]\ninvert_y = 1",
        "[game.audio]\nui_volume = 101",
        "[game.audio]\nui_volume = -1",
        "[game.audio]\nui_volume = 50.5",
        "[game.audio]\nsfx_volume = 50",
        "[game.audio]\nmaster_volume = 256",
    ] {
        fs::write(&path, invalid).unwrap();
        assert_eq!(
            read_settings(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidData,
            "{invalid}"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), invalid);
    }
    fs::remove_file(path).unwrap();
}

#[test]
fn save_creates_and_replaces_complete_native_settings() {
    let path = settings_test_path();
    GameSettings::default().save(&path).unwrap();
    let expected = SettingsDraft {
        max_fps: 165,
        mouse_sensitivity_text: "1.23".into(),
        invert_y: true,
        audio: AudioSettings {
            master_volume: 73,
            ui_volume: 31,
        },
        ..default()
    }
    .to_settings()
    .unwrap();
    expected.save(&path).unwrap();
    assert_eq!(read_settings(&path).unwrap(), expected);
    let saved = fs::read_to_string(&path).unwrap();
    let table: toml::Value = toml::from_str(&saved).unwrap();
    assert_eq!(table["game"]["max_fps"].as_integer(), Some(165));
    assert_eq!(table["game"]["audio"]["ui_volume"].as_integer(), Some(31));
    fs::remove_file(path).unwrap();
}

#[test]
fn invalid_settings_cannot_replace_existing_file() {
    let path = settings_test_path();
    let original = "[game]\nmax_fps = 90";
    fs::write(&path, original).unwrap();
    let mut invalid = GameSettings::default();
    invalid.max_fps = NonZeroU32::new(59).unwrap();
    assert_eq!(
        invalid.save(&path).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    invalid.max_fps = NonZeroU32::new(60).unwrap();
    for sensitivity in [
        MAX_MOUSE_SENSITIVITY + 0.0001,
        -0.003,
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
    ] {
        invalid.camera.mouse_sensitivity = sensitivity;
        assert_eq!(
            invalid.save(&path).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }
    invalid.camera = CameraSettings::default();
    invalid.audio.ui_volume = 101;
    assert_eq!(
        invalid.save(&path).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
}

#[cfg(windows)]
#[test]
fn failed_file_replacement_preserves_original_settings() {
    use std::os::windows::fs::OpenOptionsExt;
    let path = settings_test_path();
    let original = "[game]\nmax_fps = 144";
    fs::write(&path, original).unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let settings = GameSettings {
        max_fps: NonZeroU32::new(240).unwrap(),
        ..default()
    };
    assert!(settings.save(&path).is_err());
    drop(locked);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
}

#[test]
fn real_native_plugin_loads_custom_and_partial_groups_and_rejects_invalid_file() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tmp/settings-tests")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("settings.toml");
    let expected = SettingsDraft {
        max_fps: 75,
        mouse_sensitivity_text: "1.23".into(),
        invert_y: true,
        audio: AudioSettings {
            master_volume: 73,
            ui_volume: 31,
        },
        ..default()
    }
    .to_settings()
    .unwrap();
    expected.save(&path).unwrap();
    for contents in [
        fs::read_to_string(&path).unwrap(),
        String::new(),
        "[game]\nmax_fps = 120".into(),
        "[game.camera]\ninvert_y = true".into(),
        "[game.camera]\nmouse_sensitivity = 0.0".into(),
        format!("[game.camera]\nmouse_sensitivity = {MAX_MOUSE_SENSITIVITY}"),
        "[game.camera]\nmouse_sensitivity = 0.0301".into(),
        "[game.audio]\nui_volume = 31".into(),
        "[game]\nmax_fps = 59".into(),
    ] {
        fs::write(&path, &contents).unwrap();
        let expected = parse_settings(&contents).unwrap_or_default();
        let mut app = native_settings_app(&directory).unwrap();
        assert!(app.is_plugin_added::<bevy::settings::SettingsPlugin>());
        validate_loaded_settings_from(&mut app, SettingsFile { path: path.clone() });
        assert_eq!(
            app.world().resource::<GameSettings>(),
            &expected,
            "{contents}"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), contents);
    }
    fs::remove_file(&path).unwrap();
    let mut app = native_settings_app(&directory).unwrap();
    validate_loaded_settings_from(&mut app, SettingsFile { path: path.clone() });
    assert_eq!(
        app.world().resource::<GameSettings>(),
        &GameSettings::default()
    );
    assert!(!path.exists());
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
    fs::remove_dir(directory).unwrap();
}

#[test]
fn draft_preserves_unedited_sensitivity_precision_while_other_fields_change() {
    let custom =
        parse_settings("[game]\nmax_fps = 75\n[game.camera]\nmouse_sensitivity = 0.0037407")
            .unwrap();
    let mut draft = SettingsDraft::from_settings(&custom);
    assert_eq!(draft.mouse_sensitivity_text, "1.25");
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
    assert_eq!(draft.mouse_sensitivity_text, "1.25");
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        1.25 * DEFAULT_MOUSE_SENSITIVITY
    );

    let mut draft = SettingsDraft::from_settings(&custom);
    assert!(draft.set_sensitivity_multiplier(1.25));
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        1.25 * DEFAULT_MOUSE_SENSITIVITY
    );
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "1.26");
    assert_eq!(
        draft.to_settings().unwrap().camera.mouse_sensitivity,
        1.26 * DEFAULT_MOUSE_SENSITIVITY
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
    let custom: GameSettings =
        parse_settings("[game]\nmax_fps = 75\n[game.audio]\nmaster_volume = 73\nui_volume = 97")
            .unwrap();
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
            .add_plugins(GameSettingsPlugin);
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
        .add_plugins(GameSettingsPlugin);
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

#[test]
fn sensitivity_multiplier_validates_raw_text_before_quantizing_and_normalizing() {
    let mut draft = SettingsDraft::default();
    for (input, expected, normalized) in [
        ("0", 0.0, "0.00"),
        ("-0", 0.0, "0.00"),
        ("10", 10.0, "10.00"),
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
            expected * DEFAULT_MOUSE_SENSITIVITY
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
    for invalid in [-0.01, 10.001, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert!(!draft.set_sensitivity_multiplier(invalid));
        assert_eq!(draft.mouse_sensitivity_text, "1.23");
    }
}

#[test]
fn sensitivity_step_clamps_to_limits_and_replaces_invalid_text_from_default() {
    let mut draft = SettingsDraft::default();
    draft.set_sensitivity_multiplier(0.0);
    draft.adjust(SettingKey::MouseSensitivity, -1);
    assert_eq!(draft.mouse_sensitivity_text, "0.00");
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "0.01");
    draft.set_sensitivity_multiplier(10.0);
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "10.00");
    draft.adjust(SettingKey::MouseSensitivity, -1);
    assert_eq!(draft.mouse_sensitivity_text, "9.99");
    draft.set_sensitivity_text("1e".into());
    draft.adjust(SettingKey::MouseSensitivity, 0);
    assert_eq!(draft.mouse_sensitivity_text, "1e");
    draft.adjust(SettingKey::MouseSensitivity, 1);
    assert_eq!(draft.mouse_sensitivity_text, "1.01");
}

#[test]
fn native_sensitivity_zero_and_maximum_round_trip_and_custom_precision_is_preserved() {
    let path = settings_test_path();
    for sensitivity in [0.0, -0.0, MAX_MOUSE_SENSITIVITY, 0.0037407] {
        let mut settings = GameSettings::default();
        settings.camera.mouse_sensitivity = sensitivity;
        settings.save(&path).unwrap();
        assert_eq!(read_settings(&path).unwrap(), settings);
        let saved = fs::read_to_string(&path).unwrap();
        let table: toml::Value = toml::from_str(&saved).unwrap();
        assert_eq!(
            table["game"]["camera"]["mouse_sensitivity"]
                .as_float()
                .unwrap() as f32,
            sensitivity
        );
        let draft = SettingsDraft::from_settings(&settings);
        assert_eq!(
            draft.to_settings().unwrap().camera.mouse_sensitivity,
            sensitivity
        );
        if sensitivity == 0.0 {
            assert_eq!(draft.mouse_sensitivity_text, "0.00");
        } else if sensitivity == MAX_MOUSE_SENSITIVITY {
            assert_eq!(draft.mouse_sensitivity_text, "10.00");
        }
    }
    fs::remove_file(path).unwrap();
}
