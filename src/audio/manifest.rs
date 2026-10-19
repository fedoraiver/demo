//! 音效清单与播放策略的加载边界。

use super::{MAX_VOICES, SoundCue};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Deserialize)]
pub(super) struct Manifest {
    pub(super) schema_version: u32,
    pub(super) assets: Vec<ManifestAsset>,
}

#[derive(Deserialize)]
pub(super) struct ManifestAsset {
    pub(super) id: String,
    pub(super) path: String,
    pub(super) category: String,
    pub(super) event_ids: Vec<String>,
    pub(super) playback: PlaybackPolicy,
}

#[derive(Deserialize, Clone)]
pub(super) struct PlaybackPolicy {
    pub(super) volume: f64,
    pub(super) cooldown_seconds: f64,
    pub(super) max_instances: usize,
    pub(super) looped: bool,
}

impl Manifest {
    /// 编译时嵌入清单，但仍检查契约；破损清单只禁用反馈，不改变玩法状态。
    pub(super) fn parse(text: &str) -> Result<Self, String> {
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
