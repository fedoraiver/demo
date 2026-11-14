//! 统一卸载共享刚体和失效关系，恢复物品独立运动、碰撞与原有插值设置。

use super::{
    HeldAttachment, HeldBy, HeldCollider, HeldCollisionProxy, HeldTarget, HoldingItems,
    ItemCollider, Pickable,
    components::{CarryBaseMass, ResumeInterpolation},
};
use crate::{character::Character, physics::item_collision_layers};
use avian3d::prelude::*;
use bevy::{
    ecs::relationship::{Relationship, RelationshipTarget},
    prelude::*,
};

/// 转向受阻与主动松手共用卸载入口，调用方提供解除前的安全世界姿态和真实速度。
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
        let proxy = item_ref.get::<ItemCollider>().and_then(ItemCollider::get);
        let holder = item_ref
            .get::<HeldBy>()
            .map(Relationship::get)
            .or_else(|| proxy.and_then(|proxy| world.get::<ColliderOf>(proxy).map(|of| of.body)));
        if attachment.is_none() && item_ref.get::<HeldTarget>().is_none() {
            return;
        }
        if let Some(proxy) = proxy
            && let Ok(mut proxy) = world.get_entity_mut(proxy)
        {
            // 先从 BVH 移除再卸载归属，避免同一碰撞实体在两棵树重复登记。
            proxy.insert(ColliderDisabled).remove::<ColliderOf>();
            proxy.despawn();
        }
        let mut item_entity = world.entity_mut(item);
        item_entity.insert(ColliderDisabled);
        item_entity
            .remove::<(HeldBy, HeldTarget, HeldAttachment, ItemCollider, ColliderOf)>()
            .remove::<Sleeping>()
            .insert((
                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),
                Position(pose.translation),
                Rotation(pose.rotation),
                pose,
                LinearVelocity(linear_velocity),
                AngularVelocity(angular_velocity),
                item_collision_layers(),
            ));
        if let Some(attachment) = attachment {
            item_entity.insert(ResumeInterpolation {
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
            && let Some(base) = world.get::<CarryBaseMass>(holder).map(|base| base.mass)
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
    event: On<Despawn<Character>>,
    mut commands: Commands,
    proxies: Query<(Entity, &ColliderOf), With<HeldCollisionProxy>>,
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

/// 关系钩子可能先移除 HeldCollider，独立标记保证解绑与端点销毁后仍能清理代理。
pub(super) fn cleanup_orphaned_colliders(
    mut commands: Commands,
    items: Query<&ItemCollider, (With<HeldAttachment>, With<Pickable>)>,
    proxies: Query<(Entity, Option<&HeldCollider>), With<HeldCollisionProxy>>,
) {
    for (proxy, item) in &proxies {
        let attached = item.is_some_and(|relation| {
            items
                .get(relation.get())
                .is_ok_and(|collider| collider.get() == Some(proxy))
        });
        if !attached {
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
            Option<&HeldAttachment>,
            Option<&ItemCollider>,
            &Position,
            &Rotation,
            &Transform,
            &LinearVelocity,
            &AngularVelocity,
        ),
        Or<(With<HeldTarget>, With<HeldAttachment>)>,
    >,
    proxies: Query<(&HeldCollider, Option<&ColliderOf>), With<HeldCollisionProxy>>,
) {
    for (item, held_by, attachment, collider, position, rotation, transform, velocity, angular) in
        &items
    {
        let reason = match held_by {
            Some(held_by) if holders.contains(held_by.get()) => {
                let proxy = collider
                    .and_then(ItemCollider::get)
                    .and_then(|proxy| proxies.get(proxy).ok());
                if let (Some(attachment), Some((relation, body))) = (attachment, proxy)
                    && relation.get() == item
                    && (attachment.pending || body.is_some_and(|body| body.body == held_by.get()))
                {
                    continue;
                }
                "collision_proxy_missing_or_rebound"
            }
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
        mass.0 = base.mass;
        commands.entity(holder).remove::<CarryBaseMass>();
        info!(target: "demo::carry", ?holder, mass = base.mass,
            reason = "held_item_missing", "Holder mass restored after carry relation disappeared");
    }
}

/// 下一固定步在旧端点清除后恢复自由箱插值，保留原本由其他模块设置的暂停项。
pub(super) fn resume_interpolation(
    mut commands: Commands,
    items: Query<(Entity, &ResumeInterpolation)>,
) {
    for (item, resume) in &items {
        let mut item = commands.entity(item);
        if resume.translation {
            item.remove::<NoTranslationEasing>();
        }
        if resume.rotation {
            item.remove::<NoRotationEasing>();
        }
        item.remove::<ResumeInterpolation>();
    }
}
