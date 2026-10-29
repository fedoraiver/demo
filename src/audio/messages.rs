//! 播放端与消息生产者共享的音效契约；不初始化音频设备。

use bevy::prelude::*;

/// 稳定事件标识与音频清单对应；未来玩法在业务成功或失败时发送，不能从按键猜测结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SoundCue {
    MenuHover,
    MenuConfirm,
    MenuCancel,
    ItemPickup,
    ItemRelease,
    ItemHandoff,
    ItemLand,
    CartCollision,
    CharacterBounce,
    InstabilityWarning,
    DeliverySuccess,
    DeliveryFailure,
}

impl SoundCue {
    pub(crate) const ALL: [Self; 12] = [
        Self::MenuHover,
        Self::MenuConfirm,
        Self::MenuCancel,
        Self::ItemPickup,
        Self::ItemRelease,
        Self::ItemHandoff,
        Self::ItemLand,
        Self::CartCollision,
        Self::CharacterBounce,
        Self::InstabilityWarning,
        Self::DeliverySuccess,
        Self::DeliveryFailure,
    ];

    /// 与 manifest 的 event_ids 使用同一英文标识，便于日志与资产对应。
    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::MenuHover => "menu_hover",
            Self::MenuConfirm => "menu_confirm",
            Self::MenuCancel => "menu_cancel",
            Self::ItemPickup => "parcel_pickup",
            Self::ItemRelease => "parcel_release",
            Self::ItemHandoff => "parcel_handoff",
            Self::ItemLand => "parcel_land",
            Self::CartCollision => "cart_collision",
            Self::CharacterBounce => "character_bounce",
            Self::InstabilityWarning => "instability_warning",
            Self::DeliverySuccess => "delivery_success",
            Self::DeliveryFailure => "delivery_failure",
        }
    }
}

/// 业务实体只用于日志和节流，不持有其组件引用，实体销毁后消息仍可被消费。
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
