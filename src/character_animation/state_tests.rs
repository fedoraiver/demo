//! 无窗口覆盖主角动画的 state 行为。

use super::test_support::*;
use super::*;

#[test]
fn actual_local_velocity_blends_cardinal_diagonal_and_carry_directions() {
    use CourierAnimationState::*;
    for (velocity, direction) in [
        (Vec3::NEG_Z, Walk),
        (Vec3::Z, WalkBackward),
        (Vec3::NEG_X, WalkLeft),
        (Vec3::X, WalkRight),
    ] {
        let target = animation_target(velocity * 3.0, Quat::IDENTITY, true, false, false);
        assert_eq!(target.weights[direction as usize], 1.0);
    }
    let diagonal = animation_target(
        Vec3::new(-3.0, 10.0, -3.0),
        Quat::IDENTITY,
        true,
        false,
        true,
    );
    assert!(diagonal.weights[CarryWalk as usize] > 0.0);
    assert!(diagonal.weights[CarryLeft as usize] > 0.0);
    assert!((diagonal.weights.iter().sum::<f32>() - 1.0).abs() < 1.0e-6);
    let forward_weight = diagonal.weights[CarryWalk as usize];
    let left_weight = diagonal.weights[CarryLeft as usize];
    assert!(
        (forward_weight * FORWARD_REFERENCE_SPEED - left_weight * SIDEWAYS_REFERENCE_SPEED).abs()
            < 1.0e-6
    );
    let vertical = animation_target(Vec3::Y * 5.0, Quat::IDENTITY, true, false, false);
    assert_eq!(vertical.weights[Idle as usize], 1.0);
}

#[test]
fn bevy_evaluates_continuous_blend_and_shared_phase_on_a_bone() {
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let target_id = AnimationTargetId::from_name(&Name::new("foot"));
    let named = app
        .world()
        .resource::<Assets<Gltf>>()
        .get(&asset)
        .unwrap()
        .named_animations
        .clone();
    let mut clips = app.world_mut().resource_mut::<Assets<AnimationClip>>();
    for state in CourierAnimationState::ALL {
        let vector = match state {
            CourierAnimationState::Walk | CourierAnimationState::CarryWalk => Vec3::NEG_Z,
            CourierAnimationState::WalkBackward | CourierAnimationState::CarryBackward => Vec3::Z,
            CourierAnimationState::WalkLeft | CourierAnimationState::CarryLeft => Vec3::NEG_X,
            CourierAnimationState::WalkRight | CourierAnimationState::CarryRight => Vec3::X,
            _ => Vec3::ZERO,
        };
        clips
            .get_mut(&named[state.name()])
            .unwrap()
            .add_curve_to_target(
                target_id,
                AnimatableCurve::new(
                    animated_field!(Transform::translation),
                    UnevenSampleAutoCurve::new([
                        (0.0, Vec3::ZERO),
                        (0.4, vector),
                        (0.8, Vec3::ZERO),
                    ])
                    .unwrap(),
                ),
            );
    }
    let (character, visual, player) = spawn_courier(&mut app, asset);
    let foot = app
        .world_mut()
        .spawn((
            target_id,
            AnimatedBy(player),
            Transform::default(),
            ChildOf(player),
        ))
        .id();
    set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
    notify_ready(&mut app, visual);
    // 新图的资产事件在帧末发布，先完成零时长绑定帧再检查下一帧真实骨骼求值。
    step(&mut app, 0.0);
    step(&mut app, 0.2);
    assert_gait_phase(&app, player, 0.25);
    assert!(
        app.world()
            .get::<Transform>(foot)
            .unwrap()
            .translation
            .abs_diff_eq(Vec3::NEG_Z * 0.5, 1.0e-5)
    );

    set_velocity(&mut app, character, Vec3::X * SIDEWAYS_REFERENCE_SPEED);
    step(&mut app, 0.1);
    assert_gait_phase(&app, player, 0.375);
    let expected = (Vec3::NEG_Z * weight(&app, player, CourierAnimationState::Walk)
        + Vec3::X * weight(&app, player, CourierAnimationState::WalkRight))
        * 0.75;
    assert!(
        app.world()
            .get::<Transform>(foot)
            .unwrap()
            .translation
            .abs_diff_eq(expected, 1.0e-5)
    );
    assert_eq!(
        app.world().get::<Transform>(character).unwrap().translation,
        Vec3::ZERO
    );
}

#[test]
fn mouse_facing_is_read_on_frame_without_a_fixed_step() {
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let (character, visual, player) = spawn_courier(&mut app, asset);
    set_velocity(&mut app, character, Vec3::NEG_Z * 3.0);
    notify_ready(&mut app, visual);
    step(&mut app, 0.0);
    assert_eq!(weight(&app, player, CourierAnimationState::Walk), 1.0);

    app.world_mut()
        .get_mut::<Transform>(character)
        .unwrap()
        .rotation = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
    step(&mut app, 1.0 / 120.0);
    // 不补跑固定模拟；本次 app.update 返回就能看见新方向以及连续过渡。
    assert!(weight(&app, player, CourierAnimationState::WalkRight) > 0.0);
    assert!(weight(&app, player, CourierAnimationState::Walk) > 0.0);
    assert_eq!(
        app.world().get::<CourierAnimation>(player).unwrap().current,
        CourierAnimationState::WalkRight
    );
}

#[test]
fn direction_and_holding_changes_preserve_synchronized_gait_phase() {
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let (character, visual, player) = spawn_courier(&mut app, asset);
    set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
    notify_ready(&mut app, visual);
    step(&mut app, 0.2);
    assert_gait_phase(&app, player, 0.25);

    set_velocity(&mut app, character, Vec3::X * SIDEWAYS_REFERENCE_SPEED);
    step(&mut app, 0.1);
    assert_gait_phase(&app, player, 0.375);
    let item = app
        .world_mut()
        .spawn(<HeldBy as Relationship>::from(character))
        .id();
    step(&mut app, 0.05);
    assert_gait_phase(&app, player, 0.4375);
    assert!(weight(&app, player, CourierAnimationState::WalkRight) > 0.0);
    assert!(weight(&app, player, CourierAnimationState::CarryRight) > 0.0);

    app.world_mut().entity_mut(item).remove::<HeldBy>();
    set_velocity(&mut app, character, Vec3::ZERO);
    step(&mut app, 0.05);
    assert_gait_phase(&app, player, 0.4375);
    assert!(weight(&app, player, CourierAnimationState::Idle) > 0.0);
    assert!(weight(&app, player, CourierAnimationState::CarryRight) > 0.0);
}

#[test]
fn smooth_blend_and_stride_rate_are_independent_of_render_frame_rate() {
    fn simulate(hz: u32) -> ([f32; ANIMATION_COUNT], f32) {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset);
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        set_velocity(&mut app, character, Vec3::NEG_Z * 4.5);
        for _ in 0..hz / 4 {
            step(&mut app, 1.0 / hz as f32);
        }
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        assert_gait_phase(&app, player, 0.9375);
        (animation.weights, animation.gait_phase)
    }
    let (at_60, phase_60) = simulate(60);
    let (at_120, phase_120) = simulate(120);
    for index in 0..ANIMATION_COUNT {
        assert!((at_60[index] - at_120[index]).abs() < 1.0e-5);
    }
    assert!((phase_60 - phase_120).abs() < 1.0e-5);
}
