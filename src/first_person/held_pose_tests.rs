//! held pose tests 的无窗口回归。

use super::*;

#[test]
fn water_recovery_uses_current_camera_facing_for_the_same_fixed_step_movement() {
    let (mut app, window, character, camera, _) = test_app();
    let spawn = Transform::from_xyz(4.0, 0.03, 5.0).with_rotation(Quat::from_rotation_y(-0.6));
    app.world_mut()
        .entity_mut(character)
        .insert(SpawnPoint(spawn));
    // 通过真实输入上下文持续按住 W，避免下一帧 Enhanced Input 清空手写的移动意图。
    inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Pressed);
    mouse_motion(&mut app, Vec2::new(-500.0, 0.0));
    app.update();
    let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
    let facing = Quat::from_rotation_y(yaw) * Vec3::NEG_Z;
    assert!((spawn.rotation * Vec3::NEG_Z).dot(facing) < 0.0);
    assert_eq!(
        app.world()
            .get::<CharacterIntent>(character)
            .unwrap()
            .movement,
        Vec2::Y
    );
    let underwater = Vec3::new(40.0, -2.0, -40.0);
    app.world_mut().get_mut::<Position>(character).unwrap().0 = underwater;
    app.world_mut()
        .get_mut::<Transform>(character)
        .unwrap()
        .translation = underwater;
    app.world_mut()
        .get_mut::<LinearVelocity>(character)
        .unwrap()
        .0 = Vec3::new(5.0, -3.0, 4.0);
    let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
    fixed_step(&mut app);
    let world = app.world();
    assert_eq!(
        world.resource::<Time<Fixed>>().elapsed() - fixed_before,
        world.resource::<Time<Fixed>>().timestep()
    );
    let position = world.get::<Position>(character).unwrap().0;
    assert!(position.distance(spawn.translation) < 0.1, "{position:?}");
    let velocity = world.get::<LinearVelocity>(character).unwrap().0;
    assert!(velocity.xz().length() > 0.05, "{velocity:?}");
    assert!(
        velocity.xz().normalize().dot(facing.xz()) > 0.9999,
        "Recovery movement used the spawn facing: {velocity:?} {facing:?}"
    );
    assert!(
        world
            .get::<Transform>(character)
            .unwrap()
            .forward()
            .dot(facing)
            > 0.9999
    );
    let recovered_fixed_time = world.resource::<Time<Fixed>>().elapsed();
    for _ in 0..3 {
        // 恢复后的零固定步帧不能再次用出生朝向覆盖当前镜头方向或推进物理。
        app.update();
        let world = app.world();
        assert_eq!(
            world.resource::<Time<Fixed>>().elapsed(),
            recovered_fixed_time
        );
        assert_eq!(world.get::<Position>(character).unwrap().0, position);
        assert_eq!(world.get::<LinearVelocity>(character).unwrap().0, velocity);
        assert!(
            world
                .get::<Transform>(character)
                .unwrap()
                .forward()
                .dot(facing)
                > 0.9999
        );
    }
}

#[test]
fn turning_preserves_translation_interpolation_and_camera_reads_presented_position() {
    let (mut app, _, character, camera, _) = test_app();
    let visual_offset = Vec3::new(0.0, 0.72, 0.0);
    let visual = app
        .world_mut()
        .spawn((
            CharacterVisual,
            Visibility::default(),
            Transform::from_translation(visual_offset),
            ChildOf(character),
        ))
        .id();
    app.world_mut()
        .get_mut::<CharacterIntent>(character)
        .unwrap()
        .movement = Vec2::Y;
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
        1.0 / 240.0,
    )));
    let mut start = app.world().get::<Transform>(character).unwrap().translation;
    let mut end = app.world().get::<Position>(character).unwrap().0;
    let mut moving_frames_without_fixed_step = 0;
    for _ in 0..32 {
        let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
        let physical_before = app.world().get::<Position>(character).unwrap().0;
        mouse_motion(&mut app, Vec2::new(2.0, 0.0));
        app.update();
        let world = app.world();
        let time = world.resource::<Time<Fixed>>();
        if time.elapsed() != fixed_before {
            start = physical_before;
            end = world.get::<Position>(character).unwrap().0;
        } else if start.distance(end) > 0.0001 {
            moving_frames_without_fixed_step += 1;
        }
        // 连续无固定步帧仍按同一端点插值；若转向误触发瞬移检测，此处会立即失败。
        let expected = start.lerp(end, time.overstep_fraction());
        let character_transform = world.get::<Transform>(character).unwrap();
        assert!(
            character_transform
                .translation
                .abs_diff_eq(expected, 0.00001)
        );
        let view = world.get::<FirstPersonCamera>(camera).unwrap();
        assert!(
            character_transform
                .rotation
                .abs_diff_eq(Quat::from_rotation_y(view.yaw), 0.00001)
        );
        let camera_transform = world.get::<Transform>(camera).unwrap();
        assert!(
            camera_transform
                .translation
                .abs_diff_eq(view.transform(expected).translation, 0.00001)
        );
        assert!(
            world
                .get::<GlobalTransform>(character)
                .unwrap()
                .translation()
                .abs_diff_eq(expected, 0.00001)
        );
        let visual_global = world.get::<GlobalTransform>(visual).unwrap();
        assert!(
            visual_global
                .translation()
                .abs_diff_eq(character_transform.transform_point(visual_offset), 0.00001)
        );
        assert!(
            (visual_global.compute_transform().rotation * Vec3::NEG_Z)
                .abs_diff_eq(*character_transform.forward(), 0.00001)
        );
    }
    assert!(moving_frames_without_fixed_step >= 3);
}

#[test]
fn held_box_aligns_safely_then_shares_current_frame_pose_and_visuals() {
    for (frame_duration, grip) in [Duration::ZERO, Duration::from_secs_f64(1.0 / 120.0)]
        .into_iter()
        .flat_map(|duration| carry_grip_cases().map(|grip| (duration, grip)))
    {
        let (mut app, _, character, camera, _) = test_app();
        let character_visual = app
            .world_mut()
            .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
            .id();
        let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
        if let Some(grip) = grip {
            app.world_mut().entity_mut(item).insert(CarryGrip(grip));
        }
        let grip_offset =
            grip.unwrap_or_else(|| app.world().resource::<PrototypeConfig>().hold_offset);
        let visual_offset = Vec3::new(0.0, 0.18, 0.0);
        app.world_mut()
            .entity_mut(item)
            .insert(Visibility::default());
        let visual_child = app
            .world_mut()
            .spawn((
                Transform::from_translation(visual_offset),
                Visibility::default(),
                ChildOf(item),
            ))
            .id();
        fixed_step(&mut app);
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        fixed_step(&mut app);
        assert_eq!(
            app.world()
                .get::<HoldingItems>(character)
                .unwrap()
                .iter()
                .next(),
            Some(item)
        );
        assert!(app.world().get::<RigidBody>(item).is_none());
        let target = app.world().get::<HeldTarget>(item).unwrap();
        assert!(
            app.world()
                .get::<Position>(item)
                .unwrap()
                .0
                .distance(target.translation)
                > 0.1
        );
        // 拿起保留原位置；安全对齐完成后，转向的物理姿态和视觉都由人物直接派生。
        for _ in 0..30 {
            fixed_step(&mut app);
        }

        app.insert_resource(TimeUpdateStrategy::ManualDuration(frame_duration));
        let mut frames_without_fixed_step = 0;
        for _ in 0..12 {
            let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();
            mouse_motion(&mut app, Vec2::new(25.0, 5.0));
            // 不补跑固定步，直接检查本帧目标、物理位置和视觉子实体传播结果。
            app.update();
            let world = app.world();
            if world.resource::<Time<Fixed>>().elapsed() == fixed_time {
                frames_without_fixed_step += 1;
            }
            let view = world.get::<FirstPersonCamera>(camera).unwrap();
            assert!(
                !world
                    .get::<InheritedVisibility>(character_visual)
                    .unwrap()
                    .get()
            );
            assert!(
                world
                    .get::<InheritedVisibility>(visual_child)
                    .unwrap()
                    .get()
            );
            let character_transform = world.get::<Transform>(character).unwrap();
            let rotation = Quat::from_rotation_y(view.yaw);
            assert!(character_transform.rotation.abs_diff_eq(rotation, 0.00001));
            let held_target = world.get::<HeldTarget>(item).unwrap();
            let expected_target = character_transform.transform_point(grip_offset);
            assert!(
                held_target
                    .translation
                    .abs_diff_eq(expected_target, 0.00001)
            );
            assert!(held_target.rotation.abs_diff_eq(rotation, 0.00001));
            let expected_camera = view.transform(character_transform.translation);
            let camera_transform = world.get::<Transform>(camera).unwrap();
            assert!(
                camera_transform
                    .translation
                    .abs_diff_eq(expected_camera.translation, 0.00001)
            );
            assert!(
                camera_transform
                    .rotation
                    .abs_diff_eq(expected_camera.rotation, 0.00001)
            );
            assert!(world.get::<RigidBody>(item).is_none());
            let physical_target =
                world.get::<Position>(character).unwrap().0 + rotation * grip_offset;
            assert!(
                world
                    .get::<Position>(item)
                    .unwrap()
                    .0
                    .abs_diff_eq(physical_target, 0.0001)
            );
            assert!(
                world
                    .get::<Transform>(item)
                    .unwrap()
                    .translation
                    .abs_diff_eq(expected_target, 0.0001)
            );
            assert_item_visual_matches_root(world, item, visual_child, visual_offset);
        }
        assert!(
            frames_without_fixed_step > 0,
            "The regression must exercise frames without a simulation step"
        );
    }
}

#[test]
fn turning_updates_grip_target_and_released_box_stops_following() {
    for grip in carry_grip_cases() {
        let (mut app, _, character, camera, _) = test_app();
        let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
        if let Some(grip) = grip {
            app.world_mut().entity_mut(item).insert(CarryGrip(grip));
        }
        let grip_offset =
            grip.unwrap_or_else(|| app.world().resource::<PrototypeConfig>().hold_offset);
        let visual_offset = Vec3::new(0.0, 0.18, 0.0);
        let visual_child = app
            .world_mut()
            .spawn((Transform::from_translation(visual_offset), ChildOf(item)))
            .id();
        fixed_step(&mut app);
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        fixed_step(&mut app);
        for _ in 0..30 {
            fixed_step(&mut app);
        }
        let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
        mouse_motion(&mut app, Vec2::new(500.0, -100.0));
        app.update();
        assert_eq!(
            app.world().resource::<Time<Fixed>>().elapsed(),
            fixed_before
        );
        let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
        let character_transform = app.world().get::<Transform>(character).unwrap();
        let rotation = Quat::from_rotation_y(yaw);
        assert!(character_transform.up().dot(Vec3::Y) > 0.9999);
        assert!(character_transform.rotation.abs_diff_eq(rotation, 0.00001));
        let expected_target = character_transform.transform_point(grip_offset);
        let physical_target =
            app.world().get::<Position>(character).unwrap().0 + rotation * grip_offset;
        assert!(
            app.world()
                .get::<Position>(item)
                .unwrap()
                .0
                .abs_diff_eq(physical_target, 0.0001)
        );
        assert!(
            app.world()
                .get::<HeldTarget>(item)
                .unwrap()
                .translation
                .abs_diff_eq(expected_target, 0.00001)
        );
        assert_item_visual_matches_root(app.world(), item, visual_child, visual_offset);

        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        fixed_step(&mut app);
        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(app.world().get::<HeldTarget>(item).is_none());
        assert_eq!(
            app.world().get::<RigidBody>(item),
            Some(&RigidBody::Dynamic)
        );
        let released_position = app.world().get::<Position>(item).unwrap().0;
        let released_velocity = app.world().get::<LinearVelocity>(item).unwrap().0;
        let released_transform = *app.world().get::<Transform>(item).unwrap();
        assert!(
            released_position.y
                > app.world().resource::<PrototypeConfig>().parcel_half_height + 0.1
        );
        for _ in 0..6 {
            mouse_motion(&mut app, Vec2::new(50.0, 10.0));
            app.update();
            // 没有固定步时，仅更新人物和镜头；已释放箱子不得被旧目标重新拉回。
            assert_eq!(
                app.world().get::<Position>(item).unwrap().0,
                released_position
            );
            assert_eq!(
                app.world().get::<LinearVelocity>(item).unwrap().0,
                released_velocity
            );
            assert_eq!(
                *app.world().get::<Transform>(item).unwrap(),
                released_transform
            );
            assert!(app.world().get::<HeldBy>(item).is_none());
            assert!(app.world().get::<HeldTarget>(item).is_none());
            assert_item_visual_matches_root(app.world(), item, visual_child, visual_offset);
        }
    }
}
