//! 消费一次性交互意图，以视线和本批次预留选择物品；释放保留真实位姿和速度。

use super::{
    HeldBy, HeldTarget, Pickable, begin_attachment,
    queries::{BodyKinematicsReadOnly, FreePickable, InteractingCharacter},
    release_item,
};
use crate::{character::Character, settings::PrototypeConfig};
use avian3d::prelude::*;
use bevy::{ecs::relationship::RelationshipTarget, prelude::*};
use std::collections::HashSet;

/// 拾取建立物理持握关系；释放只解除控制，保留刚体姿态、线速度和角速度。
pub(super) fn handle_interaction(
    mut commands: Commands,
    config: Res<PrototypeConfig>,
    spatial_query: SpatialQuery,
    mut reserved: Local<HashSet<Entity>>,
    mut characters: Query<InteractingCharacter, (With<Character>, Without<Pickable>)>,
    pickables: Query<FreePickable, (With<Pickable>, Without<HeldBy>, Without<Character>)>,
    held_items: Query<BodyKinematicsReadOnly, (With<Pickable>, With<HeldBy>, Without<Character>)>,
) {
    reserved.clear();
    for mut character in &mut characters {
        if !std::mem::take(&mut character.intent.interact_pending) {
            continue;
        }
        if let Some(item) = character.holding.and_then(|items| items.iter().next()) {
            if let Ok(body) = held_items.get(item) {
                release_item(
                    &mut commands,
                    item,
                    Transform {
                        translation: body.position.0,
                        rotation: body.rotation.0,
                        scale: body.transform.scale,
                    },
                    body.velocity.0,
                    body.angular_velocity.0,
                    "interact_action_release",
                );
            }
            continue;
        }
        let origin = character.pose.position.0 + Vec3::Y * config.hold_offset.y;
        let nearest = pickables
            .iter()
            .filter(|item| !reserved.contains(&item.entity))
            .filter_map(|item| {
                let distance = character
                    .pose
                    .position
                    .0
                    .distance_squared(item.pose.position.0);
                if distance > config.pickup_radius.powi(2) {
                    return None;
                }
                // 碰撞世界也约束拾取视线，不能隔着墙抓取箱子。
                let offset = item.pose.position.0 - origin;
                if let Ok(direction) = Dir3::new(offset)
                    && let Some(hit) = spatial_query.cast_ray(
                        origin,
                        direction,
                        offset.length(),
                        true,
                        &SpatialQueryFilter::from_excluded_entities([character.entity]),
                    )
                    && hit.entity != item.entity
                {
                    return None;
                }
                Some((item.entity, distance))
            })
            .min_by(|(_, a), (_, b)| a.total_cmp(b));
        if let Some((item, distance_squared)) = nearest {
            // 同批次延迟命令尚未应用，预留集合防止两个角色同时占用一件物体。
            reserved.insert(item);
            commands.entity(item).insert((
                HeldBy {
                    holder: character.entity,
                },
                HeldTarget {
                    translation: character.pose.position.0
                        + character.transform.rotation * config.hold_offset,
                    rotation: character.transform.rotation,
                },
            ));
            let pickable = pickables
                .get(item)
                .expect("Selected carryable must remain in the interaction query");
            begin_attachment(
                &mut commands,
                item,
                Transform::from_translation(character.pose.position.0)
                    .with_rotation(character.pose.rotation.0),
                Transform {
                    translation: pickable.pose.position.0,
                    rotation: pickable.pose.rotation.0,
                    scale: pickable.transform.scale,
                },
                *pickable.rigid_body,
                pickable.translation_paused,
                pickable.rotation_paused,
                pickable.collider_disabled,
            );
            info!(target: "demo::gameplay",
                character = ?character.entity,
                ?item,
                before = "free",
                after = "held",
                distance = distance_squared.sqrt(),
                reason = "interact_action_pickup",
                "Carryable item picked up"
            );
        } else {
            info!(target: "demo::gameplay",
                character = ?character.entity,
                reason = "no_visible_pickable_in_range",
                "No pickable item in range"
            );
        }
    }
}
