//! 音频资源加载、播放与混音，通过声音请求和设置预览协作。

mod manifest;
mod messages;
mod mix;
mod playback;

use bevy::{
    ecs::error::{BevyError, ErrorContext, match_severity},
    prelude::*,
};
use bevy_seedling::{
    SeedlingPlugins, SeedlingSystems, context::SampleRate, node::DiffRate,
    platform::cpal::StartStreamError, prelude::PoolLabel,
};

use crate::settings::AudioSettings;
pub(crate) use messages::{SoundCue, SoundRequest};
use mix::{AudioMix, sync_audio_mix, sync_pool_volume};
use playback::{
    SoundBank, log_load_failures, play_requests, preload_sounds, register_exit, spawn_ui_pool,
};

const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/assets/audio/audio_manifest.json"
));
// 音量百分比在素材基准响度上做衰减，默认 100% 保留混音余量。
const MASTER_GAIN: f64 = 0.25;
const MAX_VOICES: usize = 4;

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

/// 当前菜单反馈使用的 UI 输出通道。
#[derive(PoolLabel, Default, Debug, Clone, PartialEq, Eq, Hash)]
struct UiPool;

/// 安装 Seedling 输出与音频生命周期；无设备测试只装配采样与混音数据。
pub(crate) struct GameAudioPlugin;

impl Plugin for GameAudioPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(SeedlingPlugins)
            .init_resource::<SoundBank>()
            .init_resource::<AudioMix>()
            .init_resource::<AudioPreview>()
            .add_message::<SoundRequest>()
            .add_systems(Startup, (spawn_ui_pool, preload_sounds))
            .configure_sets(Update, (AudioSystems::Mix, AudioSystems::Playback).chain())
            .add_systems(
                Update,
                (log_load_failures, sync_audio_mix, sync_pool_volume)
                    .chain()
                    .in_set(AudioSystems::Mix),
            )
            .add_systems(Update, play_requests.in_set(AudioSystems::Playback));
        register_exit(app);
        configure_output_lifecycle(app);
    }
}

fn configure_output_lifecycle(app: &mut App) {
    // 菜单混音与退出停止在本帧刷新，不受后端默认的 10ms 参数同步间隔限制。
    app.insert_resource(DiffRate(std::time::Duration::ZERO));
    // Seedling 将设备启动失败交给 Bevy；仅此错误降为可继续运行，其余沿用默认策略。
    app.set_error_handler(handle_audio_error).configure_sets(
        Last,
        (
            SeedlingSystems::Acquire,
            SeedlingSystems::Connect,
            SeedlingSystems::Pool,
            SeedlingSystems::Queue,
            SeedlingSystems::Flush,
        )
            .run_if(resource_exists::<SampleRate>),
    );
}

fn handle_audio_error(error: BevyError, context: ErrorContext) {
    if error.downcast_ref::<StartStreamError>().is_some() {
        error!(target: "demo::audio", operation = "start_audio_output", %error, %context,
            reason = "audio_device_unavailable", "Audio output unavailable; game continues");
    } else {
        match_severity(error, context);
    }
}

#[cfg(test)]
mod tests;
