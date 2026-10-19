//! view tests 的无窗口回归。

use super::*;

#[test]
fn actual_mouse_action_applies_aggregate_once_and_fixed_steps_keep_input() {
    let (mut app, _, character, camera, _) = test_app();
    mouse_motion(&mut app, Vec2::new(100.0, 0.0));
    mouse_motion(&mut app, Vec2::new(50.0, 0.0));
    app.update();
    let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
    assert!((yaw - (-0.45_f32).rem_euclid(TAU)).abs() < 0.00001);
    // 一帧无固定步时，Observer 更新的角度和持续移动轴都保留至模拟消费。
    app.world_mut()
        .get_mut::<CharacterIntent>(character)
        .unwrap()
        .movement = Vec2::Y;
    for _ in 0..3 {
        fixed_step(&mut app);
    }
    let transform = app.world().get::<Transform>(character).unwrap();
    assert!(
        transform
            .forward()
            .dot(Quat::from_rotation_y(yaw) * Vec3::NEG_Z)
            > 0.9999
    );
    let speed = app.world().resource::<PrototypeConfig>().move_speed;
    let position = app.world().get::<Position>(character).unwrap().0;
    let displacement = Vec3::new(position.x, 0.0, position.z);
    let direction = Quat::from_rotation_y(yaw) * Vec3::NEG_Z;
    // 动态角色逐步加速，检验固定步保留输入与方向。
    assert!(displacement.dot(direction) > 0.0);
    assert!(displacement.length() <= speed * 3.0 / 60.0 + 0.00001);
    assert!(displacement.normalize().dot(direction) > 0.9999);
    app.update();
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        yaw
    );
    let view = app.world().get::<FirstPersonCamera>(camera).unwrap();
    let eye =
        app.world().get::<Transform>(character).unwrap().translation + Vec3::Y * view.eye_height;
    let camera_transform = app.world().get::<Transform>(camera).unwrap();
    assert!(camera_transform.translation.abs_diff_eq(eye, 0.00001));
    assert!(camera_transform.forward().dot(direction) > 0.9999);
}

#[test]
fn look_routes_by_controller_clamps_pitch_and_supports_inversion() {
    let (mut app, _, _, first, first_controller) = test_app();
    let second_target = app
        .world_mut()
        .spawn((Character, Transform::default()))
        .id();
    let second = app
        .world_mut()
        .spawn((
            FirstPersonCamera::new(second_target),
            MouseLookState {
                active: true,
                initialized: true,
                ..default()
            },
        ))
        .id();
    let second_controller = app
        .world_mut()
        .spawn((GameplayContext, ControlsCamera(second)))
        .id();
    app.world_mut()
        .trigger(fire(second_controller, Vec2::new(30.0, 10000.0)));
    assert_eq!(
        app.world().get::<FirstPersonCamera>(first).unwrap().yaw,
        0.0
    );
    assert_eq!(
        app.world().get::<FirstPersonCamera>(second).unwrap().pitch,
        85.0_f32.to_radians()
    );
    app.world_mut()
        .trigger(fire(second_controller, Vec2::new(0.0, -10000.0)));
    assert_eq!(
        app.world().get::<FirstPersonCamera>(second).unwrap().pitch,
        -85.0_f32.to_radians()
    );
    let pitch = app.world().get::<FirstPersonCamera>(first).unwrap().pitch;
    app.world_mut()
        .resource_mut::<GameSettings>()
        .camera
        .invert_y = true;
    app.world_mut()
        .trigger(fire(first_controller, Vec2::new(0.0, 10.0)));
    assert!(
        (app.world().get::<FirstPersonCamera>(first).unwrap().pitch - (pitch - 0.03)).abs()
            < 0.00001
    );
    app.world_mut()
        .get_mut::<MouseLookState>(first)
        .unwrap()
        .active = false;
    let yaw = app.world().get::<FirstPersonCamera>(first).unwrap().yaw;
    app.world_mut()
        .trigger(fire(first_controller, Vec2::new(30.0, 0.0)));
    assert_eq!(
        app.world().get::<FirstPersonCamera>(first).unwrap().yaw,
        yaw
    );
    app.world_mut().despawn(second);
    app.world_mut().trigger(fire(second_controller, Vec2::ONE));
}

#[test]
fn starts_at_eye_height_and_hides_only_the_controlled_character() {
    let (mut app, _, character, camera, _) = test_app();
    let own_visual = app
        .world_mut()
        .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
        .id();
    let other_character = app
        .world_mut()
        .spawn((Character, Transform::default(), Visibility::default()))
        .id();
    let other_visual = app
        .world_mut()
        .spawn((
            CharacterVisual,
            Visibility::default(),
            ChildOf(other_character),
        ))
        .id();
    let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
    app.world_mut()
        .entity_mut(item)
        .insert(Visibility::default());
    let item_visual = app
        .world_mut()
        .spawn((Transform::default(), Visibility::default(), ChildOf(item)))
        .id();

    // 首帧显示同步就使用眼位和自身隐藏，不需要任何视角输入。
    app.update();
    let pose = app.world().get::<Transform>(camera).unwrap();
    let position = app.world().get::<Transform>(character).unwrap().translation;
    assert!(
        pose.translation
            .abs_diff_eq(position + Vec3::Y * 1.65, 0.00001)
    );
    assert!(pose.forward().dot(Vec3::NEG_Z) > 0.9999);
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().pitch,
        0.0
    );
    assert!(
        !app.world()
            .get::<InheritedVisibility>(own_visual)
            .unwrap()
            .get()
    );
    assert!(
        app.world()
            .get::<InheritedVisibility>(other_visual)
            .unwrap()
            .get()
    );
    assert!(
        app.world()
            .get::<InheritedVisibility>(item_visual)
            .unwrap()
            .get()
    );
}

#[test]
fn i_key_keeps_first_person_pose_visibility_and_gameplay_intent() {
    let (mut app, window, character, camera, _) = test_app();
    let visual = app
        .world_mut()
        .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
        .id();
    mouse_motion(&mut app, Vec2::new(100.0, -50.0));
    app.update();
    let pose = *app.world().get::<Transform>(camera).unwrap();
    let position = app.world().get::<Position>(character).unwrap().0;
    let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();

    // 使用真实键盘消息覆盖长按、松开和重复按下，帧末不补跑模拟。
    for state in [
        ButtonState::Pressed,
        ButtonState::Released,
        ButtonState::Pressed,
    ] {
        inspector_keyboard(&mut app, window, KeyCode::KeyI, state);
        for _ in 0..3 {
            app.update();
            assert_eq!(*app.world().get::<Transform>(camera).unwrap(), pose);
            assert_eq!(app.world().get::<Position>(character).unwrap().0, position);
            assert_eq!(app.world().resource::<Time<Fixed>>().elapsed(), fixed_time);
            assert!(
                !app.world()
                    .get::<InheritedVisibility>(visual)
                    .unwrap()
                    .get()
            );
            assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
            let intent = app.world().get::<CharacterIntent>(character).unwrap();
            assert_eq!(intent.movement, Vec2::ZERO);
            assert!(!intent.jump_pending && !intent.interact_pending);
        }
    }
    // I 保持按下时鼠标仍可正常观察。
    mouse_motion(&mut app, Vec2::new(10.0, 10.0));
    app.update();
    assert_ne!(
        app.world().get::<Transform>(camera).unwrap().rotation,
        pose.rotation
    );
    assert_eq!(
        app.world().get::<Transform>(camera).unwrap().translation,
        pose.translation
    );
}

#[test]
fn first_person_look_clamps_up_and_down_and_uses_camera_settings() {
    let (mut app, _, character, camera, _) = test_app();
    app.world_mut()
        .resource_mut::<GameSettings>()
        .camera
        .mouse_sensitivity = 0.006;
    app.world_mut()
        .resource_mut::<GameSettings>()
        .camera
        .invert_y = true;
    mouse_motion(&mut app, Vec2::new(10.0, 10.0));
    app.update();
    let view = app.world().get::<FirstPersonCamera>(camera).unwrap();
    assert!((view.yaw - (-0.06_f32).rem_euclid(TAU)).abs() < 0.00001);
    assert!((view.pitch + 0.06).abs() < 0.00001);
    assert!(app.world().get::<Transform>(camera).unwrap().forward().y > 0.0);
    for (delta_y, pitch, forward_y) in [
        (10000.0, -85.0_f32.to_radians(), 1.0),
        (-10000.0, 85.0_f32.to_radians(), -1.0),
    ] {
        mouse_motion(&mut app, Vec2::new(0.0, delta_y));
        app.update();
        assert_eq!(
            app.world().get::<FirstPersonCamera>(camera).unwrap().pitch,
            pitch
        );
        let transform = app.world().get::<Transform>(camera).unwrap();
        assert_eq!(
            transform.translation,
            app.world().get::<Transform>(character).unwrap().translation + Vec3::Y * 1.65
        );
        assert!(transform.forward().y * forward_y > 0.99);
        assert!(transform.rotation.is_finite());
    }
}

#[test]
fn hidden_character_visuals_recover_when_camera_binding_becomes_invalid() {
    for removed in [
        "camera",
        "controller",
        "character_component",
        "target_binding",
    ] {
        let (mut app, _, character, camera, controller) = test_app();
        let visual = app
            .world_mut()
            .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
            .id();
        app.update();
        assert!(
            !app.world()
                .get::<InheritedVisibility>(visual)
                .unwrap()
                .get()
        );
        match removed {
            "camera" => {
                app.world_mut().despawn(camera);
            }
            "controller" => {
                app.world_mut().despawn(controller);
            }
            "character_component" => {
                app.world_mut().entity_mut(character).remove::<Character>();
            }
            "target_binding" => {
                app.world_mut()
                    .get_mut::<FirstPersonCamera>(camera)
                    .unwrap()
                    .target = Entity::PLACEHOLDER;
            }
            _ => unreachable!(),
        }
        app.update();
        assert_eq!(
            app.world().get::<Visibility>(visual),
            Some(&Visibility::Inherited)
        );
        assert!(
            app.world()
                .get::<InheritedVisibility>(visual)
                .unwrap()
                .get()
        );
    }
}

#[test]
fn first_person_motion_follows_actual_fixed_step_count() {
    for frame_duration in [Duration::ZERO, Duration::from_millis(50)] {
        let (mut app, _, character, camera, _) = test_app();
        app.insert_resource(TimeUpdateStrategy::ManualDuration(frame_duration));
        {
            let mut intent = app
                .world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap();
            intent.movement = Vec2::Y;
            intent.jump_pending = true;
            intent.interact_pending = true;
        }
        let position_before = app.world().get::<Position>(character).unwrap().0;
        let presentation_before = app.world().get::<Transform>(character).unwrap().translation;
        let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
        mouse_motion(&mut app, Vec2::new(100.0, 100.0));
        app.update();
        let world = app.world();
        let simulated = world.resource::<Time<Fixed>>().elapsed() - fixed_before;
        let view = world.get::<FirstPersonCamera>(camera).unwrap();
        assert!((view.yaw - (-0.3_f32).rem_euclid(TAU)).abs() < 0.00001);
        let transform = world.get::<Transform>(character).unwrap();
        let position = world.get::<Position>(character).unwrap().0;
        let direction = Quat::from_rotation_y(view.yaw) * Vec3::NEG_Z;
        assert!(transform.forward().dot(direction) > 0.9999);
        let intent = world.get::<CharacterIntent>(character).unwrap();
        if frame_duration.is_zero() {
            assert!(simulated.is_zero());
            assert!(intent.jump_pending && intent.interact_pending);
            assert_eq!(position, position_before);
            assert_eq!(transform.translation, presentation_before);
        } else {
            assert!(simulated >= world.resource::<Time<Fixed>>().timestep() * 2);
            assert!(!intent.jump_pending && !intent.interact_pending);
            assert!(position.y > position_before.y);
            let displacement = Vec3::new(position.x, 0.0, position.z)
                - Vec3::new(position_before.x, 0.0, position_before.z);
            assert!(displacement.dot(direction) > 0.0);
            assert!(displacement.normalize().dot(direction) > 0.9999);
            assert!(
                displacement.length()
                    <= world.resource::<PrototypeConfig>().move_speed * simulated.as_secs_f32()
                        + 0.00001
            );
        }
        assert!(
            world
                .get::<Transform>(camera)
                .unwrap()
                .translation
                .abs_diff_eq(transform.translation + Vec3::Y * 1.65, 0.00001)
        );
    }
}

#[test]
fn equal_mouse_distance_has_equal_rotation_at_different_render_rates() {
    let mut rotations = Vec::new();
    for fps in [60, 120] {
        let (mut app, _, _, camera, _) = test_app();
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / f64::from(fps),
        )));
        for _ in 0..fps {
            mouse_motion(&mut app, Vec2::X * (200.0 / fps as f32));
            app.update();
        }
        rotations.push(app.world().get::<FirstPersonCamera>(camera).unwrap().yaw);
    }
    assert!((rotations[0] - rotations[1]).abs() < 0.0001);
    assert!((rotations[0] - (-0.6_f32).rem_euclid(TAU)).abs() < 0.0001);
}

#[test]
fn cameras_follow_their_own_characters_at_eye_height() {
    let mut app = App::new();
    app.add_systems(Update, follow_first_person_camera);
    for position in [Vec3::new(3.0, 1.0, -2.0), Vec3::new(-4.0, 0.0, 7.0)] {
        let target = app
            .world_mut()
            .spawn((Character, Transform::from_translation(position)))
            .id();
        app.world_mut()
            .spawn((FirstPersonCamera::new(target), Transform::default()));
    }
    app.update();
    let world = app.world_mut();
    let mut query = world.query::<(&FirstPersonCamera, &Transform)>();
    for (view, transform) in query.iter(world) {
        let position = world.get::<Transform>(view.target).unwrap().translation;
        assert!(
            transform
                .translation
                .abs_diff_eq(position + Vec3::Y * 1.65, 0.00001)
        );
    }
}
