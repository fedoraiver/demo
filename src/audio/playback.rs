//! 音效资源、排队限额、通道播放与退出清理。

use super::{
    MANIFEST, MASTER_GAIN, MAX_VOICES, SoundCue, SoundRequest, UiTrack,
    manifest::{Manifest, PlaybackPolicy},
    mix::{AudioMix, volume_decibels},
};
use bevy::{asset::AssetLoadFailedEvent, prelude::*};
use bevy_kira_audio::{
    AudioChannel, AudioControl, AudioInstance, AudioSource, PlaybackState, prelude::Decibels,
};
use std::collections::HashMap;

pub(super) struct LoadedSound {
    pub(super) handle: Handle<AudioSource>,
    pub(super) policy: PlaybackPolicy,
}

pub(super) struct Voice {
    pub(super) cue: SoundCue,
    pub(super) handle: Handle<AudioInstance>,
    // 排队实例尚未进入 Assets，等待句柄就绪后同步最新预览，避免沿用过时音量。
    pub(super) applied_volume: Option<Decibels>,
}

/// 集中维护声音句柄与播放状态，记录每种事件最近一次获准播放的时间。
#[derive(Resource, Default)]
pub(super) struct SoundBank {
    pub(super) sounds: HashMap<SoundCue, LoadedSound>,
    pub(super) voices: Vec<Voice>,
    pub(super) last_played: HashMap<SoundCue, f64>,
}

pub(super) fn preload_sounds(server: Res<AssetServer>, mut bank: ResMut<SoundBank>) {
    let manifest = match Manifest::parse(MANIFEST) {
        Ok(manifest) => manifest,
        Err(error) => {
            error!(target: "demo::audio", operation = "load_audio_manifest", %error, "Audio pipeline disabled");
            return;
        }
    };
    for asset in manifest.assets {
        let handle = server.load::<AudioSource>(asset.path.clone());
        for cue in SoundCue::ALL {
            if asset.event_ids.iter().any(|id| id == cue.id()) {
                bank.sounds.insert(
                    cue,
                    LoadedSound {
                        handle: handle.clone(),
                        policy: asset.playback.clone(),
                    },
                );
            }
        }
        info!(target: "demo::audio", asset_id = %asset.id, path = %asset.path, reason = "startup_preload", "Audio asset requested");
    }
    info!(target: "demo::audio",
        backend = "bevy_kira_audio",
        backend_version = "0.27.1",
        master_gain = MASTER_GAIN,
        max_voices = MAX_VOICES,
        loaded_mappings = bank.sounds.len(),
        "Audio pipeline initialized"
    );
}

pub(super) fn log_load_failures(mut failures: MessageReader<AssetLoadFailedEvent<AudioSource>>) {
    for failure in failures.read() {
        error!(target: "demo::audio", operation = "load_audio", path = %failure.path, error = %failure.error, "Audio asset failed to load");
    }
}

/// Queued 也算并发，避免同帧 Kira 尚未生成实例时穿过限额。
pub(super) fn allow_request(
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

pub(super) fn play_requests(
    mut requests: MessageReader<SoundRequest>,
    // 冷却使用真实时间，保证暂停期间的界面反馈仍可触发。
    time: Res<Time<Real>>,
    sources: Res<Assets<AudioSource>>,
    ui: Res<AudioChannel<UiTrack>>,
    mix: Res<AudioMix>,
    mut bank: ResMut<SoundBank>,
) {
    bank.voices
        .retain(|voice| ui.state(&voice.handle) != PlaybackState::Stopped);
    for request in requests.read() {
        let Some(sound) = bank.sounds.get(&request.cue) else {
            continue;
        };
        let gain = mix.gain();
        if gain == 0.0 || sound.policy.volume == 0.0 {
            // 静音请求立即消费，恢复音量时不能补播旧交互，也不占冷却或并发。
            debug!(target: "demo::audio", event = request.cue.id(), source = ?request.source,
                reason = "muted", "Audio cue skipped");
            continue;
        }
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
            debug!(target: "demo::audio", event = request.cue.id(), source = ?request.source, reason = "loading_or_playback_limit", "Audio cue skipped");
            continue;
        }
        // Kira 接受分贝；清单音量是线性倍率，须显式换算，不能直接把倍率传成 dB。
        let decibels = volume_decibels(gain, sound.policy.volume);
        let handle = ui.play(sound.handle.clone()).with_volume(decibels).handle();
        bank.voices.push(Voice {
            cue: request.cue,
            handle,
            applied_volume: None,
        });
        bank.last_played.insert(request.cue, now);
        info!(target: "demo::audio", event = request.cue.id(), source = ?request.source, volume_db = decibels.0,
            reason = "accepted_sound_request", "Audio cue queued");
    }
}

pub(super) fn stop_on_exit(mut exit: MessageReader<AppExit>, ui: Res<AudioChannel<UiTrack>>) {
    if exit.read().next().is_some() {
        ui.stop();
        info!(target: "demo::audio", reason = "app_exit", "UI audio channel stopped");
    }
}
