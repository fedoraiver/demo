//! Kira 播放端统一预加载、节流和限制并发；事件收集不依赖输出设备。

use std::collections::{HashMap, HashSet};

use bevy::{asset::AssetLoadFailedEvent, prelude::*};
use bevy_kira_audio::{
    AudioApp, AudioChannel, AudioControl, AudioInstance, AudioPlugin as KiraAudioPlugin,
    AudioSource, PlaybackState,
};
use bevy_kira_audio::{AudioSystemSet, AudioTween, prelude::Decibels};
use serde::Deserialize;

use crate::{
    audio_events::{SoundCue, SoundRequest},
    settings::{AudioSettings, GameSettings, SettingsDraft},
    ui::{MenuPage, MenuState},
};

const MANIFEST: &str = include_str!("../assets/audio/audio_manifest.json");
// 保留第一版混音余量；菜单百分比只能衰减，默认 100% 不改变现有听感。
const MASTER_GAIN: f64 = 0.25;
const MAX_VOICES: usize = 4;
// 为菜单保留一个名额，不打断已播放的声音；物理反馈不能占满全部短音并发。
const RESERVED_UI_VOICES: usize = 1;

/// 只在真正启动游戏时注册 Kira；测试可以只注册 SoundEventsPlugin。
pub(crate) struct GameAudioPlugin;

#[derive(Resource)]
struct UiTrack;
#[derive(Resource)]
struct SfxTrack;

impl Plugin for GameAudioPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(KiraAudioPlugin)
            .add_audio_channel::<UiTrack>()
            .add_audio_channel::<SfxTrack>()
            .init_resource::<SoundBank>()
            .init_resource::<AudioMix>()
            .add_systems(Startup, preload_sounds)
            .add_systems(
                Update,
                // 鼠标导航在 UI 更新中产生消息，播放需等本帧交互处理完再消费。
                (
                    log_load_failures,
                    sync_audio_mix,
                    sync_voice_volumes,
                    play_requests,
                    stop_on_exit,
                )
                    .chain()
                    .after(crate::ui::UiSystems::Style),
            )
            // Kira 在 PostUpdate 才把 Queued 句柄写入 Assets，当帧就绪后再次同步，避免旧增益多留一帧。
            .add_systems(
                PostUpdate,
                sync_voice_volumes.after(AudioSystemSet::PlayTypedChannels),
            );
    }
}

#[derive(Deserialize)]
struct Manifest {
    schema_version: u32,
    assets: Vec<ManifestAsset>,
}

#[derive(Deserialize)]
struct ManifestAsset {
    id: String,
    path: String,
    category: String,
    event_ids: Vec<String>,
    playback: PlaybackPolicy,
}

#[derive(Deserialize, Clone)]
struct PlaybackPolicy {
    volume: f64,
    cooldown_seconds: f64,
    max_instances: usize,
    looped: bool,
}

impl Manifest {
    /// 编译时嵌入清单，但仍检查契约；破损清单只禁用反馈，不改变玩法状态。
    fn parse(text: &str) -> Result<Self, String> {
        let manifest: Self = serde_json::from_str(text).map_err(|error| error.to_string())?;
        if manifest.schema_version != 1 {
            return Err("Unsupported audio manifest schema".into());
        }
        let mut ids = HashSet::new();
        for asset in &manifest.assets {
            if !ids.insert(&asset.id)
                || !asset
                    .path
                    .starts_with(&format!("audio/{}/", asset.category))
                || asset.path.contains("..")
                || !(asset.path.ends_with(".wav") || asset.path.ends_with(".ogg"))
                || !asset.playback.volume.is_finite()
                || !(0.0..=1.0).contains(&asset.playback.volume)
                || !asset.playback.cooldown_seconds.is_finite()
                || !(0.0..=10.0).contains(&asset.playback.cooldown_seconds)
                || !(1..=MAX_VOICES).contains(&asset.playback.max_instances)
            {
                return Err(format!("Invalid audio asset policy: {}", asset.id));
            }
        }
        for cue in SoundCue::ALL {
            let matches: Vec<_> = manifest
                .assets
                .iter()
                .filter(|asset| asset.event_ids.iter().any(|id| id == cue.id()))
                .collect();
            if matches.len() != 1
                || matches[0].playback.looped
                || !matches!(matches[0].category.as_str(), "ui" | "sfx")
            {
                return Err(format!("Invalid one-shot event mapping: {}", cue.id()));
            }
        }
        Ok(manifest)
    }
}

struct LoadedSound {
    handle: Handle<AudioSource>,
    policy: PlaybackPolicy,
    ui: bool,
}

struct Voice {
    cue: SoundCue,
    handle: Handle<AudioInstance>,
    ui: bool,
    // 排队实例尚未进入 Assets，等待句柄就绪后同步最新预览，避免沿用过时音量。
    applied_volume: Option<Decibels>,
}

/// 两条业务通道共用的有效混音源；离开设置页便回到最近成功应用的配置。
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq, Default)]
struct AudioMix {
    settings: AudioSettings,
    preview: bool,
}

impl AudioMix {
    fn gain(&self, ui: bool) -> f64 {
        let category = if ui {
            self.settings.ui_volume
        } else {
            self.settings.sfx_volume
        };
        MASTER_GAIN * f64::from(self.settings.master_volume) * f64::from(category) / 10_000.0
    }
}

/// Kira 的 SILENCE 有明确静音语义，避免把 log10(0) 产生的非有限值传给后端。
fn volume_decibels(gain: f64, asset_volume: f64) -> Decibels {
    let volume = gain * asset_volume;
    if volume <= 0.0 {
        Decibels::SILENCE
    } else {
        Decibels((20.0 * volume.log10()) as f32)
    }
}

fn sync_audio_mix(
    settings: Res<GameSettings>,
    draft: Option<Res<SettingsDraft>>,
    menu: Option<Res<MenuState>>,
    mut mix: ResMut<AudioMix>,
) {
    let preview = menu.is_some_and(|menu| menu.page == MenuPage::Settings);
    let desired = AudioMix {
        settings: if preview {
            draft.as_ref().map_or(settings.audio, |draft| draft.audio)
        } else {
            settings.audio
        },
        preview,
    };
    if *mix != desired {
        // 连续拖动由 UI 在放手时汇总；这里只记录预览启用或退出及正式配置变化。
        if !preview || !mix.preview {
            info!(
                master_volume_before = mix.settings.master_volume,
                master_volume_after = desired.settings.master_volume,
                sfx_volume_before = mix.settings.sfx_volume,
                sfx_volume_after = desired.settings.sfx_volume,
                ui_volume_before = mix.settings.ui_volume,
                ui_volume_after = desired.settings.ui_volume,
                reason = if preview {
                    "settings_preview"
                } else {
                    "applied_settings"
                },
                "Audio mix changed"
            );
        }
        *mix = desired;
    }
}

fn sync_voice_volumes(
    mix: Res<AudioMix>,
    mut bank: ResMut<SoundBank>,
    mut instances: ResMut<Assets<AudioInstance>>,
) {
    // Kira 0.26 的通道 set_volume 会覆盖每个实例的绝对音量，不能保持素材间响度。
    // 因此统一计算 UI/SFX 增益，再按每条声音的清单音量同步，覆盖正在播放和刚就绪实例。
    let SoundBank { sounds, voices, .. } = &mut *bank;
    for voice in voices {
        let Some(sound) = sounds.get(&voice.cue) else {
            continue;
        };
        let volume = volume_decibels(mix.gain(voice.ui), sound.policy.volume);
        if voice.applied_volume != Some(volume)
            && let Some(mut instance) = instances.get_mut(voice.handle.id())
        {
            instance.set_decibels(volume, AudioTween::linear(std::time::Duration::ZERO));
            voice.applied_volume = Some(volume);
        }
    }
}

/// 短音的句柄生命周期与播放状态集中维护；只保留每种事件最后一次获准的播放时间。
#[derive(Resource, Default)]
struct SoundBank {
    sounds: HashMap<SoundCue, LoadedSound>,
    voices: Vec<Voice>,
    last_played: HashMap<SoundCue, f64>,
}

fn preload_sounds(server: Res<AssetServer>, mut bank: ResMut<SoundBank>) {
    let manifest = match Manifest::parse(MANIFEST) {
        Ok(manifest) => manifest,
        Err(error) => {
            error!(operation = "load_audio_manifest", %error, "Audio pipeline disabled");
            return;
        }
    };
    for asset in manifest.assets {
        // 合成环境底声只用于试听，不随场景自动播放，也不占用短音通道。
        if asset.category == "ambience" {
            continue;
        }
        let handle = server.load::<AudioSource>(asset.path.clone());
        for cue in SoundCue::ALL {
            if asset.event_ids.iter().any(|id| id == cue.id()) {
                bank.sounds.insert(
                    cue,
                    LoadedSound {
                        handle: handle.clone(),
                        policy: asset.playback.clone(),
                        ui: asset.category == "ui",
                    },
                );
            }
        }
        info!(asset_id = %asset.id, path = %asset.path, reason = "startup_preload", "Audio asset requested");
    }
    info!(
        backend = "bevy_kira_audio",
        backend_version = "0.26.0",
        master_gain = MASTER_GAIN,
        max_voices = MAX_VOICES,
        reserved_ui_voices = RESERVED_UI_VOICES,
        loaded_mappings = bank.sounds.len(),
        "Audio pipeline initialized"
    );
}

fn log_load_failures(mut failures: MessageReader<AssetLoadFailedEvent<AudioSource>>) {
    for failure in failures.read() {
        error!(operation = "load_audio", path = %failure.path, error = %failure.error, "Audio asset failed to load");
    }
}

/// Queued 也算并发，避免同帧 Kira 尚未生成实例时穿过限额。
fn allow_request(
    policy: &PlaybackPolicy,
    now: f64,
    last: Option<f64>,
    same_cue: usize,
    total: usize,
) -> bool {
    total < MAX_VOICES
        && same_cue < policy.max_instances
        && last.is_none_or(|last| now - last >= policy.cooldown_seconds)
}

fn play_requests(
    mut requests: MessageReader<SoundRequest>,
    // 暂停会冻结虚拟时间，菜单节流必须继续使用真实时间。
    time: Res<Time<Real>>,
    sources: Res<Assets<AudioSource>>,
    ui: Res<AudioChannel<UiTrack>>,
    sfx: Res<AudioChannel<SfxTrack>>,
    mix: Res<AudioMix>,
    mut bank: ResMut<SoundBank>,
) {
    bank.voices.retain(|voice| {
        let state = if voice.ui {
            ui.state(&voice.handle)
        } else {
            sfx.state(&voice.handle)
        };
        state != PlaybackState::Stopped
    });
    for request in requests.read() {
        let Some(sound) = bank.sounds.get(&request.cue) else {
            continue;
        };
        let gain = mix.gain(sound.ui);
        if gain == 0.0 || sound.policy.volume == 0.0 {
            // 静音请求立即消费，恢复音量时不能补播旧交互，也不占冷却或并发。
            debug!(event = request.cue.id(), source = ?request.source,
                reason = "muted", "Audio cue skipped");
            continue;
        }
        let now = time.elapsed_secs_f64();
        let same_cue = bank
            .voices
            .iter()
            .filter(|voice| voice.cue == request.cue)
            .count();
        let sfx_at_capacity = !sound.ui
            && bank.voices.iter().filter(|voice| !voice.ui).count()
                >= MAX_VOICES - RESERVED_UI_VOICES;
        if !sources.contains(sound.handle.id())
            || sfx_at_capacity
            || !allow_request(
                &sound.policy,
                now,
                bank.last_played.get(&request.cue).copied(),
                same_cue,
                bank.voices.len(),
            )
        {
            debug!(event = request.cue.id(), source = ?request.source, reason = "loading_or_playback_limit", "Audio cue skipped");
            continue;
        }
        // Kira 0.26 接受分贝；清单音量是线性倍率，须显式换算，不能直接把倍率传成 dB。
        let decibels = volume_decibels(gain, sound.policy.volume);
        let is_ui = sound.ui;
        let handle = if is_ui {
            ui.play(sound.handle.clone()).with_volume(decibels).handle()
        } else {
            sfx.play(sound.handle.clone())
                .with_volume(decibels)
                .handle()
        };
        bank.voices.push(Voice {
            cue: request.cue,
            handle,
            ui: is_ui,
            applied_volume: None,
        });
        bank.last_played.insert(request.cue, now);
        info!(event = request.cue.id(), source = ?request.source, volume_db = decibels.0,
            reason = "accepted_sound_request", "Audio cue queued");
    }
}

fn stop_on_exit(
    mut exit: MessageReader<AppExit>,
    ui: Res<AudioChannel<UiTrack>>,
    sfx: Res<AudioChannel<SfxTrack>>,
) {
    if exit.read().next().is_some() {
        ui.stop();
        sfx.stop();
        info!(reason = "app_exit", "Audio channels stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn settings_preview_survives_category_changes_and_rolls_back_on_exit() {
        use crate::ui::SettingsTab;

        let mut app = queued_test_app();
        let saved_audio = AudioSettings {
            master_volume: 40,
            sfx_volume: 60,
            ui_volume: 80,
        };
        app.world_mut().resource_mut::<GameSettings>().audio = saved_audio;
        let preview_audio = AudioSettings {
            master_volume: 75,
            sfx_volume: 20,
            ui_volume: 50,
        };
        app.insert_resource(SettingsDraft {
            audio: preview_audio,
            ..default()
        })
        .insert_resource(MenuState {
            page: MenuPage::Settings,
            tab: SettingsTab::Audio,
            return_page: MenuPage::Pause,
            ..default()
        });
        app.update();
        assert_eq!(app.world().resource::<AudioMix>().settings, preview_audio);
        assert_eq!(app.world().resource::<GameSettings>().audio, saved_audio);
        app.world_mut().resource_mut::<MenuState>().tab = SettingsTab::Graphics;
        app.update();
        assert_eq!(app.world().resource::<AudioMix>().settings, preview_audio);
        // 保存失败不更新 GameSettings，继续预览；离开设置页时只取最近一次成功应用值。
        app.update();
        assert_eq!(app.world().resource::<AudioMix>().settings, preview_audio);
        app.world_mut().resource_mut::<MenuState>().page = MenuPage::Pause;
        app.update();
        assert_eq!(app.world().resource::<AudioMix>().settings, saved_audio);
        assert!(!app.world().resource::<AudioMix>().preview);

        // 已成功 Apply 的音量是新回滚目标，不回退到进入设置前的值。
        app.world_mut().resource_mut::<MenuState>().page = MenuPage::Settings;
        app.world_mut().resource_mut::<GameSettings>().audio = preview_audio;
        app.world_mut()
            .resource_mut::<SettingsDraft>()
            .audio
            .master_volume = 5;
        app.update();
        assert_eq!(app.world().resource::<AudioMix>().settings.master_volume, 5);
        app.world_mut().resource_mut::<MenuState>().page = MenuPage::Pause;
        app.update();
        assert_eq!(app.world().resource::<AudioMix>().settings, preview_audio);
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
}
