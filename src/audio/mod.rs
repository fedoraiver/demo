//! 音效播放与混音；玩法和菜单只通过音效请求及可选预览数据协作。

mod manifest;
mod messages;
mod mix;
mod playback;

use bevy::prelude::*;
use bevy_kira_audio::{AudioApp, AudioPlugin as KiraAudioPlugin, AudioSystemSet};

use crate::settings::AudioSettings;
pub(crate) use messages::{SoundCue, SoundRequest};
use mix::{AudioMix, sync_audio_mix, sync_voice_volumes};
use playback::{SoundBank, log_load_failures, play_requests, preload_sounds, stop_on_exit};

const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/audio_manifest.json"
));
// 保留混音余量；菜单百分比只衰减，默认 100% 维持现有响度。
const MASTER_GAIN: f64 = 0.25;
const MAX_VOICES: usize = 4;
// 保留菜单反馈的并发名额，不打断已经播放的声音。
const RESERVED_UI_VOICES: usize = 1;

/// 设置界面发布的临时音量；清空后立即使用最近成功应用的配置。
#[derive(Resource, Default, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AudioPreview {
    pub settings: Option<AudioSettings>,
}

/// 跨功能只约束混音与播放阶段，具体资源和实例处理顺序留在音频内部。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum AudioSystems {
    Mix,
    Playback,
}

#[derive(Resource)]
struct UiTrack;
#[derive(Resource)]
struct SfxTrack;

/// 安装 Kira 输出与音频生命周期；无设备测试直接使用内部纯数据夹具。
pub(crate) struct GameAudioPlugin;

impl Plugin for GameAudioPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(KiraAudioPlugin)
            .add_audio_channel::<UiTrack>()
            .add_audio_channel::<SfxTrack>()
            .init_resource::<SoundBank>()
            .init_resource::<AudioMix>()
            .init_resource::<AudioPreview>()
            .add_message::<SoundRequest>()
            .add_systems(Startup, preload_sounds)
            .configure_sets(Update, (AudioSystems::Mix, AudioSystems::Playback).chain())
            .add_systems(
                Update,
                (log_load_failures, sync_audio_mix, sync_voice_volumes)
                    .chain()
                    .in_set(AudioSystems::Mix),
            )
            .add_systems(
                Update,
                (play_requests, stop_on_exit)
                    .chain()
                    .in_set(AudioSystems::Playback),
            )
            // 排队句柄在 Kira 的 PostUpdate 中生成，创建后立即补齐当前增益。
            .add_systems(
                PostUpdate,
                sync_voice_volumes.after(AudioSystemSet::PlayTypedChannels),
            );
    }
}

#[cfg(test)]
mod tests;
