//! 共享 BSN 控件只声明实体结构；交互、滚动与视觉刷新由各自系统承担。
//! Scene 拥有已复制的组件与句柄，精确捕获避免 Rust 2024 延长参数借用。

use super::{MenuButton, SettingKey, UiAction, theme::*};
use bevy::{prelude::*, text::FontSourceTemplate};

/// 说明文本属于按钮实体，焦点变化时只更新右侧说明，不重建页面。
#[derive(Component, Default, Clone, Copy)]
pub(super) struct SettingDescription {
    pub title: &'static str,
    pub body: &'static str,
}

/// 数值文字只保存对应字段；草稿变化时原位更新 Text，不销毁滚动区域和焦点实体。
#[derive(Component, Clone)]
pub(super) struct SettingValue {
    pub key: SettingKey,
}

impl Default for SettingValue {
    fn default() -> Self {
        // BSN 模板需要组件初值；setting_row 装配时始终用实际字段 key 覆盖它。
        Self {
            key: SettingKey::FrameRate,
        }
    }
}

/// 用于图形和文字的标准间距，不承担输入或跨实体行为。
pub(super) fn column(gap: f32) -> Node {
    Node {
        flex_direction: FlexDirection::Column,
        row_gap: px(gap),
        min_width: px(0),
        ..default()
    }
}

pub(super) fn label<Value: Into<String>>(
    theme: &UiTheme,
    value: Value,
    size: f32,
    color: Color,
) -> impl Scene + use<Value> {
    let value = value.into();
    bsn! {
        Text(value)
        TextFont {
            font: {FontSourceTemplate::Handle(theme.body.clone().into())},
            font_size: px(theme.size(size).max(14.0)),
        }
        TextColor(color)
        // 文字保留自然测量宽度，横排短标签与纵排正文共用同一布局规则。
        Node { flex_shrink: 1.0 }
    }
}

pub(super) fn heading<Value: Into<String>>(
    theme: &UiTheme,
    value: Value,
    size: f32,
    color: Color,
) -> impl Scene + use<Value> {
    let value = value.into();
    bsn! {
        Text(value)
        TextFont {
            font: {FontSourceTemplate::Handle(theme.heading.clone().into())},
            font_size: px(theme.size(size).max(14.0)),
        }
        TextColor(color)
        Node { flex_shrink: 1.0 }
    }
}

pub(super) fn paper_panel(theme: &UiTheme) -> impl Scene + use<> {
    let scale = theme.scale;
    bsn! {
        Node {
            padding: px(theme.size(24.0)),
            border: px(2),
            border_radius: BorderRadius::all(px(10)),
            flex_direction: FlexDirection::Column,
            row_gap: px(theme.size(18.0)),
            min_width: px(0),
        }
        BackgroundColor(PAPER)
        BorderColor::all(CREAM)
        paper_shadow(scale)
    }
}

/// 图标、文字和右侧箭头保持独立节点，长菜单名称可以正常换行。
pub(super) fn menu_button(
    theme: &UiTheme,
    title: &'static str,
    icon: &'static str,
    action: UiAction,
    index: usize,
) -> impl Scene + use<> {
    menu_button_with_size(theme, title, icon, action, index, false)
}

/// 固定菜单用较紧凑的按钮预算，设置分类仍保留原有尺寸。
pub(super) fn fixed_menu_button(
    theme: &UiTheme,
    title: &'static str,
    icon: &'static str,
    action: UiAction,
    index: usize,
) -> impl Scene + use<> {
    menu_button_with_size(theme, title, icon, action, index, true)
}

fn menu_button_with_size(
    theme: &UiTheme,
    title: &'static str,
    icon: &'static str,
    action: UiAction,
    index: usize,
    fixed_menu: bool,
) -> impl Scene + use<> {
    let scale = theme.scale;
    bsn! {
        MenuButton { action, index }
        Node {
            width: percent(100),
            min_height: px(theme.size(if fixed_menu { 52.0 } else { 69.0 })),
            padding: UiRect::axes(
                px(theme.size(if fixed_menu { 18.0 } else { 20.0 })),
                px(theme.size(if fixed_menu { 9.0 } else { 13.0 })),
            ),
            border: px(2),
            border_radius: BorderRadius::all(px(8)),
            align_items: AlignItems::Center,
            column_gap: px(theme.size(if fixed_menu { 14.0 } else { 18.0 })),
            flex_shrink: 0.0,
        }
        BackgroundColor(PAPER)
        BorderColor::all(CREAM)
        paper_shadow(scale)
        Children [
            Node {
                width: px(theme.size(if fixed_menu { 30.0 } else { 36.0 })),
                justify_content: JustifyContent::Center,
                flex_shrink: 0.0,
            }
            Children [
                @heading(theme, icon, if fixed_menu { 27.0 } else { 31.0 }, INK)
            ]
            --
            @label(theme, title, if fixed_menu { 24.0 } else { 27.0 }, INK)
            Node { flex_grow: 1.0 }
            --
            @heading(theme, ">", if fixed_menu { 22.0 } else { 24.0 }, INK)
        ]
    }
}

pub(super) fn small_button(
    theme: &UiTheme,
    title: &'static str,
    action: UiAction,
    index: usize,
) -> impl Scene + use<> {
    let scale = theme.scale;
    bsn! {
        MenuButton { action, index }
        Node {
            min_height: px(theme.size(49.0)),
            min_width: px(0),
            padding: UiRect::axes(px(theme.size(19.0)), px(theme.size(11.0))),
            border: px(2),
            border_radius: BorderRadius::all(px(7)),
            justify_content: JustifyContent::Center,
            align_items: AlignItems::Center,
        }
        BackgroundColor(PAPER)
        BorderColor::all(CREAM)
        paper_shadow(scale)
        Children [
            @label(theme, title, 21.0, INK)
        ]
    }
}

/// 未接通的功能不带 Button 或 MenuButton，避免鼠标和键盘误触发。
pub(super) fn placeholder_row(
    theme: &UiTheme,
    title: &'static str,
    menu: bool,
) -> impl Scene + use<> {
    bsn! {
        Node {
            width: percent(100),
            min_height: px(theme.size(if menu { 52.0 } else { 56.0 })),
            padding: UiRect::axes(px(theme.size(17.0)), px(theme.size(11.0))),
            border: px(1),
            border_radius: BorderRadius::all(px(7)),
            align_items: AlignItems::Center,
            column_gap: px(theme.size(12.0)),
            row_gap: px(theme.size(6.0)),
            flex_wrap: FlexWrap::Wrap,
            flex_shrink: 0.0,
        }
        BackgroundColor({if menu { Color::srgba(0.76, 0.78, 0.79, 0.92) } else { SUBTLE }})
        BorderColor::all(Color::srgba(0.83, 0.84, 0.83, 0.75))
        Children [
            @label(theme, title, if menu { 22.0 } else { 20.0 }, MUTED)
            Node { flex_grow: 1.0 }
            --
            Node {
                padding: UiRect::axes(px(theme.size(8.0)), px(theme.size(4.0))),
                border_radius: BorderRadius::all(px(4)),
            }
            BackgroundColor(Color::srgba(0.39, 0.42, 0.46, 0.13))
            Children [
                @label(theme, "Coming Soon", 14.0, MUTED)
            ]
        ]
    }
}

/// 减少与增加按钮共享设置键，鼠标和键盘均进入同一动作路由。
pub(super) fn setting_row(
    theme: &UiTheme,
    title: &'static str,
    value: String,
    key: SettingKey,
    index: usize,
    description: &'static str,
) -> impl Scene + use<> {
    let details = SettingDescription {
        title,
        body: description,
    };
    bsn! {
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
            @label(theme, title, 21.0, INK)
            Node { flex_grow: 1.0, min_width: px(theme.size(130.0)) }
            --
            Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
            Children [
                @small_button(theme, "<", UiAction::Adjust(key, -1), index)
                details
                Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)) }
                --
                Node {
                    width: px(theme.size(130.0)),
                    min_height: px(theme.size(43.0)),
                    justify_content: JustifyContent::Center,
                    align_items: AlignItems::Center,
                    padding: px(theme.size(5.0)),
                    border: px(1),
                    border_radius: BorderRadius::all(px(5)),
                }
                BackgroundColor(CREAM)
                BorderColor::all(Color::srgba(0.2, 0.25, 0.32, 0.15))
                Children [
                    @label(theme, value, 20.0, INK)
                    SettingValue { key }
                ]
                --
                @small_button(theme, ">", UiAction::Adjust(key, 1), index + 1)
                details
                Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)) }
            ]
        ]
    }
}

pub(super) fn keycap(theme: &UiTheme, key: &'static str, light: bool) -> impl Scene + use<> {
    let color = if light { CREAM } else { INK };
    bsn! {
        Node {
            min_width: px(theme.size(29.0)),
            min_height: px(theme.size(29.0)),
            padding: UiRect::axes(px(theme.size(8.0)), px(theme.size(4.0))),
            border: px(1),
            border_radius: BorderRadius::all(px(4)),
            align_items: AlignItems::Center,
            justify_content: JustifyContent::Center,
        }
        BorderColor::all(color)
        Children [
            @label(theme, key, 17.0, color)
        ]
    }
}

/// 纸箱标志由普通 UI 节点组合，避免把品牌和按钮文字烘焙进图片。
pub(super) fn parcel_stamp(theme: &UiTheme) -> impl Scene + use<> {
    bsn! {
        Node {
            width: px(theme.size(50.0)),
            height: px(theme.size(45.0)),
            border: px(3),
            border_radius: BorderRadius::all(px(4)),
            align_items: AlignItems::Center,
            justify_content: JustifyContent::Center,
        }
        BackgroundColor(Color::srgb(0.75, 0.51, 0.27))
        BorderColor::all(INK)
        Children [
            Node {
                position_type: PositionType::Absolute,
                top: px(0),
                width: percent(30),
                height: percent(40),
            }
            BackgroundColor(Color::srgb(0.91, 0.71, 0.42))
            --
            Node {
                width: percent(40),
                height: px(theme.size(6.0)),
                margin: UiRect::top(px(theme.size(12.0))),
                border_radius: BorderRadius::all(px(2)),
            }
            BackgroundColor(INK)
        ]
    }
}

pub(super) fn logo(theme: &UiTheme, compact: bool) -> impl Scene + use<> {
    let scale = theme.scale;
    // 固定菜单标题留出六行按钮的高度；设置与帮助的小标志保持原样。
    let title_size = if compact { 50.0 } else { 56.0 };
    bsn! {
        column(3.0 * scale)
        Children [
            Node { align_items: AlignItems::Center, column_gap: px(theme.size(12.0)) }
            Children [
                @parcel_stamp(theme)
                --
                @label(theme, "ISLAND DELIVERY CO.", 15.0, CREAM)
            ]
            --
            @heading(theme, "ISLAND", title_size, CREAM)
            TextShadow { offset: {Vec2::new(3.0, 4.0)}, color: INK }
            --
            @heading(theme, "COURIER", title_size, GOLD)
            TextShadow { offset: {Vec2::new(3.0, 4.0)}, color: INK }
            --
            @label(theme, "SMALL ISLAND. BIG DELIVERIES.", 16.0, CREAM)
            TextShadow { offset: {Vec2::new(1.0, 2.0)}, color: INK }
            Node { margin: UiRect::top(px(theme.size(7.0))) }
        ]
    }
}
