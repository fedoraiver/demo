//! 音量行装配与数值文字同步，滑条交互由公共设置控件负责。

use bevy::prelude::*;

use crate::settings::SettingsDraft;

use super::{SettingKey, UiAction, UiSystems, slider::slider_control, theme::*, widgets::*};

/// 数字保存设置键，草稿更新不需要重建实体树。
#[derive(Component, Clone)]
struct VolumeValue {
    key: SettingKey,
}

impl Default for VolumeValue {
    fn default() -> Self {
        Self {
            key: SettingKey::MasterVolume,
        }
    }
}

pub(super) fn register(app: &mut App) {
    app.add_systems(
        Update,
        update_volume_visuals
            .after(UiSystems::Build)
            .after(UiSystems::Pointer)
            .before(UiSystems::Style),
    );
}

/// 0% 明确显示静音；其余数字保留自然文字测量。
fn volume_text(value: u8) -> String {
    if value == 0 {
        "Muted".into()
    } else {
        format!("{value}%")
    }
}

/// 三个导航目标依次为减少、滑条与增加；窄面板允许整组自然换行。
pub(super) fn volume_row(
    theme: &UiTheme,
    title: &'static str,
    value: u8,
    key: SettingKey,
    index: usize,
    description: &'static str,
) -> impl Scene {
    let scale = theme.scale;
    let details = SettingDescription {
        title,
        body: description,
    };
    bsn! {
        Name({format!("Volume row: {title}")})
        column(8.0 * scale)
        Node {
            width: percent(100),
            padding: px(theme.size(10.0)),
            border_radius: BorderRadius::all(px(7)),
            flex_shrink: 0.0,
        }
        BackgroundColor(SUBTLE)
        Children [
            @label(theme, title, 21.0, INK)
            --
            Name("Volume controls")
            Node {
                width: percent(100),
                align_items: AlignItems::Center,
                column_gap: px(theme.size(8.0)),
                row_gap: px(theme.size(8.0)),
                flex_wrap: FlexWrap::Wrap,
            }
            Children [
                @small_button(theme, "<", UiAction::Adjust(key, -1), index)
                details
                Node { padding: px(theme.size(7.0)), min_width: px(theme.size(SETTING_ARROW_MIN_WIDTH_PX)), flex_shrink: 0.0 }
                --
                @slider_control(theme, key, index + 1, f32::from(value), details)
                --
                @small_button(theme, ">", UiAction::Adjust(key, 1), index + 2)
                details
                Node { padding: px(theme.size(7.0)), min_width: px(theme.size(SETTING_ARROW_MIN_WIDTH_PX)), flex_shrink: 0.0 }
                --
                Name("Volume value display")
                Node {
                    width: px(theme.size(64.0)),
                    min_height: px(theme.size(SETTING_CONTROL_MIN_HEIGHT_PX)),
                    align_items: AlignItems::Center,
                    justify_content: JustifyContent::Center,
                    flex_shrink: 0.0,
                }
                Children [
                    @label(theme, volume_text(value), 20.0, INK)
                    Name("Volume value label")
                    VolumeValue { key }
                ]
            ]
        ]
    }
}

/// 草稿由请求系统在 PreUpdate 修改，随后同帧更新已有数值文字。
fn update_volume_visuals(draft: Res<SettingsDraft>, mut values: Query<(&VolumeValue, &mut Text)>) {
    if !draft.is_changed() {
        return;
    }
    for (key, mut text) in &mut values {
        if let Some(value) = draft.volume(key.key) {
            let value = volume_text(value);
            if text.0 != value {
                text.0 = value;
            }
        }
    }
}
