use crate::item_interaction::parcel_body;
use std::time::Duration;

use avian3d::prelude::{
    ColliderDisabled, ColliderOf, LinearVelocity, Physics, Position, RigidBody,
};
use bevy::{ecs::relationship::RelationshipTarget, time::TimeUpdateStrategy};

use crate::{
    character::CharacterMotion,
    item_interaction::{HeldBy, HeldTarget, HoldingItems, Parcel, Pickable},
    settings::PrototypeConfig,
};

use super::actions::{InteractAction, JumpAction, MoveAction};
use super::*;
use bevy_enhanced_input::prelude::{Cancel, *};

fn fire<A: InputAction>(context: Entity, value: A::Output) -> Fire<A> {
    Fire {
        context,
        action: Entity::PLACEHOLDER,
        value,
        state: TriggerState::Fired,
        fired_secs: 0.0,
        elapsed_secs: 0.0,
    }
}

#[test]
fn actions_are_routed_to_their_own_character() {
    let mut app = App::new();
    app.add_observer(record_movement)
        .add_observer(request_jump)
        .add_observer(request_interaction);
    let first = app
        .world_mut()
        .spawn((Character, CharacterIntent::default()))
        .id();
    let second = app
        .world_mut()
        .spawn((Character, CharacterIntent::default()))
        .id();
    let first_context = app
        .world_mut()
        .spawn((GameplayContext, ControlsCharacter(first)))
        .id();
    let second_context = app
        .world_mut()
        .spawn((GameplayContext, ControlsCharacter(second)))
        .id();

    app.world_mut()
        .trigger(fire::<MoveAction>(first_context, Vec2::X));
    app.world_mut()
        .trigger(fire::<JumpAction>(second_context, true));
    app.world_mut()
        .trigger(fire::<InteractAction>(first_context, true));

    let first_intent = app.world().get::<CharacterIntent>(first).unwrap();
    let second_intent = app.world().get::<CharacterIntent>(second).unwrap();
    assert_eq!(first_intent.movement, Vec2::X);
    assert!(!first_intent.jump_pending);
    assert!(first_intent.interact_pending);
    assert_eq!(second_intent.movement, Vec2::ZERO);
    assert!(second_intent.jump_pending);
    assert!(!second_intent.interact_pending);
}

#[test]
fn movement_completion_and_cancellation_clear_only_their_character() {
    let mut app = App::new();
    app.add_observer(clear_completed_movement)
        .add_observer(clear_cancelled_movement);
    let first = app
        .world_mut()
        .spawn((
            Character,
            CharacterIntent {
                movement: Vec2::X,
                ..default()
            },
        ))
        .id();
    let second = app
        .world_mut()
        .spawn((
            Character,
            CharacterIntent {
                movement: Vec2::Y,
                ..default()
            },
        ))
        .id();
    let first_context = app
        .world_mut()
        .spawn((GameplayContext, ControlsCharacter(first)))
        .id();
    let second_context = app
        .world_mut()
        .spawn((GameplayContext, ControlsCharacter(second)))
        .id();

    app.world_mut().trigger(Complete::<MoveAction> {
        context: first_context,
        action: Entity::PLACEHOLDER,
        value: Vec2::ZERO,
        state: TriggerState::None,
        fired_secs: 0.0,
        elapsed_secs: 0.0,
    });
    assert_eq!(
        app.world().get::<CharacterIntent>(first).unwrap().movement,
        Vec2::ZERO
    );
    assert_eq!(
        app.world().get::<CharacterIntent>(second).unwrap().movement,
        Vec2::Y
    );
    app.world_mut().trigger(Cancel::<MoveAction> {
        context: second_context,
        action: Entity::PLACEHOLDER,
        value: Vec2::ZERO,
        state: TriggerState::None,
        elapsed_secs: 0.0,
    });
    assert_eq!(
        app.world().get::<CharacterIntent>(second).unwrap().movement,
        Vec2::ZERO
    );
}

#[test]
fn keyboard_press_fires_once_and_requests_survive_until_consumed() {
    // 复用真实控制关联；零固定步帧只记录请求，不让运动和交互消费者提前取走。
    let (mut app, _, character, _, _) = super::pose_tests::test_app();

    {
        let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
        keys.press(KeyCode::Space);
        keys.press(KeyCode::KeyE);
        keys.press(KeyCode::KeyW);
    }
    app.update();
    app.update();
    {
        let mut intent = app
            .world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap();
        assert!(intent.jump_pending);
        assert!(intent.interact_pending);
        assert_eq!(intent.movement, Vec2::Y);
        intent.jump_pending = false;
        intent.interact_pending = false;
    }
    app.update();
    let intent = app.world().get::<CharacterIntent>(character).unwrap();
    assert!(!intent.jump_pending);
    assert!(!intent.interact_pending);

    {
        let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
        keys.release(KeyCode::Space);
        keys.release(KeyCode::KeyE);
        keys.release(KeyCode::KeyW);
    }
    app.update();
    assert_eq!(
        app.world()
            .get::<CharacterIntent>(character)
            .unwrap()
            .movement,
        Vec2::ZERO
    );
    {
        let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
        keys.press(KeyCode::Space);
        keys.press(KeyCode::KeyE);
    }
    app.update();
    let intent = app.world().get::<CharacterIntent>(character).unwrap();
    assert!(intent.jump_pending);
    assert!(intent.interact_pending);
}

#[test]
fn keyboard_actions_drive_physics_pickup_jump_and_release() {
    // 使用完整输入、相机与真实物理组合，所有断言都在实际 app.update 的帧末检查。
    let (mut app, _, character, _, _) = super::pose_tests::test_app();
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
        1.0 / 60.0,
    )));
    let config = app.world().resource::<PrototypeConfig>().clone();
    let item = app
        .world_mut()
        .spawn((
            Parcel,
            Pickable,
            Transform::from_xyz(0.0, config.parcel_half_height, -1.0),
            parcel_body(&config),
        ))
        .id();
    // 接地由真实碰撞探测建立，测试不预先伪造 grounded。
    for _ in 0..30 {
        app.update();
    }
    assert!(
        app.world()
            .get::<CharacterMotion>(character)
            .unwrap()
            .grounded
    );
    let character_before = app.world().get::<Position>(character).unwrap().0;
    let item_before = app.world().get::<Position>(item).unwrap().0;
    let physics_before = app.world().resource::<Time<Physics>>().elapsed();

    {
        let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
        keys.press(KeyCode::KeyE);
        keys.press(KeyCode::KeyW);
        keys.press(KeyCode::Space);
    }
    app.update();

    assert!(app.world().resource::<Time<Physics>>().elapsed() > physics_before);
    assert_eq!(
        app.world()
            .get::<HoldingItems>(character)
            .unwrap()
            .iter()
            .collect::<Vec<_>>(),
        vec![item]
    );
    let intent = app.world().get::<CharacterIntent>(character).unwrap();
    assert!(!intent.jump_pending && !intent.interact_pending);
    let character_after = app.world().get::<Position>(character).unwrap().0;
    let item_after = app.world().get::<Position>(item).unwrap().0;
    assert!(character_after.y > character_before.y);
    assert!(character_after.z < character_before.z);
    assert!(app.world().get::<LinearVelocity>(character).unwrap().y > 0.0);
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
    assert!(app.world().get::<ColliderDisabled>(item).is_some());
    // 拾取先建立整体碰撞并安全对齐，第一步箱子仍与目标有间距，不能瞬移到手中。
    let target = app.world().get::<HeldTarget>(item).unwrap();
    assert!(item_after.distance(target.translation) > 0.1);

    for _ in 0..12 {
        app.update();
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert!(!intent.jump_pending && !intent.interact_pending);
        assert!(app.world().get::<HeldBy>(item).is_some());
    }
    assert!(
        app.world()
            .get::<Position>(item)
            .unwrap()
            .0
            .distance(item_before)
            > 0.1
    );

    // 松开后再次按 E 才释放；下一物理步仍保留已有水平速度并自然积分。
    {
        let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
        keys.release(KeyCode::Space);
        keys.release(KeyCode::KeyE);
    }
    app.update();
    let release_position = app.world().get::<Position>(item).unwrap().0;
    let release_velocity = Vec3::new(2.0, 1.0, -1.0);
    app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = release_velocity;
    app.world_mut()
        .resource_mut::<ButtonInput<KeyCode>>()
        .press(KeyCode::KeyE);
    app.update();

    assert!(app.world().get::<HeldBy>(item).is_none());
    assert!(app.world().get::<HeldTarget>(item).is_none());
    assert!(
        app.world()
            .get::<HoldingItems>(character)
            .is_none_or(|items| items.is_empty())
    );
    let velocity_after_release = app.world().get::<LinearVelocity>(item).unwrap().0;
    assert!((velocity_after_release.x - release_velocity.x).abs() < 0.05);
    assert!((velocity_after_release.z - release_velocity.z).abs() < 0.05);
    assert!(app.world().get::<Position>(item).unwrap().0.x > release_position.x);
    for _ in 0..3 {
        app.update();
        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(
            !app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .interact_pending
        );
    }
}
