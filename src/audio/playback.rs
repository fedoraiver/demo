//! 音效资源、排队限额、通道播放与退出清理。

use super::{
    MANIFEST, MASTER_GAIN, MAX_VOICES, SoundCue, SoundRequest, UiPool,
    manifest::{Manifest, PlaybackPolicy},
    mix::{AudioMix, amplitude_volume},
};
use bevy::{app::OnAppExitSystems, asset::AssetLoadFailedEvent, prelude::*, window::ExitSystems};
use bevy_seedling::SeedlingSystems;
use bevy_seedling::prelude::{AudioSample, PoolSize, SamplePlayer, SamplerPool, VolumeNode};
use std::collections::HashMap;

pub(super) struct LoadedSound {
    pub(super) handle: Handle<AudioSample>,
    pub(super) policy: PlaybackPolicy,
}

/// 排队和播放中的 UI 声音；Seedling 完成播放后销毁实体并释放并发名额。
#[derive(Component, Clone)]
pub(super) struct Voice {
    pub(super) cue: SoundCue,
}

/// 集中维护声音句柄与播放状态，记录每种事件最近一次获准播放的时间。
#[derive(Resource, Default)]
pub(super) struct SoundBank {
    pub(super) sounds: HashMap<SoundCue, LoadedSound>,
    pub(super) last_played: HashMap<SoundCue, f64>,
}

pub(super) fn spawn_ui_pool(mut commands: Commands) {
    // 这两个第三方组件没有 BSN 模板，结构声明后直接插入。
    commands
        .spawn_scene(bsn! {
            #UiAudioPool
            // 保留逐帧即时混音，极低的合法音量不被后端默认阈值额外静音。
            VolumeNode { volume: {amplitude_volume(MASTER_GAIN)}, smooth_seconds: 0.0, min_gain: 0.0 }
        })
        .insert((SamplerPool(UiPool), PoolSize(MAX_VOICES..=MAX_VOICES)));
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
        let handle = server.load::<AudioSample>(asset.path.clone());
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
        backend = "bevy_seedling",
        backend_version = "0.9.0",
        master_gain = MASTER_GAIN,
        max_voices = MAX_VOICES,
        loaded_mappings = bank.sounds.len(),
        "Audio pipeline initialized"
    );
}

pub(super) fn log_load_failures(mut failures: MessageReader<AssetLoadFailedEvent<AudioSample>>) {
    for failure in failures.read() {
        error!(target: "demo::audio", operation = "load_audio", path = %failure.path, error = %failure.error, "Audio asset failed to load");
    }
}

/// 排队也算并发，同帧延迟生成的实体由局部计数纳入限额。
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
    sources: Res<Assets<AudioSample>>,
    voices: Query<&Voice>,
    mut commands: Commands,
    mix: Res<AudioMix>,
    mut bank: ResMut<SoundBank>,
) {
    let mut total = 0;
    let mut counts = HashMap::new();
    for voice in &voices {
        total += 1;
        *counts.entry(voice.cue).or_insert(0) += 1;
    }
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
        let same_cue = counts.get(&request.cue).copied().unwrap_or(0);
        if !sources.contains(sound.handle.id())
            || !allow_request(
                &sound.policy,
                now,
                bank.last_played.get(&request.cue).copied(),
                same_cue,
                total,
            )
        {
            debug!(target: "demo::audio", event = request.cue.id(), source = ?request.source, reason = "loading_or_playback_limit", "Audio cue skipped");
            continue;
        }
        let player = SamplePlayer::new(sound.handle.clone())
            .with_volume(amplitude_volume(sound.policy.volume));
        let voice = Voice { cue: request.cue };
        // SamplePlayer 的资产句柄没有 BSN 模板，声明身份与分类后直接插入播放器。
        commands
            .spawn_scene(bsn! {
                #UiAudioVoice
                UiPool
                voice
            })
            .insert(player);
        total += 1;
        *counts.entry(request.cue).or_insert(0) += 1;
        bank.last_played.insert(request.cue, now);
        info!(target: "demo::audio", event = request.cue.id(), source = ?request.source, gain,
            reason = "accepted_sound_request", "Audio cue queued");
    }
}

pub(super) fn register_exit(app: &mut App) {
    // 关闭窗口在 Last 发出退出消息，先提交声音销毁，再让采样池停止并刷新到输出线程。
    app.add_systems(
        Last,
        stop_on_exit
            .in_set(OnAppExitSystems)
            .after(ExitSystems)
            .before(SeedlingSystems::Pool),
    );
}

fn stop_on_exit(
    mut exit: MessageReader<AppExit>,
    voices: Query<Entity, With<Voice>>,
    mut commands: Commands,
) {
    if exit.read().next().is_some() {
        for entity in &voices {
            commands.entity(entity).despawn();
        }
        info!(target: "demo::audio", reason = "app_exit", "UI audio pool stopped");
    }
}
