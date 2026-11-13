use super::*;
use super::{
    manifest::{Manifest, PlaybackPolicy},
    mix::amplitude_volume,
    playback::{LoadedSound, Voice, allow_request},
};
use crate::settings::GameSettings;
use bevy_seedling::{
    firewheel::SymphoniumAudioF32,
    prelude::{AudioSample, SamplePlayer, SamplerPool, Volume, VolumeNode},
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
fn manifest_accepts_additional_categories_and_unregistered_assets() {
    let mut manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
    let mut asset = manifest["assets"][0].clone();
    asset["id"] = serde_json::json!("future_effect");
    asset["category"] = serde_json::json!("effects");
    asset["path"] = serde_json::json!("audio/effects/future_effect.ogg");
    asset["event_ids"] = serde_json::json!(["future_effect"]);
    manifest["assets"].as_array_mut().unwrap().push(asset);

    let parsed = Manifest::parse(&serde_json::to_string(&manifest).unwrap()).unwrap();
    assert!(
        parsed
            .assets
            .iter()
            .any(|asset| asset.id == "future_effect" && asset.category == "effects")
    );
}

#[test]
fn registered_events_require_their_declared_categories() {
    let mut manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
    manifest["assets"][0]["category"] = serde_json::json!("effects");
    manifest["assets"][0]["path"] = serde_json::json!("audio/effects/menu.ogg");
    assert!(Manifest::parse(&serde_json::to_string(&manifest).unwrap()).is_err());
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
fn audio_mix_preserves_asset_balance_and_multiplies_master_and_ui_volume() {
    let mut mix = AudioMix::default();
    assert_eq!(mix.gain(), MASTER_GAIN);
    for asset_volume in [0.2, 0.5, 1.0] {
        let actual = amplitude_volume(mix.gain()).amp() * amplitude_volume(asset_volume).amp();
        assert!((f64::from(actual) - MASTER_GAIN * asset_volume).abs() < 1e-6);
    }
    mix.settings.ui_volume = 60;
    mix.settings.master_volume = 50;
    assert_eq!(mix.gain(), 0.075);
    assert!((f64::from(amplitude_volume(mix.gain()).amp()) - 0.075).abs() < 1e-6);
    mix.settings.master_volume = 0;
    assert_eq!(mix.gain(), 0.0);
    assert_eq!(amplitude_volume(mix.gain()), Volume::SILENT);
    assert_eq!(amplitude_volume(mix.gain()).amp(), 0.0);
}

#[test]
fn preview_overrides_saved_mix_and_clearing_uses_latest_applied_values() {
    let mut app = queued_test_app();
    let saved = AudioSettings {
        master_volume: 40,
        ui_volume: 80,
    };
    let preview = AudioSettings {
        master_volume: 75,
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
    for muted in [
        AudioSettings {
            master_volume: 0,
            ..default()
        },
        AudioSettings {
            ui_volume: 0,
            ..default()
        },
    ] {
        let mut app = queued_test_app();
        let source = app.world_mut().spawn_empty().id();
        app.world_mut().resource_mut::<GameSettings>().audio = muted;
        for cue in SoundCue::ALL {
            app.world_mut()
                .write_message(SoundRequest::new(cue, source));
        }
        app.update();
        assert_eq!(voice_count(&mut app), 0);
        assert!(app.world().resource::<SoundBank>().last_played.is_empty());
        app.world_mut().resource_mut::<GameSettings>().audio = AudioSettings::default();
        app.update();
        assert_eq!(voice_count(&mut app), 0);
        app.world_mut()
            .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
        app.update();
        assert_eq!(voice_count(&mut app), 1);
    }
}

/// 夹具只装配采样实体，不初始化音频设备；排队声音也计入跨帧并发上限。
#[test]
fn queued_requests_obey_limits_without_audio_device() {
    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    for cue in SoundCue::ALL {
        app.world_mut()
            .write_message(SoundRequest::new(cue, source));
    }
    app.update();
    assert_eq!(voice_count(&mut app), 3);
    app.world_mut()
        .resource_mut::<Time<Real>>()
        .advance_by(std::time::Duration::from_secs(2));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    assert_eq!(voice_count(&mut app), MAX_VOICES);
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    assert_eq!(voice_count(&mut app), MAX_VOICES);
    let bank = app.world().resource::<SoundBank>();
    assert_eq!(bank.last_played[&SoundCue::MenuConfirm], 0.0);
    let world = app.world_mut();
    let mut players = world.query_filtered::<&SamplePlayer, With<Voice>>();
    assert_eq!(players.iter(world).count(), MAX_VOICES);
    for player in players.iter(world) {
        assert!(player.volume.amp() > 0.0);
    }
}

fn queued_test_app() -> App {
    let mut app = App::new();
    app.init_resource::<Time<Real>>()
        .init_resource::<Assets<AudioSample>>()
        .init_resource::<GameSettings>()
        .init_resource::<AudioMix>()
        .init_resource::<AudioPreview>()
        .init_resource::<SoundBank>()
        .add_message::<SoundRequest>()
        .add_message::<AppExit>()
        .add_systems(Startup, spawn_ui_pool)
        .add_systems(
            Update,
            (sync_audio_mix, sync_pool_volume, play_requests).chain(),
        );
    register_exit(&mut app);
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
        let sample = decode_sample(&path);
        let handle = app
            .world_mut()
            .resource_mut::<Assets<AudioSample>>()
            .add(sample);
        app.world_mut().resource_mut::<SoundBank>().sounds.insert(
            cue,
            LoadedSound {
                handle,
                policy: asset.playback.clone(),
            },
        );
    }
    app
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
    assert_eq!(voice_count(&mut app), 1);

    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
        20,
    )));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    assert_eq!(voice_count(&mut app), 1);

    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
        80,
    )));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    assert_eq!(app.world().resource::<Time>().elapsed(), paused_at);
    assert!(app.world().resource::<Time<Real>>().elapsed() > paused_at);
    assert_eq!(voice_count(&mut app), 2);

    // Queued 实例也受单事件上限约束，即使冷却已结束仍不增加第三条。
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs(1)));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuHover, source));
    app.update();
    assert_eq!(voice_count(&mut app), 2);
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
        .resource_mut::<Assets<AudioSample>>()
        .remove(handle.id())
        .unwrap();
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    assert_eq!(voice_count(&mut app), 0);
    app.world_mut()
        .resource_mut::<Assets<AudioSample>>()
        .insert(handle.id(), sound)
        .unwrap();
    app.update();
    assert_eq!(voice_count(&mut app), 0);
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    assert_eq!(voice_count(&mut app), 1);
}

#[test]
fn seedling_decodes_every_shipped_file_without_opening_device() {
    let manifest = Manifest::parse(MANIFEST).unwrap();
    for asset in manifest.assets {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("assets")
            .join(asset.path);
        let sample = decode_sample(&path);
        assert!(sample.get().len_frames() > 0);
    }
}

fn voice_count(app: &mut App) -> usize {
    let world = app.world_mut();
    world
        .query_filtered::<Entity, With<Voice>>()
        .iter(world)
        .count()
}

fn decode_sample(path: &std::path::Path) -> AudioSample {
    let probed = symphonium::probe_from_file(path, None).unwrap();
    let decoded = symphonium::decode_f32(probed, &Default::default(), None, None, None).unwrap();
    SymphoniumAudioF32(decoded).into()
}

#[test]
fn pool_volume_updates_queued_players_without_changing_asset_gain() {
    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    let asset_gain = app.world().resource::<SoundBank>().sounds[&SoundCue::MenuConfirm]
        .policy
        .volume;
    let (entity, original_volume) = {
        let world = app.world_mut();
        let mut query = world.query_filtered::<(Entity, &SamplePlayer), With<Voice>>();
        let (entity, player) = query.single(world).unwrap();
        (entity, player.volume)
    };
    assert!((f64::from(original_volume.amp()) - asset_gain).abs() < 1e-6);
    for settings in [
        AudioSettings {
            master_volume: 1,
            ui_volume: 1,
        },
        AudioSettings {
            master_volume: 50,
            ui_volume: 60,
        },
        AudioSettings {
            master_volume: 0,
            ui_volume: 100,
        },
        AudioSettings::default(),
    ] {
        app.world_mut().resource_mut::<AudioPreview>().settings = Some(settings);
        app.update();
        let expected = app.world().resource::<AudioMix>().gain();
        let world = app.world_mut();
        let mut query = world.query_filtered::<&VolumeNode, With<SamplerPool<UiPool>>>();
        let pool = query.single(world).unwrap();
        let actual = pool.volume.amp_clamped(pool.min_gain);
        assert_eq!(pool.smooth_seconds, 0.0);
        assert!((f64::from(actual) - expected).abs() < 1e-6);
        assert!((f64::from(actual * original_volume.amp()) - expected * asset_gain).abs() < 1e-6);
        assert_eq!(
            world.get::<SamplePlayer>(entity).unwrap().volume,
            original_volume
        );
    }
}

#[test]
fn despawned_voice_releases_limit_and_exit_cleans_up_players() {
    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    let entity = {
        let world = app.world_mut();
        world
            .query_filtered::<Entity, With<Voice>>()
            .single(world)
            .unwrap()
    };
    app.world_mut().despawn(entity);
    app.world_mut()
        .resource_mut::<Time<Real>>()
        .advance_by(std::time::Duration::from_secs(2));
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    assert_eq!(voice_count(&mut app), 1);
    app.world_mut().write_message(AppExit::Success);
    app.update();
    assert_eq!(voice_count(&mut app), 0);
}

#[test]
fn last_phase_exit_removes_voices_before_the_pool_runs() {
    use bevy::window::ExitSystems;

    #[derive(Resource, Default)]
    struct PoolObserved {
        ran: bool,
    }

    fn request_exit(mut exit: MessageWriter<AppExit>) {
        exit.write(AppExit::Success);
    }

    fn observe_pool(voices: Query<(), With<Voice>>, mut observed: ResMut<PoolObserved>) {
        assert!(voices.is_empty());
        observed.ran = true;
    }

    let mut app = queued_test_app();
    let source = app.world_mut().spawn_empty().id();
    app.world_mut()
        .write_message(SoundRequest::new(SoundCue::MenuConfirm, source));
    app.update();
    assert_eq!(voice_count(&mut app), 1);
    // 模拟窗口在 Last 才产生退出消息，复用生产注册检查销毁命令的可见性。
    app.init_resource::<PoolObserved>().add_systems(
        Last,
        (
            request_exit.in_set(ExitSystems),
            observe_pool.in_set(SeedlingSystems::Pool),
        ),
    );
    app.update();
    assert!(app.world().resource::<PoolObserved>().ran);
    assert_eq!(voice_count(&mut app), 0);
}

#[test]
fn parameter_changes_do_not_wait_for_the_audio_clock() {
    use bevy_seedling::{SeedlingCorePlugin, node::DiffTimer};

    #[derive(Component)]
    struct ObservedVolume;

    #[derive(Resource, Default)]
    struct DiffObserved {
        changed: bool,
    }

    fn observe_diff(
        timer: DiffTimer,
        volume: Single<Ref<VolumeNode>, With<ObservedVolume>>,
        mut observed: ResMut<DiffObserved>,
    ) {
        observed.changed = timer.should_diff(&*volume);
    }

    let mut app = App::new();
    app.add_plugins((MinimalPlugins, AssetPlugin::default(), SeedlingCorePlugin))
        .init_resource::<DiffObserved>()
        .add_systems(Update, observe_diff);
    configure_output_lifecycle(&mut app);
    let node = app
        .world_mut()
        .spawn((ObservedVolume, VolumeNode::default()))
        .id();
    app.finish();
    app.cleanup();
    app.update();
    let elapsed = app
        .world()
        .resource::<Time<bevy_seedling::time::Audio>>()
        .elapsed();
    app.world_mut().get_mut::<VolumeNode>(node).unwrap().volume = amplitude_volume(0.125);
    app.update();
    assert_eq!(
        app.world()
            .resource::<Time<bevy_seedling::time::Audio>>()
            .elapsed(),
        elapsed,
    );
    assert!(app.world().resource::<DiffObserved>().changed);
}

#[test]
fn unavailable_output_keeps_core_running_without_a_device() {
    use bevy_seedling::SeedlingCorePlugin;

    fn unavailable() -> Result {
        Err(StartStreamError::DefaultOutputDeviceNotFound.into())
    }

    fn must_wait_for_output() {
        panic!("audio work ran before a stream was initialized");
    }

    let mut app = App::new();
    app.add_plugins((MinimalPlugins, AssetPlugin::default(), SeedlingCorePlugin))
        .add_systems(PostStartup, unavailable)
        .add_systems(Last, must_wait_for_output.in_set(SeedlingSystems::Acquire));
    configure_output_lifecycle(&mut app);
    app.finish();
    app.cleanup();
    app.update();
    app.update();
    assert!(!app.world().contains_resource::<SampleRate>());
}

#[test]
fn output_error_handler_preserves_other_errors_default_policy() {
    fn unrelated_failure() -> Result {
        Err(std::io::Error::other("unrelated failure").into())
    }

    let mut app = App::new();
    configure_output_lifecycle(&mut app);
    app.add_systems(Update, unrelated_failure);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.update())).is_err());
}
