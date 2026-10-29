//! 保留拾取瞬间姿态，并沿连续碰撞查询允许的路径逐步对齐到握点。

use super::{
    CarryGrip, CarryRotationQuery, HeldAttachment, HeldBy, HeldCollider, Pickable,
    components::CarryBaseMass, release_item,
};
use crate::{character::Character, settings::PrototypeConfig};
use avian3d::prelude::*;
use bevy::{ecs::relationship::Relationship, prelude::*};

// 拾取先保持真实姿态，再沿经过碰撞检查的小步对齐双手，不能瞬间把箱子塞进障碍。
const ALIGN_SPEED: f32 = 5.0;
const ALIGN_ANGULAR_SPEED: f32 = std::f32::consts::TAU;
const ALIGN_BLOCKED_TIMEOUT: f32 = 0.35;

/// 开始挂接但不改变箱子的世界姿态，等待刚体移除及其 Observer 命令完成。
pub(super) fn begin_attachment(
    commands: &mut Commands,
    item: Entity,
    holder_pose: Transform,
    item_pose: Transform,
    free_body: RigidBody,
    translation_was_paused: bool,
    rotation_was_paused: bool,
    collider_was_disabled: bool,
) {
    let inverse = holder_pose.rotation.inverse();
    let collider = commands.spawn_empty().id();
    // 活动 ColliderOf 卸载时会迁移 BVH；先移出旧索引，避免恢复时重复注册同一碰撞实体。
    commands.entity(item).insert(ColliderDisabled);
    commands.entity(item).remove::<RigidBody>().insert((
        HeldAttachment {
            collider,
            local_pose: Transform {
                translation: inverse * (item_pose.translation - holder_pose.translation),
                rotation: inverse * item_pose.rotation,
                scale: item_pose.scale,
            },
            pending: true,
            free_body,
            translation_was_paused,
            rotation_was_paused,
            collider_was_disabled,
            blocked_seconds: 0.0,
        },
        NoTranslationEasing,
        NoRotationEasing,
    ));
}

/// 持握期间只保留人物的 Dynamic，碰到箱子即对同一刚体求解，内部形状自动互不碰撞。
pub(super) fn finish_attachments(
    mut commands: Commands,
    mut items: Query<
        (
            Entity,
            &HeldBy,
            &Mass,
            &Collider,
            &CollisionLayers,
            &Friction,
            &Restitution,
            &mut HeldAttachment,
        ),
        (With<Pickable>, Without<RigidBody>),
    >,
    holders: Query<(&Mass, Option<&CarryBaseMass>), With<Character>>,
) {
    for (item, held_by, mass, collider, layers, friction, restitution, mut attachment) in &mut items
    {
        if !attachment.pending {
            continue;
        }
        let holder = held_by.get();
        let Ok((holder_mass, base_mass)) = holders.get(holder) else {
            continue;
        };
        if base_mass.is_none() {
            commands.entity(holder).insert(CarryBaseMass {
                mass: holder_mass.0,
            });
        }
        commands.entity(holder).insert(Mass(holder_mass.0 + mass.0));
        // RigidBodyColliders 的 linked_spawn 会销毁附属碰撞，因此使用代理保护独立业务箱。
        // 代理复制真实形状和表面配置，不含模型子树，也没有第二个 Dynamic。
        commands
            .entity(attachment.collider)
            .insert((
                Name::new("Held parcel collision proxy"),
                HeldCollider { item },
                collider.clone(),
                *layers,
                *friction,
                *restitution,
                CollisionEventsEnabled,
                Transform::IDENTITY,
            ))
            .insert(ColliderOf { body: holder })
            .insert(ColliderTransform::from(attachment.local_pose));
        if attachment.collider_was_disabled {
            commands
                .entity(attachment.collider)
                .insert(ColliderDisabled);
        }
        attachment.pending = false;
        info!(target: "demo::carry", ?item, ?holder, collider = ?attachment.collider,
            local_position = ?attachment.local_pose.translation,
            body_mass = holder_mass.0 + mass.0,
            reason = "carry_attachment_ready", "Carryable item attached to holder body");
    }
}

/// 物理使用 Position / Rotation，呈现使用 Transform；局部挂接姿态是两者共同的唯一来源。
pub(super) fn world_pose(holder: Transform, local: Transform) -> Transform {
    Transform {
        translation: holder.translation + holder.rotation * local.translation,
        rotation: holder.rotation * local.rotation,
        scale: local.scale,
    }
}

/// 有限的小步对齐不会积分箱体力；受阻保留安全姿态，持续受阻则解除持握。
pub(super) fn align_attachments(
    mut commands: Commands,
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    safety: CarryRotationQuery,
    holders: Query<(&Position, &Rotation, &RigidBodyColliders), With<Character>>,
    mut items: Query<
        (
            Entity,
            &HeldBy,
            &Collider,
            Option<&CarryGrip>,
            &mut HeldAttachment,
            &Position,
            &Rotation,
            &LinearVelocity,
            &AngularVelocity,
        ),
        (With<Pickable>, Without<Character>),
    >,
) {
    for (item, held_by, collider, grip, mut attachment, position, rotation, velocity, angular) in
        &mut items
    {
        if attachment.pending {
            continue;
        }
        let Ok((holder_position, holder_rotation, body_colliders)) = holders.get(held_by.get())
        else {
            continue;
        };
        let target = grip.map_or(config.hold_offset, |grip| grip.offset);
        let offset = target - attachment.local_pose.translation;
        let angle = attachment.local_pose.rotation.angle_between(Quat::IDENTITY);
        if offset.length_squared() < 1e-8 && angle < 0.0001 {
            continue;
        }
        let mut candidate = attachment.local_pose;
        candidate.translation += offset.clamp_length_max(ALIGN_SPEED * time.delta_secs());
        if angle > 0.0001 {
            candidate.rotation = candidate.rotation.slerp(
                Quat::IDENTITY,
                (ALIGN_ANGULAR_SPEED * time.delta_secs() / angle).min(1.0),
            );
        }
        let holder_pose =
            Transform::from_translation(holder_position.0).with_rotation(holder_rotation.0);
        let start = world_pose(holder_pose, attachment.local_pose);
        let end = world_pose(holder_pose, candidate);
        let excluded: Vec<_> = body_colliders.iter().collect();
        if !safety.pose_path_blocked(collider, start, end, &excluded) {
            attachment.local_pose = candidate;
            attachment.blocked_seconds = 0.0;
        } else {
            attachment.blocked_seconds += time.delta_secs();
            if attachment.blocked_seconds >= ALIGN_BLOCKED_TIMEOUT {
                release_item(
                    &mut commands,
                    item,
                    Transform::from_translation(position.0)
                        .with_rotation(rotation.0)
                        .with_scale(attachment.local_pose.scale),
                    velocity.0,
                    angular.0,
                    "carry_alignment_blocked",
                );
            }
        }
    }
}
