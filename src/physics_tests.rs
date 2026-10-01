//! 通过真实无窗口物理调度验证拾取遮挡、同批次占用和外部冲量。

use avian3d::prelude::*;
use bevy::{
    ecs::relationship::{Relationship, RelationshipTarget},
    prelude::*,
    time::TimeUpdateStrategy,
};
use std::time::Duration;

use crate::{
    gameplay::{
        Character, CharacterIntent, CharacterMotion, GameplayPlugin, GameplaySystems, HeldBy,
        HeldTarget, HoldingItems, Parcel, Pickable, PrototypeConfig,
    },
    physics::{character_body, ground_body, parcel_body, world_collision_layers},
};

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
