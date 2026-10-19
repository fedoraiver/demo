//! 统一卸载共享刚体和失效关系，恢复物品独立运动、碰撞与原有插值设置。

use super::{
    HeldAttachment, HeldBy, HeldCollider, HeldTarget, HoldingItems, Pickable,
    components::{CarryBaseMass, ResumeCarryEasing},
};
use crate::{character::Character, physics::parcel_collision_layers};
use avian3d::prelude::*;
use bevy::{
    ecs::relationship::{Relationship, RelationshipTarget},
    prelude::*,
};

/// 相机受阻、主动松手与落水共用卸载入口，调用方提供解除前的安全世界姿态和真实速度。
pub(crate) fn release_item(
    commands: &mut Commands,
    item: Entity,
    pose: Transform,
    linear_velocity: Vec3,
    angular_velocity: Vec3,
    reason: &'static str,
) {
    // 关系、所属刚体与双方质量必须作为同一批结构变更卸载，避免多个释放来源重复恢复。
    commands.queue(move |world: &mut World| {
        let Some(item_ref) = world.get_entity(item).ok() else {
            return;
        };
        let attachment = item_ref.get::<HeldAttachment>().copied();
        let holder = item_ref.get::<HeldBy>().map(Relationship::get).or_else(|| {
            attachment.and_then(|attachment| {
                world
                    .get::<ColliderOf>(attachment.collider)
                    .map(|of| of.body)
            })
        });
        if attachment.is_none() && item_ref.get::<HeldTarget>().is_none() {
            return;
        }
        if let Some(attachment) = attachment
            && let Ok(mut proxy) = world.get_entity_mut(attachment.collider)
        {
            // 先从 BVH 移除再卸载归属，避免同一碰撞实体在两棵树重复登记。
            proxy.insert(ColliderDisabled).remove::<ColliderOf>();
            proxy.despawn();
        }
        let mut item_entity = world.entity_mut(item);
        item_entity.insert(ColliderDisabled);
        item_entity
            .remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()
            .remove::<Sleeping>()
            .insert((
                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),
                Position(pose.translation),
                Rotation(pose.rotation),
                pose,
                LinearVelocity(linear_velocity),
                AngularVelocity(angular_velocity),
                parcel_collision_layers(),
            ));
        if let Some(attachment) = attachment {
            item_entity.insert(ResumeCarryEasing {
                translation: !attachment.translation_was_paused,
                rotation: !attachment.rotation_was_paused,
            });
            if !attachment.collider_was_disabled {
                item_entity.remove::<ColliderDisabled>();
            }
        } else {
            item_entity.remove::<ColliderDisabled>();
        }
        if let Some(holder) = holder
            && let Some(base) = world.get::<CarryBaseMass>(holder).map(|base| base.0)
        {
            world
                .entity_mut(holder)
                .insert(Mass(base))
                .remove::<CarryBaseMass>();
        }
        info!(target: "demo::gameplay", ?holder, ?item,
            position = ?pose.translation, velocity = ?linear_velocity, ?angular_velocity,
            before = "held", after = "free", reason, "Carryable item released");
    });
}

/// Despawn 观察先排队停用代理，再让 Avian 的刚体卸载与 linked_spawn 清理运行。
pub(super) fn prepare_holder_despawn(
    event: On<Despawn, Character>,
    mut commands: Commands,
    proxies: Query<(Entity, &ColliderOf), With<HeldCollider>>,
) {
    for (proxy, owner) in &proxies {
        if owner.body == event.entity {
            commands
                .entity(proxy)
                .insert(ColliderDisabled)
                .remove::<ColliderOf>();
        }
    }
}

/// 业务箱本身被销毁后清理代理，防止人物带着不可见的附属碰撞继续运动。
pub(super) fn cleanup_orphaned_colliders(
    mut commands: Commands,
    items: Query<(), With<Pickable>>,
    proxies: Query<(Entity, &HeldCollider)>,
) {
    for (proxy, item) in &proxies {
        if !items.contains(item.0) {
            commands
                .entity(proxy)
                .insert(ColliderDisabled)
                .remove::<ColliderOf>()
                .despawn();
        }
    }
}

/// 关系被外部解除或人物销毁时，独立箱实体仍能恢复自由刚体，不产生残留附属碰撞。
pub(super) fn release_orphaned_items(
    mut commands: Commands,
    holders: Query<(), With<Character>>,
    items: Query<
        (
            Entity,
            Option<&HeldBy>,
            &Position,
            &Rotation,
            &Transform,
            &LinearVelocity,
            &AngularVelocity,
        ),
        With<HeldTarget>,
    >,
) {
    for (item, held_by, position, rotation, transform, velocity, angular) in &items {
        let reason = match held_by {
            Some(held_by) if holders.contains(held_by.get()) => continue,
            Some(_) => "holder_missing",
            None => "holding_relation_removed",
        };
        release_item(
            &mut commands,
            item,
            Transform::from_translation(position.0)
                .with_rotation(rotation.0)
                .with_scale(transform.scale),
            velocity.0,
            angular.0,
            reason,
        );
    }
}

/// 箱实体被销毁时关系钩子会清空反向索引，人物仍存活则归还其原质量。
pub(super) fn restore_empty_holder_mass(
    mut commands: Commands,
    mut holders: Query<(Entity, &mut Mass, &CarryBaseMass, Option<&HoldingItems>), With<Character>>,
) {
    for (holder, mut mass, base, holding) in &mut holders {
        if holding.is_some_and(|holding| holding.iter().next().is_some()) {
            continue;
        }
        mass.0 = base.0;
        commands.entity(holder).remove::<CarryBaseMass>();
        info!(target: "demo::carry", ?holder, mass = base.0,
            reason = "held_item_missing", "Holder mass restored after carry relation disappeared");
    }
}

/// 下一固定步在旧端点清除后恢复自由箱插值，保留原本由其他模块设置的暂停项。
pub(super) fn resume_carry_easing(
    mut commands: Commands,
    items: Query<(Entity, &ResumeCarryEasing)>,
) {
    for (item, resume) in &items {
        let mut item = commands.entity(item);
        if resume.translation {
            item.remove::<NoTranslationEasing>();
        }
        if resume.rotation {
            item.remove::<NoRotationEasing>();
        }
        item.remove::<ResumeCarryEasing>();
    }
}
