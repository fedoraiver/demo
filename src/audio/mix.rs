//! 有效混音与 UI 采样池的增益同步。

use super::{AudioPreview, MASTER_GAIN, UiPool};
use crate::settings::{AudioSettings, GameSettings, MAX_AUDIO_VOLUME};
use bevy::prelude::*;
use bevy_seedling::prelude::{SamplerPool, Volume, VolumeNode};

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

/// Firewheel 的 Linear 使用响度曲线；振幅倍率转为分贝，保持现有混音的乘积语义。
pub(super) fn amplitude_volume(gain: f64) -> Volume {
    if gain <= 0.0 {
        Volume::SILENT
    } else {
        Volume::Decibels((20.0 * gain.log10()) as f32)
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

pub(super) fn sync_pool_volume(
    mix: Res<AudioMix>,
    mut pools: Query<&mut VolumeNode, With<SamplerPool<UiPool>>>,
) {
    // 素材倍率保留在 SamplePlayer，池总线只应用当前混音，排队与播放中声音共用。
    let volume = amplitude_volume(mix.gain());
    for mut pool in &mut pools {
        if pool.volume != volume {
            pool.volume = volume;
        }
    }
}
