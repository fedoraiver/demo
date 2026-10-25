//! 物品交互、共享刚体持握、连续转向与音效反馈的无窗口回归。

use super::*;

mod attachment_tests {
    //! 通过真实交互和无窗口物理步检查组合持握的装卸、质量与异常关系生命周期。

    use super::*;
    use crate::character::character_body;
    use crate::item_interaction::parcel_body;
    use crate::{
        character::{Character, CharacterIntent, CharacterMotion, CharacterPlugin},
        game_flow::configure_feature_order,
        physics::{GamePhysicsPlugin, ground_body, parcel_collision_layers},
        settings::PrototypeConfig,
    };
    use avian3d::prelude::*;
    use bevy::time::TimeUpdateStrategy;

    fn app() -> App {
        let mut app = App::new();
        configure_feature_order(&mut app);
        app.add_plugins((
            MinimalPlugins,
            TransformPlugin,
            (GamePhysicsPlugin, CharacterPlugin, ItemInteractionPlugin),
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((ground_body(&config), Transform::IDENTITY));
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    fn actors(app: &mut App) -> (Entity, Entity) {
        let config = app.world().resource::<PrototypeConfig>().clone();
        let holder = app
            .world_mut()
            .spawn((
                Character,
                CharacterIntent::default(),
                CharacterMotion::default(),
                Transform::IDENTITY,
                character_body(&config),
            ))
            .id();
        let item = app
            .world_mut()
            .spawn((
                Parcel,
                Pickable,
                CarryGrip(Vec3::new(0.0, 1.3, -0.48)),
                Transform::from_xyz(0.0, 0.3, -1.1),
                parcel_body(&config),
            ))
            .id();
        (holder, item)
    }

    fn steps(app: &mut App, count: usize) {
        for _ in 0..count {
            app.update();
        }
    }

    fn pick_up(app: &mut App, holder: Entity) {
        app.world_mut()
            .get_mut::<CharacterIntent>(holder)
            .unwrap()
            .interact_pending = true;
        app.update();
    }

    #[test]
    fn pickup_aligns_without_teleporting_and_release_restores_the_original_mass() {
        let mut app = app();
        let (holder, item) = actors(&mut app);
        steps(&mut app, 30);
        let before = app.world().get::<Position>(item).unwrap().0;
        let mass_before = app.world().get::<ComputedMass>(holder).unwrap().value();
        pick_up(&mut app, holder);
        let after = app.world().get::<Position>(item).unwrap().0;
        assert!(
            before.distance(after) < 0.12,
            "Pickup skipped its alignment path"
        );
        assert!(app.world().get::<RigidBody>(item).is_none());
        let proxy = app.world().get::<HeldAttachment>(item).unwrap().collider;
        assert_eq!(app.world().get::<ColliderOf>(proxy).unwrap().body, holder);
        assert!(app.world().get::<ColliderDisabled>(item).is_some());
        assert!(app.world().get::<ChildOf>(item).is_none());
        assert!(
            (app.world().get::<ComputedMass>(holder).unwrap().value() - mass_before - 3.0).abs()
                < 0.001
        );

        steps(&mut app, 60);
        let relative = app.world().get::<Rotation>(holder).unwrap().0.inverse()
            * (app.world().get::<Position>(item).unwrap().0
                - app.world().get::<Position>(holder).unwrap().0);
        assert!(relative.abs_diff_eq(Vec3::new(0.0, 1.3, -0.48), 0.001));
        pick_up(&mut app, holder);
        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(app.world().get_entity(proxy).is_err());
        assert!(app.world().get::<ColliderDisabled>(item).is_none());
        assert_eq!(
            app.world().get::<RigidBody>(item),
            Some(&RigidBody::Dynamic)
        );
        assert_eq!(app.world().get::<ColliderOf>(item).unwrap().body, item);
        assert!(
            (app.world().get::<ComputedMass>(holder).unwrap().value() - mass_before).abs() < 0.001
        );
    }

    #[test]
    fn unloading_preserves_the_supplied_safe_world_pose_and_motion() {
        let mut app = app();
        let (holder, item) = actors(&mut app);
        steps(&mut app, 30);
        pick_up(&mut app, holder);
        steps(&mut app, 60);
        let pose = Transform::from_translation(app.world().get::<Position>(item).unwrap().0)
            .with_rotation(app.world().get::<Rotation>(item).unwrap().0);
        let linear = Vec3::new(2.0, -0.25, 1.0);
        let angular = Vec3::new(0.0, 0.8, 0.0);
        // 只执行卸载命令核对瞬间快照，不混入下一次重力和接触求解。
        let mut schedule = Schedule::default();
        schedule.add_systems(move |mut commands: Commands| {
            release_item(&mut commands, item, pose, linear, angular, "turn_collision");
        });
        schedule.run(app.world_mut());
        let world = app.world();
        assert_eq!(world.get::<Position>(item).unwrap().0, pose.translation);
        assert_eq!(world.get::<Rotation>(item).unwrap().0, pose.rotation);
        assert_eq!(*world.get::<Transform>(item).unwrap(), pose);
        assert_eq!(world.get::<LinearVelocity>(item).unwrap().0, linear);
        assert_eq!(world.get::<AngularVelocity>(item).unwrap().0, angular);
        assert_eq!(world.get::<Mass>(holder).unwrap().0, 75.0);
        assert_eq!(
            world.get::<CollisionLayers>(item),
            Some(&parcel_collision_layers())
        );
        assert!(world.get::<HeldAttachment>(item).is_none());
        assert_eq!(world.get::<RigidBody>(item), Some(&RigidBody::Dynamic));
        assert_eq!(world.get::<ColliderOf>(item).unwrap().body, item);
    }

    #[test]
    fn detached_relationship_and_holder_destruction_leave_a_free_independent_box() {
        for despawn_holder in [false, true] {
            let mut app = app();
            let (holder, item) = actors(&mut app);
            steps(&mut app, 30);
            pick_up(&mut app, holder);
            steps(&mut app, 60);
            let proxy = app.world().get::<HeldAttachment>(item).unwrap().collider;
            if despawn_holder {
                app.world_mut().despawn(holder);
            } else {
                app.world_mut().entity_mut(item).remove::<HeldBy>();
            }
            app.update();
            let world = app.world();
            assert!(
                world.get_entity(item).is_ok(),
                "A business box must outlive its holder"
            );
            assert!(world.get::<HeldAttachment>(item).is_none());
            assert!(world.get::<HeldTarget>(item).is_none());
            assert!(world.get_entity(proxy).is_err());
            assert_eq!(world.get::<RigidBody>(item), Some(&RigidBody::Dynamic));
            assert_eq!(world.get::<ColliderOf>(item).unwrap().body, item);
            if !despawn_holder {
                assert_eq!(world.get::<Mass>(holder).unwrap().0, 75.0);
            }
            let before = world.get::<Position>(item).unwrap().0;
            steps(&mut app, 30);
            assert!(app.world().get::<Position>(item).unwrap().y < before.y - 0.5);
        }
    }

    #[test]
    fn held_item_destruction_restores_holder_mass_and_collider_inventory() {
        let mut app = app();
        let (holder, item) = actors(&mut app);
        steps(&mut app, 30);
        pick_up(&mut app, holder);
        steps(&mut app, 60);
        assert_eq!(app.world().get::<Mass>(holder).unwrap().0, 78.0);
        let proxy = app.world().get::<HeldAttachment>(item).unwrap().collider;
        app.world_mut().despawn(item);
        app.update();
        let world = app.world();
        assert!(world.get_entity(item).is_err());
        assert!(world.get_entity(proxy).is_err());
        assert_eq!(world.get::<Mass>(holder).unwrap().0, 75.0);
        assert!((world.get::<ComputedMass>(holder).unwrap().value() - 75.0).abs() < 0.001);
        assert!(
            !world
                .get::<RigidBodyColliders>(holder)
                .unwrap()
                .iter()
                .any(|entity| entity == proxy)
        );
        app.update();
        assert_eq!(app.world().get::<Mass>(holder).unwrap().0, 75.0);
    }

    #[test]
    fn scaled_collider_and_preexisting_pause_and_disable_flags_survive_carrying() {
        for collider_disabled in [false, true] {
            let mut app = app();
            let (holder, item) = actors(&mut app);
            let scale = Vec3::splat(1.2);
            app.world_mut().get_mut::<Transform>(item).unwrap().scale = scale;
            steps(&mut app, 30);
            app.world_mut()
                .entity_mut(item)
                .insert((NoTranslationEasing, NoRotationEasing));
            if collider_disabled {
                app.world_mut().entity_mut(item).insert(ColliderDisabled);
            }
            pick_up(&mut app, holder);
            steps(&mut app, 60);
            let proxy = app.world().get::<HeldAttachment>(item).unwrap().collider;
            assert!(
                app.world()
                    .get::<Collider>(proxy)
                    .unwrap()
                    .scale()
                    .abs_diff_eq(scale, 0.001)
            );
            assert_eq!(
                app.world().get::<ColliderDisabled>(proxy).is_some(),
                collider_disabled
            );
            pick_up(&mut app, holder);
            app.update();
            let world = app.world();
            assert_eq!(world.get::<Transform>(item).unwrap().scale, scale);
            assert_eq!(
                world.get::<ColliderDisabled>(item).is_some(),
                collider_disabled
            );
            assert!(world.get::<NoTranslationEasing>(item).is_some());
            assert!(world.get::<NoRotationEasing>(item).is_some());
            assert!(world.get_entity(proxy).is_err());
            assert_eq!(world.get::<RigidBody>(item), Some(&RigidBody::Dynamic));
        }
    }
}

mod frame_tests {
    //! 在实际帧末核对整体持箱与释放，不安装窗口后端、渲染器或完整游戏。

    use crate::character::character_body;
    use crate::item_interaction::parcel_body;
    use std::time::Duration;

    use avian3d::prelude::*;
    use bevy::{
        camera::visibility::VisibilityPlugin,
        ecs::relationship::Relationship,
        input::{
            ButtonState, InputPlugin,
            keyboard::{Key, KeyboardInput},
            mouse::MouseMotion,
        },
        mesh::skinning::SkinnedMeshInverseBindposes,
        prelude::*,
        scene::ScenePlugin,
        time::TimeUpdateStrategy,
        window::{CursorOptions, PrimaryWindow},
    };

    use crate::{
        bounds_recovery::{BoundsRecoveryPlugin, SpawnPoint, WaterRecoveryOrder},
        character::{Character, CharacterIntent, CharacterMotion, CharacterPlugin},
        first_person::{
            ControlsCamera, FirstPersonCamera, FirstPersonPlugin, MouseLookState, PlayerId,
            spawn_keyboard_controller,
        },
        game_flow::{FixedGameplaySystems, configure_feature_order},
        item_interaction::{
            CarryGrip, HeldAttachment, HeldBy, HeldTarget, ItemInteractionPlugin, Parcel, Pickable,
        },
        physics::{
            GamePhysicsPlugin, ground_body, parcel_collision_layers, world_collision_layers,
        },
        settings::{GameSettings, PrototypeConfig},
    };
    use bevy_enhanced_input::prelude::EnhancedInputPlugin;

    struct CarryFixture {
        app: App,
        window: Entity,
        character: Entity,
        camera: Entity,
        parcel: Entity,
        visual: Entity,
        grip: Vec3,
        visual_offset: Vec3,
    }

    #[test]
    fn open_mesh_ground_turn_keeps_actual_held_parcel_in_zero_step_frame() {
        for exact_ground_pose in [false, true] {
            let mut fixture = carry_fixture(Some(Vec3::new(0.0, 1.3, -0.48)));
            let world = fixture.app.world_mut();
            let ground = world
                .query_filtered::<Entity, (With<RigidBody>, Without<Character>, Without<Pickable>)>(
                )
                .single(world)
                .unwrap();
            // 保留原地面高度和碰撞层，只改为平坦三角网格，复现真实地形上的旋转查询。
            world.entity_mut(ground).insert(Collider::trimesh(
                vec![
                    Vec3::new(-20.0, 0.0, -20.0),
                    Vec3::new(20.0, 0.0, -20.0),
                    Vec3::new(20.0, 0.0, 20.0),
                    Vec3::new(-20.0, 0.0, 20.0),
                ],
                vec![[0, 2, 1], [0, 3, 2]],
            ));
            fixture
                .app
                .insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
            fixture.app.update();
            assert_held_pose(&fixture);
            // 覆盖脚底精确位于地面平面的姿态，避免只测试求解器微小穿入后的单一浮点取值。
            if exact_ground_pose {
                fixture
                    .app
                    .world_mut()
                    .entity_mut(fixture.character)
                    .insert((
                        Position(Vec3::ZERO),
                        Transform::IDENTITY,
                        NoTranslationEasing,
                    ));
            }
            fixture
                .app
                .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
            let sensitivity = fixture
                .app
                .world()
                .resource::<GameSettings>()
                .camera
                .mouse_sensitivity;
            let before = fixture.app.world().resource::<Time<Fixed>>().elapsed();
            let camera_before = fixture
                .app
                .world()
                .get::<Transform>(fixture.camera)
                .unwrap()
                .rotation;
            fixture.app.world_mut().write_message(MouseMotion {
                delta: Vec2::X * (-0.001 / sensitivity),
            });
            fixture.app.update();
            let world = fixture.app.world();
            assert_eq!(world.resource::<Time<Fixed>>().elapsed(), before);
            assert!(
                !world
                    .get::<Transform>(fixture.camera)
                    .unwrap()
                    .rotation
                    .abs_diff_eq(camera_before, 0.000001)
            );
            assert_eq!(
                world.get::<HeldBy>(fixture.parcel).map(Relationship::get),
                Some(fixture.character),
                "An unobstructed turn above the ground must keep the parcel held"
            );
            assert_held_pose(&fixture);
        }
    }

    /// Window 仅作为 Enhanced Input 所需的 ECS 数据；真实 E 绑定负责建立持握关系。
    fn carry_fixture(grip: Option<Vec3>) -> CarryFixture {
        carry_fixture_with_easing(grip, false)
    }

    fn carry_fixture_with_easing(grip: Option<Vec3>, preserve_easing_pause: bool) -> CarryFixture {
        let mut app = App::new();
        configure_feature_order(&mut app);
        app.add_plugins((
            MinimalPlugins,
            // 真实输入上下文使用 BSN；仅启用无窗口资产与场景服务来应用声明式绑定。
            AssetPlugin::default(),
            ScenePlugin,
            InputPlugin,
            TransformPlugin,
            VisibilityPlugin,
            GamePhysicsPlugin,
            CharacterPlugin,
            ItemInteractionPlugin,
            EnhancedInputPlugin,
            FirstPersonPlugin,
            BoundsRecoveryPlugin,
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO))
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<SkinnedMeshInverseBindposes>>();
        app.finish();
        app.cleanup();
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((ground_body(&config), Transform::IDENTITY));
        let window = app
            .world_mut()
            .spawn((
                Window {
                    focused: true,
                    ..default()
                },
                CursorOptions::default(),
                PrimaryWindow,
            ))
            .id();
        let character = app
            .world_mut()
            .spawn((
                Character,
                CharacterIntent::default(),
                CharacterMotion { grounded: true },
                character_body(&config),
                Transform::IDENTITY,
                SpawnPoint(Transform::IDENTITY),
            ))
            .id();
        let camera_state = FirstPersonCamera::new(character);
        let camera_pose = camera_state.transform(Vec3::ZERO);
        let camera = app
            .world_mut()
            .spawn((camera_state, MouseLookState::default(), camera_pose))
            .id();
        let mut commands = app.world_mut().commands();
        let controller = spawn_keyboard_controller(&mut commands, PlayerId(1), character);
        commands.entity(controller).insert(ControlsCamera(camera));
        app.world_mut().flush();
        let parcel = app
            .world_mut()
            .spawn((
                Parcel,
                Pickable,
                parcel_body(&config),
                Transform::from_xyz(0.0, 0.35, -1.0),
                SpawnPoint(Transform::from_xyz(0.0, 0.35, -1.0)),
            ))
            .id();
        if preserve_easing_pause {
            app.world_mut()
                .entity_mut(parcel)
                .insert((NoTranslationEasing, NoRotationEasing));
        }
        if let Some(grip) = grip {
            app.world_mut().entity_mut(parcel).insert(CarryGrip(grip));
        }
        let grip = grip.unwrap_or(config.hold_offset);
        let visual_offset = Vec3::new(0.0, 0.18, 0.0);
        let visual = app
            .world_mut()
            .spawn((Transform::from_translation(visual_offset), ChildOf(parcel)))
            .id();
        // 捕获初始化及端点建立只发生在发出待验证输入之前。
        app.update();
        app.update();
        app.insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
        for _ in 0..20 {
            app.update();
        }
        interaction_key(&mut app, window, ButtonState::Pressed);
        app.update();
        assert_eq!(app.world().get::<HeldBy>(parcel).unwrap().get(), character);
        interaction_key(&mut app, window, ButtonState::Released);
        app.update();
        // 拾取允许短暂对齐，先完成这段初始化；随后输入后的帧末断言绝不补跑模拟。
        for _ in 0..30 {
            app.update();
        }
        CarryFixture {
            app,
            window,
            character,
            camera,
            parcel,
            visual,
            grip,
            visual_offset,
        }
    }

    fn interaction_key(app: &mut App, window: Entity, state: ButtonState) {
        app.world_mut().write_message(KeyboardInput {
            key_code: KeyCode::KeyE,
            logical_key: Key::Character("e".into()),
            state,
            text: None,
            repeat: false,
            window,
        });
    }

    /// 根实体与视觉子体都必须使用当前人物呈现姿态，不能只检查 HeldTarget。
    fn assert_held_pose(fixture: &CarryFixture) {
        let world = fixture.app.world();
        let character = world.get::<Transform>(fixture.character).unwrap();
        let parcel = world.get::<Transform>(fixture.parcel).unwrap();
        let expected_position = character.transform_point(fixture.grip);
        assert!(
            parcel.translation.abs_diff_eq(expected_position, 0.0001),
            "The actual held parcel must follow in the current frame: actual={:?}, expected={expected_position:?}",
            parcel.translation
        );
        let target = world.get::<HeldTarget>(fixture.parcel).unwrap();
        assert!(target.translation.abs_diff_eq(expected_position, 0.0001));
        let visual = world
            .get::<GlobalTransform>(fixture.visual)
            .unwrap()
            .compute_transform();
        assert!(
            visual
                .translation
                .abs_diff_eq(parcel.transform_point(fixture.visual_offset), 0.0001)
        );
        for axis in [Vec3::NEG_Z, Vec3::Y] {
            assert!((parcel.rotation * axis).abs_diff_eq(character.rotation * axis, 0.0001));
            assert!((visual.rotation * axis).abs_diff_eq(parcel.rotation * axis, 0.0001));
        }
        let proxy = world
            .get::<HeldAttachment>(fixture.parcel)
            .unwrap()
            .collider;
        assert_eq!(
            world.get::<ColliderOf>(proxy).unwrap().body,
            fixture.character
        );
        assert!(world.get::<ColliderDisabled>(fixture.parcel).is_some());
        assert!(world.get::<RigidBody>(fixture.parcel).is_none());
        assert!(world.get::<ChildOf>(fixture.parcel).is_none());
        // 内部代理必须复制真实箱体形状，不能用缩小的碰撞形状换取通过。
        let original_bounds = world
            .get::<Collider>(fixture.parcel)
            .unwrap()
            .shape_scaled()
            .compute_local_aabb();
        let proxy_bounds = world
            .get::<Collider>(proxy)
            .unwrap()
            .shape_scaled()
            .compute_local_aabb();
        assert!(original_bounds.mins.abs_diff_eq(proxy_bounds.mins, 0.0001));
        assert!(original_bounds.maxs.abs_diff_eq(proxy_bounds.maxs, 0.0001));
    }

    #[test]
    fn actual_held_parcel_and_visual_follow_fast_turns_at_each_frame_end() {
        for duration in [
            Duration::ZERO,
            Duration::from_millis(50),
            Duration::from_secs_f64(1.0 / 120.0),
            Duration::from_secs_f64(1.0 / 240.0),
        ] {
            for grip in [
                None,
                Some(Vec3::new(0.0, 1.3, -0.48)),
                Some(Vec3::new(0.0, 1.3, -0.62)),
            ] {
                let mut fixture = carry_fixture(grip);
                fixture
                    .app
                    .insert_resource(TimeUpdateStrategy::ManualDuration(duration));
                let mut zero_steps = 0;
                let mut multiple_steps = 0;
                for frame in 0..16 {
                    let before = fixture.app.world().resource::<Time<Fixed>>().elapsed();
                    fixture.app.world_mut().write_message(MouseMotion {
                        delta: Vec2::new(if frame % 2 == 0 { 180.0 } else { -130.0 }, 0.0),
                    });
                    fixture.app.update();
                    // 不补跑固定步、姿态系统或变换传播；这里就是用户看到的本帧状态。
                    assert_held_pose(&fixture);
                    let advanced = fixture.app.world().resource::<Time<Fixed>>().elapsed() - before;
                    zero_steps += usize::from(advanced.is_zero());
                    multiple_steps += usize::from(advanced.as_secs_f64() > 1.5 / 60.0);
                }
                if duration == Duration::from_millis(50) {
                    assert!(multiple_steps > 0);
                } else {
                    assert!(zero_steps > 0);
                }
            }
        }
    }

    #[test]
    fn released_parcel_keeps_its_identity_and_stops_following_zero_step_turns() {
        let mut fixture = carry_fixture(Some(Vec3::new(0.0, 1.3, -0.48)));
        let proxy = fixture
            .app
            .world()
            .get::<HeldAttachment>(fixture.parcel)
            .unwrap()
            .collider;
        interaction_key(&mut fixture.app, fixture.window, ButtonState::Pressed);
        fixture.app.update();
        let world = fixture.app.world();
        assert!(world.get::<HeldBy>(fixture.parcel).is_none());
        assert!(world.get::<HeldTarget>(fixture.parcel).is_none());
        assert_eq!(
            world.get::<RigidBody>(fixture.parcel),
            Some(&RigidBody::Dynamic)
        );
        assert_eq!(
            world.get::<ColliderOf>(fixture.parcel).unwrap().body,
            fixture.parcel
        );
        assert!(world.get::<ColliderDisabled>(fixture.parcel).is_none());
        assert!(world.get_entity(proxy).is_err());
        assert!(world.get::<ChildOf>(fixture.parcel).is_none());
        let position = *world.get::<Position>(fixture.parcel).unwrap();
        let velocity = *world.get::<LinearVelocity>(fixture.parcel).unwrap();
        let pose = *world.get::<Transform>(fixture.parcel).unwrap();
        fixture
            .app
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
        interaction_key(&mut fixture.app, fixture.window, ButtonState::Released);
        for _ in 0..8 {
            fixture.app.world_mut().write_message(MouseMotion {
                delta: Vec2::X * 200.0,
            });
            fixture.app.update();
            let world = fixture.app.world();
            assert_eq!(*world.get::<Position>(fixture.parcel).unwrap(), position);
            assert_eq!(
                *world.get::<LinearVelocity>(fixture.parcel).unwrap(),
                velocity
            );
            assert!(
                world
                    .get::<Transform>(fixture.parcel)
                    .unwrap()
                    .translation
                    .abs_diff_eq(pose.translation, 0.0001)
            );
        }
    }

    #[test]
    fn blocked_turn_arc_releases_at_safe_pose_and_keeps_camera_turning() {
        assert_blocked_turn_arc_releases(std::f32::consts::PI);
    }

    #[test]
    fn blocked_turn_arc_releases_before_clear_150_degree_endpoint() {
        assert_blocked_turn_arc_releases(150.0_f32.to_radians());
    }

    #[test]
    fn negative_half_turn_checks_the_requested_positive_x_arc() {
        assert_blocked_turn_arc_releases(-std::f32::consts::PI);
    }

    #[test]
    fn full_turn_checks_the_arc_even_when_the_final_pose_is_unchanged() {
        assert_blocked_turn_arc_releases(std::f32::consts::TAU);
    }

    fn assert_blocked_turn_arc_releases(angle: f32) {
        let mut fixture = carry_fixture(None);
        let character_position = fixture
            .app
            .world()
            .get::<Position>(fixture.character)
            .unwrap()
            .0;
        // 障碍位于输入方向圆弧扫过的中段，起点和终点均空；只检查最终角度会漏掉阻挡。
        let obstacle_x = if angle > 0.0 { -0.9 } else { 0.9 };
        fixture.app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(0.18, 1.0, 0.18),
            world_collision_layers(),
            Transform::from_translation(character_position + Vec3::new(obstacle_x, 1.0, 0.0)),
        ));
        fixture.app.update();
        assert!(fixture.app.world().get::<HeldBy>(fixture.parcel).is_some());
        assert!(
            fixture
                .app
                .world()
                .get::<LinearVelocity>(fixture.character)
                .unwrap()
                .length()
                < 0.05,
            "The rotation probe must start with a settled character"
        );
        let safe_position = *fixture.app.world().get::<Position>(fixture.parcel).unwrap();
        let safe_rotation = *fixture.app.world().get::<Rotation>(fixture.parcel).unwrap();
        let proxy = fixture
            .app
            .world()
            .get::<HeldAttachment>(fixture.parcel)
            .unwrap()
            .collider;
        fixture
            .app
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
        let sensitivity = fixture
            .app
            .world()
            .resource::<GameSettings>()
            .camera
            .mouse_sensitivity;
        fixture.app.world_mut().write_message(MouseMotion {
            delta: Vec2::X * (-angle / sensitivity),
        });
        fixture.app.update();
        let world = fixture.app.world();
        assert!(
            world.get::<HeldBy>(fixture.parcel).is_none(),
            "The blocked rotation arc must release the parcel in this frame"
        );
        assert_eq!(
            world.get::<RigidBody>(fixture.parcel),
            Some(&RigidBody::Dynamic)
        );
        assert!(world.get_entity(proxy).is_err());
        let parcel = world.get::<Transform>(fixture.parcel).unwrap();
        assert!(
            world
                .get::<Position>(fixture.parcel)
                .unwrap()
                .0
                .abs_diff_eq(safe_position.0, 0.0001),
            "A blocked turn must release from the last safe physical position"
        );
        assert!(parcel.translation.abs_diff_eq(safe_position.0, 0.0001));
        for axis in [Vec3::NEG_Z, Vec3::Y] {
            assert!((parcel.rotation * axis).abs_diff_eq(safe_rotation.0 * axis, 0.0001));
        }
        let character = world.get::<Transform>(fixture.character).unwrap();
        let expected_camera = world
            .get::<FirstPersonCamera>(fixture.camera)
            .unwrap()
            .transform(character.translation);
        let camera = world.get::<Transform>(fixture.camera).unwrap();
        assert!(
            camera
                .translation
                .abs_diff_eq(expected_camera.translation, 0.0001)
        );
        let requested_position = character.translation + Vec3::Y * 1.65;
        assert!(
            camera.translation.abs_diff_eq(requested_position, 0.0001),
            "The first-person camera must stay at eye height despite the parcel obstruction"
        );
        assert!(
            (*camera.forward()).abs_diff_eq(Quat::from_rotation_y(angle) * Vec3::NEG_Z, 0.0001),
            "The first-person camera must complete the requested turn despite the parcel obstruction"
        );
    }

    struct ParcelSnapshot {
        position: Vec3,
        rotation: Quat,
        linear_velocity: Vec3,
        angular_velocity: Vec3,
        held: bool,
        dynamic: bool,
    }

    #[derive(Resource)]
    struct RecoveryProbe {
        parcel: Entity,
        proxy: Entity,
        snapshot: Option<ParcelSnapshot>,
    }

    /// 记录正常主调度中恢复后的状态，再由同一个 app.update 完成真实物理与呈现。
    fn observe_recovery_before_physics(
        mut probe: ResMut<RecoveryProbe>,
        parcels: Query<(
            &Position,
            &Rotation,
            &LinearVelocity,
            &AngularVelocity,
            Has<HeldBy>,
            Option<&RigidBody>,
        )>,
    ) {
        let (position, rotation, linear, angular, held, body) = parcels.get(probe.parcel).unwrap();
        probe.snapshot = Some(ParcelSnapshot {
            position: position.0,
            rotation: rotation.0,
            linear_velocity: linear.0,
            angular_velocity: angular.0,
            held,
            dynamic: body == Some(&RigidBody::Dynamic),
        });
    }

    fn add_recovery_probe(fixture: &mut CarryFixture) {
        fixture.app.insert_resource(RecoveryProbe {
            parcel: fixture.parcel,
            proxy: fixture
                .app
                .world()
                .get::<HeldAttachment>(fixture.parcel)
                .unwrap()
                .collider,
            snapshot: None,
        });
        // 落水恢复先于 Simulate，探针在此之后读取已应用的释放命令；不主动调用恢复系统。
        fixture.app.add_systems(
            FixedUpdate,
            observe_recovery_before_physics.after(FixedGameplaySystems::Target),
        );
    }

    fn assert_free_after_recovery(fixture: &CarryFixture) {
        let world = fixture.app.world();
        assert!(world.get::<HeldBy>(fixture.parcel).is_none());
        assert!(world.get::<HeldTarget>(fixture.parcel).is_none());
        assert_eq!(
            world.get::<RigidBody>(fixture.parcel),
            Some(&RigidBody::Dynamic)
        );
        assert_eq!(
            world.get::<ColliderOf>(fixture.parcel).unwrap().body,
            fixture.parcel
        );
        assert!(world.get::<ColliderDisabled>(fixture.parcel).is_none());
        assert!(
            world
                .get_entity(world.resource::<RecoveryProbe>().proxy)
                .is_err()
        );
        assert_eq!(
            world.get::<CollisionLayers>(fixture.parcel),
            Some(&parcel_collision_layers())
        );
        assert!(world.get::<ChildOf>(fixture.parcel).is_none());
        let mass = world.resource::<PrototypeConfig>().character_mass;
        assert!((world.get::<Mass>(fixture.character).unwrap().0 - mass).abs() < 0.001);
    }

    #[test]
    fn actual_attachment_holder_water_recovery_releases_dry_parcel_at_its_real_pose() {
        let mut fixture = carry_fixture(Some(Vec3::new(0.0, 1.3, -0.48)));
        assert_held_pose(&fixture);
        // 先让组合体获得真实平移速度，避免错误清零也能通过释放速度断言。
        fixture
            .app
            .world_mut()
            .entity_mut(fixture.character)
            .insert(LinearVelocity(Vec3::X * 2.0));
        fixture.app.update();
        let world = fixture.app.world();
        let position = world.get::<Position>(fixture.parcel).unwrap().0;
        let rotation = world.get::<Rotation>(fixture.parcel).unwrap().0;
        let velocity = world.get::<LinearVelocity>(fixture.parcel).unwrap().0;
        let angular = world.get::<AngularVelocity>(fixture.parcel).unwrap().0;
        assert!(position.y > 0.0);
        assert!(velocity.length() > 0.1);
        let proxy = world
            .get::<HeldAttachment>(fixture.parcel)
            .unwrap()
            .collider;
        assert_eq!(
            world.get::<ColliderOf>(proxy).unwrap().body,
            fixture.character
        );
        let spawn = Transform::from_xyz(20.0, 0.0, 14.0);
        fixture
            .app
            .world_mut()
            .entity_mut(fixture.character)
            .insert(SpawnPoint(spawn));
        fixture
            .app
            .world_mut()
            .get_mut::<Position>(fixture.character)
            .unwrap()
            .y = -1.6;
        add_recovery_probe(&mut fixture);
        fixture.app.update();
        // 立即检查本次实际帧末；探针提供重力积分前的精确释放状态。
        assert_free_after_recovery(&fixture);
        let world = fixture.app.world();
        let released = world.resource::<RecoveryProbe>().snapshot.as_ref().unwrap();
        assert!(!released.held && released.dynamic);
        assert!(released.position.abs_diff_eq(position, 0.0001));
        assert!(released.linear_velocity.abs_diff_eq(velocity, 0.0001));
        assert!(released.angular_velocity.abs_diff_eq(angular, 0.0001));
        for axis in [Vec3::NEG_Z, Vec3::Y] {
            assert!((released.rotation * axis).abs_diff_eq(rotation * axis, 0.0001));
        }
        assert!(
            world
                .get::<Position>(fixture.character)
                .unwrap()
                .0
                .distance(spawn.translation)
                < 0.05
        );
        assert!(
            world
                .get::<Position>(fixture.parcel)
                .unwrap()
                .0
                .distance(position)
                < 0.1
        );
        assert!(
            world
                .get::<Position>(fixture.parcel)
                .unwrap()
                .0
                .distance(spawn.translation)
                > 10.0
        );
    }

    #[test]
    fn actual_attachment_parcel_water_recovery_restores_own_spawn_and_easing_pause() {
        let mut fixture = carry_fixture_with_easing(Some(Vec3::new(0.0, 1.3, -0.48)), true);
        assert_held_pose(&fixture);
        let character_position = fixture
            .app
            .world()
            .get::<Position>(fixture.character)
            .unwrap()
            .0;
        let spawn = Transform::from_xyz(-12.0, 0.35, 9.0).with_rotation(Quat::from_rotation_y(0.7));
        fixture.app.world_mut().entity_mut(fixture.parcel).insert((
            SpawnPoint(spawn),
            Position(Vec3::new(3.0, -1.6, 4.0)),
            LinearVelocity(Vec3::new(1.0, -3.0, 0.5)),
            AngularVelocity(Vec3::Y * 2.0),
        ));
        add_recovery_probe(&mut fixture);
        fixture.app.update();
        assert_free_after_recovery(&fixture);
        let world = fixture.app.world();
        let recovered = world.resource::<RecoveryProbe>().snapshot.as_ref().unwrap();
        assert!(!recovered.held && recovered.dynamic);
        assert!(recovered.position.abs_diff_eq(spawn.translation, 0.0001));
        assert_eq!(recovered.linear_velocity, Vec3::ZERO);
        assert_eq!(recovered.angular_velocity, Vec3::ZERO);
        for axis in [Vec3::NEG_Z, Vec3::Y] {
            assert!((recovered.rotation * axis).abs_diff_eq(spawn.rotation * axis, 0.0001));
        }
        assert!(
            world
                .get::<Position>(fixture.character)
                .unwrap()
                .0
                .distance(character_position)
                < 0.05
        );
        assert!(
            world
                .get::<Transform>(fixture.parcel)
                .unwrap()
                .translation
                .distance(spawn.translation)
                < 0.05
        );
        assert!(world.get::<NoTranslationEasing>(fixture.parcel).is_some());
        assert!(world.get::<NoRotationEasing>(fixture.parcel).is_some());
        // 连续无固定步帧不能从海中端点重新插值；下一固定步也保留拾取前已有的暂停设置。
        fixture
            .app
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
        for _ in 0..3 {
            fixture.app.update();
            assert!(
                fixture
                    .app
                    .world()
                    .get::<Transform>(fixture.parcel)
                    .unwrap()
                    .translation
                    .distance(spawn.translation)
                    < 0.05
            );
        }
        fixture
            .app
            .insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
        fixture.app.update();
        assert!(
            fixture
                .app
                .world()
                .get::<NoTranslationEasing>(fixture.parcel)
                .is_some()
        );
        assert!(
            fixture
                .app
                .world()
                .get::<NoRotationEasing>(fixture.parcel)
                .is_some()
        );
    }

    #[derive(Component)]
    struct RecoveryOrderShift;

    #[test]
    fn actual_attachment_simultaneous_water_recovery_uses_item_spawn_in_both_query_orders() {
        for parcel_first in [false, true] {
            let mut fixture = carry_fixture(Some(Vec3::new(0.0, 1.3, -0.48)));
            assert_held_pose(&fixture);
            // 测试标记只把指定实体移到后创建的 archetype，明确覆盖两种恢复迭代顺序。
            let last = if parcel_first {
                fixture.character
            } else {
                fixture.parcel
            };
            fixture
                .app
                .world_mut()
                .entity_mut(last)
                .insert(RecoveryOrderShift);
            // 先让真实系统更新自己的查询缓存，再准备同时落水；观测结果只来自该系统。
            fixture.app.update();
            let world = fixture.app.world_mut();
            world.resource_mut::<WaterRecoveryOrder>().0.clear();
            let holder_spawn = Transform::from_xyz(20.0, 0.0, 14.0);
            let parcel_spawn =
                Transform::from_xyz(-12.0, 0.35, 9.0).with_rotation(Quat::from_rotation_y(0.7));
            world.entity_mut(fixture.character).insert((
                SpawnPoint(holder_spawn),
                Position(Vec3::new(3.0, -2.9, 4.0)),
                LinearVelocity(Vec3::new(1.0, -3.0, 0.5)),
            ));
            world.entity_mut(fixture.parcel).insert((
                SpawnPoint(parcel_spawn),
                Position(Vec3::new(3.0, -1.6, 3.52)),
                LinearVelocity(Vec3::new(1.0, -3.0, 0.5)),
                AngularVelocity(Vec3::Y * 2.0),
            ));
            add_recovery_probe(&mut fixture);
            fixture.app.update();
            // 同一真实帧内双方恢复，任何延迟释放命令都不能把已经恢复的箱子写回水中。
            assert_free_after_recovery(&fixture);
            let world = fixture.app.world();
            assert_eq!(
                world.resource::<WaterRecoveryOrder>().0,
                if parcel_first {
                    vec![fixture.parcel, fixture.character]
                } else {
                    vec![fixture.character, fixture.parcel]
                },
                "The actual recovery system must exercise the requested query order"
            );
            let recovered = world.resource::<RecoveryProbe>().snapshot.as_ref().unwrap();
            assert!(!recovered.held && recovered.dynamic);
            assert!(
                recovered
                    .position
                    .abs_diff_eq(parcel_spawn.translation, 0.0001),
                "Simultaneous recovery must use the parcel's own spawn: parcel_first={parcel_first}, actual={:?}",
                recovered.position
            );
            assert_eq!(recovered.linear_velocity, Vec3::ZERO);
            assert_eq!(recovered.angular_velocity, Vec3::ZERO);
            assert!(
                world
                    .get::<Position>(fixture.character)
                    .unwrap()
                    .0
                    .distance(holder_spawn.translation)
                    < 0.05
            );
            assert!(
                world
                    .get::<Transform>(fixture.parcel)
                    .unwrap()
                    .translation
                    .distance(parcel_spawn.translation)
                    < 0.05
            );
        }
    }
}

mod interaction_tests {
    //! 真实交互与共享刚体回归，检查对齐、受阻和关系异常后的释放。

    use super::handle_interaction;
    use crate::character::character_body;
    use crate::item_interaction::parcel_body;
    use crate::{
        character::{Character, CharacterIntent, CharacterMotion, CharacterPlugin},
        game_flow::configure_feature_order,
        item_interaction::{
            CarryGrip, HeldBy, HeldTarget, ItemInteractionPlugin, Parcel, Pickable,
        },
        physics::{
            GamePhysicsPlugin, ground_body, parcel_collision_layers, world_collision_layers,
        },
        settings::PrototypeConfig,
    };
    use avian3d::prelude::*;
    use bevy::prelude::*;
    use bevy::time::TimeUpdateStrategy;
    use std::time::Duration;

    fn test_app() -> App {
        let mut app = App::new();
        configure_feature_order(&mut app);
        app.add_plugins((
            MinimalPlugins,
            TransformPlugin,
            (GamePhysicsPlugin, CharacterPlugin, ItemInteractionPlugin),
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / 60.0,
        )));
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut().spawn((
            ground_body(&config),
            Transform::from_xyz(0.0, config.ground_y, 0.0),
        ));
        // 手动 update 不经过 App::run，需先完成物理插件的资源初始化。
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    fn step(app: &mut App, count: usize) {
        for _ in 0..count {
            app.update();
        }
    }

    fn spawn_character(app: &mut App, position: Vec3, intent: CharacterIntent) -> Entity {
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((
                Character,
                intent,
                CharacterMotion::default(),
                Transform::from_translation(position),
                character_body(&config),
            ))
            .id()
    }

    fn spawn_box(app: &mut App, position: Vec3) -> Entity {
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((
                Parcel,
                Pickable,
                Transform::from_translation(position),
                parcel_body(&config),
            ))
            .id()
    }

    fn interact(app: &mut App, character: Entity) {
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        step(app, 1);
    }

    #[test]
    fn item_specific_grips_align_then_remain_fixed_on_the_shared_body() {
        for grip in [Vec3::new(0.0, 1.3, -0.48), Vec3::new(0.0, 1.3, -0.62)] {
            let mut app = test_app();
            let character = spawn_character(&mut app, Vec3::ZERO, default());
            let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
            app.world_mut().entity_mut(item).insert(CarryGrip(grip));
            step(&mut app, 30);
            let before_pickup = app.world().get::<Position>(item).unwrap().0;
            interact(&mut app, character);
            assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
            assert!(app.world().get::<RigidBody>(item).is_none());
            let proxy = app
                .world()
                .get::<crate::item_interaction::HeldAttachment>(item)
                .unwrap()
                .collider;
            assert_eq!(
                app.world().get::<ColliderOf>(proxy).unwrap().body,
                character
            );
            let after_pickup = app.world().get::<Position>(item).unwrap().0;
            assert!(
                after_pickup.distance(before_pickup) < 0.2,
                "Pickup teleported the item: {before_pickup:?} {after_pickup:?}"
            );
            let initial_error =
                after_pickup.distance(app.world().get::<HeldTarget>(item).unwrap().translation);
            assert!(initial_error > 0.5);
            let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
            // 执行真实固定步，先安全对齐，再核对组合刚体保存的实际箱体位置。
            step(&mut app, 120);
            assert!(
                app.world().resource::<Time<Fixed>>().elapsed() - fixed_before
                    > Duration::from_secs(1)
            );
            let world = app.world();
            let target = world.get::<HeldTarget>(item).unwrap();
            let actual = world.get::<Position>(item).unwrap().0;
            assert!(
                actual.distance(target.translation) < 0.1,
                "The shared body did not align its held box: {grip:?} {actual:?} {:?}",
                target.translation
            );
            // 静止角色面向 -Z；分别验证真实箱体的高度和距离，不只断言派生目标的公式。
            let relative = actual - world.get::<Position>(character).unwrap().0;
            assert!((relative.y - 1.3).abs() < 0.1, "{grip:?} {relative:?}");
            assert!((relative.z - grip.z).abs() < 0.08, "{grip:?} {relative:?}");
            assert!(world.get::<LinearVelocity>(item).unwrap().0.length() < 0.1);
            let displayed_offset =
                target.translation - world.get::<Transform>(character).unwrap().translation;
            assert!(displayed_offset.abs_diff_eq(grip, 0.00001));
        }
    }

    #[test]
    fn shared_body_blocks_at_wall_and_release_keeps_velocity() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
        step(&mut app, 30);
        let before = app.world().get::<Position>(item).unwrap().0;
        interact(&mut app, character);
        assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
        assert!(app.world().get::<RigidBody>(item).is_none());
        let proxy = app
            .world()
            .get::<crate::item_interaction::HeldAttachment>(item)
            .unwrap()
            .collider;
        assert_eq!(
            app.world().get::<ColliderOf>(proxy).unwrap().body,
            character
        );
        let after = app.world().get::<Position>(item).unwrap().0;
        assert!(
            after.distance(before) < 0.2,
            "Pickup teleported: {before:?} {after:?}"
        );
        step(&mut app, 100);
        assert!((app.world().get::<Position>(item).unwrap().y - 1.0).abs() < 0.12);
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(8.0, 3.0, 0.2),
            world_collision_layers(),
            Transform::from_xyz(0.0, 1.5, -1.6),
        ));
        // 已完成正常持握后持续前进，箱体碰墙应直接阻挡同一刚体的人物。
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        step(&mut app, 90);
        let position = app.world().get::<Position>(item).unwrap().0;
        assert!(position.z > -1.3, "Held box crossed wall: {position:?}");
        assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
        let holder_position = app.world().get::<Position>(character).unwrap().0;
        assert!(
            holder_position.z > -0.4,
            "Holder entered its blocked box: {holder_position:?}"
        );
        // 直接运行交互系统验证释放瞬间不修改任何速度或位置，不混入随后重力。
        app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = Vec3::new(1.0, 2.0, 0.5);
        app.world_mut().get_mut::<AngularVelocity>(item).unwrap().0 = Vec3::new(0.5, 1.0, 0.0);
        let before_release = app.world().get::<Position>(item).unwrap().0;
        let rotation_before_release = app.world().get::<Rotation>(item).unwrap().0;
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        let mut schedule = Schedule::default();
        schedule.add_systems(handle_interaction);
        schedule.run(app.world_mut());
        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(app.world().get::<HeldTarget>(item).is_none());
        assert_eq!(
            app.world().get::<LinearVelocity>(item).unwrap().0,
            Vec3::new(1.0, 2.0, 0.5)
        );
        assert_eq!(app.world().get::<Position>(item).unwrap().0, before_release);
        assert_eq!(
            app.world().get::<AngularVelocity>(item).unwrap().0,
            Vec3::new(0.5, 1.0, 0.0)
        );
        assert_eq!(
            app.world().get::<Rotation>(item).unwrap().0,
            rotation_before_release
        );
        // 松手后退离箱体再验证重力；继续向墙走会把自由箱夹住，墙面摩擦可合法承重。
        let holder_before_retreat = app.world().get::<Position>(character).unwrap().0;
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::NEG_Y;
        step(&mut app, 120);
        let final_position = app.world().get::<Position>(item).unwrap().0;
        let final_velocity = app.world().get::<LinearVelocity>(item).unwrap().0;
        let holder_position = app.world().get::<Position>(character).unwrap().0;
        let touching_holder = app
            .world()
            .resource::<ContactGraph>()
            .get(item, character)
            .is_some_and(|(_, pair)| pair.is_touching());
        assert!(
            final_position.y < 0.5,
            "Released box did not land: box={final_position:?}, velocity={final_velocity:?}, holder={holder_position:?}, touching_holder={touching_holder}"
        );
        assert!(
            holder_position.z > holder_before_retreat.z + 1.0,
            "The holder must retreat far enough to stop clamping the free box"
        );
    }

    #[test]
    fn holder_despawn_and_external_relation_removal_restore_free_collisions() {
        for despawn in [false, true] {
            let mut app = test_app();
            let character = spawn_character(&mut app, Vec3::ZERO, default());
            let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
            step(&mut app, 30);
            interact(&mut app, character);
            step(&mut app, 60);
            if despawn {
                app.world_mut().despawn(character);
            } else {
                app.world_mut().entity_mut(item).remove::<HeldBy>();
            }
            step(&mut app, 1);
            assert!(app.world().get::<HeldTarget>(item).is_none());
            assert_eq!(
                *app.world().get::<CollisionLayers>(item).unwrap(),
                parcel_collision_layers()
            );
            step(&mut app, 120);
            assert!(app.world().get::<Position>(item).unwrap().y < 0.5);
        }
    }

    #[test]
    fn held_box_collision_stops_the_holder_before_it_enters_the_box() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::new(0.0, 0.0, 2.0), default());
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, 1.1));
        let grip = Vec3::new(0.0, 1.3, -0.48);
        app.world_mut().entity_mut(item).insert(CarryGrip(grip));
        let config = app.world().resource::<PrototypeConfig>().clone();
        let obstacle = app
            .world_mut()
            .spawn((
                RigidBody::Static,
                crate::character::character_collider(&config),
                world_collision_layers(),
                Transform::IDENTITY,
            ))
            .id();
        step(&mut app, 30);
        interact(&mut app, character);
        step(&mut app, 120);
        let proxy = app
            .world()
            .get::<crate::item_interaction::HeldAttachment>(item)
            .unwrap()
            .collider;
        let before = app.world().get::<Position>(character).unwrap().0;
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;

        let mut solved_contact = false;
        for _ in 0..180 {
            step(&mut app, 1);
            let world = app.world();
            let holder_position = world.get::<Position>(character).unwrap().0;
            let box_position = world.get::<Position>(item).unwrap().0;
            if let Some((_, pair)) = world.resource::<ContactGraph>().get(proxy, obstacle) {
                solved_contact |= pair.is_touching()
                    && pair
                        .manifolds
                        .iter()
                        .any(|manifold| manifold.total_normal_impulse() > 0.001);
            }
            // 使用正常手前偏移和持续移动，不能让人物留在远处、延长手臂来掩盖追入箱体。
            let relative = box_position - holder_position;
            assert!(
                (relative.z - grip.z).abs() < 0.16,
                "The holder moved into its obstructed box: holder={holder_position:?}, box={box_position:?}"
            );
        }
        let after = app.world().get::<Position>(character).unwrap().0;
        assert!(
            before.z - after.z > 0.5,
            "The holder must actually approach"
        );
        assert!(
            solved_contact,
            "The held box must have a solved obstacle contact"
        );
        assert!(after.z > config.character_radius * 2.0 + 0.2);
    }
}

mod rotation_tests {
    //! 完整连续路径和真实空间索引回归，保留起点接触、薄墙及退化三角面的边界。

    use super::{
        CarryRotationQuery,
        rotation_motion::{pivot_motion, pose_motion, rotation_motion},
        rotation_sweep::path_hits,
    };
    use crate::game_flow::configure_feature_order;
    use crate::physics::world_collision_layers;
    use avian3d::{
        parry::{
            math::Pose,
            query::{DefaultQueryDispatcher, NonlinearRigidMotion, QueryDispatcher, details},
        },
        prelude::*,
    };
    use bevy::prelude::*;
    use bevy::{ecs::system::SystemState, time::TimeUpdateStrategy};
    use std::f32::consts::{FRAC_PI_2, PI, TAU};

    fn local_grip() -> ColliderTransform {
        ColliderTransform {
            translation: Vec3::new(0.0, 1.3, -1.0),
            ..default()
        }
    }

    fn motion_to(angle: f32) -> NonlinearRigidMotion {
        rotation_motion(
            Vec3::ZERO,
            Quat::IDENTITY,
            Quat::from_rotation_y(angle),
            local_grip(),
        )
        .unwrap()
    }

    fn intersects_at(
        motion: &NonlinearRigidMotion,
        collider: &Collider,
        obstacle: &Collider,
        pose: Pose,
        time: f32,
    ) -> bool {
        avian3d::parry::query::intersection_test(
            &motion.position_at_time(time),
            collider.shape_scaled().as_ref(),
            &pose,
            obstacle.shape_scaled().as_ref(),
        )
        .unwrap()
        .intersecting
    }

    #[test]
    fn half_turn_hits_thin_wall_between_clear_endpoints() {
        let motion = motion_to(PI);
        let collider = Collider::cuboid(0.04, 0.04, 0.04);
        let obstacle = Collider::cuboid(0.1, 0.4, 0.0002);
        // 不同薄墙落在任意中间角度；回归不能只用恰好落在常见采样点的障碍。
        for time in [0.071, 0.197, 0.371, 0.5, 0.731, 0.929] {
            let pose = Pose::from_parts(motion.position_at_time(time).translation, Quat::IDENTITY);
            assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
            assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
            assert!(intersects_at(&motion, &collider, &obstacle, pose, time));
            assert!(path_hits(&motion, &collider, &obstacle, pose), "{time}");
        }
    }

    #[test]
    fn shortest_arc_crosses_angle_wrap_without_sweeping_opposite_side() {
        let motion = rotation_motion(
            Vec3::ZERO,
            Quat::from_rotation_y(170_f32.to_radians()),
            Quat::from_rotation_y(-170_f32.to_radians()),
            local_grip(),
        )
        .unwrap();
        let collider = Collider::cuboid(0.04, 0.04, 0.04);
        let obstacle = Collider::cuboid(0.04, 0.4, 0.04);
        let nearby = Pose::from_parts(Vec3::new(0.0, 1.3, 1.0), Quat::IDENTITY);
        let opposite = Pose::from_parts(Vec3::new(0.0, 1.3, -1.0), Quat::IDENTITY);
        assert!(path_hits(&motion, &collider, &obstacle, nearby));
        assert!(!path_hits(&motion, &collider, &obstacle, opposite));
    }

    #[test]
    fn signed_half_turn_keeps_the_actual_input_direction() {
        let collider = Collider::cuboid(0.04, 0.04, 0.04);
        let obstacle = Collider::cuboid(0.1, 0.4, 0.0002);
        let left = Pose::from_parts(Vec3::new(-1.0, 1.3, 0.0), Quat::IDENTITY);
        let right = Pose::from_parts(Vec3::new(1.0, 1.3, 0.0), Quat::IDENTITY);
        for angle in [PI, -PI] {
            let motion =
                pivot_motion(Vec3::ZERO, Quat::IDENTITY, Vec3::Y * angle, local_grip()).unwrap();
            assert_eq!(path_hits(&motion, &collider, &obstacle, left), angle > 0.0);
            assert_eq!(path_hits(&motion, &collider, &obstacle, right), angle < 0.0);
        }
    }

    #[test]
    fn full_turn_cannot_hide_collisions_behind_an_identical_end_pose() {
        let collider = Collider::cuboid(0.04, 0.04, 0.04);
        let obstacle = Collider::cuboid(0.1, 0.4, 0.0002);
        for angle in [TAU, -TAU] {
            let motion =
                pivot_motion(Vec3::ZERO, Quat::IDENTITY, Vec3::Y * angle, local_grip()).unwrap();
            for x in [-1.0, 1.0] {
                let pose = Pose::from_parts(Vec3::new(x, 1.3, 0.0), Quat::IDENTITY);
                assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
                assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
                assert!(path_hits(&motion, &collider, &obstacle, pose));
            }
        }
    }

    #[test]
    fn existing_wall_contact_can_turn_away_but_not_into_the_wall() {
        let collider = Collider::cuboid(0.4, 0.4, 0.4);
        let wall = Collider::cuboid(0.001, 2.0, 4.0);
        // 保留轻微接触穿入，覆盖真实求解后的接触容差，向外转不应被原接触误判。
        let pose = Pose::from_parts(Vec3::new(-0.2004, 1.3, -1.0), Quat::IDENTITY);
        let away = motion_to(-FRAC_PI_2);
        let into = motion_to(FRAC_PI_2);
        assert!(intersects_at(&away, &collider, &wall, pose, 0.0));
        assert!(!path_hits(&away, &collider, &wall, pose));
        assert!(path_hits(&into, &collider, &wall, pose));
        // 普通 CCD 的物体厚度门槛会放过小角度新穿入，显式转向必须同样拦住。
        assert!(path_hits(&motion_to(0.005), &collider, &wall, pose));
        assert!(!path_hits(&motion_to(-0.005), &collider, &wall, pose));
    }

    #[test]
    fn separating_start_contact_does_not_hide_later_collision() {
        let collider = Collider::cuboid(0.4, 0.4, 0.4);
        let wall = Collider::cuboid(0.001, 2.0, 4.0);
        let pose = Pose::from_parts(Vec3::new(-0.2004, 1.3, -1.0), Quat::IDENTITY);
        assert!(path_hits(&motion_to(-PI + 0.00001), &collider, &wall, pose));
    }

    #[test]
    fn no_turn_returns_no_rotation_path_even_during_contact() {
        let yaw = Quat::from_rotation_y(0.7);
        assert!(rotation_motion(Vec3::ZERO, yaw, yaw, local_grip()).is_none());
        assert!(rotation_motion(Vec3::ZERO, yaw, -yaw, local_grip()).is_none());
    }

    #[test]
    fn existing_ground_contact_remains_tangential_during_horizontal_turn() {
        let collider = Collider::cuboid(0.4, 0.4, 0.4);
        let local = ColliderTransform {
            translation: Vec3::new(0.0, 0.1999, -1.0),
            ..default()
        };
        let motion = rotation_motion(
            Vec3::ZERO,
            Quat::IDENTITY,
            Quat::from_rotation_y(1.2),
            local,
        )
        .unwrap();
        let ground_box = Collider::compound(vec![(
            Vec3::NEG_Y * 0.1,
            Quat::IDENTITY,
            Collider::cuboid(4.0, 0.2, 4.0),
        )]);
        let ground_mesh = Collider::trimesh(
            vec![
                Vec3::new(-2.0, 0.0, -2.0),
                Vec3::new(2.0, 0.0, -2.0),
                Vec3::new(2.0, 0.0, 2.0),
                Vec3::new(-2.0, 0.0, 2.0),
            ],
            vec![[0, 2, 1], [0, 3, 2]],
        );
        for ground in [ground_box, ground_mesh] {
            assert!(intersects_at(
                &motion,
                &collider,
                &ground,
                Pose::IDENTITY,
                0.0
            ));
            assert!(
                !path_hits(&motion, &collider, &ground, Pose::IDENTITY),
                "{:?}",
                ground.shape_scaled().shape_type(),
            );
        }
    }

    fn assert_clear_turn_above_mesh(collider: Collider, grip_z: f32) {
        let ground = Collider::trimesh(
            vec![
                Vec3::new(-20.0, 0.0, -20.0),
                Vec3::new(20.0, 0.0, -20.0),
                Vec3::new(20.0, 0.0, 20.0),
                Vec3::new(-20.0, 0.0, 20.0),
            ],
            vec![[0, 2, 1], [0, 3, 2]],
        );
        for origin in [
            Vec3::ZERO,
            Vec3::new(-0.6283571, -0.0000307, 3.2463346),
            Vec3::new(7.5, 0.0, 5.0),
        ] {
            for angle in [0.001, -0.001, 0.02, -0.02, FRAC_PI_2, -FRAC_PI_2, TAU, -TAU] {
                let motion = pivot_motion(
                    origin,
                    Quat::IDENTITY,
                    Vec3::Y * angle,
                    ColliderTransform {
                        translation: Vec3::new(0.0, 1.3, grip_z),
                        ..default()
                    },
                )
                .unwrap();
                // 绕世界 Y 轴转动保持每个点的高度，箱底全程高于唯一的地面平面。
                assert_eq!(motion.angvel.cross(Vec3::Y), Vec3::ZERO);
                assert!(
                    collider
                        .shape_scaled()
                        .compute_aabb(&motion.position_at_time(0.0))
                        .mins
                        .y
                        > 0.97
                );
                assert!(!intersects_at(
                    &motion,
                    &collider,
                    &ground,
                    Pose::IDENTITY,
                    0.0,
                ));
                assert!(!intersects_at(
                    &motion,
                    &collider,
                    &ground,
                    Pose::IDENTITY,
                    1.0,
                ));
                assert!(
                    !path_hits(&motion, &collider, &ground, Pose::IDENTITY),
                    "Clear turn above mesh was blocked: origin={origin:?}, angle={angle}, initial_contact={:?}, default_nonlinear={:?}",
                    DefaultQueryDispatcher.contact(
                        &motion.position_at_time(0.0).inverse(),
                        collider.shape_scaled().as_ref(),
                        ground.shape_scaled().as_ref(),
                        0.0,
                    ),
                    DefaultQueryDispatcher.cast_shapes_nonlinear(
                        &motion,
                        collider.shape_scaled().as_ref(),
                        &NonlinearRigidMotion::constant_position(Pose::IDENTITY),
                        ground.shape_scaled().as_ref(),
                        0.0,
                        1.0,
                        true,
                    ),
                );
            }
        }
    }

    #[test]
    fn clear_convex_box_turn_above_planar_mesh_keeps_the_carry() {
        assert_clear_turn_above_mesh(Collider::cuboid(0.6, 0.6, 0.6), -0.48);
    }

    #[test]
    fn clear_compound_box_turn_above_planar_mesh_keeps_the_carry() {
        assert_clear_turn_above_mesh(
            Collider::compound(vec![(
                Vec3::new(0.0, 0.01625, 0.01625),
                Quat::IDENTITY,
                Collider::cuboid(0.84, 0.6825, 0.8145),
            )]),
            -0.62,
        );
    }

    #[test]
    fn new_triangle_contact_does_not_use_the_existing_contact_margin() {
        let collider = Collider::cuboid(0.4, 0.4, 0.4);
        let wall = Collider::trimesh(
            vec![
                Vec3::new(0.0, 0.0, -2.0),
                Vec3::new(0.0, 2.0, -2.0),
                Vec3::new(0.0, 1.0, 2.0),
            ],
            vec![[0, 1, 2]],
        );
        // 起点分离 0.2mm，终点新穿入 0.2mm；新碰撞不能套用已有接触的 1mm 余量。
        for rotation in [Quat::IDENTITY, Quat::from_rotation_y(1.0e-5)] {
            // 微小转角确保非线性分支也不能把新墙接触借作已有接触余量。
            let motion = pose_motion(
                Transform::from_xyz(0.2002, 1.0, 0.0),
                Transform::from_xyz(0.1998, 1.0, 0.0).with_rotation(rotation),
            )
            .unwrap();
            assert!(!intersects_at(
                &motion,
                &collider,
                &wall,
                Pose::IDENTITY,
                0.0,
            ));
            assert!(intersects_at(
                &motion,
                &collider,
                &wall,
                Pose::IDENTITY,
                1.0,
            ));
            assert!(path_hits(&motion, &collider, &wall, Pose::IDENTITY));
        }
    }

    #[test]
    fn pickup_lifts_from_ground_but_cannot_pass_through_a_ceiling() {
        let collider = Collider::cuboid(0.6, 0.6, 0.6);
        let start = Transform::from_xyz(0.0, 0.2999, -0.9);
        let end = Transform::from_xyz(0.0, 1.8, -0.48);
        let motion = pose_motion(start, end).unwrap();
        let ground = Collider::compound(vec![(
            Vec3::NEG_Y * 0.1,
            Quat::IDENTITY,
            Collider::cuboid(4.0, 0.2, 4.0),
        )]);
        assert!(intersects_at(
            &motion,
            &collider,
            &ground,
            Pose::IDENTITY,
            0.0
        ));
        assert!(!path_hits(&motion, &collider, &ground, Pose::IDENTITY));
        let room = Collider::compound(vec![
            (
                Vec3::NEG_Y * 0.1,
                Quat::IDENTITY,
                Collider::cuboid(4.0, 0.2, 4.0),
            ),
            (
                Vec3::Y * 1.1,
                Quat::IDENTITY,
                Collider::cuboid(4.0, 0.1, 4.0),
            ),
        ]);
        assert!(!intersects_at(
            &motion,
            &collider,
            &room,
            Pose::IDENTITY,
            1.0
        ));
        assert!(path_hits(&motion, &collider, &room, Pose::IDENTITY));
    }

    #[test]
    fn pickup_translation_and_rotation_hit_between_clear_endpoints() {
        let start = Transform::from_xyz(-1.0, 1.3, 0.0);
        let end =
            Transform::from_xyz(1.0, 1.3, 0.0).with_rotation(Quat::from_rotation_y(FRAC_PI_2));
        let motion = pose_motion(start, end).unwrap();
        let offset = Vec3::new(0.25, 0.0, 0.0);
        let collider = Collider::compound(vec![(
            offset,
            Quat::IDENTITY,
            Collider::cuboid(0.04, 0.04, 0.04),
        )]);
        let obstacle = Collider::cuboid(0.0002, 0.4, 0.1);
        let pose = Pose::from_parts(motion.position_at_time(0.371) * offset, Quat::IDENTITY);
        assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
        assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
        assert!(path_hits(&motion, &collider, &obstacle, pose));
    }

    #[test]
    fn compound_geometry_and_local_rotation_follow_the_same_pivot() {
        let local = ColliderTransform {
            rotation: Quat::from_rotation_y(0.3),
            ..local_grip()
        };
        let motion = rotation_motion(
            Vec3::ZERO,
            Quat::IDENTITY,
            Quat::from_rotation_y(PI - 0.001),
            local,
        )
        .unwrap();
        let offset = Vec3::new(0.0, 0.0, 0.45);
        let collider = Collider::compound(vec![(
            offset,
            Quat::IDENTITY,
            Collider::cuboid(0.04, 0.04, 0.04),
        )]);
        let obstacle = Collider::cuboid(0.01, 0.3, 0.01);
        let pose = Pose::from_parts(motion.position_at_time(0.5) * offset, Quat::IDENTITY);
        assert!(!intersects_at(&motion, &collider, &obstacle, pose, 0.0));
        assert!(!intersects_at(&motion, &collider, &obstacle, pose, 1.0));
        assert!(path_hits(&motion, &collider, &obstacle, pose));
    }

    fn query_app() -> App {
        let mut app = App::new();
        configure_feature_order(&mut app);
        // 只运行固定物理与空间索引，不安装窗口后端或渲染插件。
        app.add_plugins((MinimalPlugins, TransformPlugin, PhysicsPlugins::default()))
            .insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    fn spawn_obstacle(app: &mut App, position: Vec3) -> Entity {
        app.world_mut()
            .spawn((
                RigidBody::Static,
                Collider::cuboid(0.1, 0.4, 0.0002),
                Transform::from_translation(position),
                world_collision_layers(),
            ))
            .id()
    }

    fn query_blocked(app: &mut App, excluded: &[Entity]) -> bool {
        let mut state = SystemState::<CarryRotationQuery>::new(app.world_mut());
        state.get(app.world()).unwrap().rotation_path_blocked(
            &Collider::cuboid(0.04, 0.04, 0.04),
            Vec3::ZERO,
            Quat::IDENTITY,
            Quat::from_rotation_y(PI),
            local_grip(),
            excluded,
        )
    }

    #[test]
    fn spatial_candidates_exclude_own_body_and_sensors() {
        let mut app = query_app();
        let middle = motion_to(PI).position_at_time(0.5).translation;
        let holder = spawn_obstacle(&mut app, Vec3::ZERO);
        let attached = app
            .world_mut()
            .spawn((
                Collider::cuboid(0.1, 0.4, 0.0002),
                ColliderOf { body: holder },
                ColliderTransform {
                    translation: middle,
                    ..default()
                },
                Transform::from_translation(middle),
                world_collision_layers(),
            ))
            .id();
        let sensor = spawn_obstacle(&mut app, middle);
        app.world_mut().entity_mut(sensor).insert(Sensor);
        app.update();
        assert_eq!(
            app.world().get::<ColliderOf>(attached).unwrap().body,
            holder
        );
        assert!(!query_blocked(&mut app, &[holder]));
        spawn_obstacle(&mut app, middle);
        app.update();
        assert!(query_blocked(&mut app, &[holder]));
    }

    #[test]
    fn blocked_result_survives_static_and_dynamic_tree_traversal() {
        for dynamic_blocker in [false, true] {
            let mut app = query_app();
            let middle = motion_to(PI).position_at_time(0.5).translation;
            let blocker = spawn_obstacle(&mut app, middle);
            let clear = spawn_obstacle(&mut app, Vec3::new(-middle.x, middle.y, middle.z));
            let dynamic = if dynamic_blocker { blocker } else { clear };
            app.world_mut()
                .entity_mut(dynamic)
                .insert((RigidBody::Dynamic, GravityScale(0.0)));
            app.update();
            assert!(query_blocked(&mut app, &[]), "{dynamic_blocker}");
        }
    }

    #[test]
    fn disabled_collider_changes_queries_without_an_extra_physics_step() {
        let mut app = query_app();
        let middle = motion_to(PI).position_at_time(0.5).translation;
        let obstacle = spawn_obstacle(&mut app, middle);
        app.update();
        assert!(query_blocked(&mut app, &[]));
        let simulated = app.world().resource::<Time<Fixed>>().elapsed();
        app.world_mut()
            .entity_mut(obstacle)
            .insert(ColliderDisabled);
        app.world_mut().flush();
        assert!(!query_blocked(&mut app, &[]));
        app.world_mut()
            .entity_mut(obstacle)
            .remove::<ColliderDisabled>();
        app.world_mut().flush();
        assert!(query_blocked(&mut app, &[]));
        assert_eq!(app.world().resource::<Time<Fixed>>().elapsed(), simulated);
    }

    #[test]
    fn many_signed_turns_cover_both_sides_with_a_bounded_sweep() {
        let mut app = query_app();
        let left = spawn_obstacle(&mut app, Vec3::new(-1.0, 1.3, 0.0));
        let right = spawn_obstacle(&mut app, Vec3::new(1.0, 1.3, 0.0));
        app.update();
        let mut state = SystemState::<CarryRotationQuery>::new(app.world_mut());
        let query = state.get(app.world()).unwrap();
        let collider = Collider::cuboid(0.04, 0.04, 0.04);
        for angle in [1000.0 * TAU + 0.3, -1000.0 * TAU - 0.3] {
            assert!(query.yaw_path_blocked(
                &collider,
                Vec3::ZERO,
                Quat::IDENTITY,
                angle,
                local_grip(),
                &[left],
            ));
            assert!(query.yaw_path_blocked(
                &collider,
                Vec3::ZERO,
                Quat::IDENTITY,
                angle,
                local_grip(),
                &[right],
            ));
        }
    }

    #[test]
    fn reported_blocker_matches_the_requested_turn_side() {
        let mut app = query_app();
        let left = spawn_obstacle(&mut app, Vec3::new(-1.0, 1.3, 0.0));
        let right = spawn_obstacle(&mut app, Vec3::new(1.0, 1.3, 0.0));
        app.update();
        let mut state = SystemState::<CarryRotationQuery>::new(app.world_mut());
        let query = state.get(app.world()).unwrap();
        let collider = Collider::cuboid(0.04, 0.04, 0.04);
        for (angle, expected) in [(PI, left), (-PI, right)] {
            assert_eq!(
                query.yaw_path_blocker(
                    &collider,
                    Vec3::ZERO,
                    Quat::IDENTITY,
                    angle,
                    local_grip(),
                    &[],
                ),
                Some(expected),
            );
            assert_eq!(
                query.yaw_path_blocker(
                    &collider,
                    Vec3::ZERO,
                    Quat::IDENTITY,
                    angle,
                    local_grip(),
                    &[expected],
                ),
                None,
            );
        }
    }

    fn wall_probe_boxes() -> [(Collider, f32, f32); 2] {
        [
            (Collider::cuboid(0.6, 0.6, 0.6), -0.48, 0.3),
            (
                Collider::compound(vec![(
                    Vec3::new(0.0, 0.01625, 0.01625),
                    Quat::IDENTITY,
                    Collider::cuboid(0.84, 0.6825, 0.8145),
                )]),
                -0.62,
                0.42,
            ),
        ]
    }

    fn wall_probe_motion(origin: Vec3, grip_z: f32, angle: f32) -> NonlinearRigidMotion {
        pivot_motion(
            origin,
            Quat::IDENTITY,
            Vec3::Y * angle,
            ColliderTransform {
                translation: Vec3::new(0.0, 1.3, grip_z),
                ..default()
            },
        )
        .unwrap()
    }

    fn assert_clear_wall_probe(
        motion: &NonlinearRigidMotion,
        collider: &Collider,
        wall: &Collider,
    ) {
        assert!(!intersects_at(motion, collider, wall, Pose::IDENTITY, 0.0));
        assert!(!intersects_at(motion, collider, wall, Pose::IDENTITY, 1.0));
        let closest = collider.shape_scaled().as_support_map().map(|cube| {
            let triangle = wall.shape_scaled().as_trimesh().unwrap().triangle(0);
            let relative = motion.position_at_time(0.0);
            (
                DefaultQueryDispatcher.closest_points(
                    &relative,
                    &triangle,
                    collider.shape_scaled().as_ref(),
                    f32::MAX,
                ),
                details::closest_points_support_map_support_map(
                    &relative,
                    &triangle,
                    cube,
                    f32::MAX,
                ),
            )
        });
        assert!(
            !path_hits(motion, collider, wall, Pose::IDENTITY),
            "Clear wall path was blocked: shape={:?}, angle={}, start={:?}, closest_default_gjk={closest:?}, default_nonlinear={:?}",
            collider.shape_scaled().shape_type(),
            motion.angvel.y,
            motion.position_at_time(0.0),
            DefaultQueryDispatcher.cast_shapes_nonlinear(
                motion,
                collider.shape_scaled().as_ref(),
                &NonlinearRigidMotion::constant_position(Pose::IDENTITY),
                wall.shape_scaled().as_ref(),
                0.0,
                1.0,
                true,
            ),
        );
    }

    #[test]
    fn near_wall_turning_away_from_large_triangle_has_no_contact() {
        let wall = Collider::trimesh(
            vec![
                Vec3::new(0.0, -20.0, -20.0),
                Vec3::new(0.0, 20.0, -20.0),
                Vec3::new(0.0, 0.0, 20.0),
            ],
            vec![[0, 1, 2]],
        );
        for (collider, grip_z, half_x) in wall_probe_boxes() {
            let origin = Vec3::new(half_x + 0.0002, 0.0, 0.0);
            let bounds = collider.shape_scaled().compute_local_aabb();
            assert!(bounds.maxs.z + grip_z < 0.0);
            // 全弧角度在 [-PI, 0]：每个点原局部 Z<0，绕 Y 转离时 X>=origin.x-half_x。
            assert!(origin.x - half_x > 0.00019);
            for angle in [-0.001, -0.1, -FRAC_PI_2, -PI + 0.00001] {
                assert_clear_wall_probe(
                    &wall_probe_motion(origin, grip_z, angle),
                    &collider,
                    &wall,
                );
            }
            // 同一微转反方向必须真正撞墙，不能通过忽略墙让无接触探针假通过。
            assert!(path_hits(
                &wall_probe_motion(origin, grip_z, 0.001),
                &collider,
                &wall,
                Pose::IDENTITY,
            ));
        }
    }

    fn finite_triangle_probe(vertices: [Vec3; 3]) {
        let wall = Collider::trimesh(vertices.to_vec(), vec![[0, 1, 2]]);
        assert!(vertices.iter().all(|point| point.z >= 0.0));
        for (collider, grip_z, _) in wall_probe_boxes() {
            let bounds = collider.shape_scaled().compute_local_aabb();
            let radius = [
                Vec2::new(bounds.mins.x, bounds.mins.z + grip_z),
                Vec2::new(bounds.mins.x, bounds.maxs.z + grip_z),
                Vec2::new(bounds.maxs.x, bounds.mins.z + grip_z),
                Vec2::new(bounds.maxs.x, bounds.maxs.z + grip_z),
            ]
            .into_iter()
            .map(|point| point.length())
            .fold(0.0_f32, f32::max);
            let origin = Vec3::new(0.0, 0.0, -radius - 0.02);
            // 绕 Y 的水平半径恒定，所有形状点全弧 Z<=-0.02，而真实三角片所有点 Z>=0。
            // 形状跨过墙的无限 X 平面也不能与有限片相交；这里证明整段，未用姿态采样作替代。
            assert!(origin.z + radius < -0.019);
            for angle in [0.001, -0.001, FRAC_PI_2, -PI, TAU] {
                assert_clear_wall_probe(
                    &wall_probe_motion(origin, grip_z, angle),
                    &collider,
                    &wall,
                );
            }
        }
    }

    #[test]
    fn finite_triangle_edge_stays_clear_over_the_complete_turn() {
        finite_triangle_probe([
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(0.0, 4.0, 0.0),
            Vec3::new(0.0, 2.0, 4.0),
        ]);
    }

    #[test]
    fn finite_triangle_line_stays_clear_over_the_complete_turn() {
        finite_triangle_probe([
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(0.0, 2.0, 0.0),
            Vec3::new(0.0, 4.0, 0.0),
        ]);
    }

    #[test]
    fn finite_triangle_point_and_thin_line_stay_clear_over_the_complete_turn() {
        finite_triangle_probe([Vec3::new(0.0, 1.3, 0.0); 3]);
        finite_triangle_probe([
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(0.0, 4.0, 0.0),
            Vec3::new(0.0, 2.0, 0.0000001),
        ]);
    }
}

mod audio_event_tests {
    //! 无设备反馈回归，直接组合插件使用的接触和握持误差系统。

    use super::audio_events::{register_feedback, warn_hold_strain};
    use super::*;
    use crate::game_flow::configure_feature_order;
    use crate::game_flow::{AppState, PlayState};
    use crate::{
        audio::{SoundCue, SoundRequest},
        character::Character,
        settings::PrototypeConfig,
    };
    use avian3d::prelude::*;
    use bevy::ecs::relationship::Relationship;

    #[test]
    fn gameplay_feedback_stays_silent_in_main_menu_and_pause() {
        let mut app = App::new();
        configure_feature_order(&mut app);
        app.init_resource::<PrototypeConfig>()
            .init_resource::<ContactGraph>()
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(State::new(AppState::MainMenu))
            .insert_resource(State::new(PlayState::Running));
        register_feedback(&mut app);
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        let holder = app
            .world_mut()
            .spawn((Character, Position::default(), Transform::default()))
            .id();
        app.world_mut().spawn((
            Parcel,
            <HeldBy as Relationship>::from(holder),
            Position(Vec3::X * 5.0),
        ));
        let parcel = app.world_mut().spawn(Parcel).id();
        let ground = app.world_mut().spawn_empty().id();
        // 只提供已解算的接触数据，验证收集系统的会话门槛，不安装物理或输出设备。
        let mut point = ContactPoint::new(Vec3::ZERO, Vec3::ZERO, Vec3::ZERO, 0.0);
        point.normal_impulse = 2.0;
        app.world_mut()
            .resource_mut::<ContactGraph>()
            .add_edge_with(ContactEdge::new(parcel, ground), |pair| {
                pair.flags.insert(ContactPairFlags::TOUCHING);
                pair.manifolds = vec![ContactManifold::new([point], -Vec3::Y)];
            });
        for _ in 0..20 {
            app.world_mut().run_schedule(FixedUpdate);
            app.world_mut().run_schedule(FixedPostUpdate);
        }
        assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());

        app.insert_resource(State::new(AppState::InGame));
        app.world_mut().run_schedule(FixedUpdate);
        app.world_mut().run_schedule(FixedPostUpdate);
        let cues: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .map(|request| request.cue)
            .collect();
        assert_eq!(cues, [SoundCue::ParcelLand]);

        app.insert_resource(State::new(PlayState::Paused));
        for _ in 0..20 {
            app.world_mut().run_schedule(FixedUpdate);
            app.world_mut().run_schedule(FixedPostUpdate);
        }
        assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());
        app.insert_resource(State::new(PlayState::Running));
        for _ in 0..10 {
            app.world_mut().run_schedule(FixedUpdate);
            app.world_mut().run_schedule(FixedPostUpdate);
        }
        let cues: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .map(|request| request.cue)
            .collect();
        assert_eq!(cues, [SoundCue::InstabilityWarning]);
    }

    #[test]
    fn sustained_strain_warns_once_and_recovery_rearms() {
        let mut app = App::new();
        configure_feature_order(&mut app);
        app.init_resource::<PrototypeConfig>()
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .add_message::<SoundRequest>()
            .add_systems(FixedUpdate, warn_hold_strain);
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        let holder = app
            .world_mut()
            .spawn((Character, Position::default(), Transform::default()))
            .id();
        let parcel = app
            .world_mut()
            .spawn((
                Parcel,
                <HeldBy as Relationship>::from(holder),
                Position(Vec3::X * 5.0),
            ))
            .id();
        for _ in 0..20 {
            app.world_mut().run_schedule(FixedUpdate);
        }
        let cues: Vec<_> = app
            .world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .collect();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].cue, SoundCue::InstabilityWarning);
        let target = app.world().resource::<PrototypeConfig>().hold_offset;
        app.world_mut().get_mut::<Position>(parcel).unwrap().0 = target;
        app.world_mut().run_schedule(FixedUpdate);
        app.world_mut().get_mut::<Position>(parcel).unwrap().0 = Vec3::X * 5.0;
        for _ in 0..10 {
            app.world_mut().run_schedule(FixedUpdate);
        }
        assert_eq!(
            app.world_mut()
                .resource_mut::<Messages<SoundRequest>>()
                .drain()
                .count(),
            1
        );
        app.world_mut().entity_mut(parcel).remove::<HeldBy>();
        app.world_mut().run_schedule(FixedUpdate);
        assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());
    }

    #[test]
    fn item_grips_allow_normal_lag_and_rearm_after_recovery() {
        // 运行真实反馈系统，覆盖海岛纸箱和木箱的偏移、物理位置与非零水平朝向。
        // 不安装物理、窗口或音频设备；位姿直接表达正常持握和两次持续受阻。
        for grip in [Vec3::new(0.0, 1.3, -0.48), Vec3::new(0.0, 1.3, -0.62)] {
            let mut app = App::new();
            configure_feature_order(&mut app);
            app.init_resource::<PrototypeConfig>()
                .insert_resource(Time::<Fixed>::from_hz(60.0))
                .add_message::<SoundRequest>()
                .add_systems(FixedUpdate, warn_hold_strain);
            app.world_mut()
                .resource_mut::<Time<Fixed>>()
                .advance_by(std::time::Duration::from_secs_f32(0.1));
            let position = Vec3::new(3.0, 0.8, -2.0);
            let rotation = Quat::from_rotation_y(1.2);
            let holder = app
                .world_mut()
                .spawn((
                    Character,
                    Position(position),
                    // 模拟目标必须读 Position，不能误读经过插值的呈现位置。
                    Transform {
                        translation: position + Vec3::X,
                        rotation,
                        ..default()
                    },
                ))
                .id();
            let target = position + rotation * grip;
            let parcel = app
                .world_mut()
                .spawn((
                    Parcel,
                    <HeldBy as Relationship>::from(holder),
                    CarryGrip(grip),
                    Position(target + rotation * Vec3::Z * 0.3),
                ))
                .id();
            let take_cues = |app: &mut App| {
                app.world_mut()
                    .resource_mut::<Messages<SoundRequest>>()
                    .drain()
                    .map(|request| (request.cue, request.source))
                    .collect::<Vec<_>>()
            };
            // 小于恢复阈值的正常惯性偏移不应触发持续失稳告警。
            for _ in 0..20 {
                app.world_mut().run_schedule(FixedUpdate);
            }
            assert!(take_cues(&mut app).is_empty(), "grip={grip:?}");

            for _ in 0..2 {
                app.world_mut().get_mut::<Position>(parcel).unwrap().0 = target + Vec3::X * 2.0;
                for _ in 0..20 {
                    app.world_mut().run_schedule(FixedUpdate);
                }
                assert_eq!(
                    take_cues(&mut app),
                    [(SoundCue::InstabilityWarning, parcel)],
                    "grip={grip:?}"
                );
                for _ in 0..10 {
                    app.world_mut().run_schedule(FixedUpdate);
                }
                assert!(take_cues(&mut app).is_empty(), "grip={grip:?}");

                // 恢复到实际物品目标后重新武装；下一轮受阻仍应发出一条警告。
                app.world_mut().get_mut::<Position>(parcel).unwrap().0 = target;
                app.world_mut().run_schedule(FixedUpdate);
                assert!(take_cues(&mut app).is_empty(), "grip={grip:?}");
            }
        }
    }
}
