//! 有效混音及排队、已播放实例的增益同步。

use super::{AudioPreview, MASTER_GAIN, playback::SoundBank};
use crate::settings::{AudioSettings, GameSettings, MAX_AUDIO_VOLUME};
use bevy::prelude::*;
use bevy_kira_audio::{AudioInstance, AudioTween, prelude::Decibels};

/// 音频输出的有效混音源，离开设置页后采用最近成功应用的配置。
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(super) struct AudioMix {
    pub(super) settings: AudioSettings,
    pub(super) preview: bool,
}

impl AudioMix {
    /// 当前 UI 通道使用总音量和 UI 分类音量计算增益。
    pub(super) fn gain(&self) -> f64 {
        let volume_scale = f64::from(MAX_AUDIO_VOLUME);
        MASTER_GAIN * f64::from(self.settings.master_volume) * f64::from(self.settings.ui_volume)
            / (volume_scale * volume_scale)
    }
}

/// Kira 的 SILENCE 有明确静音语义，避免把 log10(0) 产生的非有限值传给后端。
pub(super) fn volume_decibels(gain: f64, asset_volume: f64) -> Decibels {
    let volume = gain * asset_volume;
    if volume <= 0.0 {
        Decibels::SILENCE
    } else {
        Decibels((20.0 * volume.log10()) as f32)
    }
}

pub(super) fn sync_audio_mix(
    settings: Res<GameSettings>,
    preview: Res<AudioPreview>,
    mut mix: ResMut<AudioMix>,
) {
    let desired_settings = preview.settings.unwrap_or(settings.audio);
    let preview = preview.settings.is_some();
    let desired = AudioMix {
        settings: desired_settings,
        preview,
    };
    if *mix != desired {
        // 连续拖动由 UI 在放手时汇总；这里只记录预览启用或退出及正式配置变化。
        if !preview || !mix.preview {
            info!(target: "demo::audio",
                master_volume_before = mix.settings.master_volume,
                master_volume_after = desired.settings.master_volume,
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

pub(super) fn sync_voice_volumes(
    mix: Res<AudioMix>,
    mut bank: ResMut<SoundBank>,
    mut instances: ResMut<Assets<AudioInstance>>,
) {
    // Kira 的通道 set_volume 会覆盖每个实例的绝对音量，不能保持素材间响度。
    // 因此按通道混音和素材清单音量同步，覆盖正在播放和刚就绪实例。
    let SoundBank { sounds, voices, .. } = &mut *bank;
    for voice in voices {
        let Some(sound) = sounds.get(&voice.cue) else {
            continue;
        };
        let volume = volume_decibels(mix.gain(), sound.policy.volume);
        if voice.applied_volume != Some(volume)
            && let Some(mut instance) = instances.get_mut(voice.handle.id())
        {
            instance.set_decibels(volume, AudioTween::linear(std::time::Duration::ZERO));
            voice.applied_volume = Some(volume);
        }
    }
}
