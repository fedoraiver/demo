//! 真实交互与共享刚体回归，检查对齐、受阻和关系异常后的释放。

use super::handle_interaction;
use crate::character::character_body;
use crate::item_interaction::parcel_body;
use crate::{
    character::{Character, CharacterIntent, CharacterMotion, CharacterPlugin},
    game_flow::configure_feature_order,
    item_interaction::{CarryGrip, HeldBy, HeldTarget, ItemInteractionPlugin, Parcel, Pickable},
    physics::{GamePhysicsPlugin, ground_body, parcel_collision_layers, world_collision_layers},
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
            app.world().resource::<Time<Fixed>>().elapsed() - fixed_before > Duration::from_secs(1)
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
