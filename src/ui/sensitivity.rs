//! 原生文本输入负责光标、选择与粘贴；草稿保存百分比文本，应用时才转换为相机参数。

use super::{theme::*, widgets::*, *};
use bevy::{
    input::InputSystems,
    input_focus::{InputFocus, InputFocusSystems, tab_navigation::TabIndex},
    text::{EditableText, FontSourceTemplate, TextCursorStyle, TextEditChange},
    ui_widgets::{SelectAllOnFocus, TextInput},
};
use bevy_enhanced_input::prelude::EnhancedInputSystems;

/// 标记灵敏度编辑节点，限定草稿同步和输入归属的查询范围。
#[derive(Component, Clone, Default)]
pub(super) struct SensitivityInput;

/// 在原生输入分发前记录编辑归属，避免同帧焦点变化让菜单动作穿透。
#[derive(Resource, Default)]
pub(super) struct SensitivityEditing {
    pub active: bool,
}

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
        .add_systems(Update, sync_text.in_set(UiSystems::Style));
}

pub(super) fn sensitivity_row(theme: &UiTheme, draft: &SettingsDraft) -> impl Scene + use<> {
    let mut editable = EditableText::new(&draft.mouse_sensitivity_percent);
    editable.max_characters = Some(64);
    bsn! {
        Name("Setting row: Mouse Sensitivity")
        Node {
            width: percent(100),
            min_height: px(theme.size(60.0)),
            padding: px(theme.size(10.0)),
            border_radius: BorderRadius::all(px(7)),
            align_items: AlignItems::Center,
            column_gap: px(theme.size(9.0)),
            flex_wrap: FlexWrap::Wrap,
            row_gap: px(theme.size(8.0)),
        }
        BackgroundColor(SUBTLE)
        Children [
            @label(theme, "Mouse Sensitivity", 21.0, INK)
            Node { flex_grow: 1.0 }
            --
            Name("Mouse sensitivity controls")
            Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
            Children [
                Name("Mouse sensitivity percentage input")
                SensitivityInput
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
                MenuButton { action: UiAction::EditSensitivity, index: 4 }
                SettingDescription {
                    title: "Mouse Sensitivity",
                    body: "Type a positive percentage. 100% is the default sensitivity. Enter finishes editing; Apply saves your changes. Esc discards unapplied settings.",
                }
                Node {
                    width: px(theme.size(190.0)),
                    min_height: px(theme.size(49.0)),
                    padding: px(theme.size(9.0)),
                    border: px(2),
                    border_radius: BorderRadius::all(px(7)),
                    overflow: Overflow::clip(),
                }
                BackgroundColor(PAPER)
                BorderColor::all(CREAM)
                --
                @label(theme, "%", 20.0, INK)
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
        if draft.mouse_sensitivity_percent != value {
            draft.mouse_sensitivity_percent = value;
            menu.status = None;
        }
    }
}

fn sync_text(
    draft: Res<SettingsDraft>,
    mut inputs: Query<&mut EditableText, With<SensitivityInput>>,
) {
    if !draft.is_changed() {
        return;
    }
    for mut text in &mut inputs {
        if text.value().to_string() != draft.mouse_sensitivity_percent {
            // 恢复默认只替换现有编辑缓冲，不重建控件或保留尚未执行的旧编辑。
            *text = EditableText::new(&draft.mouse_sensitivity_percent);
            text.max_characters = Some(64);
        }
    }
}
