//! 指针只读取 Bevy UI 命中，真实光标位移负责输入来源切换。

use super::*;
use crate::audio::{SoundCue, SoundRequest};
use bevy::{
    picking::{
        PickingSystems,
        hover::Hovered,
        pointer::{PointerAction, PointerId, PointerInput},
    },
    prelude::*,
    ui::Pressed,
    window::PrimaryWindow,
};

/// 原生 Button 对任意指针键维护 Pressed；菜单单独保留主键来源以筛选动作和样式。
#[derive(Component)]
pub(super) struct PrimaryPress {
    pub pointer: PointerId,
}

pub(super) fn register(app: &mut App) {
    app.add_message::<PointerPress>()
        .add_message::<PointerInput>()
        .add_observer(primary_press)
        .add_observer(clear_primary_press)
        .add_systems(
            PreUpdate,
            clear_cancelled_primary_presses.after(PickingSystems::Last),
        )
        .add_systems(Update, pointer_interaction.in_set(UiSystems::Pointer));
}

fn primary_press(
    event: On<PointerPress>,
    buttons: Query<(), With<MenuButton>>,
    mut commands: Commands,
) {
    if event.button == PointerButton::Primary && buttons.contains(event.entity) {
        commands.entity(event.entity).insert(PrimaryPress {
            pointer: event.pointer.id,
        });
    }
}

/// 原生 Button 在释放、拖动结束或取消时移除 Pressed；同一生命周期清理主键来源。
fn clear_primary_press(
    event: On<Remove<Pressed>>,
    buttons: Query<(), With<MenuButton>>,
    mut commands: Commands,
) {
    // 页面销毁也移除 Pressed，此时目标可能已随旧树消失。
    if buttons.contains(event.entity) {
        commands.entity(event.entity).try_remove::<PrimaryPress>();
    }
}

/// Bevy 先从 HoverMap 排除取消的指针，随后可能无法为它发出 PointerCancel。
/// 在原生命中阶段之后补清同一指针的菜单按下状态，避免下一次副键继承残留高亮。
fn clear_cancelled_primary_presses(
    mut inputs: MessageReader<PointerInput>,
    pressed: Query<(Entity, &PrimaryPress)>,
    windows: Query<&Window, With<PrimaryWindow>>,
    mut commands: Commands,
) {
    for input in inputs
        .read()
        .filter(|input| matches!(input.action, PointerAction::Cancel))
    {
        for (entity, press) in &pressed {
            if press.pointer == input.pointer_id {
                commands.entity(entity).remove::<(PrimaryPress, Pressed)>();
            }
        }
    }
    // 鼠标后端不把失焦或离窗转换为 Cancel；窗口生命周期也须结束其主键样式。
    if !windows
        .single()
        .is_ok_and(|window| window.focused && window.cursor_position().is_some())
    {
        for (entity, press) in &pressed {
            if press.pointer == PointerId::Mouse {
                commands.entity(entity).remove::<(PrimaryPress, Pressed)>();
            }
        }
    }
}

/// Bevy 原生 UI 已完成按钮命中；这里只读取缓冲的按下事件，不另读 MouseButton。
pub(super) fn pointer_interaction(
    menu: Res<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    windows: Query<&Window, With<PrimaryWindow>>,
    buttons: Query<(Entity, &MenuButton, Ref<Hovered>, Has<PrimaryPress>)>,
    parents: Query<&ChildOf>,
    mut presses: MessageReader<PointerPress>,
    mut requests: MessageWriter<UiRequest>,
    mut sounds: MessageWriter<SoundRequest>,
    mut previous_cursor: Local<Option<Vec2>>,
    mut previous_hover: Local<Option<Entity>>,
) {
    // 原生 UI 重建也会产生 Hovered；只用窗口位置变化识别真实鼠标导航，避免抢走键盘焦点。
    let cursor = windows.single().ok().and_then(Window::cursor_position);
    let pointer_moved = cursor != *previous_cursor;
    *previous_cursor = cursor;
    if menu.page == MenuPage::Hidden {
        presses.clear();
        *previous_hover = None;
        return;
    }
    if pointer_moved {
        *source = MenuInputSource::Pointer;
    }
    let mut clicked = None;
    // 缓冲消息保留同帧按下并释放的点击；在 Build 后核对身份，旧页面的命中不会穿透新树。
    // 原始命中可能是按钮文字，沿实际 ChildOf 关系寻找所属按钮，与原生事件冒泡一致。
    for press in presses
        .read()
        .filter(|press| press.button == PointerButton::Primary)
    {
        let mut entity = press.entity;
        loop {
            if let Ok((_, button, _, _)) = buttons.get(entity) {
                clicked = Some(entity);
                *source = MenuInputSource::Pointer;
                focus.index = button.index;
                if !matches!(button.action, UiAction::Adjust(_, 0)) {
                    requests.write(UiRequest {
                        action: button.action,
                    });
                }
                break;
            }
            let Ok(parent) = parents.get(entity) else {
                break;
            };
            entity = parent.parent();
        }
    }
    let hovered = buttons
        .iter()
        .find_map(|(entity, _, hovered, pressed)| (hovered.0 || pressed).then_some(entity));
    // 键盘原生 Activate 不进入菜单请求；键盘与手柄仍只经过 Enhanced Input。
    for (entity, button, hovered, pressed) in &buttons {
        if !pressed && hovered.0 && pointer_moved && clicked != Some(entity) {
            focus.index = button.index;
            if *previous_hover != Some(entity) && !hovered.is_added() {
                sounds.write(SoundRequest::new(SoundCue::MenuHover, entity));
            }
        }
    }
    *previous_hover = hovered;
}
