//! 无窗口覆盖主角动画的 jump 行为。

use super::test_support::*;
use super::*;

#[test]
fn air_states_filter_grounding_noise_and_freeze_walking_phase() {
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let (character, visual, player) = spawn_courier(&mut app, asset);
    set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
    notify_ready(&mut app, visual);
    step(&mut app, 0.1);
    app.world_mut()
        .get_mut::<CharacterMotion>(character)
        .unwrap()
        .grounded = false;
    step(&mut app, 0.02);
    assert!(
        app.world()
            .get::<CourierAnimation>(player)
            .unwrap()
            .grounded
    );
    assert_eq!(weight(&app, player, CourierAnimationState::Fall), 0.0);

    set_velocity(&mut app, character, Vec3::new(0.0, 5.0, -1.5));
    step(&mut app, 0.01);
    assert_eq!(
        app.world().get::<CourierAnimation>(player).unwrap().current,
        CourierAnimationState::Jump
    );
    assert_gait_phase(&app, player, 0.15);
    set_velocity(&mut app, character, Vec3::new(0.0, -0.1, -1.5));
    step(&mut app, 0.01);
    assert_eq!(
        app.world().get::<CourierAnimation>(player).unwrap().current,
        CourierAnimationState::Jump
    );
    set_velocity(&mut app, character, Vec3::new(0.0, -1.0, -1.5));
    app.world_mut()
        .spawn(<HeldBy as Relationship>::from(character));
    step(&mut app, 0.05);
    assert_eq!(
        app.world().get::<CourierAnimation>(player).unwrap().current,
        CourierAnimationState::CarryFall
    );
    assert_gait_phase(&app, player, 0.15);

    app.world_mut()
        .get_mut::<CharacterMotion>(character)
        .unwrap()
        .grounded = true;
    set_velocity(&mut app, character, Vec3::NEG_Z * FORWARD_REFERENCE_SPEED);
    step(&mut app, 0.02);
    assert!(weight(&app, player, CourierAnimationState::CarryLand) > 0.0);
    assert!(weight(&app, player, CourierAnimationState::CarryFall) > 0.0);
    assert_gait_phase(&app, player, 0.15);
    step(&mut app, LAND_VISUAL_DURATION);
    assert!(weight(&app, player, CourierAnimationState::CarryWalk) > 0.0);
    assert_gait_phase(&app, player, 0.425);
}

#[test]
fn upward_velocity_overrides_raw_grounding_and_jump_pose_moves_once_then_holds() {
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let (character, visual, player) = spawn_courier(&mut app, asset.clone());
    let bone = jump_pose_bone(&mut app, &asset, player);
    notify_ready(&mut app, visual);
    step(&mut app, 0.0);
    set_velocity(&mut app, character, Vec3::Y * 5.0);
    // 有意保留 raw grounded=true，复现起跳首帧接地数据尚未刷新的边界。
    step(&mut app, 0.01);
    let animation = app.world().get::<CourierAnimation>(player).unwrap();
    assert!(!animation.grounded);
    assert_eq!(animation.jump_phase, CourierJumpPhase::Rising);
    assert_eq!(phase_seek(&app, player, CourierAnimationState::Jump), 0.0);
    step(&mut app, 0.12);
    assert!((phase_seek(&app, player, CourierAnimationState::Jump) - 0.4).abs() < 1.0e-5);
    assert!(app.world().get::<Transform>(bone).unwrap().translation.y > 0.1);

    let item = app
        .world_mut()
        .spawn(<HeldBy as Relationship>::from(character))
        .id();
    step(&mut app, 0.03);
    for state in [
        CourierAnimationState::Jump,
        CourierAnimationState::CarryJump,
    ] {
        assert!((phase_seek(&app, player, state) - 0.5).abs() < 1.0e-5);
    }
    step(&mut app, 0.5);
    let end_height = app.world().get::<Transform>(bone).unwrap().translation.y;
    assert!((end_height - 0.25).abs() < 0.001);
    step(&mut app, 0.4);
    for state in [
        CourierAnimationState::Jump,
        CourierAnimationState::CarryJump,
    ] {
        // 实际 AnimationPlugin 执行后仍停在最后一帧，不能被内部自动推进环回第一帧。
        assert_eq!(phase_seek(&app, player, state), GAIT_CYCLE_DURATION);
    }
    assert!((app.world().get::<Transform>(bone).unwrap().translation.y - end_height).abs() < 0.001);

    app.world_mut()
        .get_mut::<CharacterMotion>(character)
        .unwrap()
        .grounded = false;
    set_velocity(&mut app, character, Vec3::Y * -0.1);
    step(&mut app, 0.01);
    assert_eq!(
        app.world()
            .get::<CourierAnimation>(player)
            .unwrap()
            .jump_phase,
        CourierJumpPhase::Rising
    );
    set_velocity(&mut app, character, Vec3::Y * -0.5);
    step(&mut app, 0.01);
    assert_eq!(
        app.world()
            .get::<CourierAnimation>(player)
            .unwrap()
            .jump_phase,
        CourierJumpPhase::Falling
    );
    step(&mut app, 0.08);
    app.world_mut().entity_mut(item).remove::<HeldBy>();
    step(&mut app, 0.03);
    for state in [
        CourierAnimationState::Fall,
        CourierAnimationState::CarryFall,
    ] {
        assert!((phase_seek(&app, player, state) - 0.11).abs() < 1.0e-5);
    }
    assert_eq!(
        phase_seek(&app, player, CourierAnimationState::Jump),
        GAIT_CYCLE_DURATION
    );
    assert_eq!(
        app.world().get::<Transform>(character).unwrap().translation,
        Vec3::ZERO
    );
}

#[test]
fn initial_raw_grounded_frame_with_upward_velocity_binds_jump_immediately() {
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let (character, visual, player) = spawn_courier(&mut app, asset.clone());
    let bone = jump_pose_bone(&mut app, &asset, player);
    set_velocity(&mut app, character, Vec3::Y * 5.0);
    notify_ready(&mut app, visual);
    step(&mut app, 0.0);
    assert_eq!(weight(&app, player, CourierAnimationState::Jump), 1.0);
    assert!(
        !app.world()
            .get::<CourierAnimation>(player)
            .unwrap()
            .grounded
    );
    step(&mut app, 0.12);
    assert!((app.world().get::<Transform>(bone).unwrap().translation.y - 0.2).abs() < 1.0e-5);
}

#[test]
fn first_support_probe_does_not_fake_landing_but_sustained_initial_air_does() {
    for unsupported_time in [0.0, AIRBORNE_DELAY + 0.01] {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        // 两种初态都有 raw grounded=false 和零竖直速度：尚未探测支撑与高处刚开始坠落。
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = false;
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        if unsupported_time > 0.0 {
            step(&mut app, unsupported_time);
        }
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = true;
        step(&mut app, 0.01);
        let animation = app.world().get::<CourierAnimation>(player).unwrap();
        if unsupported_time == 0.0 {
            assert_eq!(animation.jump_phase, CourierJumpPhase::Grounded);
            for _ in 0..12 {
                step(&mut app, 1.0 / 60.0);
                assert_eq!(weight(&app, player, CourierAnimationState::Land), 0.0);
                assert_eq!(weight(&app, player, CourierAnimationState::CarryLand), 0.0);
                // 使用真实图输出，确保首次支撑探测不会出现落地缓冲的负向姿态曲线。
                assert!(app.world().get::<Transform>(bone).unwrap().translation.y >= 0.0);
            }
        } else {
            assert_eq!(animation.jump_phase, CourierJumpPhase::Landing);
            step(&mut app, 0.1);
            assert!(weight(&app, player, CourierAnimationState::Land) > 0.0);
            assert!(app.world().get::<Transform>(bone).unwrap().translation.y < 0.0);
        }
    }
}

#[test]
fn landing_buffers_once_and_carry_changes_preserve_its_progress() {
    for carrying in [false, true] {
        let mut app = animation_app();
        let asset = courier_asset(&mut app);
        let (character, visual, player) = spawn_courier(&mut app, asset.clone());
        let bone = jump_pose_bone(&mut app, &asset, player);
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = false;
        set_velocity(&mut app, character, Vec3::Y * -2.0);
        let item = carrying.then(|| {
            app.world_mut()
                .spawn(<HeldBy as Relationship>::from(character))
                .id()
        });
        notify_ready(&mut app, visual);
        step(&mut app, 0.0);
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = true;
        set_velocity(&mut app, character, Vec3::ZERO);
        step(&mut app, 0.01);
        assert_eq!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .jump_phase,
            CourierJumpPhase::Landing
        );
        let land = if carrying {
            CourierAnimationState::CarryLand
        } else {
            CourierAnimationState::Land
        };
        assert!(weight(&app, player, land) > 0.0);
        assert_eq!(phase_seek(&app, player, land), 0.0);
        step(&mut app, 0.1);
        assert!(app.world().get::<Transform>(bone).unwrap().translation.y < 0.0);
        if let Some(item) = item {
            app.world_mut().entity_mut(item).remove::<HeldBy>();
        } else {
            app.world_mut()
                .spawn(<HeldBy as Relationship>::from(character));
        }
        step(&mut app, 0.05);
        for state in [
            CourierAnimationState::Land,
            CourierAnimationState::CarryLand,
        ] {
            assert!(
                (phase_seek(&app, player, state)
                    - 0.15 / LAND_VISUAL_DURATION * GAIT_CYCLE_DURATION)
                    .abs()
                    < 1.0e-5
            );
        }
        step(&mut app, 0.08);
        assert_eq!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .jump_phase,
            CourierJumpPhase::Grounded
        );
        for _ in 0..12 {
            step(&mut app, 1.0 / 60.0);
            assert_eq!(phase_seek(&app, player, land), GAIT_CYCLE_DURATION);
            assert_eq!(
                app.world()
                    .get::<CourierAnimation>(player)
                    .unwrap()
                    .jump_phase,
                CourierJumpPhase::Grounded
            );
        }
        // 一帧接地探测噪声后回到地面，也不能重复起播刚结束的落地动作。
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = false;
        step(&mut app, 0.02);
        app.world_mut()
            .get_mut::<CharacterMotion>(character)
            .unwrap()
            .grounded = true;
        step(&mut app, 0.02);
        assert_eq!(
            app.world()
                .get::<CourierAnimation>(player)
                .unwrap()
                .jump_phase,
            CourierJumpPhase::Grounded
        );
        assert_eq!(phase_seek(&app, player, land), GAIT_CYCLE_DURATION);
    }
}

#[test]
fn pause_gate_freezes_jump_clock_and_evaluated_pose_without_restarting_on_resume() {
    use crate::game_flow::{AppState, PlayState};
    let mut app = animation_app();
    let asset = courier_asset(&mut app);
    let (character, visual, player) = spawn_courier(&mut app, asset.clone());
    let bone = jump_pose_bone(&mut app, &asset, player);
    set_velocity(&mut app, character, Vec3::Y * 5.0);
    notify_ready(&mut app, visual);
    step(&mut app, 0.0);
    step(&mut app, 0.06);
    let seek = phase_seek(&app, player, CourierAnimationState::Jump);
    let pose = *app.world().get::<Transform>(bone).unwrap();
    app.insert_resource(State::new(AppState::InGame))
        .insert_resource(State::new(PlayState::Paused));
    step(&mut app, 0.5);
    assert_eq!(phase_seek(&app, player, CourierAnimationState::Jump), seek);
    assert_eq!(*app.world().get::<Transform>(bone).unwrap(), pose);
    app.insert_resource(State::new(PlayState::Running));
    step(&mut app, 0.01);
    assert!(
        (phase_seek(&app, player, CourierAnimationState::Jump)
            - 0.07 / JUMP_VISUAL_DURATION * GAIT_CYCLE_DURATION)
            .abs()
            < 1.0e-5
    );
}
