//! 无窗口覆盖主角动画的 grounding 行为。

use super::test_support::*;
use super::*;

#[test]
fn evaluated_direction_blend_keeps_sole_above_physics_feet_without_accumulating() {
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let hip_id = AnimationTargetId::from_name(&Name::new("hip"));
    let named = app
        .world()
        .resource::<Assets<Gltf>>()
        .get(&asset)
        .unwrap()
        .named_animations
        .clone();
    let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
    // 两个单动作都抬脚，但旋转插值使弯腿变直，真实复现方向混合的穿地来源。
    for state in CourierAnimationState::ALL {
        let angle = match state {
            CourierAnimationState::Walk => 0.35,
            CourierAnimationState::WalkRight => -0.35,
            _ => 0.0,
        };
        let rotation = Quat::from_rotation_x(angle);
        clips
            .get_mut(&named[state.name()])
            .unwrap()
            .add_curve_to_target(
                hip_id,
                AnimatableCurve::new(
                    animated_field!(Transform::rotation),
                    UnevenSampleAutoCurve::new([(0.0, rotation), (0.8, rotation)]).unwrap(),
                ),
            );
    }
    let (character, visual, player) = spawn_courier(&mut app, asset);
    let hip = app
        .world_mut()
        .spawn((
            hip_id,
            AnimatedBy(player),
            Transform::from_xyz(0.0, 0.97, 0.0),
            ChildOf(player),
        ))
        .id();
    let foot = app
        .world_mut()
        .spawn((Transform::from_xyz(0.0, -1.0, 0.0), ChildOf(hip)))
        .id();
    let mut marker_query = app.world_mut().query::<(Entity, &Name)>();
    let markers: Vec<_> = marker_query
        .iter(app.world())
        .filter(|(_, name)| name.as_str().starts_with("Courier_Sole_"))
        .map(|(entity, _)| entity)
        .collect();
    for (index, entity) in markers.iter().enumerate() {
        app.world_mut().entity_mut(*entity).insert((
            Transform::from_xyz(
                if index % 2 == 0 { -0.1 } else { 0.1 },
                0.0,
                if index % 4 < 2 { -0.03 } else { 0.03 },
            ),
            ChildOf(foot),
        ));
    }
    set_velocity(
        &mut app,
        character,
        Vec3::new(SIDEWAYS_REFERENCE_SPEED, 0.0, -FORWARD_REFERENCE_SPEED),
    );
    notify_ready(&mut app, visual);
    step(&mut app, 0.0);
    let offset = app.world().get::<Transform>(visual).unwrap().translation.y;
    assert!((offset - 0.033).abs() < 1.0e-5);
    assert_eq!(
        app.world().get::<Transform>(character).unwrap().translation,
        Vec3::ZERO
    );
    for _ in 0..8 {
        step(&mut app, 1.0 / 120.0);
        // 检查实际帧末 GlobalTransform，不能补跑传播或改用上一帧骨骼姿态。
        for marker in &markers {
            assert!(
                app.world()
                    .get::<GlobalTransform>(*marker)
                    .unwrap()
                    .translation()
                    .y
                    >= SOLE_CLEARANCE - 1.0e-5
            );
        }
        assert!(
            (app.world().get::<Transform>(visual).unwrap().translation.y - offset).abs() < 1.0e-5
        );
    }
    set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
    step(&mut app, 1.0 / 60.0);
    assert!(app.world().get::<Transform>(visual).unwrap().translation.y < offset);
    assert!(app.world().get::<Transform>(visual).unwrap().translation.y > 0.0);
}
