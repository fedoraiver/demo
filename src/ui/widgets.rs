//! BSN 控件只声明实体结构；按钮行为由菜单输入与请求系统处理。

use bevy::{input::mouse::MouseScrollUnit, prelude::*, text::FontSourceTemplate};

use super::{MenuButton, SettingKey, UiAction, theme::*};

/// 说明文本属于按钮实体，焦点变化时只更新右侧说明，不重建页面。
#[derive(Component, Default, Clone)]
pub(super) struct SettingDescription {
    pub title: &'static str,
    pub body: &'static str,
}

/// 可滚动区域的标记；用于键盘导航时把当前按钮滚入视野。
#[derive(Component, Default, Clone)]
pub(super) struct MenuScroll;

/// 用于图形和文字的标准间距，不承担输入或跨实体行为。
pub(super) fn column(gap: f32) -> Node {
    Node {
        flex_direction: FlexDirection::Column,
        row_gap: px(gap),
        min_width: px(0),
        ..default()
    }
}

pub(super) fn label(
    theme: &UiTheme,
    value: impl Into<String>,
    size: f32,
    color: Color,
) -> impl Scene {
    let value = value.into();
    bsn! {
        Text(value)
        TextFont {
            font: {FontSourceTemplate::Handle(theme.body.clone().into())},
            font_size: px(theme.size(size).max(14.0)),
        }
        TextColor(color)
        // 文字保留自动最小宽度；显式设为 0 会让 Bevy 0.19 把横排测量宽度也解析成 0。
        Node { flex_shrink: 1.0 }
    }
}

pub(super) fn heading(
    theme: &UiTheme,
    value: impl Into<String>,
    size: f32,
    color: Color,
) -> impl Scene {
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

pub(super) fn paper_panel(theme: &UiTheme) -> impl Scene {
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
        template_value(paper_shadow(theme.scale))
    }
}

/// 图标、文字和右侧箭头保持独立节点，长菜单名称可以正常换行。
pub(super) fn menu_button(
    theme: &UiTheme,
    title: &'static str,
    icon: &'static str,
    action: UiAction,
    index: usize,
) -> impl Scene {
    bsn! {
        Button
        template_value(MenuButton { action, index })
        Node {
            width: percent(100),
            min_height: px(theme.size(69.0)),
            padding: UiRect::axes(px(theme.size(20.0)), px(theme.size(13.0))),
            border: px(2),
            border_radius: BorderRadius::all(px(8)),
            align_items: AlignItems::Center,
            column_gap: px(theme.size(18.0)),
            flex_shrink: 0.0,
        }
        BackgroundColor(PAPER)
        BorderColor::all(CREAM)
        template_value(paper_shadow(theme.scale))
        Children [
            (
                Node {
                    width: px(theme.size(36.0)),
                    justify_content: JustifyContent::Center,
                    flex_shrink: 0.0,
                }
                Children [heading(theme, icon, 31.0, INK)]
            ),
            (
                label(theme, title, 27.0, INK)
                Node { flex_grow: 1.0 }
            ),
            heading(theme, ">", 24.0, INK),
        ]
    }
}

pub(super) fn small_button(
    theme: &UiTheme,
    title: &'static str,
    action: UiAction,
    index: usize,
) -> impl Scene {
    bsn! {
        Button
        template_value(MenuButton { action, index })
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
        template_value(paper_shadow(theme.scale))
        Children [label(theme, title, 21.0, INK)]
    }
}

/// 未接通的功能不带 Button 或 MenuButton，避免鼠标和键盘误触发。
pub(super) fn placeholder_row(theme: &UiTheme, title: &'static str, menu: bool) -> impl Scene {
    bsn! {
        Node {
            width: percent(100),
            min_height: px(theme.size(if menu { 69.0 } else { 56.0 })),
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
            (
                label(theme, title, if menu { 25.0 } else { 20.0 }, MUTED)
                Node { flex_grow: 1.0 }
            ),
            (
                Node {
                    padding: UiRect::axes(px(theme.size(8.0)), px(theme.size(4.0))),
                    border_radius: BorderRadius::all(px(4)),
                }
                BackgroundColor(Color::srgba(0.39, 0.42, 0.46, 0.13))
                Children [label(theme, "Coming Soon", 14.0, MUTED)]
            ),
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
) -> impl Scene {
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
            (
                label(theme, title, 21.0, INK)
                Node { flex_grow: 1.0, min_width: px(theme.size(130.0)) }
            ),
            (
                Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
                Children [
                    (
                        small_button(theme, "<", UiAction::Adjust(key, -1), index)
                        template_value(details.clone())
                        Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)) }
                    ),
                    (
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
                        Children [label(theme, value, 20.0, INK)]
                    ),
                    (
                        small_button(theme, ">", UiAction::Adjust(key, 1), index + 1)
                        template_value(details)
                        Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)) }
                    ),
                ]
            ),
        ]
    }
}

pub(super) fn keycap(theme: &UiTheme, key: &'static str, light: bool) -> impl Scene {
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
        Children [label(theme, key, 17.0, color)]
    }
}

/// 纸箱标志由普通 UI 节点组合，避免把品牌和按钮文字烘焙进图片。
pub(super) fn parcel_stamp(theme: &UiTheme) -> impl Scene {
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
            (
                Node {
                    position_type: PositionType::Absolute,
                    top: px(0),
                    width: percent(30),
                    height: percent(40),
                }
                BackgroundColor(Color::srgb(0.91, 0.71, 0.42))
            ),
            (
                Node {
                    width: percent(40),
                    height: px(theme.size(6.0)),
                    margin: UiRect::top(px(theme.size(12.0))),
                    border_radius: BorderRadius::all(px(2)),
                }
                BackgroundColor(INK)
            ),
        ]
    }
}

pub(super) fn logo(theme: &UiTheme, compact: bool) -> impl Scene {
    let title_size = if compact { 50.0 } else { 73.0 };
    bsn! {
        template_value(column(theme.size(3.0)))
        Children [
            (
                Node { align_items: AlignItems::Center, column_gap: px(theme.size(12.0)) }
                Children [
                    parcel_stamp(theme),
                    label(theme, "ISLAND DELIVERY CO.", 15.0, CREAM),
                ]
            ),
            (
                heading(theme, "ISLAND", title_size, CREAM)
                TextShadow { offset: {Vec2::new(3.0, 4.0)}, color: INK }
            ),
            (
                heading(theme, "COURIER", title_size, GOLD)
                TextShadow { offset: {Vec2::new(3.0, 4.0)}, color: INK }
            ),
            (
                label(theme, "SMALL ISLAND. BIG DELIVERIES.", 16.0, CREAM)
                TextShadow { offset: {Vec2::new(1.0, 2.0)}, color: INK }
                Node { margin: UiRect::top(px(theme.size(7.0))) }
            ),
        ]
    }
}

/// 鼠标滚轮使用 Bevy UI 的指针事件；不另行读取底层滚轮，避免重复滚动。
pub(super) fn scroll_area(theme: &UiTheme) -> impl Scene {
    bsn! {
        MenuScroll
        Node {
            flex_direction: FlexDirection::Column,
            width: percent(100),
            min_height: px(0),
            flex_grow: 1.0,
            // 在页面根的纵向布局中只占剩余高度，页脚始终留在可视区域。
            flex_basis: px(0),
            overflow: Overflow::scroll_y(),
            row_gap: px(theme.size(18.0)),
            padding: px(theme.size(5.0)),
        }
        ScrollPosition(Vec2::ZERO)
        on(scroll_menu)
    }
}

fn scroll_menu(
    mut event: On<Pointer<Scroll>>,
    mut areas: Query<(&mut ScrollPosition, &ComputedNode), With<MenuScroll>>,
) {
    let Ok((mut position, node)) = areas.get_mut(event.entity) else {
        return;
    };
    let delta = match event.unit {
        MouseScrollUnit::Line => event.y * 32.0,
        MouseScrollUnit::Pixel => event.y,
    };
    let range = (node.content_size().y - node.size().y).max(0.0) * node.inverse_scale_factor();
    position.y = (position.y - delta).clamp(0.0, range);
    event.propagate(false);
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::{
        app::{HierarchyPropagatePlugin, PropagateSet},
        asset::{AssetEventSystems, AssetPlugin},
        camera::{ComputedCameraValues, RenderTargetInfo, Viewport},
        scene::ScenePlugin,
        text::{
            TextLayoutInfo, TextPlugin, detect_text_needs_rerender,
            load_font_assets_into_font_collection,
        },
        ui::{
            ui_layout_system,
            ui_surface::UiSurface,
            update::propagate_ui_target_cameras,
            widget::{measure_text_system, text_system},
        },
    };

    /// 使用真实字体测量与字形布局；虚拟相机只提供尺寸，不安装窗口或渲染器。
    fn layout_app() -> App {
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            AssetPlugin::default(),
            ScenePlugin,
            TextPlugin,
            HierarchyPropagatePlugin::<ComputedUiTargetCamera>::new(PostUpdate),
            HierarchyPropagatePlugin::<ComputedUiRenderTargetInfo>::new(PostUpdate),
        ))
        .init_asset::<Image>()
        .init_resource::<UiScale>()
        .init_resource::<UiSurface>()
        .add_systems(
            PostUpdate,
            (
                propagate_ui_target_cameras,
                measure_text_system
                    .after(load_font_assets_into_font_collection)
                    .after(detect_text_needs_rerender),
                ui_layout_system,
                text_system.before(AssetEventSystems),
            )
                .chain(),
        )
        .configure_sets(
            PostUpdate,
            PropagateSet::<ComputedUiTargetCamera>::default()
                .after(propagate_ui_target_cameras)
                .before(measure_text_system),
        )
        .configure_sets(
            PostUpdate,
            PropagateSet::<ComputedUiRenderTargetInfo>::default()
                .after(propagate_ui_target_cameras)
                .before(measure_text_system),
        );
        let size = UVec2::new(900, 900);
        app.world_mut().spawn((
            Camera2d,
            IsDefaultUiCamera,
            Camera {
                computed: ComputedCameraValues {
                    target_info: Some(RenderTargetInfo {
                        physical_size: size,
                        scale_factor: 1.0,
                    }),
                    ..default()
                },
                viewport: Some(Viewport {
                    physical_size: size,
                    ..default()
                }),
                ..default()
            },
        ));
        app.finish();
        app.cleanup();
        app
    }

    #[test]
    fn bsn_row_text_keeps_intrinsic_width_and_column_text_wraps() {
        let mut app = layout_app();
        // TextPlugin 的内嵌字体是真实字体，避免测试依赖本机的外部美术资产。
        let theme = UiTheme {
            heading: default(),
            body: default(),
            scale: 1.0,
        };
        const PARAGRAPH: &str = "Move around the island with WASD. Jump with Space. Carry a parcel to explore a new route and make your next delivery.";
        app.world_mut()
            .spawn_scene(bsn! {
                template_value(column(12.0))
                Node { width: percent(100), height: percent(100), padding: px(16) }
                Children [
                    (
                        Node { column_gap: px(12), align_items: AlignItems::Center }
                        Children [
                            small_button(&theme, "Restore Defaults", UiAction::RestoreDefaults, 0),
                            small_button(&theme, "Apply", UiAction::ApplySettings, 1),
                            small_button(&theme, "Back", UiAction::Back, 2),
                        ]
                    ),
                    setting_row(&theme, "Frame Rate Limit", "60 FPS".into(), SettingKey::FrameRate, 3, "Adjust the maximum frame rate."),
                    placeholder_row(&theme, "Window Mode", false),
                    (
                        Node { column_gap: px(9), align_items: AlignItems::Center }
                        Children [
                            keycap(&theme, "Arrows", true),
                            label(&theme, "Navigate", 17.0, CREAM),
                            keycap(&theme, "Enter", true),
                            label(&theme, "Confirm", 17.0, CREAM),
                            keycap(&theme, "Esc", true),
                            label(&theme, "Back", 17.0, CREAM),
                            keycap(&theme, "WASD", false),
                            keycap(&theme, "Space", false),
                            keycap(&theme, "E", false),
                        ]
                    ),
                    (
                        Node { column_gap: px(9), align_items: AlignItems::Center }
                        Children [
                            (
                                Node { width: px(49), height: px(49), align_items: AlignItems::Center, justify_content: JustifyContent::Center }
                                BackgroundColor(GOLD)
                                Children [heading(&theme, "01", 26.0, INK)]
                            ),
                            heading(&theme, "MOVE & JUMP", 27.0, INK),
                        ]
                    ),
                    (
                        Node { column_gap: px(9), align_items: AlignItems::Center }
                        Children [
                            parcel_stamp(&theme),
                            label(&theme, "ISLAND DELIVERY CO.", 15.0, CREAM),
                        ]
                    ),
                    (
                        template_value(column(8.0))
                        Node { width: px(240), padding: px(12), flex_shrink: 0.0 }
                        Children [heading(&theme, "HOW TO PLAY", 25.0, INK), label(&theme, PARAGRAPH, 18.0, INK)]
                    ),
                ]
            })
            .unwrap();
        // 资产事件首帧进入字体集合，后续更新完成实际字形与布局计算。
        for _ in 0..3 {
            app.update();
        }
        let world = app.world_mut();
        let mut texts = world.query::<(&Text, &ComputedNode, &TextLayoutInfo)>();
        let invisible: Vec<_> = texts
            .iter(world)
            .filter(|(_, node, layout)| {
                node.size().x <= 0.0 || node.size().y <= 0.0 || layout.glyphs.is_empty()
            })
            .map(|(text, node, layout)| (text.0.as_str(), node.size(), layout.glyphs.len()))
            .collect();
        assert!(
            invisible.is_empty(),
            "Text needs visible layout: {invisible:?}"
        );
        let (_, paragraph, glyphs) = texts
            .iter(world)
            .find(|(text, _, _)| text.0 == PARAGRAPH)
            .unwrap();
        assert!(paragraph.size().x <= 216.0);
        assert!(
            paragraph.size().y > 36.0,
            "Description must wrap into multiple lines"
        );
        assert!(!glyphs.glyphs.is_empty());
    }
}
