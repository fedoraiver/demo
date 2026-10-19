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
    physics::{GamePhysicsPlugin, ground_body, parcel_collision_layers, world_collision_layers},
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
            .query_filtered::<Entity, (With<RigidBody>, Without<Character>, Without<Pickable>)>()
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
