//! 灵敏度倍率的原生数字输入与失焦提交；滑条复用设置公共捕获路径。

use super::{slider::slider_control, theme::*, widgets::*, *};
use crate::settings::MAX_MOUSE_SENSITIVITY_MULTIPLIER;
use bevy::{
    clipboard::Clipboard,
    text::{FontCx, LayoutCx},
    ui_widgets::ImeSystems,
};
use bevy::{
    input::InputSystems,
    input_focus::{InputFocus, InputFocusSystems, tab_navigation::TabIndex},
    text::{
        EditableText, EditableTextSystems, FontSourceTemplate, TextCursorStyle, TextEdit,
        TextEditChange,
    },
    ui_widgets::{SelectAllOnFocus, TextInput},
    window::PrimaryWindow,
};
use bevy_enhanced_input::prelude::EnhancedInputSystems;

/// 输入节点保留上一帧实际焦点，失焦后才规范文本，避免每帧覆写未完成编辑。
#[derive(Component, Clone, Default)]
pub(super) struct SensitivityInput {
    pub was_focused: bool,
}

/// 在原生输入分发前记录编辑归属，避免同帧焦点变化让菜单动作穿透。
#[derive(Resource, Default)]
pub(super) struct SensitivityEditing {
    pub active: bool,
}

pub(super) const INPUT_ERROR: &str = "Enter a mouse sensitivity from 0.00 to 10.00.";

pub(super) fn register(app: &mut App) {
    app.init_resource::<InputFocus>()
        .init_resource::<SensitivityEditing>()
        .add_observer(on_text_change)
        .add_systems(
            PreUpdate,
            capture_editing
                .after(InputSystems)
                .before(InputFocusSystems::Dispatch)
                .before(EnhancedInputSystems::Prepare),
        )
        .add_systems(
            PreUpdate,
            apply_pending_input
                .after(InputFocusSystems::Dispatch)
                .after(ImeSystems::HandleEvents),
        )
        .add_systems(Update, sync_text.in_set(UiSystems::Style))
        .add_systems(
            PostUpdate,
            normalize_blurred_text
                .after(EditableTextSystems)
                .before(bevy::ui::widget::update_editable_text_layout),
        );
}

pub(super) fn sensitivity_row(theme: &UiTheme, draft: &SettingsDraft) -> impl Scene + use<> {
    let mut editable = EditableText::new(&draft.mouse_sensitivity_text);
    let gap = theme.size(8.0);
    editable.max_characters = Some(64);
    let details = SettingDescription {
        title: "Mouse Sensitivity",
        body: "Drag the slider or type a value from 0.00 to 10.00. 1.00 is the default; 0.00 stops mouse look. Enter finishes editing; Apply saves your changes. Esc discards unapplied settings.",
    };
    let fill =
        draft.sensitivity_multiplier().unwrap_or(1.0) / MAX_MOUSE_SENSITIVITY_MULTIPLIER * 100.0;
    bsn! {
        Name("Setting row: Mouse Sensitivity")
        column(gap)
        Node { width: percent(100), padding: px(theme.size(10.0)), border_radius: BorderRadius::all(px(7)), flex_shrink: 0.0 }
        BackgroundColor(SUBTLE)
        Children [
            @label(theme, "Mouse Sensitivity", 21.0, INK)
            --
            Name("Mouse sensitivity controls")
            Node { width: percent(100), align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
            Children [
                @slider_control(theme, SettingKey::MouseSensitivity, 4, fill, details)
                Node { min_height: px(theme.size(49.0)) }
                --
                Name("Mouse sensitivity numeric input")
                SensitivityInput::default()
                TextInput
                editable
                SelectAllOnFocus
                TabIndex(-1)
                TextCursorStyle { color: INK }
                TextFont {
                    font: {FontSourceTemplate::Handle(theme.body.clone().into())},
                    font_size: px(theme.size(20.0).max(MIN_FONT_SIZE_PX)),
                }
                TextColor(INK)
                MenuButton { action: UiAction::EditSensitivity, index: 5 }
                details
                Node {
                    width: px(theme.size(96.0)), min_width: px(theme.size(96.0)), flex_shrink: 0.0,
                    min_height: px(theme.size(49.0)), padding: px(theme.size(9.0)),
                    border: px(2), border_radius: BorderRadius::all(px(7)), overflow: Overflow::clip(),
                }
                BackgroundColor(PAPER)
                BorderColor::all(CREAM)
            ]
        ]
    }
}

fn capture_editing(
    focus: Res<InputFocus>,
    inputs: Query<(), With<SensitivityInput>>,
    mut editing: ResMut<SensitivityEditing>,
) {
    editing.active = focus.get().is_some_and(|entity| inputs.contains(entity));
}

fn on_text_change(
    event: On<TextEditChange>,
    inputs: Query<&EditableText, With<SensitivityInput>>,
    mut draft: ResMut<SettingsDraft>,
    mut menu: ResMut<MenuState>,
) {
    if let Ok(text) = inputs.get(event.event_target()) {
        let value = text.value().to_string();
        if value != draft.mouse_sensitivity_text && draft.set_sensitivity_text(value) {
            menu.status = None;
        }
    }
}

/// 仅将本控件的原生编辑提前到菜单提交和本帧布局之前，不重复解释键盘或 IME。
/// 最小菜单夹具没有文字设施时不处理；正式 DefaultPlugins 提供这些原生资源。
pub(super) fn apply_pending_input(
    mut inputs: Query<&mut EditableText, With<SensitivityInput>>,
    mut font_context: Option<ResMut<FontCx>>,
    mut layout_context: Option<ResMut<LayoutCx>>,
    mut clipboard: Option<ResMut<Clipboard>>,
    mut draft: ResMut<SettingsDraft>,
    mut menu: ResMut<MenuState>,
) {
    let (Some(ref mut fonts), Some(ref mut layout), Some(ref mut clipboard)) = (
        font_context.as_mut(),
        layout_context.as_mut(),
        clipboard.as_mut(),
    ) else {
        return;
    };
    for mut text in &mut inputs {
        if text.pending_edits.is_empty() && text.pending_paste.is_none() {
            continue;
        }
        let before = text.value().to_string();
        text.apply_pending_edits(fonts, &mut layout.0, clipboard, &|_| true);
        let value = text.value().to_string();
        if value != before && draft.set_sensitivity_text(value) {
            menu.status = None;
        }
    }
}

/// 保留同一编辑器的字体和缩放，同时取消旧编辑或尚未完成的粘贴。
fn replace_text(text: &mut EditableText, value: &str) {
    text.clear();
    text.editor_mut().set_text(value);
    text.queue_edit(TextEdit::TextEnd(false));
}

fn sync_text(
    draft: Res<SettingsDraft>,
    mut inputs: Query<&mut EditableText, With<SensitivityInput>>,
) {
    if !draft.is_changed() {
        return;
    }
    for mut text in &mut inputs {
        if text.value().to_string() != draft.mouse_sensitivity_text {
            replace_text(&mut text, &draft.mouse_sensitivity_text);
        }
    }
}

/// 原生编辑在 PostUpdate 应用后再处理失焦，合法完成才规范两位。
pub(super) fn normalize_blurred_text(
    focus: Res<InputFocus>,
    windows: Query<&Window, With<PrimaryWindow>>,
    mut inputs: Query<(Entity, &mut SensitivityInput, &mut EditableText)>,
    mut draft: ResMut<SettingsDraft>,
    mut menu: ResMut<MenuState>,
) {
    let window_focused = windows.single().is_ok_and(|window| window.focused);
    for (entity, mut input, mut text) in &mut inputs {
        let focused = window_focused && focus.get() == Some(entity);
        if input.was_focused && !focused {
            if text.is_composing() || text.pending_paste.is_some() {
                continue;
            }
            if draft.normalize_sensitivity() {
                replace_text(&mut text, &draft.mouse_sensitivity_text);
            } else {
                menu.status = Some(INPUT_ERROR.into());
            }
        }
        input.was_focused = focused;
    }
}
