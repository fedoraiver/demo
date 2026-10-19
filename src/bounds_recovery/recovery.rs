//! 在越界固定步恢复出生姿态并卸载持握，下一固定步再恢复本功能暂停的插值通道。

use super::SpawnPoint;
#[cfg(test)]
use super::WaterRecoveryOrder;
use crate::{
    character::{Character, CharacterIntent, CharacterMotion},
    item_interaction::{HeldBy, HeldTarget, Pickable, release_item},
    physics::parcel_collision_layers,
};
use avian3d::prelude::*;
use bevy::{
    ecs::{
        query::QueryData,
        relationship::Relationship,
        system::lifetimeless::{Read, Write},
    },
    prelude::*,
};

// 海面顶位于 -1.2 米，保留浸没距离以免岸边接触触发恢复。
pub(super) const WATER_RECOVERY_Y: f32 = -1.5;

/// 记录本次恢复临时添加的插值暂停项，不移除原先由其他功能设置的暂停组件。
#[derive(Component)]
pub(super) struct ResumeInterpolation {
    translation: bool,
    rotation: bool,
}

/// 只收集恢复需要的物理与呈现状态；未配置出生点的实体不参与恢复。
#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct RecoverableBody {
    entity: Entity,
    spawn: Read<SpawnPoint>,
    position: Write<Position>,
    rotation: Write<Rotation>,
    transform: Write<Transform>,
    linear_velocity: Write<LinearVelocity>,
    angular_velocity: Write<AngularVelocity>,
    intent: Option<Write<CharacterIntent>>,
    motion: Option<Write<CharacterMotion>>,
    character: Has<Character>,
    translation_paused: Has<NoTranslationEasing>,
    rotation_paused: Has<NoRotationEasing>,
}

/// 恢复实体自身的出生姿态；角色落水只释放手中物品，物品落水时再独立恢复。
pub(super) fn recover_from_water(
    mut commands: Commands,
    mut bodies: ParamSet<(
        Query<RecoverableBody, Or<(With<Character>, With<Pickable>)>>,
        Query<(
            Entity,
            &HeldBy,
            &Position,
            &Rotation,
            &Transform,
            &LinearVelocity,
            &AngularVelocity,
            Option<&SpawnPoint>,
        )>,
    )>,
    #[cfg(test)] mut recovery_order: ResMut<WaterRecoveryOrder>,
) {
    // 在重置人物前保存持箱的真实世界状态；ParamSet 避免与恢复查询的可变访问冲突。
    let held_items: Vec<_> = bodies
        .p1()
        .iter()
        .map(
            |(item, holder, position, rotation, transform, velocity, angular, spawn)| {
                // 双方同一步落水时，先排队的卸载也必须使用箱子出生姿态，避免实体遍历顺序影响恢复。
                let recovered = (position.y < WATER_RECOVERY_Y).then_some(spawn).flatten();
                (
                    item,
                    holder.get(),
                    recovered.map_or(
                        Transform {
                            translation: position.0,
                            rotation: rotation.0,
                            scale: transform.scale,
                        },
                        |spawn| spawn.0,
                    ),
                    if recovered.is_some() {
                        Vec3::ZERO
                    } else {
                        velocity.0
                    },
                    if recovered.is_some() {
                        Vec3::ZERO
                    } else {
                        angular.0
                    },
                )
            },
        )
        .collect();
    for mut body in &mut bodies.p0() {
        if body.position.y >= WATER_RECOVERY_Y {
            continue;
        }

        let entity = body.entity;
        #[cfg(test)]
        recovery_order.0.push(entity);
        let position_before = body.position.0;
        if body.character {
            for &(item, holder, pose, velocity, angular) in &held_items {
                if holder == entity {
                    release_item(
                        &mut commands,
                        item,
                        pose,
                        velocity,
                        angular,
                        "holder_water_recovery",
                    );
                    info!(target: "demo::island_recovery", ?item, holder = ?entity,
                        before = "held", after = "free", reason = "holder_water_recovery",
                        "Held item released during water recovery");
                }
            }
        } else {
            // 箱体自身也落水时，卸载与恢复出生姿态使用同一状态，不能被后续释放命令拖回海中。
            release_item(
                &mut commands,
                entity,
                body.spawn.0,
                Vec3::ZERO,
                Vec3::ZERO,
                "item_water_recovery",
            );
            commands
                .entity(entity)
                .remove::<(HeldBy, HeldTarget)>()
                .insert(parcel_collision_layers());
        }

        let spawn = body.spawn.0;
        body.position.0 = spawn.translation;
        body.rotation.0 = spawn.rotation;
        *body.transform = spawn;
        body.linear_velocity.0 = Vec3::ZERO;
        body.angular_velocity.0 = Vec3::ZERO;
        if let Some(mut intent) = body.intent {
            // 移动轴是持续输入，保留它才能让按住的移动键在恢复后继续生效。
            intent.jump_pending = false;
            intent.interact_pending = false;
        }
        if let Some(mut motion) = body.motion {
            motion.grounded = false;
        }

        let mut recovered = commands.entity(entity);
        recovered.remove::<Sleeping>().insert(ResumeInterpolation {
            translation: !body.translation_paused,
            rotation: !body.rotation_paused,
        });
        // 固定步内的瞬移默认也会插值；使用 Avian 的官方暂停组件避开旧海中端点。
        // 暂停保持到下一固定步，因此连续没有固定步的渲染帧也不会出现跨岛拖影。
        if !body.translation_paused {
            recovered.insert(NoTranslationEasing);
        }
        if !body.rotation_paused {
            recovered.insert(NoRotationEasing);
        }

        info!(target: "demo::island_recovery", ?entity, ?position_before,
            position_after = ?spawn.translation, reason = "water_recovery",
            "Entity recovered after entering water");
    }
}

/// 下一固定步从恢复后的位置重新采样插值，只移除本模块临时添加的暂停项。
pub(super) fn resume_interpolation(
    mut commands: Commands,
    recovered: Query<(Entity, &ResumeInterpolation)>,
) {
    for (entity, resume) in &recovered {
        let mut entity = commands.entity(entity);
        if resume.translation {
            entity.remove::<NoTranslationEasing>();
        }
        if resume.rotation {
            entity.remove::<NoRotationEasing>();
        }
        entity.remove::<ResumeInterpolation>();
    }
}
