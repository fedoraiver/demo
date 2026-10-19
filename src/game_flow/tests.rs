use super::*;

use avian3d::prelude::{Collider, LinearVelocity, Position, RigidBody};
use bevy::time::TimeUpdateStrategy;

use crate::{
    character::CharacterPlugin, item_interaction::ItemInteractionPlugin, physics::GamePhysicsPlugin,
};

#[test]
fn pause_freezes_actual_physics_immediately_and_resume_does_not_catch_up() {
    // 使用真实 Avian 调度和单个几何刚体，直接检查每次 app.update 返回后的位姿。
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        TransformPlugin,
        GameFlowPlugin,
        GamePhysicsPlugin,
        CharacterPlugin,
        ItemInteractionPlugin,
    ))
    .insert_resource(Time::<Fixed>::from_hz(60.0))
    .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
        1.0 / 60.0,
    )));
    app.finish();
    app.cleanup();
    app.update();
    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(AppState::InGame);
    app.update();
    let body = app
        .world_mut()
        .spawn((
            RigidBody::Dynamic,
            Collider::cuboid(0.6, 0.6, 0.6),
            LinearVelocity(Vec3::new(2.0, 0.0, 0.0)),
            Transform::from_xyz(0.0, 10.0, 0.0),
        ))
        .id();
    for _ in 0..3 {
        app.update();
    }
    let position = *app.world().get::<Position>(body).unwrap();
    let velocity = *app.world().get::<LinearVelocity>(body).unwrap();
    assert!(position.x > 0.0);
    assert!(velocity.y < 0.0);
    app.world_mut()
        .resource_mut::<NextState<PlayState>>()
        .set(PlayState::Paused);
    for _ in 0..12 {
        app.update();
        assert_eq!(*app.world().get::<Position>(body).unwrap(), position);
        assert_eq!(*app.world().get::<LinearVelocity>(body).unwrap(), velocity);
    }
    app.world_mut()
        .resource_mut::<NextState<PlayState>>()
        .set(PlayState::Running);
    app.update();
    app.update();
    let resumed = app.world().get::<Position>(body).unwrap();
    assert!(resumed.x > position.x);
    assert!(
        resumed.x - position.x < 0.08,
        "resume must not integrate paused wall time"
    );
}
