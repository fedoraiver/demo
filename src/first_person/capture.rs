//! F3 切换鼠标捕获状态，并在检查器启用时同步输入归属。

use super::*;
#[cfg(feature = "inspector")]
use bevy_inspector_egui::bevy_egui::egui;

/// 在输入转发前确定归属；切换前约定其他按键已松开，检查器没有进行中的交互。
pub(super) fn sync_mouse_capture(
    mut commands: Commands,
    keys: Res<ButtonInput<KeyCode>>,
    mut focus_events: MessageReader<WindowFocused>,
    mut windows: Query<(Entity, &Window, &mut CursorOptions), With<PrimaryWindow>>,
    controllers: Query<
        (
            Entity,
            Option<&ControlsCharacter>,
            Option<&ControlsCamera>,
            &ContextActivity<GameplayContext>,
        ),
        With<GameplayContext>,
    >,
    characters: Query<(), With<Character>>,
    mut cameras: Query<
        (Entity, Option<&CameraTarget>, &mut MouseLookState),
        With<FirstPersonCamera>,
    >,
    #[cfg(feature = "inspector")] mut egui_contexts: Query<
        (&mut EguiContextSettings, &mut EguiInput),
        With<PrimaryEguiContext>,
    >,
    app_state: Option<Res<State<AppState>>>,
) {
    let running = app_state
        .as_ref()
        .is_none_or(|state| *state.get() == AppState::Running);
    let Ok((window_entity, window, mut cursor)) = windows.single_mut() else {
        focus_events.clear();
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
    // 消息也要检查，以保留同帧失焦又回焦的释放边界。
    let mut lost_focus = false;
    for event in focus_events.read() {
        lost_focus |= event.window == window_entity && !event.focused;
    }
    let window_focused = window.focused && !lost_focus;

    let mut any_active = false;
    for (camera, target, mut state) in &mut cameras {
        let character = target.map(|target| target.character);
        let target_available = character.is_some_and(|character| {
            characters.contains(character)
                && controllers
                    .iter()
                    .any(|(_, controlled_character, controlled_camera, _)| {
                        controlled_character
                            .is_some_and(|controlled| controlled.character == character)
                            && controlled_camera
                                .is_some_and(|controlled| controlled.camera == camera)
                    })
        });
        if !target_available && (!state.initialized || state.target_available) {
            warn!(target: "demo::camera", ?camera, ?character,
                before = "available", after = "unavailable", reason = "camera_binding_unavailable",
                "Camera target or controller unavailable");
        }
        state.target_available = target_available;
        let before = state.active;
        let (active, reason) =
            capture_decision(&state, &keys, running, target_available, window_focused);
        let capture_transition = !state.initialized || before != active;
        state.active = active;
        state.skip_motion = capture_transition;
        if capture_transition {
            info!(target: "demo::camera", ?camera, ?character,
                ?window_entity, before = if before { "captured" } else { "released" },
                after = if active { "captured" } else { "released" }, reason,
                "Mouse look capture changed");
        }
        state.initialized = true;
        any_active |= active;
    }
    #[cfg(feature = "inspector")]
    let capture_started = any_active && cursor.visible;
    cursor.visible = !any_active;
    // Bevy 的窗口后端会在 Locked 不受支持时尝试 Confined，并将失败写入统一日志。
    cursor.grab_mode = if any_active {
        CursorGrabMode::Locked
    } else {
        CursorGrabMode::None
    };
    #[cfg(feature = "inspector")]
    for (mut settings, mut input) in &mut egui_contexts {
        let enabled = !any_active;
        let systems = &mut settings.input_system_settings;
        systems.run_write_window_pointer_moved_messages = enabled;
        systems.run_write_pointer_button_messages = enabled;
        systems.run_write_mouse_wheel_messages_system = enabled;
        systems.run_write_keyboard_input_messages_system = enabled;
        systems.run_write_ime_messages_system = enabled;
        if capture_started {
            // 停止转发不会删除最后的光标位置；只在恢复捕获时结束检查器悬停。
            input.events.push(egui::Event::PointerGone);
        }
    }
    for (controller, character, controlled_camera, activity) in &controllers {
        let after =
            character
                .zip(controlled_camera)
                .is_some_and(|(character, controlled_camera)| {
                    cameras
                        .get(controlled_camera.camera)
                        .is_ok_and(|(_, target, state)| {
                            target.is_some_and(|target| target.character == character.character)
                                && state.active
                        })
                });
        if **activity != after {
            commands
                .entity(controller)
                .insert(ContextActivity::<GameplayContext>::new(after));
            let reason = if after {
                "gameplay_input_resumed"
            } else if !window_focused {
                "window_focus_lost"
            } else if !running {
                "menu_open"
            } else {
                "capture_inactive"
            };
            info!(target: "demo::input", ?controller, character = ?character.map(|controlled| controlled.character),
                before = **activity, after, reason, "Gameplay input context activity changed");
        }
    }
}

/// 先处理强制释放，再处理手动切换与首次捕获。
fn capture_decision(
    state: &MouseLookState,
    keys: &ButtonInput<KeyCode>,
    running: bool,
    target_available: bool,
    window_focused: bool,
) -> (bool, &'static str) {
    if !running {
        (false, "menu_open")
    } else if !target_available {
        (false, "camera_binding_unavailable")
    } else if !window_focused {
        (false, "window_focus_lost")
    } else if keys.just_pressed(KeyCode::Escape) {
        (false, "escape_pressed")
    } else if keys.just_pressed(KeyCode::F3) {
        // F3 独立于玩法输入，即使玩法上下文已停用也能恢复捕获。
        (!state.active, "capture_toggle")
    } else if !state.initialized {
        (true, "initialization")
    } else {
        (state.active, "unchanged")
    }
}
