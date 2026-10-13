//! 手持箱使用角色的同一刚体；独立业务根保留身份、碰撞形状和释放后的运动状态。

use avian3d::{interpolation::TransformEasingSystems, prelude::*};
use bevy::{
    ecs::relationship::{Relationship, RelationshipTarget},
    prelude::*,
};

use crate::{
    app_flow::gameplay_running,
    carry_rotation::CarryRotationQuery,
    gameplay::{
        CarryGrip, Character, GameplaySystems, HeldBy, HeldTarget, HoldingItems, Pickable,
        PrototypeConfig,
    },
    physics::parcel_collision_layers,
};

// 拾取先保持真实姿态，再沿经过碰撞检查的小步对齐双手，不能瞬间把箱子塞进障碍。
const ALIGN_SPEED: f32 = 5.0;
const ALIGN_ANGULAR_SPEED: f32 = std::f32::consts::TAU;
const ALIGN_BLOCKED_TIMEOUT: f32 = 0.35;

/// 实际碰撞形状相对组合刚体的姿态；箱实体不成为人物的 ChildOf，避免异常销毁时连带消失。
#[derive(Component, Clone, Copy)]
pub(crate) struct HeldAttachment {
    pub(crate) collider: Entity,
    pub(crate) local_pose: Transform,
    pending: bool,
    free_body: RigidBody,
    translation_was_paused: bool,
    rotation_was_paused: bool,
    collider_was_disabled: bool,
    blocked_seconds: f32,
}

/// 无视觉碰撞代理对应的快递身份；代理随组合体清理，业务箱根始终独立。
#[derive(Component)]
pub(crate) struct HeldCollider(pub(crate) Entity);

/// 独立箱根不属于人物的 Children，显式保存原质量供挂接和解除时恢复。
#[derive(Component)]
struct CarryBaseMass(f32);

/// 释放后先丢弃手持期间的插值端点，再恢复调用前未暂停的插值通道。
#[derive(Component)]
struct ResumeCarryEasing {
    translation: bool,
    rotation: bool,
}

/// 注册装卸、碰撞姿态与插值恢复；呈现由相机的同帧同步链调用。
pub(crate) struct CarryPlugin;

impl Plugin for CarryPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            FixedFirst,
            resume_carry_easing
                .after(TransformEasingSystems::Reset)
                .before(TransformEasingSystems::UpdateStart)
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
                // Remove<RigidBody> 的 Avian Observer 会延迟移除 ColliderOf，必须先应用再挂接。
                .chain()
                .after(GameplaySystems::Simulate)
                .run_if(gameplay_running),
        )
        .add_systems(
            FixedPostUpdate,
            sync_held_physics
                .after(PhysicsSystems::Writeback)
                .run_if(gameplay_running),
        )
        .add_observer(prepare_holder_despawn);
    }
}

/// 开始挂接但不改变箱子的世界姿态，等待刚体移除及其 Observer 命令完成。
pub(crate) fn begin_attachment(
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
fn finish_attachments(
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
            commands.entity(holder).insert(CarryBaseMass(holder_mass.0));
        }
        commands.entity(holder).insert(Mass(holder_mass.0 + mass.0));
        // RigidBodyColliders 的 linked_spawn 会销毁附属碰撞，因此使用代理保护独立业务箱。
        // 代理复制真实形状和表面配置，不含模型子树，也没有第二个 Dynamic。
        commands
            .entity(attachment.collider)
            .insert((
                Name::new("Held parcel collision proxy"),
                HeldCollider(item),
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
fn world_pose(holder: Transform, local: Transform) -> Transform {
    Transform {
        translation: holder.translation + holder.rotation * local.translation,
        rotation: holder.rotation * local.rotation,
        scale: local.scale,
    }
}

/// 有限的小步对齐不会积分箱体力；受阻保留安全姿态，持续受阻则解除持握。
fn align_attachments(
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
        let target = grip.map_or(config.hold_offset, |grip| grip.0);
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

/// 同步组合体内箱子的真实世界姿态和速度，不依赖人物是否具有视觉 Children。
pub(crate) fn sync_held_physics(
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
pub(crate) fn sync_held_presentation(
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
        target.translation =
            holder.translation + holder.rotation * grip.map_or(config.hold_offset, |grip| grip.0);
        target.rotation = holder.rotation;
        if let Some(attachment) = attachment
            && !attachment.pending
        {
            *transform = world_pose(*holder, attachment.local_pose);
        }
    }
}

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
fn prepare_holder_despawn(
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
fn cleanup_orphaned_colliders(
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
fn release_orphaned_items(
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
fn restore_empty_holder_mass(
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
fn resume_carry_easing(mut commands: Commands, items: Query<(Entity, &ResumeCarryEasing)>) {
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

#[cfg(test)]
#[path = "carry_tests.rs"]
mod tests;
