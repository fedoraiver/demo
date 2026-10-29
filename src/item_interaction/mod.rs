//! 物品拾取、共享刚体持握、完整转向碰撞与释放恢复；不自动安装其他项目插件。

mod attachment;
mod audio_events;
mod body;
mod components;
mod interaction;
mod lifecycle;
mod pose;
mod rotation_motion;
mod rotation_query;
mod rotation_sweep;
mod triangle_plane;

pub(crate) use body::item_body;
pub(crate) use components::{
    CarryGrip, HeldAttachment, HeldBy, HeldCollider, HeldTarget, HoldingItems, Item, Pickable,
};
pub(crate) use lifecycle::release_item;
pub(crate) use rotation_query::CarryRotationQuery;

use crate::game_flow::{FixedGameplaySystems, PresentationSystems, gameplay_running};
use attachment::{align_attachments, begin_attachment, finish_attachments};
use avian3d::{interpolation::TransformEasingSystems, prelude::PhysicsSystems};
use bevy::prelude::*;
use interaction::handle_interaction;
use lifecycle::{
    cleanup_orphaned_colliders, prepare_holder_despawn, release_orphaned_items,
    restore_empty_holder_mass, resume_carry_easing,
};
use pose::{sync_held_physics, sync_held_presentation};

/// 注册交互、持握生命周期、物理与呈现同步及物品反馈；物理插件由调用方显式安装。
pub(crate) struct ItemInteractionPlugin;

impl Plugin for ItemInteractionPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<Item>()
            .register_type::<Pickable>()
            .register_type::<CarryGrip>()
            .register_type::<HeldTarget>()
            .add_systems(
                FixedFirst,
                resume_carry_easing
                    .after(TransformEasingSystems::Reset)
                    .before(TransformEasingSystems::UpdateStart)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedUpdate,
                handle_interaction
                    .in_set(FixedGameplaySystems::Interaction)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedUpdate,
                sync_held_presentation
                    .in_set(FixedGameplaySystems::Target)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedUpdate,
                (
                    release_orphaned_items,
                    cleanup_orphaned_colliders,
                    restore_empty_holder_mass,
                    finish_attachments,
                    align_attachments,
                    sync_held_physics,
                )
                    // 移除独立刚体产生的 Avian Observer 命令必须先应用，随后才能创建共享碰撞代理。
                    .chain()
                    .in_set(FixedGameplaySystems::Attachment)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedPostUpdate,
                sync_held_physics
                    .after(PhysicsSystems::Writeback)
                    .run_if(gameplay_running),
            )
            .add_systems(
                RunFixedMainLoop,
                sync_held_physics
                    .in_set(PresentationSystems::HeldPhysics)
                    .run_if(gameplay_running),
            )
            .add_systems(
                RunFixedMainLoop,
                sync_held_presentation
                    .in_set(PresentationSystems::HeldPresentation)
                    .run_if(gameplay_running),
            )
            .add_observer(prepare_holder_despawn);
        audio_events::register_feedback(app);
    }
}

#[cfg(test)]
mod tests;
