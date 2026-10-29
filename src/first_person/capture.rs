//! F3 切换游戏与检查器输入归属，并维护窗口捕获生命周期。

use super::*;
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
            &ControlsCharacter,
            &ControlsCamera,
            &ContextActivity<GameplayContext>,
        ),
        With<GameplayContext>,
    >,
    characters: Query<(), With<Character>>,
    mut cameras: Query<(Entity, &FirstPersonCamera, &mut MouseLookState)>,
    mut egui_contexts: Query<(&mut EguiContextSettings, &mut EguiInput), With<PrimaryEguiContext>>,
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

    let mut any_active = false;
    for (camera, view, mut state) in &mut cameras {
        let available = characters.contains(view.target)
            && controllers
                .iter()
                .any(|(_, character, controlled_camera, _)| {
                    character.character == view.target && controlled_camera.camera == camera
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
        } else if keys.just_pressed(KeyCode::F3) {
            // F3 属于窗口捕获控制，须早于 Egui 转发与玩法动作准备，且不随 GameplayContext 停用。
            state.active = !state.active;
            "inspector_toggle"
        } else if !state.initialized {
            state.active = true;
            "initialization"
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
    let capture_started = any_active && cursor.visible;
    cursor.visible = !any_active;
    // Bevy 的窗口后端会在 Locked 不受支持时尝试 Confined，并将失败写入统一日志。
    cursor.grab_mode = if any_active {
        CursorGrabMode::Locked
    } else {
        CursorGrabMode::None
    };
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
        let after = cameras
            .get(controlled_camera.camera)
            .is_ok_and(|(_, view, state)| view.target == character.character && state.active);
        if **activity != after {
            commands
                .entity(controller)
                .insert(ContextActivity::<GameplayContext>::new(after));
            info!(target: "demo::input", ?controller, character = ?character.character,
                before = **activity, after, reason = if after { "gameplay_input_resumed" }
                    else if !window.focused || lost_focus { "window_focus_lost" }
                    else if !running { "menu_open" }
                    else { "capture_inactive" }, "Gameplay input context activity changed");
        }
    }
}
