//! 消费一次性交互意图，以视线和本批次预留选择物品；释放保留真实位姿和速度。

use super::{HeldBy, HeldTarget, HoldingItems, Pickable, begin_attachment, release_item};
use crate::{
    audio::{SoundCue, SoundRequest},
    character::{Character, CharacterIntent},
    settings::PrototypeConfig,
};
use avian3d::prelude::*;
use bevy::{ecs::relationship::RelationshipTarget, prelude::*};
use std::collections::HashSet;

/// 拾取建立物理持握关系；释放只解除控制，保留刚体姿态、线速度和角速度。
pub(super) fn handle_interaction(
    mut commands: Commands,
    config: Res<PrototypeConfig>,
    spatial_query: SpatialQuery,
    mut reserved: Local<HashSet<Entity>>,
    mut characters: Query<
        (
            Entity,
            &Position,
            &Rotation,
            &Transform,
            &mut CharacterIntent,
            Option<&HoldingItems>,
        ),
        (With<Character>, Without<Pickable>),
    >,
    pickables: Query<
        (
            Entity,
            &Position,
            &Rotation,
            &Transform,
            &RigidBody,
            Has<NoTranslationEasing>,
            Has<NoRotationEasing>,
            Has<ColliderDisabled>,
        ),
        (With<Pickable>, Without<HeldBy>, Without<Character>),
    >,
    held_items: Query<
        (
            &Position,
            &Rotation,
            &Transform,
            &LinearVelocity,
            &AngularVelocity,
        ),
        (With<Pickable>, With<HeldBy>, Without<Character>),
    >,
) {
    reserved.clear();
    for (character, position, rotation, transform, mut intent, holding) in &mut characters {
        if !std::mem::take(&mut intent.interact_pending) {
            continue;
        }
        if let Some(item) = holding.and_then(|items| items.iter().next()) {
            if let Ok((item_position, item_rotation, item_transform, velocity, angular_velocity)) =
                held_items.get(item)
            {
                release_item(
                    &mut commands,
                    item,
                    Transform {
                        translation: item_position.0,
                        rotation: item_rotation.0,
                        scale: item_transform.scale,
                    },
                    velocity.0,
                    angular_velocity.0,
                    "interact_action_release",
                );
                // 延迟消息与解除关系一起提交，播放者只能收到已接受的交互结果。
                commands.write_message(SoundRequest::new(SoundCue::ParcelRelease, item));
            }
            continue;
        }
        let origin = position.0 + Vec3::Y * config.hold_offset.y;
        let nearest = pickables
            .iter()
            .filter(|(item, ..)| !reserved.contains(item))
            .filter_map(|(item, item_position, ..)| {
                let distance = position.0.distance_squared(item_position.0);
                if distance > config.pickup_radius.powi(2) {
                    return None;
                }
                // 碰撞世界也约束拾取视线，不能隔着墙抓取箱子。
                let offset = item_position.0 - origin;
                if let Ok(direction) = Dir3::new(offset)
                    && let Some(hit) = spatial_query.cast_ray(
                        origin,
                        direction,
                        offset.length(),
                        true,
                        &SpatialQueryFilter::from_excluded_entities([character]),
                    )
                    && hit.entity != item
                {
                    return None;
                }
                Some((item, distance))
            })
            .min_by(|(_, a), (_, b)| a.total_cmp(b));
        if let Some((item, distance_squared)) = nearest {
            // 同批次延迟命令尚未应用，预留集合防止两个角色同时占用一件物体。
            reserved.insert(item);
            commands.entity(item).insert((
                HeldBy(character),
                HeldTarget {
                    translation: position.0 + transform.rotation * config.hold_offset,
                    rotation: transform.rotation,
                },
            ));
            let (
                _,
                item_position,
                item_rotation,
                item_transform,
                body,
                translation_paused,
                rotation_paused,
                collider_disabled,
            ) = pickables
                .get(item)
                .expect("Selected carryable must remain in the interaction query");
            begin_attachment(
                &mut commands,
                item,
                Transform::from_translation(position.0).with_rotation(rotation.0),
                Transform {
                    translation: item_position.0,
                    rotation: item_rotation.0,
                    scale: item_transform.scale,
                },
                *body,
                translation_paused,
                rotation_paused,
                collider_disabled,
            );
            commands.write_message(SoundRequest::new(SoundCue::ParcelPickup, item));
            info!(target: "demo::gameplay",
                ?character,
                ?item,
                before = "free",
                after = "held",
                distance = distance_squared.sqrt(),
                reason = "interact_action_pickup",
                "Carryable item picked up"
            );
        } else {
            info!(target: "demo::gameplay",
                ?character,
                reason = "no_visible_pickable_in_range",
                "No pickable item in range"
            );
        }
    }
}
