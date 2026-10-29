//! 主角动画绑定、混合、跳跃与视觉接地的无窗口回归。

use super::{binding::CourierAnimationPending, *};

mod test_support {
    //! 真实动画图的最小无窗口装配与断言辅助。

    pub(super) use std::time::Duration;

    pub(super) use crate::character::{Character, CharacterMotion};
    pub(super) use avian3d::prelude::LinearVelocity;

    use super::*;
    pub(super) use bevy::{
        animation::{AnimatedBy, AnimationTargetId, animated_field},
        ecs::relationship::Relationship,
        world_serialization::{WorldAsset, WorldInstanceReady, WorldInstanceSpawner},
    };

    pub(super) use crate::{first_person::CharacterVisual, item_interaction::HeldBy};

    pub(super) fn animation_app() -> App {
        let mut app = App::new();
        // 使用真实图求值、播放器与目标更新；只安装资产和任务池，不创建窗口或渲染器。
        app.add_plugins((
            TaskPoolPlugin::default(),
            AssetPlugin::default(),
            AnimationPlugin,
            TransformPlugin,
        ))
        .init_resource::<Assets<Gltf>>()
        .init_resource::<Assets<WorldAsset>>()
        .init_resource::<Time>()
        .add_plugins(CharacterAnimationPlugin);
        app.finish();
        app.cleanup();
        app
    }

    pub(super) fn courier_asset(app: &mut App) -> Handle<Gltf> {
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        let mut named = Vec::new();
        for state in CourierAnimationState::ALL {
            let mut clip = AnimationClip::default();
            clip.set_duration(GAIT_CYCLE_DURATION);
            named.push((state.name().into(), clips.add(clip)));
        }
        let gltf = Gltf {
            scenes: default(),
            named_scenes: default(),
            meshes: default(),
            named_meshes: default(),
            materials: default(),
            named_materials: default(),
            nodes: default(),
            named_nodes: default(),
            skins: default(),
            named_skins: default(),
            default_scene: None,
            // 排列故意与动作图不同，确保生产代码按名字绑定。
            animations: named.iter().rev().map(|(_, clip)| clip.clone()).collect(),
            named_animations: named.into_iter().collect(),
            source: None,
        };
        app.world_mut().resource_mut::<Assets<Gltf>>().add(gltf)
    }

    pub(super) fn spawn_courier(app: &mut App, asset: Handle<Gltf>) -> (Entity, Entity, Entity) {
        let character = app
            .world_mut()
            .spawn((
                Character,
                LinearVelocity::ZERO,
                Transform::default(),
                CharacterMotion { grounded: true },
            ))
            .id();
        let visual = app
            .world_mut()
            .spawn((
                CourierVisual { gltf: asset },
                CharacterVisual,
                ChildOf(character),
            ))
            .id();
        let armature = app
            .world_mut()
            .spawn((Transform::default(), ChildOf(visual)))
            .id();
        let player = app
            .world_mut()
            .spawn((
                AnimationPlayer::default(),
                Transform::default(),
                ChildOf(armature),
            ))
            .id();
        for name in SOLE_MARKER_NAMES {
            app.world_mut().spawn((
                Name::new(name),
                Transform::from_xyz(0.0, 0.012, 0.0),
                ChildOf(player),
            ));
        }
        (character, visual, player)
    }

    pub(super) fn notify_ready(app: &mut App, visual: Entity) {
        // 用最小空世界取得有效实例标识，不加载窗口或完整游戏。
        let asset = app
            .world_mut()
            .resource_mut::<Assets<WorldAsset>>()
            .add(WorldAsset::new(World::new()));
        let instance_id = WorldInstanceSpawner::default()
            .spawn_sync(app.world_mut(), asset.id())
            .unwrap();
        app.world_mut().trigger(WorldInstanceReady {
            entity: visual,
            instance_id,
        });
    }

    pub(super) fn step(app: &mut App, seconds: f32) {
        app.world_mut()
            .resource_mut::<Time>()
            .advance_by(Duration::from_secs_f32(seconds));
        app.update();
    }

    pub(super) fn weight(app: &App, player: Entity, state: CourierAnimationState) -> f32 {
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        app.world()
            .get::<AnimationPlayer>(player)
            .unwrap()
            .animation(animation.nodes.node(state))
            .unwrap()
            .weight()
    }

    pub(super) fn set_velocity(app: &mut App, character: Entity, velocity: Vec3) {
        app.world_mut()
            .get_mut::<LinearVelocity>(character)
            .unwrap()
            .0 = velocity;
    }

    pub(super) fn phase_seek(app: &App, player: Entity, state: CourierAnimationState) -> f32 {
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        app.world()
            .get::<AnimationPlayer>(player)
            .unwrap()
            .animation(animation.nodes.node(state))
            .unwrap()
            .seek_time()
    }

    pub(super) fn jump_pose_bone(app: &mut App, asset: &Handle<Gltf>, player: Entity) -> Entity {
        let target_id = AnimationTargetId::from_name(&Name::new("jump_pose"));
        let named = app
            .world()
            .resource::<Assets<Gltf>>()
            .get(asset)
            .unwrap()
            .named_animations
            .clone();
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        // 全部片段覆盖同一字段，让断言检查真实图求值后的动态姿态，而非只检查播放器权重。
        for state in CourierAnimationState::ALL {
            let heights = match state {
                CourierAnimationState::Jump | CourierAnimationState::CarryJump => [0.0, 0.2, 0.25],
                CourierAnimationState::Fall | CourierAnimationState::CarryFall => [0.25, 0.2, 0.25],
                CourierAnimationState::Land | CourierAnimationState::CarryLand => {
                    [-0.12, -0.10, 0.0]
                }
                _ => [0.0; 3],
            };
            clips
                .get_mut(&named[state.name()])
                .unwrap()
                .add_curve_to_target(
                    target_id,
                    AnimatableCurve::new(
                        animated_field!(Transform::translation),
                        UnevenSampleAutoCurve::new([
                            (0.0, Vec3::Y * heights[0]),
                            (0.4, Vec3::Y * heights[1]),
                            (0.8, Vec3::Y * heights[2]),
                        ])
                        .unwrap(),
                    ),
                );
        }
        app.world_mut()
            .spawn((
                target_id,
                AnimatedBy(player),
                Transform::default(),
                ChildOf(player),
            ))
            .id()
    }

    pub(super) fn assert_gait_phase(app: &App, player: Entity, expected: f32) {
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        let active = app.world().get::<AnimationPlayer>(player).unwrap();
        assert!((animation.gait_phase - expected).abs() < 1.0e-5);
        for state in CourierAnimationState::ALL {
            if state.is_locomotion() {
                let index = state as usize;
                let actual = active
                    .animation(animation.nodes.node(state))
                    .unwrap()
                    .seek_time()
                    / animation.nodes.durations[index];
                assert!((actual - expected).abs() < 1.0e-5);
            }
        }
        let sum: f32 = active
            .playing_animations()
            .map(|(_, clip)| clip.weight())
            .sum();
        assert!((sum - 1.0).abs() < 1.0e-5);
    }
}

mod binding_tests {
    //! 无窗口覆盖主角动画的 binding 行为。

    use super::test_support::*;
    use super::*;

    #[test]
    fn only_courier_subtree_binds_named_clips() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (_, visual, player) = spawn_courier(&mut app, asset.clone());
        let npc = app.world_mut().spawn_empty().id();
        let npc_visual = app.world_mut().spawn(ChildOf(npc)).id();
        let npc_player = app
            .world_mut()
            .spawn((AnimationPlayer::default(), ChildOf(npc_visual)))
            .id();
        let invalid_visual = app
            .world_mut()
            .spawn((
                CourierVisual {
                    gltf: asset.clone(),
                },
                ChildOf(npc),
            ))
            .id();
        let invalid_player = app
            .world_mut()
            .spawn((AnimationPlayer::default(), ChildOf(invalid_visual)))
            .id();
        for root in [visual, npc_visual, invalid_visual] {
            notify_ready(&mut app, root);
        }
        step(&mut app, 0.0);
        for other in [npc_player, invalid_player] {
            assert!(app.world().get::<CourierAnimation>(other).is_none());
            assert!(app.world().get::<AnimationGraphHandle>(other).is_none());
        }
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        let graph_handle = app.world().get::<AnimationGraphHandle>(player).unwrap();
        let graph = app
            .world()
            .resource::<Assets<AnimationGraph>>()
            .get(&graph_handle.0)
            .unwrap();
        let gltf = app.world().resource::<Assets<Gltf>>().get(&asset).unwrap();
        for state in CourierAnimationState::ALL {
            let AnimationNodeType::Clip(clip) = &graph[animation.nodes.node(state)].node_type
            else {
                panic!("expected a clip node");
            };
            assert_eq!(clip.id(), gltf.named_animations[state.name()].id());
        }
        assert!(app.world().get::<AnimationTransitions>(player).is_none());
    }

    #[test]
    fn pending_scene_waits_for_gltf_and_clip_assets() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let gltf = app
            .world_mut()
            .resource_mut::<Assets<Gltf>>()
            .remove(&asset)
            .unwrap();
        let (_, visual, player) = spawn_courier(&mut app, asset.clone());
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        let clip_handle = gltf.named_animations["Walk_Right"].clone();
        let clip = app
            .world_mut()
            .resource_mut::<Assets<AnimationClip>>()
            .remove(&clip_handle)
            .unwrap();
        app.world_mut()
            .resource_mut::<Assets<Gltf>>()
            .insert(asset.id(), gltf)
            .unwrap();
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        app.world_mut()
            .resource_mut::<Assets<AnimationClip>>()
            .insert(clip_handle.id(), clip)
            .unwrap();
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_some());
        assert!(app.world().get::<CourierAnimationPending>(visual).is_none());
    }

    #[test]
    fn missing_named_clip_fails_binding_without_partial_player_state() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        app.world_mut()
            .resource_mut::<Assets<Gltf>>()
            .get_mut(&asset)
            .unwrap()
            .named_animations
            .remove("Carry_Right");
        let (_, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        assert!(app.world().get::<CourierAnimationPending>(visual).is_none());
        assert_eq!(
            app.world()
                .get::<AnimationPlayer>(player)
                .unwrap()
                .playing_animations()
                .count(),
            0
        );
    }

    #[test]
    fn missing_character_detaches_surviving_player() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        // 模拟视觉被外部重挂后旧角色销毁，播放器不能继续读取失效关联。
        app.world_mut().entity_mut(visual).remove::<ChildOf>();
        app.world_mut().despawn(character);
        step(&mut app, 0.0);
        assert!(app.world().get::<CourierAnimation>(player).is_none());
        assert!(app.world().get::<AnimationGraphHandle>(player).is_none());
        assert!(app.world().get::<CourierFootGrounding>(visual).is_none());
        assert_eq!(
            app.world()
                .get::<AnimationPlayer>(player)
                .unwrap()
                .playing_animations()
                .count(),
            0
        );
    }
}

mod grounding_tests {
    //! 无窗口覆盖主角动画的 grounding 行为。

    use super::test_support::*;
    use super::*;

    #[test]
    fn evaluated_direction_blend_keeps_sole_above_physics_feet_without_accumulating() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let hip_id = AnimationTargetId::from_name(&Name::new("hip"));
        let named = app
            .world()
            .resource::<Assets<Gltf>>()
            .get(&asset)
            .unwrap()
            .named_animations
            .clone();
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        // 两个单动作都抬脚，但旋转插值使弯腿变直，真实复现方向混合的穿地来源。
        for state in CourierAnimationState::ALL {
            let angle = match state {
                CourierAnimationState::Walk => 0.35,
                CourierAnimationState::WalkRight => -0.35,
                _ => 0.0,
            };
            let rotation = Quat::from_rotation_x(angle);
            clips
                .get_mut(&named[state.name()])
                .unwrap()
                .add_curve_to_target(
                    hip_id,
                    AnimatableCurve::new(
                        animated_field!(Transform::rotation),
                        UnevenSampleAutoCurve::new([(0.0, rotation), (0.8, rotation)]).unwrap(),
                    ),
                );
        }
        let (character, visual, player) = spawn_courier(&mut app, asset);
        let hip = app
            .world_mut()
            .spawn((
                hip_id,
                AnimatedBy(player),
                Transform::from_xyz(0.0, 0.97, 0.0),
                ChildOf(player),
            ))
            .id();
        let foot = app
            .world_mut()
            .spawn((Transform::from_xyz(0.0, -1.0, 0.0), ChildOf(hip)))
            .id();
        let mut marker_query = app.world_mut().query::<(Entity, &Name)>();
        let markers: Vec<_> = marker_query
            .iter(app.world())
            .filter(|(_, name)| name.as_str().starts_with("Courier_Sole_"))
            .map(|(entity, _)| entity)
            .collect();
        for (index, entity) in markers.iter().enumerate() {
            app.world_mut().entity_mut(*entity).insert((
                Transform::from_xyz(
                    if index % 2 == 0 { -0.1 } else { 0.1 },
                    0.0,
                    if index % 4 < 2 { -0.03 } else { 0.03 },
                ),
                ChildOf(foot),
            ));
        }
        set_velocity(
            &mut app,
            character,
            Vec3::new(SIDEWAYS_REFERENCE_SPEED, 0.0, -FORWARD_REFERENCE_SPEED),
        );
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        let offset = app.world().get::<Transform>(visual).unwrap().translation.y;
        assert!((offset - 0.033).abs() < 1.0e-5);
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
        for _ in 0..8 {
            step(&mut app, 1.0 / 120.0);
            // 检查实际帧末 GlobalTransform，不能补跑传播或改用上一帧骨骼姿态。
            for marker in &markers {
                assert!(
                    app.world()
                        .get::<GlobalTransform>(*marker)
                        .unwrap()
                        .translation()
                        .y
                        >= SOLE_CLEARANCE - 1.0e-5
                );
            }
            assert!(
                (app.world().get::<Transform>(visual).unwrap().translation.y - offset).abs()
                    < 1.0e-5
            );
        }
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        step(&mut app, 1.0 / 60.0);
        assert!(app.world().get::<Transform>(visual).unwrap().translation.y < offset);
        assert!(app.world().get::<Transform>(visual).unwrap().translation.y > 0.0);
    }
}

mod jump_tests {
    //! 无窗口覆盖主角动画的 jump 行为。

    use super::test_support::*;
    use super::*;

    #[test]
    fn air_states_filter_grounding_noise_and_freeze_walking_phase() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        notify_ready(&mut app, visual);
        step(&mut app, 0.1);
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = false;
        step(&mut app, 0.02);
        assert!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .grounded
        );
        assert_eq!(weight(&app, player, CourierAnimationState::Fall), 0.0);

        set_velocity(&mut app, character, Vec3::new(0.0, 5.0, -1.5));
        step(&mut app, 0.01);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::Jump
        );
        assert_gait_phase(&app, player, 0.15);
        set_velocity(&mut app, character, Vec3::new(0.0, -0.1, -1.5));
        step(&mut app, 0.01);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::Jump
        );
        set_velocity(&mut app, character, Vec3::new(0.0, -1.0, -1.5));
        app.world_mut()
            .spawn(<HeldBy as Relationship>::from(character));
        step(&mut app, 0.05);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::CarryFall
        );
        assert_gait_phase(&app, player, 0.15);

        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = true;
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        step(&mut app, 0.02);
        assert!(weight(&app, player, CourierAnimationState::CarryLand) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::CarryFall) > 0.0);
        assert_gait_phase(&app, player, 0.15);
        step(&mut app, LAND_VISUAL_DURATION);
        assert!(weight(&app, player, CourierAnimationState::CarryWalk) > 0.0);
        assert_gait_phase(&app, player, 0.425);
    }

    #[test]
    fn upward_velocity_overrides_raw_grounding_and_jump_pose_moves_once_then_holds() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        set_velocity(&mut app, character, Vec3::Y * 5.0);
        // 有意保留 raw grounded=true，复现起跳首帧接地数据尚未刷新的边界。
        step(&mut app, 0.01);
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        assert!(!animation.grounded);
        assert_eq!(animation.jump_phase, CourierJumpPhase::Rising);
        assert_eq!(phase_seek(&app, player, CourierAnimationState::Jump), 0.0);
        step(&mut app, 0.12);
        assert!((phase_seek(&app, player, CourierAnimationState::Jump) - 0.4).abs() < 1.0e-5);
        assert!(app.world().get::<Transform>(bone).unwrap().translation.y > 0.1);

        let item = app
            .world_mut()
            .spawn(<HeldBy as Relationship>::from(character))
            .id();
        step(&mut app, 0.03);
        for state in [
            CourierAnimationState::Jump,
            CourierAnimationState::CarryJump,
        ] {
            assert!((phase_seek(&app, player, state) - 0.5).abs() < 1.0e-5);
        }
        step(&mut app, 0.5);
        let end_height = app.world().get::<Transform>(bone).unwrap().translation.y;
        assert!((end_height - 0.25).abs() < 0.001);
        step(&mut app, 0.4);
        for state in [
            CourierAnimationState::Jump,
            CourierAnimationState::CarryJump,
        ] {
            // 实际 AnimationPlugin 执行后仍停在最后一帧，不能被内部自动推进环回第一帧。
            assert_eq!(phase_seek(&app, player, state), GAIT_CYCLE_DURATION);
        }
        assert!(
            (app.world().get::<Transform>(bone).unwrap().translation.y - end_height).abs() < 0.001
        );

        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = false;
        set_velocity(&mut app, character, Vec3::Y * -0.1);
        step(&mut app, 0.01);
        assert_eq!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .jump_phase,
            CourierJumpPhase::Rising
        );
        set_velocity(&mut app, character, Vec3::Y * -0.5);
        step(&mut app, 0.01);
        assert_eq!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .jump_phase,
            CourierJumpPhase::Falling
        );
        step(&mut app, 0.08);
        app.world_mut().entity_mut(item).remove::<HeldBy>();
        step(&mut app, 0.03);
        for state in [
            CourierAnimationState::Fall,
            CourierAnimationState::CarryFall,
        ] {
            assert!((phase_seek(&app, player, state) - 0.11).abs() < 1.0e-5);
        }
        assert_eq!(
            phase_seek(&app, player, CourierAnimationState::Jump),
            GAIT_CYCLE_DURATION
        );
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
    }

    #[test]
    fn initial_raw_grounded_frame_with_upward_velocity_binds_jump_immediately() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        set_velocity(&mut app, character, Vec3::Y * 5.0);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert_eq!(weight(&app, player, CourierAnimationState::Jump), 1.0);
        assert!(
            !app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .grounded
        );
        step(&mut app, 0.12);
        assert!((app.world().get::<Transform>(bone).unwrap().translation.y - 0.2).abs() < 1.0e-5);
    }

    #[test]
    fn first_support_probe_does_not_fake_landing_but_sustained_initial_air_does() {
        for unsupported_time in [0.0, AIRBORNE_DELAY + 0.01] {
            let mut app = animation_app();
            let asset = courier_asset(&mut app);
            let (character, visual, player) = spawn_courier(&mut app, asset.clone());
            let bone = jump_pose_bone(&mut app, &asset, player);
            // 两种初态都有 raw grounded=false 和零竖直速度：尚未探测支撑与高处刚开始坠落。
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = false;
            notify_ready(&mut app, visual);
            step(&mut app, 0.0);
            if unsupported_time > 0.0 {
                step(&mut app, unsupported_time);
            }
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = true;
            step(&mut app, 0.01);
            let animation = app.world().get::<CourierAnimation>(player).unwrap();
            if unsupported_time == 0.0 {
                assert_eq!(animation.jump_phase, CourierJumpPhase::Grounded);
                for _ in 0..12 {
                    step(&mut app, 1.0 / 60.0);
                    assert_eq!(weight(&app, player, CourierAnimationState::Land), 0.0);
                    assert_eq!(weight(&app, player, CourierAnimationState::CarryLand), 0.0);
                    // 使用真实图输出，确保首次支撑探测不会出现落地缓冲的负向姿态曲线。
                    assert!(app.world().get::<Transform>(bone).unwrap().translation.y >= 0.0);
                }
            } else {
                assert_eq!(animation.jump_phase, CourierJumpPhase::Landing);
                step(&mut app, 0.1);
                assert!(weight(&app, player, CourierAnimationState::Land) > 0.0);
                assert!(app.world().get::<Transform>(bone).unwrap().translation.y < 0.0);
            }
        }
    }

    #[test]
    fn landing_buffers_once_and_carry_changes_preserve_its_progress() {
        for carrying in [false, true] {
            let mut app = animation_app();
            let asset = courier_asset(&mut app);
            let (character, visual, player) = spawn_courier(&mut app, asset.clone());
            let bone = jump_pose_bone(&mut app, &asset, player);
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = false;
            set_velocity(&mut app, character, Vec3::Y * -2.0);
            let item = carrying.then(|| {
                app.world_mut()
                    .spawn(<HeldBy as Relationship>::from(character))
                    .id()
            });
            notify_ready(&mut app, visual);
            step(&mut app, 0.0);
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = true;
            set_velocity(&mut app, character, Vec3::ZERO);
            step(&mut app, 0.01);
            assert_eq!(
                app.world()
                    .get::<CourierAnimation>(player)
                    .unwrap()
                    .jump_phase,
                CourierJumpPhase::Landing
            );
            let land = if carrying {
                CourierAnimationState::CarryLand
            } else {
                CourierAnimationState::Land
            };
            assert!(weight(&app, player, land) > 0.0);
            assert_eq!(phase_seek(&app, player, land), 0.0);
            step(&mut app, 0.1);
            assert!(app.world().get::<Transform>(bone).unwrap().translation.y < 0.0);
            if let Some(item) = item {
                app.world_mut().entity_mut(item).remove::<HeldBy>();
            } else {
                app.world_mut()
                    .spawn(<HeldBy as Relationship>::from(character));
            }
            step(&mut app, 0.05);
            for state in [
                CourierAnimationState::Land,
                CourierAnimationState::CarryLand,
            ] {
                assert!(
                    (phase_seek(&app, player, state)
                        - 0.15 / LAND_VISUAL_DURATION * GAIT_CYCLE_DURATION)
                        .abs()
                        < 1.0e-5
                );
            }
            step(&mut app, 0.08);
            assert_eq!(
                app.world()
                    .get::<CourierAnimation>(player)
                    .unwrap()
                    .jump_phase,
                CourierJumpPhase::Grounded
            );
            for _ in 0..12 {
                step(&mut app, 1.0 / 60.0);
                assert_eq!(phase_seek(&app, player, land), GAIT_CYCLE_DURATION);
                assert_eq!(
                    app.world()
                        .get::<CourierAnimation>(player)
                        .unwrap()
                        .jump_phase,
                    CourierJumpPhase::Grounded
                );
            }
            // 一帧接地探测噪声后回到地面，也不能重复起播刚结束的落地动作。
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = false;
            step(&mut app, 0.02);
            app.world_mut()
                .get_mut::<CharacterMotion>(character)
                .unwrap()
                .grounded = true;
            step(&mut app, 0.02);
            assert_eq!(
                app.world()
                    .get::<CourierAnimation>(player)
                    .unwrap()
                    .jump_phase,
                CourierJumpPhase::Grounded
            );
            assert_eq!(phase_seek(&app, player, land), GAIT_CYCLE_DURATION);
        }
    }

    #[test]
    fn pause_gate_freezes_jump_clock_and_evaluated_pose_without_restarting_on_resume() {
        use crate::game_flow::{AppState, PlayState};
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        set_velocity(&mut app, character, Vec3::Y * 5.0);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        step(&mut app, 0.06);
        let seek = phase_seek(&app, player, CourierAnimationState::Jump);
        let pose = *app.world().get::<Transform>(bone).unwrap();
        app.insert_resource(State::new(AppState::InGame))
            .insert_resource(State::new(PlayState::Paused));
        step(&mut app, 0.5);
        assert_eq!(phase_seek(&app, player, CourierAnimationState::Jump), seek);
        assert_eq!(*app.world().get::<Transform>(bone).unwrap(), pose);
        app.insert_resource(State::new(PlayState::Running));
        step(&mut app, 0.01);
        assert!(
            (phase_seek(&app, player, CourierAnimationState::Jump)
                - 0.07 / JUMP_VISUAL_DURATION * GAIT_CYCLE_DURATION)
                .abs()
                < 1.0e-5
        );
    }
}

mod state_tests {
    //! 无窗口覆盖主角动画的 state 行为。

    use super::test_support::*;
    use super::*;

    #[test]
    fn actual_local_velocity_blends_cardinal_diagonal_and_carry_directions() {
        use CourierAnimationState::*;
        for (velocity, direction) in [
            (Vec3::NEG_Z, Walk),
            (Vec3::Z, WalkBackward),
            (Vec3::NEG_X, WalkLeft),
            (Vec3::X, WalkRight),
        ] {
            let target = animation_target(velocity * 3.0, Quat::IDENTITY, true, false, false);
            assert_eq!(target.weights[direction as usize], 1.0);
        }
        let diagonal = animation_target(
            Vec3::new(-3.0, 10.0, -3.0),
            Quat::IDENTITY,
            true,
            false,
            true,
        );
        assert!(diagonal.weights[CarryWalk as usize] > 0.0);
        assert!(diagonal.weights[CarryLeft as usize] > 0.0);
        assert!((diagonal.weights.iter().sum::<f32>() - 1.0).abs() < 1.0e-6);
        let forward_weight = diagonal.weights[CarryWalk as usize];
        let left_weight = diagonal.weights[CarryLeft as usize];
        assert!(
            (forward_weight * FORWARD_REFERENCE_SPEED - left_weight * SIDEWAYS_REFERENCE_SPEED)
                .abs()
                < 1.0e-6
        );
        let vertical = animation_target(Vec3::Y * 5.0, Quat::IDENTITY, true, false, false);
        assert_eq!(vertical.weights[Idle as usize], 1.0);
    }

    #[test]
    fn bevy_evaluates_continuous_blend_and_shared_phase_on_a_bone() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let target_id = AnimationTargetId::from_name(&Name::new("foot"));
        let named = app
            .world()
            .resource::<Assets<Gltf>>()
            .get(&asset)
            .unwrap()
            .named_animations
            .clone();
        let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
        for state in CourierAnimationState::ALL {
            let vector = match state {
                CourierAnimationState::Walk | CourierAnimationState::CarryWalk => Vec3::NEG_Z,
                CourierAnimationState::WalkBackward | CourierAnimationState::CarryBackward => {
                    Vec3::Z
                }
                CourierAnimationState::WalkLeft | CourierAnimationState::CarryLeft => Vec3::NEG_X,
                CourierAnimationState::WalkRight | CourierAnimationState::CarryRight => Vec3::X,
                _ => Vec3::ZERO,
            };
            clips
                .get_mut(&named[state.name()])
                .unwrap()
                .add_curve_to_target(
                    target_id,
                    AnimatableCurve::new(
                        animated_field!(Transform::translation),
                        UnevenSampleAutoCurve::new([
                            (0.0, Vec3::ZERO),
                            (0.4, vector),
                            (0.8, Vec3::ZERO),
                        ])
                        .unwrap(),
                    ),
                );
        }
        let (character, visual, player) = spawn_courier(&mut app, asset);
        let foot = app
            .world_mut()
            .spawn((
                target_id,
                AnimatedBy(player),
                Transform::default(),
                ChildOf(player),
            ))
            .id();
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        notify_ready(&mut app, visual);
        // 新图的资产事件在帧末发布，先完成零时长绑定帧再检查下一帧真实骨骼求值。
        step(&mut app, 0.0);
        step(&mut app, 0.2);
        assert_gait_phase(&app, player, 0.25);
        assert!(
            app.world()
                .get::<Transform>(foot)
                .unwrap()
                .translation
                .abs_diff_eq(Vec3::NEG_Z * 0.5, 1.0e-5)
        );

        set_velocity(&mut app, character, Vec3::X * SIDEWAYS_REFERENCE_SPEED);
        step(&mut app, 0.1);
        assert_gait_phase(&app, player, 0.375);
        let expected = (Vec3::NEG_Z * weight(&app, player, CourierAnimationState::Walk)
            + Vec3::X * weight(&app, player, CourierAnimationState::WalkRight))
            * 0.75;
        assert!(
            app.world()
                .get::<Transform>(foot)
                .unwrap()
                .translation
                .abs_diff_eq(expected, 1.0e-5)
        );
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
    }

    #[test]
    fn mouse_facing_is_read_on_frame_without_a_fixed_step() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        set_velocity(&mut app, character, Vec3::NEG_Z * 3.0);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        assert_eq!(weight(&app, player, CourierAnimationState::Walk), 1.0);

        app.world_mut()
            .get_mut::<Transform>(character)
            .unwrap()
            .rotation = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
        step(&mut app, 1.0 / 120.0);
        // 不补跑固定模拟；本次 app.update 返回就能看见新方向以及连续过渡。
        assert!(weight(&app, player, CourierAnimationState::WalkRight) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::Walk) > 0.0);
        assert_eq!(
            app.world().get::<CourierAnimation>(player).unwrap().current,
            CourierAnimationState::WalkRight
        );
    }

    #[test]
    fn direction_and_holding_changes_preserve_synchronized_gait_phase() {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
        notify_ready(&mut app, visual);
        step(&mut app, 0.2);
        assert_gait_phase(&app, player, 0.25);

        set_velocity(&mut app, character, Vec3::X * SIDEWAYS_REFERENCE_SPEED);
        step(&mut app, 0.1);
        assert_gait_phase(&app, player, 0.375);
        let item = app
            .world_mut()
            .spawn(<HeldBy as Relationship>::from(character))
            .id();
        step(&mut app, 0.05);
        assert_gait_phase(&app, player, 0.4375);
        assert!(weight(&app, player, CourierAnimationState::WalkRight) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::CarryRight) > 0.0);

        app.world_mut().entity_mut(item).remove::<HeldBy>();
        set_velocity(&mut app, character, Vec3::ZERO);
        step(&mut app, 0.05);
        assert_gait_phase(&app, player, 0.4375);
        assert!(weight(&app, player, CourierAnimationState::Idle) > 0.0);
        assert!(weight(&app, player, CourierAnimationState::CarryRight) > 0.0);
    }

    #[test]
    fn smooth_blend_and_stride_rate_are_independent_of_render_frame_rate() {
        fn simulate(hz: u32) -> ([f32; ANIMATION_COUNT], f32) {
            let mut app = animation_app();
            let asset = courier_asset(&mut app);
            let (character, visual, player) = spawn_courier(&mut app, asset);
            notify_ready(&mut app, visual);
            step(&mut app, 0.0);
            set_velocity(&mut app, character, Vec3::NEG_Z * 4.5);
            for _ in 0..hz / 4 {
                step(&mut app, 1.0 / hz as f32);
            }
            let animation = app.world().get::<CourierAnimation>(player).unwrap();
            assert_gait_phase(&app, player, 0.9375);
            (animation.weights, animation.gait_phase)
        }
        let (at_60, phase_60) = simulate(60);
        let (at_120, phase_120) = simulate(120);
        for index in 0..ANIMATION_COUNT {
            assert!((at_60[index] - at_120[index]).abs() < 1.0e-5);
        }
        assert!((phase_60 - phase_120).abs() < 1.0e-5);
    }
}
