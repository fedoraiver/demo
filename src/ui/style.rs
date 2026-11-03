//! 样式、设置文本、说明与音量预览都读取当前草稿，不重建实体。

use super::{
    pages::{DEFAULT_SETTINGS_STATUS, DescriptionBody, DescriptionTitle, SettingsStatus},
    pointer::PrimaryPress,
    theme::*,
    widgets::*,
    *,
};
use crate::{
    audio::AudioPreview,
    settings::{DEFAULT_MOUSE_SENSITIVITY, SettingsDraft},
};
use bevy::{picking::hover::Hovered, prelude::*, ui::Pressed};

pub(super) fn register(app: &mut App) {
    app.add_systems(
        Update,
        (
            style_buttons,
            update_settings_text,
            update_description,
            publish_audio_preview,
            super::scroll::scroll_focused_button,
        )
            .in_set(UiSystems::Style),
    );
}

fn publish_audio_preview(
    menu: Res<MenuState>,
    draft: Res<SettingsDraft>,
    mut preview: ResMut<AudioPreview>,
) {
    preview.set_if_neq(AudioPreview {
        settings: (menu.page == MenuPage::Settings).then_some(draft.audio),
    });
}

pub(super) fn style_buttons(
    focus: Res<MenuFocus>,
    source: Res<MenuInputSource>,
    mut buttons: Query<(
        &MenuButton,
        &Hovered,
        Has<Pressed>,
        Has<PrimaryPress>,
        &mut BackgroundColor,
        &mut BorderColor,
    )>,
) {
    for (button, hovered, pressed, primary, mut background, mut border) in &mut buttons {
        // 只显示当前输入来源的焦点；分类和 Apply 也在鼠标离开后恢复普通纸色。
        let focused = match *source {
            MenuInputSource::Pointer => hovered.0 || (pressed && primary),
            MenuInputSource::Navigation => button.index == focus.index,
        };
        let color = if pressed && primary {
            Color::srgb(0.94, 0.65, 0.20)
        } else if focused {
            GOLD
        } else {
            PAPER
        };
        let edge = if focused { INK } else { CREAM };
        // 只在颜色确有改变时写入，减少 Bevy UI 的无效变化与重绘。
        if background.0 != color {
            background.0 = color;
        }
        if *border != BorderColor::all(edge) {
            *border = BorderColor::all(edge);
        }
    }
}

/// 初次装配与实时更新共用格式，确保显示值始终来自同一份设置草稿。
pub(super) fn setting_value(draft: &SettingsDraft, key: SettingKey) -> String {
    match key {
        SettingKey::FrameRate => format!("{} FPS", draft.max_fps),
        SettingKey::MouseSensitivity => format!(
            "{:.0}%",
            draft.mouse_sensitivity / DEFAULT_MOUSE_SENSITIVITY * 100.0
        ),
        SettingKey::InvertY => if draft.invert_y { "On" } else { "Off" }.into(),
        // 音量控件由 volume 模块更新，此处仍保持枚举格式匹配完整。
        key @ (SettingKey::MasterVolume | SettingKey::SfxVolume | SettingKey::UiVolume) => {
            format!("{}%", draft.volume(key).unwrap())
        }
    }
}

fn update_settings_text(
    draft: Res<SettingsDraft>,
    state: Res<MenuState>,
    mut text: Query<
        (&mut Text, Option<&SettingValue>),
        Or<(With<SettingValue>, With<SettingsStatus>)>,
    >,
) {
    if !draft.is_changed() && !state.is_changed() {
        return;
    }
    for (mut text, key) in &mut text {
        let value = key.map_or_else(
            || {
                state
                    .status
                    .as_deref()
                    .unwrap_or(DEFAULT_SETTINGS_STATUS)
                    .to_owned()
            },
            |key| setting_value(&draft, key.key),
        );
        if text.0 != value {
            text.0 = value;
        }
    }
}

fn update_description(
    focus: Res<MenuFocus>,
    buttons: Query<(&MenuButton, &SettingDescription)>,
    mut text: Query<
        (&mut Text, Has<DescriptionTitle>),
        Or<(With<DescriptionTitle>, With<DescriptionBody>)>,
    >,
) {
    let details = buttons
        .iter()
        .find_map(|(button, details)| (button.index == focus.index).then_some(details));
    let Some(details) = details else {
        return;
    };
    for (mut text, title) in &mut text {
        let value = if title { details.title } else { details.body };
        if text.0 != value {
            text.0 = value.into();
        }
    }
}
