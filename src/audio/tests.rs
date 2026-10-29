use super::*;
use super::{
    manifest::{Manifest, PlaybackPolicy},
    mix::volume_decibels,
    playback::{LoadedSound, allow_request},
};
use crate::settings::GameSettings;
use bevy_kira_audio::{
    AudioChannel, AudioControl, AudioInstance, AudioSource, PlaybackState, prelude::Decibels,
};

#[test]
fn shipped_manifest_maps_all_cues_once() {
    let manifest = Manifest::parse(MANIFEST).unwrap();
    for asset in manifest.assets {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join(asset.path);
        assert!(path.is_file(), "Missing audio asset: {}", path.display());
    }
}

#[test]
fn playback_limits_cover_same_frame_cooldown_and_global_cap() {
    let policy = PlaybackPolicy {
        volume: 0.7,
        cooldown_seconds: 0.2,
        max_instances: 2,
        looped: false,
    };
    assert!(allow_request(&policy, 1.0, None, 0, 0));
    assert!(!allow_request(&policy, 1.1, Some(1.0), 1, 1));
    assert!(!allow_request(&policy, 1.0, None, 2, 2));
    assert!(!allow_request(&policy, 1.0, None, 0, MAX_VOICES));
    assert!(allow_request(&policy, 1.3, Some(1.0), 1, 1));
}

#[test]
fn audio_mix_preserves_asset_balance_and_controls_categories_independently() {
    let mut mix = AudioMix::default();
    assert_eq!(mix.gain(true), MASTER_GAIN);
    assert_eq!(mix.gain(false), MASTER_GAIN);
    for asset_volume in [0.2, 0.5, 1.0] {
        let decibels = volume_decibels(mix.gain(true), asset_volume);
        assert!((f64::from(decibels.as_amplitude()) - MASTER_GAIN * asset_volume).abs() < 1e-6);
    }
    mix.settings.sfx_volume = 20;
    assert_eq!(mix.gain(true), MASTER_GAIN);
    assert_eq!(mix.gain(false), 0.05);
    mix.settings.ui_volume = 60;
    mix.settings.master_volume = 50;
    assert_eq!(mix.gain(true), 0.075);
    assert_eq!(mix.gain(false), 0.025);
    mix.settings.master_volume = 0;
    for ui in [true, false] {
        let silent = volume_decibels(mix.gain(ui), 1.0);
        assert_eq!(silent, Decibels::SILENCE);
        assert!(silent.0.is_finite());
        assert_eq!(silent.as_amplitude(), 0.0);
    }
}

#[test]
fn preview_overrides_saved_mix_and_clearing_uses_latest_applied_values() {
    let mut app = queued_test_app();
    let saved = AudioSettings {
        master_volume: 40,
        sfx_volume: 60,
        ui_volume: 80,
    };
    let preview = AudioSettings {
        master_volume: 75,
        sfx_volume: 20,
        ui_volume: 50,
    };
    app.world_mut().resource_mut::<GameSettings>().audio = saved;
    app.world_mut().resource_mut::<AudioPreview>().settings = Some(preview);
    app.update();
    assert_eq!(app.world().resource::<AudioMix>().settings, preview);
    assert_eq!(app.world().resource::<GameSettings>().audio, saved);
    app.update();
    assert_eq!(app.world().resource::<AudioMix>().settings, preview);
    app.world_mut().resource_mut::<AudioPreview>().settings = None;
    app.update();
    assert_eq!(app.world().resource::<AudioMix>().settings, saved);
    assert!(!app.world().resource::<AudioMix>().preview);
    app.world_mut().resource_mut::<GameSettings>().audio = preview;
    app.world_mut().resource_mut::<AudioPreview>().settings = Some(AudioSettings {
        master_volume: 5,
        ..preview
    });
    app.update();
    assert_eq!(app.world().resource::<AudioMix>().settings.master_volume, 5);
    app.world_mut().resource_mut::<AudioPreview>().settings = None;
    app.update();
    assert_eq!(app.world().resource::<AudioMix>().settings, preview);
}

#[test]
fn muted_requests_are_discarded_without_cooldown_and_unmute_does_not_replay() {
    for muted_ui in [true, false] {
        let mut app = queued_test_app();
        let source = app.world_mut().spawn_empty().id();
        let muted_cue = if muted_ui {
            SoundCue::MenuConfirm
        } else {
            SoundCue::ParcelPickup
        };
        let audible_cue = if muted_ui {
            SoundCue::ParcelPickup
        } else {
            SoundCue::MenuConfirm
        };
        let mut settings = app.world_mut().resource_mut::<GameSettings>();
        if muted_ui {
            settings.audio.ui_volume = 0;
        } else {
            settings.audio.sfx_volume = 0;
        }
        app.world_mut()
            .write_message(SoundRequest::new(muted_cue, source));
        app.world_mut()
            .write_message(SoundRequest::new(audible_cue, source));
        app.update();
        let bank = app.world().resource::<SoundBank>();
        assert_eq!(bank.voices.len(), 1);
        assert_eq!(bank.voices[0].cue, audible_cue);
        assert!(!bank.last_played.contains_key(&muted_cue));
        app.world_mut().resource_mut::<GameSettings>().audio = AudioSettings::default();
        app.update();
        assert_eq!(app.world().resource::<SoundBank>().voices.len(), 1);
        app.world_mut()
            .write_message(SoundRequest::new(muted_cue, source));
        app.update();
        assert_eq!(app.world().resource::<SoundBank>().voices.len(), 2);
    }
    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    app.world_mut()
        .resource_mut::<GameSettings>()
        .audio
        .master_volume = 0;
    for cue in [SoundCue::MenuConfirm, SoundCue::ParcelPickup] {
        app.world_mut()
            .write_message(SoundRequest::new(cue, source));
    }
    app.update();
    assert!(app.world().resource::<SoundBank>().voices.is_empty());
    assert!(app.world().resource::<SoundBank>().last_played.is_empty());
    app.world_mut()
        .resource_mut::<GameSettings>()
        .audio
        .master_volume = 100;
    app.update();
    assert!(app.world().resource::<SoundBank>().voices.is_empty());
}

/// 默认通道只排队而不会初始化设备；实际执行播放系统验证 Queued 的跨帧限额。
#[test]
fn queued_requests_obey_limits_without_audio_device() {
    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    for cue in SoundCue::ALL.into_iter().take(5) {
        app.world_mut()
            .write_message(SoundRequest::new(cue, source));
    }
    app.update();
    assert_eq!(app.world().resource::<SoundBank>().voices.len(), MAX_VOICES);
    app.world_mut()
        .resource_mut::<Time<Real>>()
        .advance_by(std::time::Duration::from_secs(2));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::ParcelHandoff, source));
    app.update();
    let bank = app.world().resource::<SoundBank>();
    assert_eq!(bank.voices.len(), MAX_VOICES);
    assert!(!bank.last_played.contains_key(&SoundCue::ParcelHandoff));
    for voice in &bank.voices {
        let state = if voice.ui {
            app.world()
                .resource::<AudioChannel<UiTrack>>()
                .state(&voice.handle)
        } else {
            app.world()
                .resource::<AudioChannel<SfxTrack>>()
                .state(&voice.handle)
        };
        assert_eq!(state, PlaybackState::Queued);
    }
}

fn queued_test_app() -> App {
    let mut app = App::new();
    app.init_resource::<Time<Real>>()
        .init_resource::<Assets<AudioSource>>()
        .init_resource::<Assets<AudioInstance>>()
        .init_resource::<GameSettings>()
        .init_resource::<AudioMix>()
        .init_resource::<AudioPreview>()
        .init_resource::<AudioChannel<UiTrack>>()
        .init_resource::<AudioChannel<SfxTrack>>()
        .init_resource::<SoundBank>()
        .add_message::<SoundRequest>()
        .add_systems(
            Update,
            (sync_audio_mix, sync_voice_volumes, play_requests).chain(),
        );
    let manifest = Manifest::parse(MANIFEST).unwrap();
    for cue in SoundCue::ALL {
        let asset = manifest
            .assets
            .iter()
            .find(|asset| asset.event_ids.iter().any(|id| id == cue.id()))
            .unwrap();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join(&asset.path);
        let sound = bevy_kira_audio::prelude::StaticSoundData::from_file(path).unwrap();
        let handle = app
            .world_mut()
            .resource_mut::<Assets<AudioSource>>()
            .add(AudioSource { sound });
        app.world_mut().resource_mut::<SoundBank>().sounds.insert(
            cue,
            LoadedSound {
                handle,
                policy: asset.playback.clone(),
                ui: asset.category == "ui",
            },
        );
    }
    app
}

#[test]
fn gameplay_queue_reserves_menu_feedback_and_keeps_global_cap() {
    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    for cue in [
        SoundCue::ParcelPickup,
        SoundCue::ParcelRelease,
        SoundCue::ParcelHandoff,
        SoundCue::ParcelLand,
    ] {
        app.world_mut()
            .write_message(SoundRequest::new(cue, source));
    }
    app.update();
    let bank = app.world().resource::<SoundBank>();
    assert_eq!(bank.voices.len(), MAX_VOICES - RESERVED_UI_VOICES);
    assert!(bank.voices.iter().all(|voice| !voice.ui));
    assert!(!bank.last_played.contains_key(&SoundCue::ParcelLand));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    let bank = app.world().resource::<SoundBank>();
    assert_eq!(bank.voices.len(), MAX_VOICES);
    let menu = bank.voices.iter().find(|voice| voice.ui).unwrap();
    assert_eq!(menu.cue, SoundCue::MenuConfirm);
    assert_eq!(
        app.world()
            .resource::<AudioChannel<UiTrack>>()
            .state(&menu.handle),
        PlaybackState::Queued
    );
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuCancel, source));
    app.update();
    assert_eq!(app.world().resource::<SoundBank>().voices.len(), MAX_VOICES);
    assert!(
        !app.world()
            .resource::<SoundBank>()
            .last_played
            .contains_key(&SoundCue::MenuCancel)
    );
}

#[test]
fn menu_cooldown_uses_real_time_while_virtual_time_is_paused() {
    use bevy::time::{TimePlugin, TimeUpdateStrategy};
    use std::time::Duration;

    let mut app = queued_test_app();
    app.add_plugins(TimePlugin)
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
    app.update();
    app.world_mut().resource_mut::<Time<Virtual>>().pause();
    let source = app.world_mut().spawn_empty().id();
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    let paused_at = app.world().resource::<Time>().elapsed();
    assert_eq!(app.world().resource::<SoundBank>().voices.len(), 1);

    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
        20,
    )));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    assert_eq!(app.world().resource::<SoundBank>().voices.len(), 1);

    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
        80,
    )));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    assert_eq!(app.world().resource::<Time>().elapsed(), paused_at);
    assert!(app.world().resource::<Time<Real>>().elapsed() > paused_at);
    let bank = app.world().resource::<SoundBank>();
    assert_eq!(bank.voices.len(), 2);
    assert!(bank.voices.iter().all(|voice| voice.ui));

    // Queued 实例也受单事件上限约束，即使冷却已结束仍不增加第三条。
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs(1)));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    assert_eq!(app.world().resource::<SoundBank>().voices.len(), 2);
}

#[test]
fn unloaded_menu_cue_is_discarded_instead_of_replayed_after_loading() {
    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    let handle = app.world().resource::<SoundBank>().sounds[&SoundCue::MenuConfirm]
        .handle
        .clone();
    let sound = app
        .world_mut()
        .resource_mut::<Assets<AudioSource>>()
        .remove(handle.id())
        .unwrap();
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    assert!(app.world().resource::<SoundBank>().voices.is_empty());
    app.world_mut()
        .resource_mut::<Assets<AudioSource>>()
        .insert(handle.id(), sound)
        .unwrap();
    app.update();
    assert!(app.world().resource::<SoundBank>().voices.is_empty());
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    assert_eq!(app.world().resource::<SoundBank>().voices.len(), 1);
}

#[test]
fn kira_decodes_every_shipped_file_without_opening_device() {
    let manifest = Manifest::parse(MANIFEST).unwrap();
    for asset in manifest.assets {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join(asset.path);
        bevy_kira_audio::prelude::StaticSoundData::from_file(&path)
            .unwrap_or_else(|error| panic!("Failed to decode {}: {error}", path.display()));
    }
}
