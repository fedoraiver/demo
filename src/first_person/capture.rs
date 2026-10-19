//! 鼠标捕获与检查器输入隔离。

use super::*;

/// 检查器释放使用动作事件；相机捕获系统继续负责下一帧上下文与点击恢复。
pub(super) fn release_pointer_for_inspector(
    event: On<Fire<ReleasePointerAction>>,
    controllers: Query<&ControlsCamera, With<GameplayContext>>,
    mut cameras: Query<&mut MouseLookState>,
    mut windows: Query<(&Window, &mut CursorOptions), With<PrimaryWindow>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut capture) = cameras.get_mut(controlled.0) else {
        return;
    };
    let Ok((window, mut cursor)) = windows.single_mut() else {
        return;
    };
    if !window.focused {
        return;
    }
    let was_captured = capture.active;
    capture.active = false;
    capture.skip_motion = true;
    cursor.visible = true;
    cursor.grab_mode = CursorGrabMode::None;
    if was_captured {
        info!(target: "demo::camera", camera = ?controlled.0, before = "captured", after = "released",
            reason = "inspector_release_action", "Mouse look capture changed");
    }
}

/// 游戏捕获鼠标时检查器仍显示，但不能接收藏在面板上的光标点击或角色操作按键。
pub(super) fn filter_captured_egui_input(
    keys: Res<ButtonInput<KeyCode>>,
    windows: Query<(&Window, &CursorOptions), With<PrimaryWindow>>,
    mut contexts: Query<(&mut EguiContext, &mut EguiInput), With<PrimaryEguiContext>>,
) {
    let Ok((window, cursor)) = windows.single() else {
        return;
    };
    // Esc 必须在本帧直接放行检查器输入，不等后续捕获同步；窗口焦点仍由 egui 的原始输入设施维护。
    if !window.focused
        || cursor.visible
        || cursor.grab_mode == CursorGrabMode::None
        || keys.just_pressed(KeyCode::Escape)
    {
        return;
    }
    for (mut context, mut input) in &mut contexts {
        let context = context.get_mut();
        input.0.events.clear();
        // 面板外恢复捕获的按下已进入 egui；仅补齐仍按下的释放，再移除位置，避免过滤真实松开后状态残留。
        context.input(|state| {
            for button in [
                egui::PointerButton::Primary,
                egui::PointerButton::Secondary,
                egui::PointerButton::Middle,
                egui::PointerButton::Extra1,
                egui::PointerButton::Extra2,
            ] {
                if state.pointer.button_down(button) {
                    input.0.events.push(egui::Event::PointerButton {
                        pos: egui::pos2(-10000.0, -10000.0),
                        button,
                        pressed: false,
                        modifiers: default(),
                    });
                }
            }
            for key in &state.keys_down {
                input.0.events.push(egui::Event::Key {
                    key: *key,
                    physical_key: None,
                    pressed: false,
                    repeat: false,
                    modifiers: default(),
                });
            }
        });
        input.0.events.push(egui::Event::PointerGone);
        context.stop_dragging();
        context.memory_mut(|memory| {
            if let Some(focused) = memory.focused() {
                memory.surrender_focus(focused);
            }
        });
    }
}

/// 同时检查窗口状态和焦点消息，避免同一帧失焦后又回焦时自动恢复捕获。
pub(super) fn sync_mouse_capture(
    mut commands: Commands,
    keys: Res<ButtonInput<KeyCode>>,
    mut button_events: MessageReader<MouseButtonInput>,
    mut focus_events: MessageReader<WindowFocused>,
    mut windows: Query<(Entity, &Window, &mut CursorOptions), With<PrimaryWindow>>,
    controllers: Query<
        (
            Entity,
            &ControlsCharacter,
            &ControlsCamera,
            &ContextActivity<GameplayContext>,
        ),
        With<GameplayContext>,
    >,
    characters: Query<(), With<Character>>,
    mut cameras: Query<(Entity, &FirstPersonCamera, &mut MouseLookState)>,
    mut egui_contexts: Query<&mut EguiContext, With<PrimaryEguiContext>>,
    app_state: Option<Res<State<AppState>>>,
    play_state: Option<Res<State<PlayState>>>,
) {
    let running = app_state.as_ref().is_none_or(|state| {
        *state.get() == AppState::InGame
            && play_state
                .as_ref()
                .is_some_and(|state| *state.get() == PlayState::Running)
    });
    let Ok((window_entity, window, mut cursor)) = windows.single_mut() else {
        focus_events.clear();
        button_events.clear();
        for (camera, _, mut state) in &mut cameras {
            if state.active {
                info!(target: "demo::camera", ?camera, before = "captured", after = "released",
                    reason = "window_unavailable", "Mouse look capture changed");
            }
            state.active = false;
            state.skip_motion = true;
        }
        for (controller, _, _, activity) in &controllers {
            if **activity {
                commands
                    .entity(controller)
                    .insert(ContextActivity::<GameplayContext>::INACTIVE);
            }
        }
        return;
    };
    let mut lost_focus = false;
    for event in focus_events.read() {
        lost_focus |= event.window == window_entity && !event.focused;
    }
    let mut clicked = false;
    for event in button_events.read() {
        // 失焦可能漏收松开消息，直接读取点击而不依赖仍残留的 pressed 状态。
        clicked |= event.window == window_entity
            && event.button == MouseButton::Left
            && event.state.is_pressed();
    }

    // 捕获属于窗口生命周期；必须读取当前物理光标来区分同帧点击，不能用 PostUpdate 的旧输入摘要。
    let mut pointer_over_ui = false;
    let mut using_pointer = false;
    let mut wants_keyboard = false;
    let mut popup_open = false;
    if let Ok(mut context) = egui_contexts.single_mut() {
        let context = context.get_mut();
        pointer_over_ui = window.physical_cursor_position().is_some_and(|position| {
            let position = position / context.pixels_per_point();
            context
                .layer_id_at(egui::pos2(position.x, position.y))
                .is_some_and(|layer| layer.order != egui::Order::Background)
        });
        using_pointer = context.egui_is_using_pointer();
        wants_keyboard = context.egui_wants_keyboard_input();
        popup_open = context.any_popup_open();
    }
    // 拖拽跨出面板或菜单仍打开时，点击不能意外恢复鼠标锁定。
    let gameplay_clicked = clicked && !pointer_over_ui && !using_pointer && !popup_open;

    let mut any_active = false;
    for (camera, view, mut state) in &mut cameras {
        let available = characters.contains(view.target)
            && controllers
                .iter()
                .any(|(_, character, controlled_camera, _)| {
                    character.0 == view.target && controlled_camera.0 == camera
                });
        if !available && (!state.initialized || state.target_available) {
            warn!(target: "demo::camera", ?camera, character = ?view.target,
                before = "available", after = "unavailable", reason = "camera_binding_unavailable",
                "Camera target or controller unavailable");
        }
        state.target_available = available;
        let before = state.active;
        let reason = if !running {
            state.active = false;
            "menu_open"
        } else if !available {
            state.active = false;
            "camera_binding_unavailable"
        } else if lost_focus || !window.focused {
            state.active = false;
            "window_focus_lost"
        } else if keys.just_pressed(KeyCode::Escape) {
            state.active = false;
            "escape_pressed"
        } else if !state.initialized || gameplay_clicked {
            state.active = true;
            if state.initialized {
                "window_clicked"
            } else {
                "initialization"
            }
        } else {
            "unchanged"
        };
        state.skip_motion = !state.initialized || before != state.active;
        if !state.initialized || before != state.active {
            info!(target: "demo::camera", ?camera, character = ?view.target,
                ?window_entity, before = if before { "captured" } else { "released" },
                after = if state.active { "captured" } else { "released" }, reason,
                "Mouse look capture changed");
        }
        state.initialized = true;
        any_active |= state.active;
    }
    cursor.visible = !any_active;
    // Bevy 的窗口后端会在 Locked 不受支持时尝试 Confined，并将失败写入统一日志。
    cursor.grab_mode = if any_active {
        CursorGrabMode::Locked
    } else {
        CursorGrabMode::None
    };
    // 菜单与暂停停用玩法；Esc 的菜单动作由 Enhanced Input 处理，这里的底层判断只负责光标生命周期。
    // ContextActivity 是不可变组件，按实际变化插入，使 require_reset 保留重新启用前的按键释放边界。
    let gameplay_active = running
        && window.focused
        && !lost_focus
        && !wants_keyboard
        && !popup_open
        && !using_pointer
        && (any_active || !pointer_over_ui);
    for (controller, character, controlled_camera, activity) in &controllers {
        let available = characters.contains(character.0)
            && cameras
                .get(controlled_camera.0)
                .is_ok_and(|(_, view, _)| view.target == character.0);
        let after = gameplay_active && available;
        if **activity != after {
            commands
                .entity(controller)
                .insert(ContextActivity::<GameplayContext>::new(after));
            info!(target: "demo::input", ?controller, character = ?character.0,
                before = **activity, after, reason = if after { "gameplay_input_resumed" }
                    else if !window.focused || lost_focus { "window_focus_lost" }
                    else if !available { "camera_binding_unavailable" }
                    else if !running { "menu_open" }
                    else { "inspector_input" }, "Gameplay input context activity changed");
        }
    }
}
