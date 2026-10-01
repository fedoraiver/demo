//! 通过真实无窗口物理调度验证拾取遮挡、同批次占用和外部冲量。

use avian3d::prelude::*;
use bevy::{
    ecs::relationship::{Relationship, RelationshipTarget},
    prelude::*,
    time::TimeUpdateStrategy,
};
use std::time::Duration;

use crate::{
    audio_events::{SoundCue, SoundRequest},
    gameplay::{
        Character, CharacterIntent, CharacterMotion, GameplayPlugin, GameplaySystems, HeldBy,
        HeldTarget, HoldingItems, Parcel, Pickable, PrototypeConfig,
    },
    physics::{character_body, ground_body, parcel_body, world_collision_layers},
};

/// 每帧读取真正的消息缓冲，避免在多固定步或渲染帧之间重复计算反馈。
fn take_sound_cues(app: &mut App) -> Vec<SoundCue> {
    app.world_mut()
        .resource_mut::<Messages<SoundRequest>>()
        .drain()
        .map(|request| request.cue)
        .collect()
}

#[test]
fn accepted_pickup_and_release_emit_once_and_drop_emits_ground_impact() {
    let mut app = test_app();
    let character = spawn_character(&mut app, Vec3::ZERO);
    spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
    step(&mut app, 30);
    take_sound_cues(&mut app);
    request_pickup(&mut app, character);
    step(&mut app, 1);
    assert_eq!(take_sound_cues(&mut app), [SoundCue::ParcelPickup]);
    step(&mut app, 30);
    assert!(!take_sound_cues(&mut app).contains(&SoundCue::ParcelPickup));
    request_pickup(&mut app, character);
    step(&mut app, 1);
    assert_eq!(take_sound_cues(&mut app), [SoundCue::ParcelRelease]);
    let mut impacts = 0;
    for _ in 0..120 {
        app.update();
        impacts += take_sound_cues(&mut app)
            .into_iter()
            .filter(|cue| *cue == SoundCue::ParcelLand)
            .count();
    }
    assert!(
        impacts >= 1,
        "A released parcel must emit its actual landing impact"
    );
    for _ in 0..60 {
        app.update();
        assert!(
            !take_sound_cues(&mut app).contains(&SoundCue::ParcelLand),
            "A resting parcel must stay silent"
        );
    }
}

#[test]
fn failed_pickup_and_side_wall_contact_do_not_emit_success_or_landing() {
    let mut app = test_app();
    let character = spawn_character(&mut app, Vec3::new(-10.0, 0.0, 0.0));
    let item = spawn_box(&mut app, Vec3::new(0.0, 3.0, 0.0));
    app.world_mut().get_mut::<LinearVelocity>(item).unwrap().x = 3.0;
    app.world_mut().spawn((
        RigidBody::Static,
        Collider::cuboid(0.2, 5.0, 4.0),
        world_collision_layers(),
        Transform::from_xyz(0.7, 2.5, 0.0),
    ));
    request_pickup(&mut app, character);
    for _ in 0..12 {
        app.update();
        assert!(
            take_sound_cues(&mut app).is_empty(),
            "Side contact is not a ground impact and failed pickup is silent"
        );
    }
    assert!(
        app.world().get::<LinearVelocity>(item).unwrap().x < 1.0,
        "The test must actually hit the wall"
    );
}

#[test]
fn speculative_support_before_impact_does_not_lose_landing_cue() {
    // 接触预测可在真正落地前产生 TOUCHING；覆盖不同距离和较快的初始下落速度。
    for (height, vertical_speed) in [(0.349, -3.0), (0.4, -3.0), (1.0, 0.0), (2.17, -1.0)] {
        let mut app = test_app();
        let item = spawn_box(&mut app, Vec3::new(0.0, height, 0.0));
        app.world_mut().get_mut::<LinearVelocity>(item).unwrap().y = vertical_speed;
        let mut count = 0;
        for _ in 0..120 {
            app.update();
            count += take_sound_cues(&mut app)
                .iter()
                .filter(|cue| **cue == SoundCue::ParcelLand)
                .count();
        }
        assert!(
            count >= 1,
            "Missing actual landing at height={height}, speed={vertical_speed}"
        );
        for _ in 0..30 {
            app.update();
            assert!(!take_sound_cues(&mut app).contains(&SoundCue::ParcelLand));
        }
    }
}

/// 只安装时间、变换和玩法物理插件，不加载窗口、渲染器或完整场景。
fn test_app() -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, TransformPlugin, GameplayPlugin))
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

fn spawn_character(app: &mut App, position: Vec3) -> Entity {
    let config = app.world().resource::<PrototypeConfig>().clone();
    app.world_mut()
        .spawn((
            Character,
            CharacterIntent::default(),
            CharacterMotion::default(),
            character_body(&config),
            Transform::from_translation(position),
        ))
        .id()
}

fn spawn_box(app: &mut App, position: Vec3) -> Entity {
    let config = app.world().resource::<PrototypeConfig>().clone();
    app.world_mut()
        .spawn((
            Parcel,
            Pickable,
            parcel_body(&config),
            Transform::from_translation(position),
        ))
        .id()
}

fn request_pickup(app: &mut App, character: Entity) {
    app.world_mut()
        .get_mut::<CharacterIntent>(character)
        .unwrap()
        .interact_pending = true;
}

#[test]
fn wall_blocks_pickup_in_range_and_removing_wall_restores_pickup() {
    let mut app = test_app();
    let character = spawn_character(&mut app, Vec3::ZERO);
    let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
    let wall = app
        .world_mut()
        .spawn((
            RigidBody::Static,
            Collider::cuboid(2.0, 2.0, 0.1),
            world_collision_layers(),
            Transform::from_xyz(0.0, 1.0, -0.7),
        ))
        .id();
    step(&mut app, 30);
    let distance = app
        .world()
        .get::<Position>(character)
        .unwrap()
        .0
        .distance(app.world().get::<Position>(item).unwrap().0);
    assert!(distance < app.world().resource::<PrototypeConfig>().pickup_radius);

    request_pickup(&mut app, character);
    step(&mut app, 1);
    assert!(app.world().get::<HeldBy>(item).is_none());
    assert!(app.world().get::<HeldTarget>(item).is_none());
    assert!(
        !app.world()
            .get::<CharacterIntent>(character)
            .unwrap()
            .interact_pending
    );

    // 使用相同角色、箱体和距离移除唯一阻挡，排除因范围或组件缺失造成的假通过。
    app.world_mut().despawn(wall);
    step(&mut app, 2);
    request_pickup(&mut app, character);
    step(&mut app, 1);
    assert_eq!(app.world().get::<HeldBy>(item).unwrap().get(), character);
    assert!(app.world().get::<HeldTarget>(item).is_some());
}

#[test]
fn simultaneous_pickups_reserve_nearest_box_and_use_available_alternative() {
    let mut app = test_app();
    let characters = [
        spawn_character(&mut app, Vec3::new(-0.7, 0.0, 0.0)),
        spawn_character(&mut app, Vec3::new(0.7, 0.0, 0.0)),
    ];
    let nearest = spawn_box(&mut app, Vec3::new(0.0, 0.3, -0.8));
    let alternative = spawn_box(&mut app, Vec3::new(0.0, 0.3, 0.9));
    step(&mut app, 30);

    // 两个请求在同一固定步消费，不能通过顺次帧请求绕开延迟命令的重复占用边界。
    for character in characters {
        let position = app.world().get::<Position>(character).unwrap().0;
        let nearest_distance = position.distance(app.world().get::<Position>(nearest).unwrap().0);
        let alternative_distance =
            position.distance(app.world().get::<Position>(alternative).unwrap().0);
        assert!(nearest_distance < alternative_distance);
        assert!(alternative_distance < app.world().resource::<PrototypeConfig>().pickup_radius);
        request_pickup(&mut app, character);
    }
    step(&mut app, 1);
    let nearest_holder = app.world().get::<HeldBy>(nearest).unwrap().get();
    let alternative_holder = app.world().get::<HeldBy>(alternative).unwrap().get();
    assert!(characters.contains(&nearest_holder));
    assert!(characters.contains(&alternative_holder));
    assert_ne!(nearest_holder, alternative_holder);
    let mut holding_count = 0;
    for character in characters {
        let held: Vec<_> = app
            .world()
            .get::<HoldingItems>(character)
            .map(|items| items.iter().collect())
            .unwrap_or_default();
        let expected = if character == nearest_holder {
            nearest
        } else {
            alternative
        };
        assert_eq!(held, vec![expected]);
        holding_count += held.len();
        assert!(
            !app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .interact_pending
        );
    }
    // 只断言单箱最终有一个 HeldBy 会掩盖“先拾取再被第二个命令覆盖”；备用箱能排除该假通过。
    assert_eq!(holding_count, 2);
    for item in [nearest, alternative] {
        assert_eq!(
            app.world().get::<RigidBody>(item),
            Some(&RigidBody::Dynamic)
        );
    }
}

/// 在控制施力之后施加一次外部冲量，后续步骤仍由正常刹车和碰撞处理。
fn push_once(
    config: Res<PrototypeConfig>,
    mut pushed: Local<bool>,
    mut characters: Query<Forces, With<Character>>,
) {
    if *pushed {
        return;
    }
    let mut character = characters.single_mut().unwrap();
    character.apply_linear_impulse(Vec3::X * config.character_mass * 4.0);
    *pushed = true;
}

#[test]
fn external_impulse_moves_character_before_active_braking_stops_it() {
    let mut app = test_app();
    let character = spawn_character(&mut app, Vec3::ZERO);
    step(&mut app, 30);
    assert!(
        app.world()
            .get::<CharacterMotion>(character)
            .unwrap()
            .grounded
    );
    let start = app.world().get::<Position>(character).unwrap().0;
    app.add_systems(FixedUpdate, push_once.after(GameplaySystems::Simulate));

    step(&mut app, 1);
    let first_position = app.world().get::<Position>(character).unwrap().0;
    let first_velocity = app.world().get::<LinearVelocity>(character).unwrap().x;
    assert!(first_position.x - start.x > 0.04, "{first_position:?}");
    assert!(first_velocity > 3.0, "{first_velocity}");
    step(&mut app, 1);
    let second_position = app.world().get::<Position>(character).unwrap().0;
    let second_velocity = app.world().get::<LinearVelocity>(character).unwrap().x;
    assert!(second_position.x > first_position.x);
    assert!(second_velocity > 0.0 && second_velocity < first_velocity);

    step(&mut app, 12);
    assert!(
        app.world()
            .get::<LinearVelocity>(character)
            .unwrap()
            .0
            .xz()
            .length()
            < 0.05
    );
    let stopped = app.world().get::<Position>(character).unwrap().0;
    step(&mut app, 10);
    assert!((app.world().get::<Position>(character).unwrap().x - stopped.x).abs() < 0.01);
}
