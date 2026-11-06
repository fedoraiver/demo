//! 播放端与消息生产者共享的音效契约；不初始化音频设备。

use bevy::prelude::*;

/// 已接入的声音事件标识，事件与音频清单的映射共同维护。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SoundCue {
    MenuHover,
    MenuConfirm,
    MenuCancel,
}

impl SoundCue {
    pub(crate) const ALL: [Self; 3] = [Self::MenuHover, Self::MenuConfirm, Self::MenuCancel];

    /// 事件所属的音频分类，新增事件时明确其分类与输出通道。
    pub(super) const fn category(self) -> &'static str {
        match self {
            Self::MenuHover | Self::MenuConfirm | Self::MenuCancel => "ui",
        }
    }

    /// 与清单 event_ids 使用同一标识，便于日志与资产对应。
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::MenuHover => "menu_hover",
            Self::MenuConfirm => "menu_confirm",
            Self::MenuCancel => "menu_cancel",
        }
    }
}

/// 声音请求保存用于日志定位的来源实体标识，来源实体销毁后仍可消费。
#[derive(Message, Clone, Copy, Debug)]
pub(crate) struct SoundRequest {
    pub cue: SoundCue,
    pub source: Entity,
}

impl SoundRequest {
    pub(crate) fn new(cue: SoundCue, source: Entity) -> Self {
        Self { cue, source }
    }
}
