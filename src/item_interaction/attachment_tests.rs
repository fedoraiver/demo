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
    assert!((app.world().get::<ComputedMass>(holder).unwrap().value() - mass_before).abs() < 0.001);
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
