//! capture tests 的无窗口回归。

use super::*;

#[test]
fn f3_releases_pointer_and_click_recapture_skips_free_cursor_motion() {
    // 使用实际 F3 绑定验证调试释放；窗口仍只是 ECS 数据，不创建桌面窗口。
    let (mut app, window, _, camera, _) = test_app();
    let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
    app.world_mut().write_message(KeyboardInput {
        key_code: KeyCode::F3,
        logical_key: Key::F3,
        state: ButtonState::Pressed,
        text: None,
        repeat: false,
        window,
    });
    app.update();
    assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
    assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
    assert_eq!(
        app.world().get::<CursorOptions>(window).unwrap().grab_mode,
        CursorGrabMode::None
    );
    for _ in 0..3 {
        mouse_motion(&mut app, Vec2::new(50.0, 20.0));
        app.update();
        assert_eq!(
            app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
            yaw
        );
    }
    app.world_mut().write_message(KeyboardInput {
        key_code: KeyCode::F3,
        logical_key: Key::F3,
        state: ButtonState::Released,
        text: None,
        repeat: false,
        window,
    });
    mouse_button(&mut app, window, ButtonState::Pressed);
    mouse_motion(&mut app, Vec2::new(200.0, 100.0));
    app.update();
    assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        yaw
    );
    mouse_button(&mut app, window, ButtonState::Released);
    mouse_motion(&mut app, Vec2::new(10.0, 0.0));
    app.update();
    assert_ne!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        yaw
    );
}

#[test]
fn captured_pointer_over_inspector_does_not_consume_gameplay_input() {
    let (mut app, window, character, camera, controller) = test_app();
    let context = add_test_inspector(&mut app);
    let input_position = app
        .world()
        .resource::<TestInspectorUi>()
        .text_edit_rect
        .unwrap()
        .center();
    set_cursor(&mut app, window, input_position);
    inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Pressed);
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    mouse_button(&mut app, window, ButtonState::Released);
    app.update();
    assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
    assert!(
        **app
            .world()
            .get::<ContextActivity<GameplayContext>>(controller)
            .unwrap()
    );
    assert_eq!(
        app.world()
            .get::<CharacterIntent>(character)
            .unwrap()
            .movement,
        Vec2::Y
    );
    assert!(app.world().resource::<TestInspectorUi>().text.is_empty());
    assert!(
        !app.world_mut()
            .get_mut::<EguiContext>(context)
            .unwrap()
            .get_mut()
            .egui_wants_keyboard_input()
    );

    inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Released);
    escape(&mut app, window, ButtonState::Pressed);
    app.update();
    assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
    escape(&mut app, window, ButtonState::Released);
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    mouse_button(&mut app, window, ButtonState::Released);
    app.update();
    assert!(
        app.world_mut()
            .get_mut::<EguiContext>(context)
            .unwrap()
            .get_mut()
            .egui_wants_keyboard_input()
    );
    inspector_keyboard(&mut app, window, KeyCode::KeyE, ButtonState::Pressed);
    app.update();
    assert_eq!(app.world().resource::<TestInspectorUi>().text, "e");
    assert!(
        !app.world()
            .get::<CharacterIntent>(character)
            .unwrap()
            .interact_pending
    );

    inspector_keyboard(&mut app, window, KeyCode::KeyE, ButtonState::Released);
    set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    // 恢复时 egui 已收到面板外按下；下一帧过滤松开也必须把其按下状态清干净。
    mouse_button(&mut app, window, ButtonState::Released);
    app.update();
    assert!(
        !app.world_mut()
            .get_mut::<EguiContext>(context)
            .unwrap()
            .get_mut()
            .input(|input| input.pointer.any_down())
    );
    escape(&mut app, window, ButtonState::Pressed);
    app.update();
    escape(&mut app, window, ButtonState::Released);
    set_cursor(&mut app, window, input_position);
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    mouse_button(&mut app, window, ButtonState::Released);
    app.update();
    inspector_keyboard(&mut app, window, KeyCode::KeyI, ButtonState::Pressed);
    app.update();
    assert!(app.world().resource::<TestInspectorUi>().text.contains('i'));
}

#[test]
fn inspector_click_blocks_keyboard_actions_and_blank_click_requires_key_reset() {
    let (mut app, window, character, camera, controller) = test_app();
    add_test_inspector(&mut app);
    let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
    set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
    inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Pressed);
    app.update();
    assert_eq!(
        app.world()
            .get::<CharacterIntent>(character)
            .unwrap()
            .movement,
        Vec2::Y
    );
    escape(&mut app, window, ButtonState::Pressed);
    app.update();
    assert!(
        **app
            .world()
            .get::<ContextActivity<GameplayContext>>(controller)
            .unwrap()
    );

    escape(&mut app, window, ButtonState::Released);
    let input_position = app
        .world()
        .resource::<TestInspectorUi>()
        .text_edit_rect
        .unwrap()
        .center();
    set_cursor(&mut app, window, input_position);
    mouse_button(&mut app, window, ButtonState::Pressed);
    for key in [KeyCode::Space, KeyCode::KeyE] {
        inspector_keyboard(&mut app, window, key, ButtonState::Pressed);
    }
    // 首次点击面板和按键同帧到达，必须在动作准备前停用上下文。
    app.update();
    assert!(
        !**app
            .world()
            .get::<ContextActivity<GameplayContext>>(controller)
            .unwrap()
    );
    assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
    assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
    let intent = app.world().get::<CharacterIntent>(character).unwrap();
    assert_eq!(intent.movement, Vec2::ZERO);
    assert!(!intent.jump_pending && !intent.interact_pending);
    fixed_step(&mut app);
    let position = app.world().get::<Position>(character).unwrap().0;
    assert!(Vec2::new(position.x, position.z).abs_diff_eq(Vec2::ZERO, 0.00001));
    assert!(app.world().get::<LinearVelocity>(character).unwrap().y < 0.1);
    assert!(app.world().get::<HeldBy>(item).is_none());

    mouse_button(&mut app, window, ButtonState::Released);
    app.update();
    set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
    mouse_button(&mut app, window, ButtonState::Released);
    inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Released);
    app.update();
    assert!(
        **app
            .world()
            .get::<ContextActivity<GameplayContext>>(controller)
            .unwrap()
    );
    let intent = app.world().get::<CharacterIntent>(character).unwrap();
    assert!(!intent.jump_pending && !intent.interact_pending);

    for state in [ButtonState::Released, ButtonState::Pressed] {
        for key in [KeyCode::Space, KeyCode::KeyE] {
            inspector_keyboard(&mut app, window, key, state);
        }
        app.update();
    }
    let intent = app.world().get::<CharacterIntent>(character).unwrap();
    assert!(intent.jump_pending && intent.interact_pending);
    fixed_step(&mut app);
    assert!(app.world().get::<LinearVelocity>(character).unwrap().y > 0.0);
    assert_eq!(
        app.world()
            .get::<HoldingItems>(character)
            .unwrap()
            .iter()
            .next(),
        Some(item)
    );
}

#[test]
fn focused_inspector_keeps_keyboard_blocked_after_pointer_leaves_panel() {
    let (mut app, window, character, _, controller) = test_app();
    let context = add_test_inspector(&mut app);
    escape(&mut app, window, ButtonState::Pressed);
    app.update();
    escape(&mut app, window, ButtonState::Released);
    let input_position = app
        .world()
        .resource::<TestInspectorUi>()
        .text_edit_rect
        .unwrap()
        .center();
    set_cursor(&mut app, window, input_position);
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    mouse_button(&mut app, window, ButtonState::Released);
    app.update();
    assert!(
        app.world_mut()
            .get_mut::<EguiContext>(context)
            .unwrap()
            .get_mut()
            .egui_wants_keyboard_input()
    );

    set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
    for key in [KeyCode::KeyW, KeyCode::Space, KeyCode::KeyE] {
        inspector_keyboard(&mut app, window, key, ButtonState::Pressed);
    }
    app.update();
    assert!(
        !**app
            .world()
            .get::<ContextActivity<GameplayContext>>(controller)
            .unwrap()
    );
    let intent = app.world().get::<CharacterIntent>(character).unwrap();
    assert_eq!(intent.movement, Vec2::ZERO);
    assert!(!intent.jump_pending && !intent.interact_pending);
}

#[test]
fn escape_focus_and_click_gate_the_same_frames_motion() {
    let (mut app, window, _, camera, _) = test_app();
    assert!(!app.world().get::<CursorOptions>(window).unwrap().visible);
    escape(&mut app, window, ButtonState::Pressed);
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        0.0
    );
    assert_eq!(
        app.world().get::<CursorOptions>(window).unwrap().grab_mode,
        CursorGrabMode::None
    );
    escape(&mut app, window, ButtonState::Released);
    mouse_button(&mut app, window, ButtonState::Pressed);
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        0.0
    );
    mouse_button(&mut app, window, ButtonState::Released);
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
    assert!(yaw != 0.0);
    // 窗口最终仍聚焦，但消息记录曾失焦；不能自动恢复或消费本帧位移。
    app.world_mut().write_message(WindowFocused {
        window,
        focused: false,
    });
    app.world_mut().write_message(WindowFocused {
        window,
        focused: true,
    });
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
    assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        yaw
    );
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        yaw
    );
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    assert_ne!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        yaw
    );
}

#[test]
fn first_click_recaptures_even_when_focus_loss_missed_mouse_release() {
    let (mut app, window, _, camera, _) = test_app();
    mouse_button(&mut app, window, ButtonState::Pressed);
    app.update();
    app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
    app.world_mut().write_message(WindowFocused {
        window,
        focused: false,
    });
    app.update();
    // 在窗口外松开时不一定收到 Released；回焦不能依靠缓存按下状态判断点击。
    app.world_mut().get_mut::<Window>(window).unwrap().focused = true;
    app.world_mut().write_message(WindowFocused {
        window,
        focused: true,
    });
    app.update();
    assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
    mouse_button(&mut app, window, ButtonState::Pressed);
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
    assert_eq!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        0.0
    );
    mouse_motion(&mut app, Vec2::X * 50.0);
    app.update();
    assert_ne!(
        app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
        0.0
    );
}

#[test]
fn missing_target_or_controller_releases_capture_and_keeps_camera_pose() {
    for remove_target in [true, false] {
        let (mut app, window, character, camera, controller) = test_app();
        let before = *app.world().get::<Transform>(camera).unwrap();
        app.world_mut()
            .despawn(if remove_target { character } else { controller });
        mouse_motion(&mut app, Vec2::ONE * 100.0);
        // 捕获释放应在当前无固定步帧完成，不能补跑物理后再检查鼠标生命周期。
        app.update();
        assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
        assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
        assert_eq!(*app.world().get::<Transform>(camera).unwrap(), before);
    }
}
