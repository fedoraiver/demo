//! 真实无窗口固定步覆盖接地、运动、跳跃和跨渲染帧率的一次性意图。

use super::motion::update_grounded;
use crate::character::character_body;
use crate::item_interaction::parcel_body;
use crate::{
    character::{Character, CharacterIntent, CharacterMotion, CharacterPlugin},
    game_flow::configure_feature_order,
    item_interaction::{HeldBy, ItemInteractionPlugin, Parcel, Pickable},
    physics::{
        GamePhysicsPlugin, ground_body, held_collision_layers, parcel_collision_layers,
        world_collision_layers,
    },
    settings::PrototypeConfig,
};
use avian3d::prelude::*;
use bevy::time::TimeUpdateStrategy;
use bevy::{ecs::relationship::Relationship, prelude::*};
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

#[test]
fn ground_probe_respects_collision_layers_and_excludes_held_boxes() {
    let mut app = test_app();
    let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, 0.0));
    let character = spawn_character(&mut app, Vec3::new(0.0, 0.6, 0.0), default());
    step(&mut app, 30);
    let grounded = |app: &App| {
        app.world()
            .get::<CharacterMotion>(character)
            .unwrap()
            .grounded
    };
    assert!(grounded(&app), "Free box must support the character");

    // 单独重跑探测，避免改变碰撞层后物理移动影响支撑过滤的断言。
    let mut schedule = Schedule::default();
    schedule.add_systems(update_grounded);
    let character_layers = *app.world().get::<CollisionLayers>(character).unwrap();
    app.world_mut()
        .entity_mut(character)
        .insert(CollisionLayers::NONE);
    schedule.run(app.world_mut());
    assert!(
        !grounded(&app),
        "Character collision filters must be respected"
    );
    app.world_mut()
        .entity_mut(character)
        .insert(character_layers);
    schedule.run(app.world_mut());
    assert!(grounded(&app));

    let item_layers = parcel_collision_layers();
    app.world_mut()
        .entity_mut(item)
        .insert(CollisionLayers::new(
            item_layers.memberships,
            LayerMask::NONE,
        ));
    schedule.run(app.world_mut());
    assert!(
        !grounded(&app),
        "Support collision filters must be respected"
    );
    app.world_mut().entity_mut(item).insert(item_layers);
    schedule.run(app.world_mut());
    assert!(grounded(&app));

    app.world_mut().entity_mut(item).insert((
        <HeldBy as Relationship>::from(character),
        held_collision_layers(),
    ));
    schedule.run(app.world_mut());
    assert!(!grounded(&app), "Held box cannot support the character");
    // 即使外部代码误改持握碰撞层，持握身份也不能成为支撑。
    app.world_mut().entity_mut(item).insert(item_layers);
    schedule.run(app.world_mut());
    assert!(!grounded(&app));
    app.world_mut().entity_mut(item).remove::<HeldBy>();
    schedule.run(app.world_mut());
    assert!(
        grounded(&app),
        "Released box must become valid support again"
    );
    // 单独重跑 ECS 探测确认代理身份同样不能充当地面，不推进装卸或物理积分。
    app.world_mut()
        .entity_mut(item)
        .insert(crate::item_interaction::HeldCollider { item });
    schedule.run(app.world_mut());
    assert!(
        !grounded(&app),
        "A held collision proxy cannot support the character"
    );
    app.world_mut()
        .entity_mut(item)
        .remove::<crate::item_interaction::HeldCollider>();
    schedule.run(app.world_mut());
    assert!(grounded(&app));
}

#[test]
fn ground_probe_finds_floor_after_a_nearer_wall_hit() {
    let mut app = test_app();
    let wall = app
        .world_mut()
        .spawn((
            RigidBody::Static,
            Collider::cuboid(0.04, 2.0, 2.0),
            world_collision_layers(),
            Transform::from_xyz(0.26, 1.0, 0.0),
        ))
        .id();
    step(&mut app, 2);
    // 先初始化墙面，再生成角色并只跑探测，避免墙面求解先推开角色。
    let character = spawn_character(&mut app, Vec3::ZERO, default());
    let mut schedule = Schedule::default();
    schedule.add_systems(
        (
            move |config: Res<PrototypeConfig>, spatial_query: SpatialQuery| {
                let closest = spatial_query
                    .cast_shape(
                        &Collider::sphere(config.character_radius * 0.8),
                        Vec3::Y * config.character_radius,
                        Quat::IDENTITY,
                        Dir3::NEG_Y,
                        &ShapeCastConfig::from_max_distance(0.12),
                        &SpatialQueryFilter::from_excluded_entities([character]),
                    )
                    .unwrap();
                assert_eq!(closest.entity, wall);
                assert!(closest.normal1.y < 0.65);
            },
            update_grounded,
        )
            .chain(),
    );
    schedule.run(app.world_mut());
    assert!(
        app.world()
            .get::<CharacterMotion>(character)
            .unwrap()
            .grounded,
        "Side wall must not hide valid floor support"
    );
}

#[test]
fn movement_accelerates_brakes_and_diagonal_speed_is_bounded() {
    let mut app = test_app();
    let straight = spawn_character(&mut app, Vec3::ZERO, default());
    let diagonal = spawn_character(&mut app, Vec3::X * 5.0, default());
    step(&mut app, 30);
    app.world_mut()
        .get_mut::<CharacterIntent>(straight)
        .unwrap()
        .movement = Vec2::Y;
    app.world_mut()
        .get_mut::<CharacterIntent>(diagonal)
        .unwrap()
        .movement = Vec2::ONE;
    step(&mut app, 1);
    let first_speed = app
        .world()
        .get::<LinearVelocity>(straight)
        .unwrap()
        .0
        .length();
    assert!(first_speed > 0.0 && first_speed < 1.0, "{first_speed}");
    step(&mut app, 20);
    let a = app.world().get::<LinearVelocity>(straight).unwrap().0;
    let b = app.world().get::<LinearVelocity>(diagonal).unwrap().0;
    assert!((a.xz().length() - 4.5).abs() < 0.05, "{a:?}");
    assert!(
        (a.xz().length() - b.xz().length()).abs() < 0.05,
        "{a:?} {b:?}"
    );
    app.world_mut()
        .get_mut::<CharacterIntent>(straight)
        .unwrap()
        .movement = Vec2::ZERO;
    step(&mut app, 1);
    let braking = app
        .world()
        .get::<LinearVelocity>(straight)
        .unwrap()
        .0
        .xz()
        .length();
    assert!(braking > 0.0 && braking < a.xz().length());
    step(&mut app, 12);
    assert!(
        app.world()
            .get::<LinearVelocity>(straight)
            .unwrap()
            .0
            .xz()
            .length()
            < 0.05
    );
}

#[test]
fn collision_blocks_character_and_dynamic_boxes_receive_momentum() {
    let mut app = test_app();
    let character = spawn_character(&mut app, Vec3::ZERO, default());
    let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.2));
    step(&mut app, 30);
    app.world_mut().spawn((
        RigidBody::Static,
        Collider::cuboid(8.0, 3.0, 0.5),
        world_collision_layers(),
        Transform::from_xyz(0.0, 1.5, -4.0),
    ));
    app.world_mut()
        .get_mut::<CharacterIntent>(character)
        .unwrap()
        .movement = Vec2::Y;
    step(&mut app, 100);
    let position = app.world().get::<Position>(character).unwrap().0;
    assert!(position.z > -3.5, "Character crossed wall: {position:?}");
    let box_position = app.world().get::<Position>(item).unwrap().0;
    assert!(
        box_position.z < -1.4 && box_position.z > -3.8,
        "{box_position:?}"
    );
}

#[test]
fn jump_is_consumed_once_and_gravity_lands_on_collider() {
    let mut app = test_app();
    let character = spawn_character(&mut app, Vec3::ZERO, default());
    step(&mut app, 30);
    assert!(
        app.world()
            .get::<CharacterMotion>(character)
            .unwrap()
            .grounded
    );
    app.world_mut()
        .get_mut::<CharacterIntent>(character)
        .unwrap()
        .jump_pending = true;
    step(&mut app, 1);
    let velocity = app.world().get::<LinearVelocity>(character).unwrap().y;
    assert!((velocity - (5.0 - 9.81 / 60.0)).abs() < 0.05, "{velocity}");
    assert!(
        !app.world()
            .get::<CharacterIntent>(character)
            .unwrap()
            .jump_pending
    );
    app.world_mut()
        .get_mut::<CharacterIntent>(character)
        .unwrap()
        .jump_pending = true;
    step(&mut app, 1);
    assert!(app.world().get::<LinearVelocity>(character).unwrap().y < velocity);
    step(&mut app, 100);
    assert!(
        app.world()
            .get::<CharacterMotion>(character)
            .unwrap()
            .grounded
    );
    assert!(app.world().get::<Position>(character).unwrap().y.abs() < 0.03);
}

#[test]
fn resting_character_keeps_sleeping_until_movement_wakes_it_in_the_same_step() {
    let mut app = test_app();
    let character = spawn_character(&mut app, Vec3::ZERO, default());
    step(&mut app, 90);
    assert!(app.world().entity(character).contains::<Sleeping>());
    let resting_position = app.world().get::<Position>(character).unwrap().0;
    step(&mut app, 10);
    assert!(
        app.world().entity(character).contains::<Sleeping>(),
        "Physics writeback must not wake an unchanged resting character"
    );
    assert_eq!(
        app.world().get::<Position>(character).unwrap().0,
        resting_position
    );

    app.world_mut()
        .get_mut::<CharacterIntent>(character)
        .unwrap()
        .movement = Vec2::X;
    step(&mut app, 1);
    assert!(!app.world().entity(character).contains::<Sleeping>());
    let position = app.world().get::<Position>(character).unwrap().0;
    let velocity = app.world().get::<LinearVelocity>(character).unwrap().0;
    let acceleration = app.world().resource::<PrototypeConfig>().acceleration;
    let delta = app.world().resource::<Time<Fixed>>().delta_secs();
    let substeps = app.world().resource::<SubstepCount>().0 as f32;
    // 每子步先更新速度再积分位置，首步位移应为等差速度序列之和。
    let expected_distance = acceleration * delta.powi(2) * (substeps + 1.0) / (2.0 * substeps);
    assert!(
        (position.x - resting_position.x - expected_distance).abs() < 1.0e-5,
        "{position:?}"
    );
    assert!(
        (velocity.x - acceleration * delta).abs() < 1.0e-5,
        "{velocity:?}"
    );
}

#[test]
fn no_fixed_step_preserves_requests_and_render_rates_share_physics() {
    let simulate = |frame_hz: f64| {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        step(&mut app, 30);
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .jump_pending = true;
        let before = app.world().get::<Position>(character).unwrap().0;
        step(&mut app, 3);
        assert_eq!(app.world().get::<Position>(character).unwrap().0, before);
        assert!(
            app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .jump_pending
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / frame_hz,
        )));
        step(&mut app, frame_hz as usize);
        app.world().get::<Position>(character).unwrap().0
    };
    let a = simulate(60.0);
    let b = simulate(120.0);
    assert!(a.abs_diff_eq(b, 0.1), "{a:?} {b:?}");
}
