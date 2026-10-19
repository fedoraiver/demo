//! 指针只读取 Bevy UI 命中，真实光标位移负责输入来源切换。

use super::*;
use crate::audio::{SoundCue, SoundRequest};
use bevy::{prelude::*, window::PrimaryWindow};

pub(super) fn register(app: &mut App) {
    app.add_systems(Update, pointer_interaction.in_set(UiSystems::Pointer));
}

/// Bevy 原生 UI 已完成按钮命中；这里不再读取 MouseButton，防止双重触发。
fn pointer_interaction(
    menu: Res<MenuState>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    windows: Query<&Window, With<PrimaryWindow>>,
    buttons: Query<(Entity, &MenuButton, Ref<Interaction>)>,
    mut requests: MessageWriter<UiRequest>,
    mut sounds: MessageWriter<SoundRequest>,
    mut previous_cursor: Local<Option<Vec2>>,
    mut previous_hover: Local<Option<Entity>>,
) {
    // 原生 UI 重建也会产生 Hovered；只用窗口位置变化识别真实鼠标导航，避免抢走键盘焦点。
    // 底层位置只区分悬停来源，键盘与手柄动作仍由 Enhanced Input 处理，点击仍用 Interaction。
    let cursor = windows.single().ok().and_then(Window::cursor_position);
    let pointer_moved = cursor != *previous_cursor;
    *previous_cursor = cursor;
    if menu.page == MenuPage::Hidden {
        *previous_hover = None;
        return;
    }
    // 移到空白或离开窗口也切回鼠标模式，避免上次鼠标序号继续被画成键盘焦点。
    if pointer_moved {
        *source = MenuInputSource::Pointer;
    }
    let hovered = buttons
        .iter()
        .find_map(|(entity, _, interaction)| (*interaction != Interaction::None).then_some(entity));
    for (entity, button, interaction) in &buttons {
        match *interaction {
            Interaction::Hovered if pointer_moved => {
                focus.0 = button.index;
                // 同一按钮内移动、点击释放与新页面初始悬停都不重复发出焦点音。
                if *previous_hover != Some(entity) && !interaction.is_added() {
                    sounds.write(SoundRequest::new(SoundCue::MenuHover, entity));
                }
            }
            Interaction::Pressed if interaction.is_changed() => {
                *source = MenuInputSource::Pointer;
                focus.0 = button.index;
                // 滑条使用局部绝对位置生成精确数值，不再通过按钮路径重复生成调整请求。
                if !matches!(button.action, UiAction::Adjust(_, 0)) {
                    requests.write(UiRequest(button.action));
                }
            }
            _ => {}
        }
    }
    *previous_hover = hovered;
}

#[cfg(test)]
#[path = "pointer_tests.rs"]
mod tests;
