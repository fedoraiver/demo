//! Kira 播放端统一预加载、节流和限制并发；事件收集不依赖输出设备。

use std::collections::{HashMap, HashSet};

use bevy::{asset::AssetLoadFailedEvent, prelude::*};
use bevy_kira_audio::{
    AudioApp, AudioChannel, AudioControl, AudioInstance, AudioPlugin as KiraAudioPlugin,
    AudioSource, PlaybackState,
};
use serde::Deserialize;

use crate::audio_events::{SoundCue, SoundRequest};

const MANIFEST: &str = include_str!("../assets/audio/audio_manifest.json");
// 第一版固定混音余量与总并发，避免物理碰撞密集时叠加过响；试听页可独立调整监听音量。
const MASTER_GAIN: f64 = 0.25;
const MAX_VOICES: usize = 4;

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
            .add_systems(Startup, preload_sounds)
            .add_systems(
                Update,
                (log_load_failures, play_requests, stop_on_exit).chain(),
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
    time: Res<Time>,
    sources: Res<Assets<AudioSource>>,
    ui: Res<AudioChannel<UiTrack>>,
    sfx: Res<AudioChannel<SfxTrack>>,
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
        let now = time.elapsed_secs_f64();
        let same_cue = bank
            .voices
            .iter()
            .filter(|voice| voice.cue == request.cue)
            .count();
        if !sources.contains(sound.handle.id())
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
        if sound.policy.volume == 0.0 {
            continue;
        }
        // Kira 0.26 接受分贝；清单音量是线性倍率，须显式换算，不能直接把倍率传成 dB。
        let decibels = (20.0 * (MASTER_GAIN * sound.policy.volume).log10()) as f32;
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
        });
        bank.last_played.insert(request.cue, now);
        info!(event = request.cue.id(), source = ?request.source, volume_db = decibels,
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

    /// 默认通道只排队而不会初始化设备；实际执行播放系统验证 Queued 的跨帧限额。
    #[test]
    fn queued_requests_obey_limits_without_audio_device() {
        let mut app = App::new();
        app.init_resource::<Time>()
            .init_resource::<Assets<AudioSource>>()
            .init_resource::<AudioChannel<UiTrack>>()
            .init_resource::<AudioChannel<SfxTrack>>()
            .init_resource::<SoundBank>()
            .add_message::<SoundRequest>()
            .add_systems(Update, play_requests);
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
        let source = app.world_mut().spawn_empty().id();
        for cue in SoundCue::ALL.into_iter().take(5) {
            app.world_mut()
                .write_message(SoundRequest::new(cue, source));
        }
        app.update();
        assert_eq!(app.world().resource::<SoundBank>().voices.len(), MAX_VOICES);
        app.world_mut()
            .resource_mut::<Time>()
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
