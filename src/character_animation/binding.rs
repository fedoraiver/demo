//! 只为标记的主角子树绑定命名片段，等待异步 glTF 和片段时长齐备。

use avian3d::prelude::LinearVelocity;
use bevy::{animation::RepeatAnimation, prelude::*, world_serialization::WorldInstanceReady};

use crate::{
    character::{Character, CharacterMotion},
    item_interaction::HoldingItems,
};

use super::{CourierVisual, grounding::*, state::*};

/// 等待 glTF 场景和命名动画都可用，避免异步子资产先完成时错过初始化。
#[derive(Component)]
pub(super) struct CourierAnimationPending;

pub(super) fn mark_courier_animation_ready(
    ready: On<WorldInstanceReady>,
    mut commands: Commands,
    couriers: Query<(), With<CourierVisual>>,
) {
    if couriers.contains(ready.entity) {
        commands
            .entity(ready.entity)
            .insert(CourierAnimationPending);
    }
}

/// 场景就绪后只遍历该视觉根的子树，避免把 NPC 或其他模型的播放器接到主角上。
pub(super) fn initialize_ready_couriers(
    mut commands: Commands,
    roots: Query<(Entity, &CourierVisual, &ChildOf, &Transform), With<CourierAnimationPending>>,
    characters: Query<
        (
            &LinearVelocity,
            &Transform,
            &CharacterMotion,
            Option<&HoldingItems>,
        ),
        With<Character>,
    >,
    children: Query<&Children>,
    names: Query<&Name>,
    gltfs: Res<Assets<Gltf>>,
    clips: Res<Assets<AnimationClip>>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
    mut players: Query<&mut AnimationPlayer>,
) {
    for (visual_root, visual, parent, visual_transform) in &roots {
        let character = parent.parent();
        let Ok((velocity, transform, motion, holding)) = characters.get(character) else {
            warn!(target: "demo::character_animation", ?visual_root, ?character,
                reason = "invalid_character_parent", "Courier animation binding skipped");
            commands
                .entity(visual_root)
                .remove::<CourierAnimationPending>();
            continue;
        };
        let Some(gltf) = gltfs.get(&visual.gltf) else {
            continue;
        };
        let named_clips: Result<Vec<_>, _> = CourierAnimationState::ALL
            .iter()
            .map(|state| {
                gltf.named_animations
                    .get(state.name())
                    .cloned()
                    .ok_or(state.name())
            })
            .collect();
        let named_clips = match named_clips {
            Ok(named_clips) => named_clips,
            Err(animation_name) => {
                error!(target: "demo::character_animation", ?visual_root, ?character,
                    animation_name, reason = "missing_named_animation",
                    "Courier animation binding failed");
                commands
                    .entity(visual_root)
                    .remove::<CourierAnimationPending>();
                continue;
            }
        };
        // 命名句柄存在不代表异步片段已经入库；等待所有时长后再建立统一相位。
        let durations: Option<Vec<_>> = named_clips
            .iter()
            .map(|handle| clips.get(handle).map(AnimationClip::duration))
            .collect();
        let Some(durations) = durations else {
            continue;
        };
        if let Some(index) = durations
            .iter()
            .position(|duration| !duration.is_finite() || *duration <= 0.0)
        {
            error!(target: "demo::character_animation", ?visual_root, ?character,
                animation_name = CourierAnimationState::ALL[index].name(),
                duration = durations[index], reason = "invalid_animation_duration",
                "Courier animation binding failed");
            commands
                .entity(visual_root)
                .remove::<CourierAnimationPending>();
            continue;
        }
        let (graph, indices) = AnimationGraph::from_clips(named_clips);
        let nodes = CourierAnimationNodes {
            indices: indices
                .try_into()
                .expect("all named animations were loaded"),
            durations: durations
                .try_into()
                .expect("all animation durations were loaded"),
        };
        let graph_handle = graphs.add(graph);
        let rising = velocity.y > 0.35;
        let grounded = motion.grounded && velocity.y <= 0.5;
        let jump_phase = if grounded {
            CourierJumpPhase::Grounded
        } else if rising {
            CourierJumpPhase::Rising
        } else {
            CourierJumpPhase::Falling
        };
        let target = animation_target(
            velocity.0,
            transform.rotation,
            grounded,
            rising,
            has_held_item(holding),
        );
        let current = dominant_animation(&target.weights, CourierAnimationState::Idle);
        let mut player_count = 0;
        let mut first_player = None;
        for descendant in children.iter_descendants(visual_root) {
            let Ok(mut player) = players.get_mut(descendant) else {
                continue;
            };
            // 全部片段保持关联；方向变化和拾取不重播，避免左右脚相位突然归零。
            player.stop_all();
            for state in CourierAnimationState::ALL {
                let active = player.play(nodes.node(state));
                active.repeat().set_weight(target.weights[state as usize]);
                if state.is_locomotion() {
                    active.set_speed(0.0);
                } else if state.is_jump_phase() {
                    active.pause().set_speed(0.0);
                    if state.is_one_shot() {
                        active.set_repeat(RepeatAnimation::Never);
                    }
                }
            }
            commands.entity(descendant).remove::<AnimationTransitions>();
            commands.entity(descendant).insert((
                AnimationGraphHandle(graph_handle.clone()),
                CourierAnimation {
                    character,
                    nodes,
                    weights: target.weights,
                    gait_phase: 0.0,
                    grounded,
                    ungrounded_time: 0.0,
                    rising,
                    airborne_confirmed: !grounded && velocity.y.abs() > 0.5,
                    jump_phase,
                    jump_elapsed: 0.0,
                    fall_elapsed: 0.0,
                    landing_elapsed: LAND_VISUAL_DURATION,
                    current,
                },
            ));
            player_count += 1;
            first_player.get_or_insert(descendant);
        }
        commands
            .entity(visual_root)
            .remove::<CourierAnimationPending>();
        if player_count == 0 {
            warn!(target: "demo::character_animation", ?visual_root, ?character,
                reason = "animation_player_missing", "Courier animation binding skipped");
        } else {
            // 名字只用于资源契约绑定；逐帧系统持有实体身份，不扫描名字或整个世界。
            let sole_markers: Option<Vec<_>> = SOLE_MARKER_NAMES
                .iter()
                .map(|marker_name| {
                    children.iter_descendants(visual_root).find(|entity| {
                        names
                            .get(*entity)
                            .is_ok_and(|name| name.as_str() == *marker_name)
                    })
                })
                .collect();
            let foot_grounding_enabled = sole_markers.is_some();
            if let Some(sole_markers) = sole_markers {
                commands.entity(visual_root).insert(CourierFootGrounding {
                    character,
                    animation_player: first_player.expect("a courier player was bound"),
                    sole_markers: sole_markers
                        .try_into()
                        .expect("all sole markers were found"),
                    base_translation: visual_transform.translation,
                    offset: 0.0,
                });
            } else {
                warn!(target: "demo::character_animation", ?visual_root, ?character,
                    reason = "sole_markers_missing", "Courier foot grounding unavailable");
            }
            info!(target: "demo::character_animation", ?visual_root, ?character,
                player_count, clip_count = ANIMATION_COUNT, animation_after = current.name(),
                forward_reference_speed = FORWARD_REFERENCE_SPEED,
                sideways_reference_speed = SIDEWAYS_REFERENCE_SPEED,
                blend_time_constant = BLEND_TIME_CONSTANT,
                foot_grounding_enabled, sole_clearance = SOLE_CLEARANCE,
                reason = "world_instance_ready",
                "Courier animation initialized");
        }
    }
}
