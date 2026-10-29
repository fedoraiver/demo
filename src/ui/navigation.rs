//! 键盘与手柄使用 Enhanced Input，鼠标使用 Bevy UI 交互，统一产生菜单请求。

use bevy::{input::InputSystems, prelude::*, window::PrimaryWindow};
use bevy_enhanced_input::prelude::{Press, *};

use crate::audio::{SoundCue, SoundRequest};

use super::*;

#[derive(Component, Clone, Default)]
pub(super) struct MenuContext;

#[derive(InputAction)]
#[action_output(bool)]
struct PreviousAction;
#[derive(InputAction)]
#[action_output(bool)]
struct NextAction;
#[derive(InputAction)]
#[action_output(bool)]
struct LeftAction;
#[derive(InputAction)]
#[action_output(bool)]
struct RightAction;
#[derive(InputAction)]
#[action_output(bool)]
struct ConfirmAction;
#[derive(InputAction)]
#[action_output(bool)]
struct BackAction;

pub(super) fn register(app: &mut App) {
    app.add_input_context::<MenuContext>()
        .add_observer(previous)
        .add_observer(next)
        .add_observer(left)
        .add_observer(right)
        .add_observer(confirm)
        .add_observer(back)
        .add_systems(Startup, spawn_menu_input_controller)
        .add_systems(
            PreUpdate,
            sync_context
                .after(InputSystems)
                .before(EnhancedInputSystems::Prepare),
        );
}

/// 菜单上下文覆盖所有页面，Esc 在游戏运行时表达暂停，而不另读底层按键。
fn spawn_menu_input_controller(mut commands: Commands) {
    let settings = || ActionSettings {
        require_reset: true,
        consume_input: true,
        ..default()
    };
    commands.spawn_scene(bsn! {
        Name("Menu input controller")
        MenuContext
        ContextPriority::<MenuContext>::new(10)
        GamepadDevice::Any
        Actions<MenuContext> [
            Action<PreviousAction>
            settings()
            Press
            Bindings [
                Binding(KeyCode::ArrowUp)
                --
                Binding(GamepadButton::DPadUp)
            ]
            --
            Action<NextAction>
            settings()
            Press
            Bindings [
                Binding(KeyCode::ArrowDown)
                --
                Binding(GamepadButton::DPadDown)
            ]
            --
            Action<LeftAction>
            settings()
            Press
            Bindings [
                Binding(KeyCode::ArrowLeft)
                --
                Binding(GamepadButton::DPadLeft)
            ]
            --
            Action<RightAction>
            settings()
            Press
            Bindings [
                Binding(KeyCode::ArrowRight)
                --
                Binding(GamepadButton::DPadRight)
            ]
            --
            Action<ConfirmAction>
            settings()
            Press
            Bindings [
                Binding(KeyCode::Enter)
                --
                Binding(GamepadButton::South)
            ]
            --
            Action<BackAction>
            settings()
            Press
            Bindings [
                Binding(KeyCode::Escape)
                --
                Binding(GamepadButton::East)
                --
                Binding(GamepadButton::Start)
            ]
        ]
    });
}

fn sync_context(
    mut commands: Commands,
    windows: Query<&Window, With<PrimaryWindow>>,
    contexts: Query<(Entity, &ContextActivity<MenuContext>)>,
) {
    let focused = windows.single().is_ok_and(|window| window.focused);
    for (entity, activity) in &contexts {
        if **activity != focused {
            commands
                .entity(entity)
                .insert(ContextActivity::<MenuContext>::new(focused));
        }
    }
}

fn step_focus(
    menu: &MenuState,
    focus: &mut MenuFocus,
    source: &mut MenuInputSource,
    buttons: &Query<(Entity, &MenuButton)>,
    direction: i32,
) -> Option<Entity> {
    if menu.page == MenuPage::Hidden {
        return None;
    }
    let count = buttons
        .iter()
        .map(|(_, button)| button.index + 1)
        .max()
        .unwrap_or(0);
    if count > 0 {
        *source = MenuInputSource::Navigation;
        let before = focus.index;
        focus.index = (focus.index as i32 + direction).rem_euclid(count as i32) as usize;
        if focus.index != before {
            return buttons
                .iter()
                .find_map(|(entity, button)| (button.index == focus.index).then_some(entity));
        }
    }
    None
}

fn previous(
    _event: On<Fire<PreviousAction>>,
    menu: Res<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<(Entity, &MenuButton)>,
    mut sounds: MessageWriter<SoundRequest>,
) {
    if let Some(entity) = step_focus(&menu, &mut focus, &mut source, &buttons, -1) {
        sounds.write(SoundRequest::new(SoundCue::MenuHover, entity));
    }
}

fn next(
    _event: On<Fire<NextAction>>,
    menu: Res<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<(Entity, &MenuButton)>,
    mut sounds: MessageWriter<SoundRequest>,
) {
    if let Some(entity) = step_focus(&menu, &mut focus, &mut source, &buttons, 1) {
        sounds.write(SoundRequest::new(SoundCue::MenuHover, entity));
    }
}

fn adjust_focused(
    menu: &MenuState,
    focus: &MenuFocus,
    buttons: &Query<&MenuButton>,
    requests: &mut MessageWriter<UiRequest>,
    direction: i8,
) {
    if menu.page != MenuPage::Settings {
        return;
    }
    if let Some(button) = buttons.iter().find(|button| button.index == focus.index)
        && let UiAction::Adjust(key, _) = button.action
    {
        requests.write(UiRequest {
            action: UiAction::Adjust(key, direction),
        });
    }
}

fn left(
    _event: On<Fire<LeftAction>>,
    menu: Res<MenuState>,
    focus: Res<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<&MenuButton>,
    mut requests: MessageWriter<UiRequest>,
) {
    if menu.page != MenuPage::Hidden {
        *source = MenuInputSource::Navigation;
    }
    adjust_focused(&menu, &focus, &buttons, &mut requests, -1);
}

fn right(
    _event: On<Fire<RightAction>>,
    menu: Res<MenuState>,
    focus: Res<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<&MenuButton>,
    mut requests: MessageWriter<UiRequest>,
) {
    if menu.page != MenuPage::Hidden {
        *source = MenuInputSource::Navigation;
    }
    adjust_focused(&menu, &focus, &buttons, &mut requests, 1);
}

fn confirm(
    _event: On<Fire<ConfirmAction>>,
    menu: Res<MenuState>,
    focus: Res<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    buttons: Query<&MenuButton>,
    mut requests: MessageWriter<UiRequest>,
) {
    if menu.page != MenuPage::Hidden
        && let Some(button) = buttons.iter().find(|button| button.index == focus.index)
    {
        *source = MenuInputSource::Navigation;
        requests.write(UiRequest {
            action: button.action,
        });
    }
}

fn back(
    _event: On<Fire<BackAction>>,
    mut source: ResMut<MenuInputSource>,
    mut requests: MessageWriter<UiRequest>,
) {
    *source = MenuInputSource::Navigation;
    requests.write(UiRequest {
        action: UiAction::Back,
    });
}
