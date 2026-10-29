//! 共享同一局部挂接姿态，分别同步真实物理坐标与当前渲染帧的插值呈现。

use super::{
    CarryGrip, HeldAttachment, HeldBy, HeldCollider, HeldTarget, Pickable, attachment::world_pose,
};
use crate::{character::Character, settings::PrototypeConfig};
use avian3d::prelude::*;
use bevy::{ecs::relationship::Relationship, prelude::*};

/// 同步组合体内箱子的真实世界姿态和速度，不依赖人物是否具有视觉 Children。
pub(super) fn sync_held_physics(
    holders: Query<
        (
            &Position,
            &Rotation,
            &LinearVelocity,
            &AngularVelocity,
            &ComputedCenterOfMass,
        ),
        (With<Character>, Without<Pickable>),
    >,
    mut items: Query<
        (
            &HeldBy,
            &HeldAttachment,
            &mut Position,
            &mut Rotation,
            &mut LinearVelocity,
            &mut AngularVelocity,
            &mut Transform,
        ),
        (With<Pickable>, Without<Character>),
    >,
    mut proxies: Query<
        (
            &mut ColliderTransform,
            &mut Position,
            &mut Rotation,
            &mut Transform,
        ),
        (With<HeldCollider>, Without<Pickable>, Without<Character>),
    >,
) {
    for (
        held_by,
        attachment,
        mut position,
        mut rotation,
        mut velocity,
        mut angular,
        mut transform,
    ) in &mut items
    {
        if attachment.pending {
            continue;
        }
        let Ok((holder_position, holder_rotation, holder_velocity, holder_angular, center)) =
            holders.get(held_by.get())
        else {
            continue;
        };
        let pose = world_pose(
            Transform::from_translation(holder_position.0).with_rotation(holder_rotation.0),
            attachment.local_pose,
        );
        // 无 ChildOf 的代理偏移由本系统唯一维护，真实碰撞和独立模型根读取同一局部姿态。
        if let Ok((mut local, mut proxy_position, mut proxy_rotation, mut proxy_transform)) =
            proxies.get_mut(attachment.collider)
        {
            *local = ColliderTransform::from(attachment.local_pose);
            proxy_position.0 = pose.translation;
            proxy_rotation.0 = pose.rotation;
            *proxy_transform = pose;
        }
        position.0 = pose.translation;
        rotation.0 = pose.rotation;
        let world_center = holder_position.0 + holder_rotation.0 * center.0;
        velocity.0 = holder_velocity.0 + holder_angular.0.cross(pose.translation - world_center);
        angular.0 = holder_angular.0;
        *transform = pose;
    }
}

/// 帧末跟随同一份已呈现人物姿态，零固定步时也不在箱体上叠加第二份插值。
pub(super) fn sync_held_presentation(
    config: Res<PrototypeConfig>,
    holders: Query<&Transform, (With<Character>, Without<Pickable>)>,
    mut items: Query<
        (
            &HeldBy,
            Option<&HeldAttachment>,
            Option<&CarryGrip>,
            &mut HeldTarget,
            &mut Transform,
        ),
        (With<Pickable>, Without<Character>),
    >,
) {
    for (held_by, attachment, grip, mut target, mut transform) in &mut items {
        let Ok(holder) = holders.get(held_by.get()) else {
            continue;
        };
        target.translation = holder.translation
            + holder.rotation * grip.map_or(config.hold_offset, |grip| grip.offset);
        target.rotation = holder.rotation;
        if let Some(attachment) = attachment
            && !attachment.pending
        {
            *transform = world_pose(*holder, attachment.local_pose);
        }
    }
}
