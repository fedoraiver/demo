use super::super::test_support::{drain_sounds, menu_app as test_app, request};
use super::*;
use crate::audio::AudioPreview;
use crate::game_flow::{AppState, PlayState};
use bevy::window::PrimaryWindow;
use std::path::PathBuf;
#[test]
fn volume_drag_coalesces_final_value_and_confirms_only_changed_release() {
    let mut app = test_app();
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
    drain_sounds(&mut app);

    request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 61));
    request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 42));
    assert!(drain_sounds(&mut app).is_empty());
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        42
    );
    assert_eq!(
        app.world().resource::<GameSettings>().audio.master_volume,
        100
    );
    request(&mut app, UiAction::FinishVolumeEdit);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    request(&mut app, UiAction::FinishVolumeEdit);
    assert!(drain_sounds(&mut app).is_empty());

    // 最后一帧坐标和释放同时到达仍应用最终值，只反馈一次。
    for action in [
        UiAction::SetVolume(SettingKey::SfxVolume, 70),
        UiAction::SetVolume(SettingKey::SfxVolume, 33),
        UiAction::FinishVolumeEdit,
    ] {
        app.world_mut().write_message(UiRequest(action));
    }
    app.update();
    assert_eq!(app.world().resource::<SettingsDraft>().audio.sfx_volume, 33);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);

    // 拖回初值没有净变化；无效字段不能通过滑条入口修改相机或帧率。
    request(&mut app, UiAction::SetVolume(SettingKey::UiVolume, 20));
    request(&mut app, UiAction::SetVolume(SettingKey::UiVolume, 100));
    request(&mut app, UiAction::FinishVolumeEdit);
    request(&mut app, UiAction::SetVolume(SettingKey::FrameRate, 70));
    assert!(drain_sounds(&mut app).is_empty());
    assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 60);

    request(&mut app, UiAction::Back);
    drain_sounds(&mut app);
    request(&mut app, UiAction::FinishVolumeEdit);
    assert!(drain_sounds(&mut app).is_empty());
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        100
    );
}

#[test]
fn enhanced_input_adjusts_focused_volume_without_rebuilding_or_repeating() {
    let mut app = test_app();
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
    drain_sounds(&mut app);
    let (slider, index) = app
        .world_mut()
        .query::<(Entity, &MenuButton)>()
        .iter(app.world())
        .find_map(|(entity, button)| {
            (button.action == UiAction::Adjust(SettingKey::MasterVolume, 0))
                .then_some((entity, button.index))
        })
        .unwrap();
    app.world_mut().resource_mut::<MenuFocus>().0 = index;
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::ArrowLeft);
    app.update();
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        95
    );
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    assert!(app.world().get::<MenuButton>(slider).is_some());
    for _ in 0..3 {
        app.update();
    }
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        95
    );
    assert!(drain_sounds(&mut app).is_empty());
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .release(KeyCode::ArrowLeft);
    app.update();
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::ArrowRight);
    app.update();
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        100
    );
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .release(KeyCode::ArrowRight);
    app.update();
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::ArrowRight);
    app.update();
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        100
    );
    assert!(
        drain_sounds(&mut app).is_empty(),
        "A boundary press is silent"
    );
}

#[test]
fn queued_drag_never_swallows_back_and_no_op_confirm_keeps_gesture() {
    let mut app = test_app();
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
    request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 80));
    drain_sounds(&mut app);
    request(&mut app, UiAction::Adjust(SettingKey::MasterVolume, 0));
    assert!(drain_sounds(&mut app).is_empty());
    request(&mut app, UiAction::FinishVolumeEdit);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 70));
    // 上一帧鼠标采样已排队，本帧 Esc 必须立即接受并取消整个草稿。
    app.world_mut()
        .write_message(UiRequest(UiAction::SetVolume(SettingKey::MasterVolume, 60)));
    app.world_mut().write_message(UiRequest(UiAction::Back));
    app.update();
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Main);
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        100
    );
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
    request(&mut app, UiAction::FinishVolumeEdit);
    assert!(drain_sounds(&mut app).is_empty());
}

#[test]
fn audio_apply_cancel_defaults_and_failed_save_preserve_committed_values() {
    let mut app = test_app();
    assert_eq!(app.world().resource::<AudioPreview>().0, None);
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tmp/ui-settings-tests");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{}.json", uuid::Uuid::new_v4()));
    app.insert_resource(SettingsFile(path.clone()));
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
    request(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 73));
    request(&mut app, UiAction::SetVolume(SettingKey::SfxVolume, 0));
    request(&mut app, UiAction::SetVolume(SettingKey::UiVolume, 49));
    request(&mut app, UiAction::SelectTab(SettingsTab::Controls));
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        73
    );
    assert_eq!(
        app.world().resource::<GameSettings>().audio.master_volume,
        100
    );
    assert_eq!(
        app.world().resource::<AudioPreview>().0,
        Some(app.world().resource::<SettingsDraft>().audio)
    );
    request(&mut app, UiAction::ApplySettings);
    let committed = app.world().resource::<GameSettings>().audio;
    assert_eq!(committed.master_volume, 73);
    assert_eq!(committed.sfx_volume, 0);
    assert_eq!(committed.ui_volume, 49);
    assert_eq!(GameSettings::load(&path).audio, committed);
    assert_eq!(app.world().resource::<AudioPreview>().0, Some(committed));
    let saved = std::fs::read_to_string(&path).unwrap();

    request(&mut app, UiAction::RestoreDefaults);
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        100
    );
    assert_eq!(app.world().resource::<GameSettings>().audio, committed);
    assert_eq!(
        app.world().resource::<AudioPreview>().0,
        Some(crate::settings::AudioSettings::default())
    );
    request(&mut app, UiAction::Back);
    assert_eq!(app.world().resource::<SettingsDraft>().audio, committed);
    assert_eq!(app.world().resource::<AudioPreview>().0, None);
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
    request(&mut app, UiAction::Adjust(SettingKey::MasterVolume, -1));
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        68
    );
    // 保存目标改为实际目录，触发可复现的 I/O 失败而不触及用户配置。
    app.insert_resource(SettingsFile(directory));
    request(&mut app, UiAction::ApplySettings);
    assert_eq!(app.world().resource::<GameSettings>().audio, committed);
    assert_eq!(
        app.world().resource::<SettingsDraft>().audio.master_volume,
        68
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
    assert_eq!(
        app.world().resource::<AudioPreview>().0,
        Some(app.world().resource::<SettingsDraft>().audio)
    );
    assert!(
        app.world()
            .resource::<MenuState>()
            .status
            .as_ref()
            .unwrap()
            .starts_with("Could not save")
    );
    request(&mut app, UiAction::Back);
    assert_eq!(app.world().resource::<SettingsDraft>().audio, committed);
    assert_eq!(app.world().resource::<AudioPreview>().0, None);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn sfx_sample_works_in_pause_without_changing_gameplay_or_settings() {
    let mut app = test_app();
    request(&mut app, UiAction::TestSfx);
    assert!(drain_sounds(&mut app).is_empty());
    request(&mut app, UiAction::StartGame);
    request(&mut app, UiAction::Back);
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::SelectTab(SettingsTab::Audio));
    drain_sounds(&mut app);
    let draft = app.world().resource::<SettingsDraft>().clone();
    // 同帧重复试听也只产生一个素材请求，来源是菜单而非角色或包裹。
    app.world_mut().write_message(UiRequest(UiAction::TestSfx));
    app.world_mut().write_message(UiRequest(UiAction::TestSfx));
    app.update();
    let samples: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<SoundRequest>>()
        .drain()
        .collect();
    assert_eq!(samples.len(), 1);
    assert_eq!(samples[0].cue, SoundCue::ParcelPickup);
    assert!(app.world().get::<MenuContext>(samples[0].source).is_some());
    assert_eq!(*app.world().resource::<SettingsDraft>(), draft);
    assert!(app.world().resource::<Time<Virtual>>().is_paused());
    assert_eq!(
        *app.world().resource::<State<PlayState>>().get(),
        PlayState::Paused
    );
    request(&mut app, UiAction::SelectTab(SettingsTab::Graphics));
    drain_sounds(&mut app);
    request(&mut app, UiAction::TestSfx);
    assert!(drain_sounds(&mut app).is_empty());
}

#[test]
fn menu_sounds_follow_accepted_requests_and_skip_no_ops() {
    let mut app = test_app();
    request(&mut app, UiAction::Back);
    request(&mut app, UiAction::ApplySettings);
    assert!(drain_sounds(&mut app).is_empty());

    // 同帧多种输入只消费首项，声音与最终接受的菜单动作对应。
    app.world_mut()
        .write_message(UiRequest(UiAction::OpenSettings));
    app.world_mut().write_message(UiRequest(UiAction::OpenHelp));
    app.update();
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    request(&mut app, UiAction::SelectTab(SettingsTab::Graphics));
    request(&mut app, UiAction::Adjust(SettingKey::FrameRate, -1));
    assert!(drain_sounds(&mut app).is_empty());
    request(&mut app, UiAction::SelectTab(SettingsTab::Controls));
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    request(&mut app, UiAction::Adjust(SettingKey::InvertY, 1));
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    request(&mut app, UiAction::RestoreDefaults);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    request(&mut app, UiAction::Back);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);

    request(&mut app, UiAction::StartGame);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    request(&mut app, UiAction::Back);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    assert!(app.world().resource::<Time<Virtual>>().is_paused());
    request(&mut app, UiAction::OpenHelp);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    // 帮助页只有返回按钮，导航不会切换目标，也不发出焦点音。
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::ArrowDown);
    app.update();
    assert!(drain_sounds(&mut app).is_empty());
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .release(KeyCode::ArrowDown);
    request(&mut app, UiAction::Back);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
    request(&mut app, UiAction::Resume);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
    request(&mut app, UiAction::Back);
    drain_sounds(&mut app);
    request(&mut app, UiAction::ReturnToMenu);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
}

#[test]
fn enhanced_input_emits_one_hover_or_confirm_per_press() {
    let mut app = test_app();
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::ArrowDown);
    app.update();
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuHover]);
    for _ in 0..3 {
        app.update();
        assert!(drain_sounds(&mut app).is_empty());
    }
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .release(KeyCode::ArrowDown);
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::Enter);
    app.update();
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    for _ in 0..3 {
        app.update();
        assert!(drain_sounds(&mut app).is_empty());
    }
    let window = app
        .world_mut()
        .query_filtered::<Entity, With<PrimaryWindow>>()
        .single(app.world())
        .unwrap();
    app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::ArrowDown);
    app.update();
    assert!(drain_sounds(&mut app).is_empty());
}

#[test]
fn simultaneous_settings_back_and_old_button_press_remain_paused() {
    let mut app = test_app();
    request(&mut app, UiAction::StartGame);
    request(&mut app, UiAction::Back);
    request(&mut app, UiAction::OpenSettings);
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Settings);
    let old_back = app
        .world_mut()
        .query::<(Entity, &MenuButton)>()
        .iter(app.world())
        .find_map(|(entity, button)| (button.action == UiAction::Back).then_some(entity))
        .unwrap();
    drain_sounds(&mut app);

    // 同一帧键盘返回与旧页按钮的点击并存；真实 Build 必须先清理旧按钮。
    *app.world_mut().get_mut::<Interaction>(old_back).unwrap() = Interaction::Pressed;
    app.world_mut().write_message(UiRequest(UiAction::Back));
    app.update();
    assert!(app.world().get_entity(old_back).is_err());
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
    assert_eq!(
        *app.world().resource::<State<PlayState>>().get(),
        PlayState::Paused
    );

    // 检查帧末后再推进一帧，防止残留 Back 在暂停页被解释为 Resume。
    app.update();
    assert!(drain_sounds(&mut app).is_empty());
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
    assert_eq!(
        *app.world().resource::<State<PlayState>>().get(),
        PlayState::Paused
    );
}

#[test]
fn settings_cancel_preserves_runtime_and_apply_commits_only_after_save() {
    let mut app = test_app();
    let path = PathBuf::from("tmp")
        .join("ui-settings-tests")
        .join(format!("{}.json", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    app.world_mut().insert_resource(SettingsFile(path.clone()));
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
    assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 90);
    assert_eq!(app.world().resource::<GameSettings>().max_fps.get(), 60);
    assert!(!path.exists());
    request(&mut app, UiAction::Back);
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Main);
    assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 60);
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
    drain_sounds(&mut app);
    request(&mut app, UiAction::ApplySettings);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuConfirm]);
    assert_eq!(app.world().resource::<GameSettings>().max_fps.get(), 90);
    assert_eq!(GameSettings::load(&path).max_fps.get(), 90);
    std::fs::remove_file(&path).unwrap();

    // 保存目标是目录时产生真实 I/O 失败，界面保留草稿而运行设置保持原值。
    app.world_mut()
        .insert_resource(SettingsFile(path.parent().unwrap().to_path_buf()));
    request(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
    drain_sounds(&mut app);
    request(&mut app, UiAction::ApplySettings);
    assert_eq!(drain_sounds(&mut app), [SoundCue::MenuCancel]);
    assert_eq!(app.world().resource::<GameSettings>().max_fps.get(), 90);
    assert_eq!(app.world().resource::<SettingsDraft>().max_fps, 120);
    assert!(
        app.world()
            .resource::<MenuState>()
            .status
            .as_ref()
            .unwrap()
            .starts_with("Could not save")
    );
}

#[test]
fn held_confirm_fires_once_and_navigation_stops_when_window_loses_focus() {
    let mut app = test_app();
    app.world_mut().resource_mut::<MenuFocus>().0 = 1;
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::Enter);
    app.update();
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Settings);
    for _ in 0..5 {
        app.update();
    }
    assert_eq!(
        app.world().resource::<MenuState>().return_page,
        MenuPage::Main
    );
    let original = app.world().resource::<MenuFocus>().0;
    let window = app
        .world_mut()
        .query_filtered::<Entity, With<PrimaryWindow>>()
        .single(app.world())
        .unwrap();
    app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::ArrowDown);
    app.update();
    assert_eq!(app.world().resource::<MenuFocus>().0, original);
}

#[test]
fn pause_help_and_settings_return_to_pause_without_replacing_session() {
    let mut app = test_app();
    request(&mut app, UiAction::StartGame);
    assert_eq!(
        *app.world().resource::<State<AppState>>().get(),
        AppState::InGame
    );
    request(&mut app, UiAction::Back);
    assert_eq!(
        *app.world().resource::<State<PlayState>>().get(),
        PlayState::Paused
    );
    request(&mut app, UiAction::OpenHelp);
    assert_eq!(
        app.world().resource::<MenuState>().return_page,
        MenuPage::Pause
    );
    request(&mut app, UiAction::Back);
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
    request(&mut app, UiAction::OpenSettings);
    request(&mut app, UiAction::Back);
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Pause);
    assert_eq!(
        *app.world().resource::<State<PlayState>>().get(),
        PlayState::Paused
    );
    request(&mut app, UiAction::Resume);
    assert_eq!(app.world().resource::<MenuState>().page, MenuPage::Hidden);
    assert_eq!(
        *app.world().resource::<State<PlayState>>().get(),
        PlayState::Running
    );
}
