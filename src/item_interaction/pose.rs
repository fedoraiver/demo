//! 共享同一局部挂接姿态，分别同步真实物理坐标与当前渲染帧的插值呈现。

use super::{
    HeldCollider, Pickable,
    attachment::world_pose,
    queries::{HeldColliderPose, HeldPhysics, HeldPresentation, HolderPhysics},
};
use crate::{character::Character, settings::PrototypeConfig};
use avian3d::prelude::*;
use bevy::{ecs::relationship::Relationship, prelude::*};

/// 同步组合体内箱子的真实世界姿态和速度，不依赖人物是否具有视觉 Children。
pub(super) fn sync_held_physics(
    holders: Query<HolderPhysics, (With<Character>, Without<Pickable>)>,
    mut items: Query<HeldPhysics, (With<Pickable>, Without<Character>)>,
    mut proxies: Query<
        HeldColliderPose,
        (With<HeldCollider>, Without<Pickable>, Without<Character>),
    >,
) {
    for mut item in &mut items {
        if item.attachment.pending {
            continue;
        }
        let Ok(holder) = holders.get(item.held_by.get()) else {
            continue;
        };
        let pose = world_pose(
            Transform::from_translation(holder.pose.position.0)
                .with_rotation(holder.pose.rotation.0),
            item.attachment.local_pose,
        );
        // 无 ChildOf 的代理偏移由本系统唯一维护，真实碰撞和独立模型根读取同一局部姿态。
        if let Ok(mut proxy) = proxies.get_mut(item.attachment.collider) {
            *proxy.local = ColliderTransform::from(item.attachment.local_pose);
            proxy.position.0 = pose.translation;
            proxy.rotation.0 = pose.rotation;
            *proxy.transform = pose;
        }
        item.body.position.0 = pose.translation;
        item.body.rotation.0 = pose.rotation;
        let world_center = holder.pose.position.0 + holder.pose.rotation.0 * holder.center.0;
        item.body.velocity.0 = holder.velocity.0
            + holder
                .angular_velocity
                .0
                .cross(pose.translation - world_center);
        item.body.angular_velocity.0 = holder.angular_velocity.0;
        *item.body.transform = pose;
    }
}

/// 帧末跟随同一份已呈现人物姿态，零固定步时也不在箱体上叠加第二份插值。
pub(super) fn sync_held_presentation(
    config: Res<PrototypeConfig>,
    holders: Query<&Transform, (With<Character>, Without<Pickable>)>,
    mut items: Query<HeldPresentation, (With<Pickable>, Without<Character>)>,
) {
    for mut item in &mut items {
        let Ok(holder) = holders.get(item.held_by.get()) else {
            continue;
        };
        item.target.translation = holder.translation
            + holder.rotation * item.grip.map_or(config.hold_offset, |grip| grip.offset);
        item.target.rotation = holder.rotation;
        if let Some(attachment) = item.attachment
            && !attachment.pending
        {
            *item.transform = world_pose(*holder, attachment.local_pose);
        }
    }
}
