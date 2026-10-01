//! 主菜单、暂停、设置与操作说明的 BSN 页面，以及焦点的视觉呈现。

use bevy::{prelude::*, window::PrimaryWindow};

use crate::settings::SettingsDraft;

use super::{
    MenuButton, MenuFocus, MenuInputSource, MenuPage, MenuRoot, MenuState, SettingKey, SettingsTab,
    UiAction, UiSystems, theme::*, widgets::*,
};

#[derive(Component, Default, Clone)]
struct DescriptionTitle;

#[derive(Component, Default, Clone)]
struct DescriptionBody;

pub(super) fn register(app: &mut App) {
    app.init_resource::<UiTheme>()
        .add_systems(Update, rebuild_page.in_set(UiSystems::Build))
        // Build 与 Style 由插件串联，保证新 BSN 子树的延迟命令先应用。
        .add_systems(
            Update,
            (style_buttons, update_description, scroll_focused_button).in_set(UiSystems::Style),
        );
}

/// 页面状态与草稿变化时重建；键盘焦点只更新样式，避免输入实体不断销毁。
fn rebuild_page(
    mut commands: Commands,
    state: Res<MenuState>,
    draft: Res<SettingsDraft>,
    theme: Res<UiTheme>,
    windows: Query<&Window, With<PrimaryWindow>>,
    roots: Query<Entity, With<MenuRoot>>,
    mut previous_width: Local<Option<u32>>,
) {
    let width = windows.single().map_or(1440.0, |window| window.width());
    let width_bucket = width.round() as u32;
    if !state.is_changed() && !draft.is_changed() && *previous_width == Some(width_bucket) {
        return;
    }
    *previous_width = Some(width_bucket);
    for entity in &roots {
        commands.entity(entity).despawn();
    }
    if state.page == MenuPage::Hidden {
        return;
    }
    let theme = theme.for_width(width);
    let compact = width < 1000.0;
    let content: Box<dyn Scene> = match state.page {
        MenuPage::Main => Box::new(main_page(&theme, false)),
        MenuPage::Pause => Box::new(main_page(&theme, true)),
        MenuPage::Settings => Box::new(settings_page(&theme, &state, &draft, compact)),
        MenuPage::Help => Box::new(help_page(&theme, compact)),
        MenuPage::Hidden => unreachable!(),
    };
    // 句柄作为现成组件写入 BSN，spawn_scene 不依赖异步加载任务，旧页面不会复活。
    commands.spawn_scene(bsn! {
        MenuRoot
        GlobalZIndex(100)
        Node {
            width: percent(100),
            height: percent(100),
            flex_direction: FlexDirection::Column,
        }
        BackgroundColor({if state.page == MenuPage::Pause {
            Color::srgba(0.06, 0.10, 0.15, 0.68)
        } else {
            Color::NONE
        }})
        Children [
            ({content}),
            footer(&theme),
        ]
    });
}

fn page_area(theme: &UiTheme) -> impl Scene {
    bsn! {
        scroll_area(theme)
        Node {
            padding: {UiRect::axes(percent(3.5), px(theme.size(32.0)))},
            row_gap: px(theme.size(24.0)),
        }
    }
}

fn main_page(theme: &UiTheme, paused: bool) -> impl Scene {
    let first_title = if paused { "Resume" } else { "Start Game" };
    let first_action = if paused {
        UiAction::Resume
    } else {
        UiAction::StartGame
    };
    let last_title = if paused { "Back to Main Menu" } else { "Quit" };
    let last_action = if paused {
        UiAction::ReturnToMenu
    } else {
        UiAction::Quit
    };
    let tag_title = if paused {
        "TAKE A BREATHER"
    } else {
        "YOUR ISLAND. YOUR ROUTE."
    };
    let tag_body = if paused {
        "Your parcel will be right here."
    } else {
        "A little sunshine. A lot to carry."
    };
    let placeholders: Box<dyn SceneList> = if paused {
        Box::new(bsn_list![])
    } else {
        Box::new(bsn_list![
            placeholder_row(theme, "Continue", true),
            placeholder_row(theme, "Multiplayer", true),
        ])
    };
    bsn! {
        page_area(theme)
        Node { flex_direction: FlexDirection::Row, align_items: AlignItems::FlexStart }
        Children [
            (
                template_value(column(theme.size(30.0)))
                Node {
                    width: percent(32),
                    min_width: px(theme.size(280.0)),
                    max_width: px(theme.size(490.0)),
                    flex_shrink: 0.0,
                }
                Children [
                    logo(theme, false),
                    (
                        template_value(column(theme.size(12.0)))
                        Children [
                            menu_button(theme, first_title, ">", first_action, 0),
                            {placeholders},
                            menu_button(theme, "Settings", "+", UiAction::OpenSettings, 1),
                            menu_button(theme, "How to Play", "?", UiAction::OpenHelp, 2),
                            menu_button(theme, last_title, "<", last_action, 3),
                        ]
                    ),
                    (
                        Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
                        Children [
                            (
                                Node {
                                    width: px(theme.size(9.0)),
                                    height: px(theme.size(9.0)),
                                    border_radius: BorderRadius::MAX,
                                }
                                BackgroundColor(GOLD)
                            ),
                            label(theme, if paused { "DELIVERIES ON HOLD" } else { "SINGLE PLAYER" }, 15.0, CREAM),
                        ]
                    ),
                ]
            ),
            (
                Node {
                    flex_grow: 1.0,
                    min_width: px(0),
                    align_self: AlignSelf::FlexEnd,
                    justify_content: JustifyContent::FlexEnd,
                    padding: UiRect::bottom(px(theme.size(20.0))),
                }
                Children [(
                    Node {
                        padding: px(theme.size(17.0)),
                        border: px(1),
                        border_radius: BorderRadius::all(px(7)),
                        flex_direction: FlexDirection::Column,
                        row_gap: px(theme.size(6.0)),
                        max_width: px(theme.size(350.0)),
                    }
                    BackgroundColor(Color::srgba(0.09, 0.15, 0.22, 0.70))
                    BorderColor::all(Color::srgba(0.99, 0.96, 0.87, 0.40))
                    Children [
                        heading(theme, tag_title, 24.0, GOLD),
                        label(theme, tag_body, 17.0, CREAM),
                    ]
                )]
            ),
        ]
    }
}

fn footer(theme: &UiTheme) -> impl Scene {
    bsn! {
        Node {
            width: percent(100),
            min_height: px(theme.size(56.0)),
            padding: UiRect::axes(percent(3.5), px(theme.size(10.0))),
            align_items: AlignItems::Center,
            justify_content: JustifyContent::SpaceBetween,
            flex_wrap: FlexWrap::Wrap,
            row_gap: px(theme.size(7.0)),
            column_gap: px(theme.size(18.0)),
            flex_shrink: 0.0,
        }
        BackgroundColor(Color::srgba(0.07, 0.11, 0.16, 0.88))
        Children [
            label(theme, "ISLAND DELIVERY CO.  /  HANDLE WITH CARE", 14.0, CREAM),
            (
                Node {
                    column_gap: px(theme.size(17.0)),
                    row_gap: px(theme.size(8.0)),
                    flex_wrap: FlexWrap::Wrap,
                    align_items: AlignItems::Center,
                }
                Children [
                    input_hint(theme, "Arrows", "Navigate"),
                    input_hint(theme, "Enter", "Confirm"),
                    input_hint(theme, "Esc", "Back"),
                ]
            ),
        ]
    }
}

fn input_hint(theme: &UiTheme, key: &'static str, title: &'static str) -> impl Scene {
    bsn! {
        Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
        Children [keycap(theme, key, true), label(theme, title, 17.0, CREAM)]
    }
}

fn sidebar(theme: &UiTheme, state: &MenuState) -> impl Scene {
    bsn! {
        template_value(column(theme.size(25.0)))
        Node { width: percent(24), min_width: px(theme.size(205.0)), flex_shrink: 0.0 }
        Children [
            logo(theme, true),
            (
                template_value(column(theme.size(12.0)))
                Children [
                    menu_button(theme, "Graphics", "+", UiAction::SelectTab(SettingsTab::Graphics), 0),
                    menu_button(theme, "Audio", "~", UiAction::SelectTab(SettingsTab::Audio), 1),
                    menu_button(theme, "Controls", ">", UiAction::SelectTab(SettingsTab::Controls), 2),
                    menu_button(theme, "Accessibility", "+", UiAction::SelectTab(SettingsTab::Accessibility), 3),
                ]
            ),
            (
                label(theme, if state.return_page == MenuPage::Pause {
                    "Your game is paused."
                } else {
                    "Make yourself at home."
                }, 17.0, CREAM)
                TextShadow { offset: {Vec2::new(1.0, 1.0)}, color: INK }
            ),
        ]
    }
}

fn settings_page(
    theme: &UiTheme,
    state: &MenuState,
    draft: &SettingsDraft,
    compact: bool,
) -> impl Scene {
    let (category, next_index) = match state.tab {
        SettingsTab::Graphics => ("GRAPHICS", 6),
        SettingsTab::Audio => ("AUDIO", 4),
        SettingsTab::Controls => ("CONTROLS", 8),
        SettingsTab::Accessibility => ("ACCESSIBILITY", 4),
    };
    let rows: Box<dyn Scene> = match state.tab {
        SettingsTab::Graphics => Box::new(bsn! {
            template_value(column(theme.size(13.0)))
            Children [
                placeholder_row(theme, "Window Mode", false),
                placeholder_row(theme, "Resolution", false),
                placeholder_row(theme, "VSync", false),
                setting_row(theme, "Frame Rate Limit", format!("{} FPS", draft.max_fps), SettingKey::FrameRate, 4,
                    "Choose the maximum frame rate. A higher limit feels smoother when your computer can keep up. This setting does not change movement speed."),
                placeholder_row(theme, "Shadow Quality", false),
                placeholder_row(theme, "Anti-Aliasing", false),
                placeholder_row(theme, "View Distance", false),
            ]
        }),
        SettingsTab::Audio => Box::new(bsn! {
            template_value(column(theme.size(13.0)))
            Children [
                placeholder_row(theme, "Master Volume", false),
                placeholder_row(theme, "Music Volume", false),
                placeholder_row(theme, "SFX Volume", false),
                label(theme, "Audio controls are on their way.", 17.0, MUTED),
            ]
        }),
        SettingsTab::Controls => Box::new(bsn! {
            template_value(column(theme.size(13.0)))
            Children [
                setting_row(theme, "Mouse Sensitivity", format!("{:.0}%", draft.mouse_sensitivity / 0.003 * 100.0), SettingKey::MouseSensitivity, 4,
                    "Adjust how far the camera turns when you move the mouse. 100% is the default sensitivity. This affects both first-person and third-person views."),
                setting_row(theme, "Invert Camera Y", if draft.invert_y { "On".into() } else { "Off".into() }, SettingKey::InvertY, 6,
                    "Reverse vertical mouse movement. When enabled, moving the mouse upward tilts the camera downward."),
                placeholder_row(theme, "Rebind Keys", false),
                label(theme, "Move with WASD. Switch your view with I.", 17.0, MUTED),
            ]
        }),
        SettingsTab::Accessibility => Box::new(bsn! {
            template_value(column(theme.size(13.0)))
            Children [
                placeholder_row(theme, "UI Scale", false),
                placeholder_row(theme, "Camera Shake", false),
                label(theme, "More ways to make the island yours.", 17.0, MUTED),
            ]
        }),
    };
    let status = state
        .status
        .clone()
        .unwrap_or_else(|| "Changes are saved only when you choose Apply.".into());
    bsn! {
        page_area(theme)
        Children [(
            Node {
                width: percent(100),
                column_gap: px(theme.size(27.0)),
                row_gap: px(theme.size(20.0)),
                align_items: AlignItems::FlexStart,
                // 内容保留自身高度，超出视口时由页面滚动，而不是压缩控件。
                flex_shrink: 0.0,
                flex_wrap: {if compact { FlexWrap::Wrap } else { FlexWrap::NoWrap }},
            }
            Children [
                sidebar(theme, state),
                (
                    template_value(column(theme.size(18.0)))
                    Node { flex_grow: 1.0, flex_basis: px(theme.size(450.0)), min_width: px(0) }
                    Children [
                        (
                            paper_panel(theme)
                            Children [
                                heading(theme, "SETTINGS", 44.0, INK),
                                (
                                    Node {
                                        height: px(theme.size(4.0)),
                                        width: px(theme.size(70.0)),
                                        border_radius: BorderRadius::MAX,
                                    }
                                    BackgroundColor(GOLD)
                                ),
                                (
                                    Node {
                                        column_gap: px(theme.size(18.0)),
                                        row_gap: px(theme.size(19.0)),
                                        flex_direction: {if compact { FlexDirection::Column } else { FlexDirection::Row }},
                                    }
                                    Children [
                                        (
                                            template_value(column(theme.size(21.0)))
                                            Node {
                                                flex_grow: 1.0,
                                                flex_basis: {if compact { Val::Auto } else { percent(66) }},
                                                min_width: px(0),
                                            }
                                            Children [heading(theme, category, 27.0, INK), ({rows})]
                                        ),
                                        description_panel(theme, compact),
                                    ]
                                ),
                                label(theme, status, 17.0, MUTED),
                            ]
                        ),
                        (
                            Node {
                                width: percent(100),
                                justify_content: JustifyContent::SpaceBetween,
                                column_gap: px(theme.size(12.0)),
                                row_gap: px(theme.size(10.0)),
                                flex_wrap: FlexWrap::Wrap,
                            }
                            Children [
                                small_button(theme, "Restore Defaults", UiAction::RestoreDefaults, next_index),
                                (
                                    Node {
                                        column_gap: px(theme.size(12.0)),
                                        row_gap: px(theme.size(10.0)),
                                        flex_wrap: FlexWrap::Wrap,
                                    }
                                    Children [
                                        small_button(theme, "Apply", UiAction::ApplySettings, next_index + 1),
                                        small_button(theme, "Back", UiAction::Back, next_index + 2),
                                    ]
                                ),
                            ]
                        ),
                    ]
                ),
            ]
        )]
    }
}

fn description_panel(theme: &UiTheme, compact: bool) -> impl Scene {
    bsn! {
        template_value(column(theme.size(14.0)))
        Node {
            flex_basis: {if compact { Val::Auto } else { percent(30) }},
            flex_grow: 1.0,
            min_width: px(0),
            padding: px(theme.size(18.0)),
            border_radius: BorderRadius::all(px(7)),
        }
        BackgroundColor(SUBTLE)
        Children [
            (
                heading(theme, "A LITTLE FINE-TUNING", 25.0, INK)
                DescriptionTitle
            ),
            (
                label(theme, "Select a setting to see what it does. Use the arrows to change its value, then Apply to save.", 18.0, MUTED)
                DescriptionBody
            ),
            (
                Node {
                    margin: UiRect::top(px(theme.size(12.0))),
                    align_items: AlignItems::Center,
                    column_gap: px(theme.size(9.0)),
                }
                Children [parcel_stamp(theme), heading(theme, "HANDLE WITH CARE", 17.0, INK)]
            ),
        ]
    }
}

fn help_page(theme: &UiTheme, compact: bool) -> impl Scene {
    bsn! {
        page_area(theme)
        Children [
            (
                Node {
                    align_items: AlignItems::Center,
                    column_gap: px(theme.size(45.0)),
                    row_gap: px(theme.size(16.0)),
                    flex_wrap: FlexWrap::Wrap,
                    flex_shrink: 0.0,
                }
                Children [
                    (
                        logo(theme, true)
                        Node { width: percent(26), min_width: px(theme.size(210.0)) }
                    ),
                    (
                        paper_panel(theme)
                        Node { flex_grow: 1.0 }
                        Children [
                            heading(theme, "HOW TO PLAY", 48.0, INK),
                            label(theme, "Grab a parcel. Find your stride. Enjoy the island.", 22.0, MUTED),
                        ]
                    ),
                ]
            ),
            (
                Node {
                    column_gap: px(theme.size(20.0)),
                    row_gap: px(theme.size(20.0)),
                    flex_wrap: FlexWrap::Wrap,
                    flex_shrink: 0.0,
                }
                Children [
                    help_card(theme, "01", "MOVE & JUMP", "WASD", "Space", "Move", "Jump",
                        "Move relative to the camera. Build up speed, coast to a stop, and jump while grounded.", compact),
                    help_card(theme, "02", "CARRY & DROP", "E", "E again", "Pick up", "Release",
                        "Get close to a parcel with a clear path. Hold it with physics, then release it to let gravity do the rest.", compact),
                    help_card(theme, "03", "CAMERA", "Mouse", "I", "Look around", "Switch view",
                        "Use the mouse to look around. Switch between first-person and third-person. Press Esc to pause.", compact),
                ]
            ),
            (
                paper_panel(theme)
                Node {
                    flex_direction: FlexDirection::Row,
                    align_items: AlignItems::Center,
                    flex_wrap: FlexWrap::Wrap,
                    flex_shrink: 0.0,
                }
                Children [
                    (
                        label(theme, "One courier. One box at a time. Take it easy out there.", 19.0, INK)
                        Node { flex_grow: 1.0 }
                    ),
                    small_button(theme, "Back", UiAction::Back, 0),
                ]
            ),
        ]
    }
}

#[allow(clippy::too_many_arguments)]
fn help_card(
    theme: &UiTheme,
    number: &'static str,
    title: &'static str,
    key_one: &'static str,
    key_two: &'static str,
    action_one: &'static str,
    action_two: &'static str,
    details: &'static str,
    compact: bool,
) -> impl Scene {
    bsn! {
        paper_panel(theme)
        Node {
            flex_grow: 1.0,
            flex_basis: {if compact { percent(100) } else { percent(30) }},
            min_height: px(theme.size(245.0)),
            border: px(3),
            row_gap: px(theme.size(21.0)),
        }
        Children [
            (
                Node { align_items: AlignItems::Center, column_gap: px(theme.size(15.0)) }
                Children [
                    (
                        Node {
                            width: px(theme.size(46.0)),
                            height: px(theme.size(42.0)),
                            border_radius: BorderRadius::all(px(5)),
                            justify_content: JustifyContent::Center,
                            align_items: AlignItems::Center,
                            flex_shrink: 0.0,
                        }
                        BackgroundColor(GOLD)
                        Children [heading(theme, number, 26.0, INK)]
                    ),
                    heading(theme, title, 30.0, INK),
                ]
            ),
            (
                Node {
                    column_gap: px(theme.size(17.0)),
                    row_gap: px(theme.size(10.0)),
                    flex_wrap: FlexWrap::Wrap,
                }
                Children [
                    help_hint(theme, key_one, action_one),
                    help_hint(theme, key_two, action_two),
                ]
            ),
            label(theme, details, 19.0, MUTED),
        ]
    }
}

fn help_hint(theme: &UiTheme, key: &'static str, title: &'static str) -> impl Scene {
    bsn! {
        Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
        Children [keycap(theme, key, false), label(theme, title, 18.0, INK)]
    }
}

fn style_buttons(
    focus: Res<MenuFocus>,
    source: Res<MenuInputSource>,
    mut buttons: Query<(
        &MenuButton,
        &Interaction,
        &mut BackgroundColor,
        &mut BorderColor,
    )>,
) {
    for (button, interaction, mut background, mut border) in &mut buttons {
        // 只显示当前输入来源的焦点；分类和 Apply 也在鼠标离开后恢复普通纸色。
        let focused = match *source {
            MenuInputSource::Pointer => *interaction != Interaction::None,
            MenuInputSource::Navigation => button.index == focus.0,
        };
        let color = if *interaction == Interaction::Pressed {
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
        .find_map(|(button, details)| (button.index == focus.0).then_some(details));
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

/// 短窗口中键盘仍能访问所有按钮；新页面先等布局完成，再滚到焦点所在区域。
fn scroll_focused_button(
    focus: Res<MenuFocus>,
    buttons: Query<(Entity, &MenuButton, &ComputedNode, &UiGlobalTransform)>,
    parents: Query<&ChildOf>,
    mut scrolls: Query<(&ComputedNode, &UiGlobalTransform, &mut ScrollPosition), With<MenuScroll>>,
    mut previous: Local<Option<Entity>>,
) {
    let Some((entity, _, button_node, button_transform)) = buttons
        .iter()
        .find(|(_, button, _, _)| button.index == focus.0)
    else {
        return;
    };
    if *previous == Some(entity) || button_node.size().y == 0.0 {
        return;
    }
    let mut ancestor = entity;
    while let Ok(parent) = parents.get(ancestor) {
        ancestor = parent.parent();
        let Ok((node, transform, mut scroll)) = scrolls.get_mut(ancestor) else {
            continue;
        };
        if node.size().y == 0.0 {
            return;
        }
        let top = transform.affine().translation.y - node.size().y / 2.0;
        let bottom = top + node.size().y;
        let button_top = button_transform.affine().translation.y - button_node.size().y / 2.0;
        let button_bottom = button_top + button_node.size().y;
        let delta = if button_top < top {
            button_top - top
        } else if button_bottom > bottom {
            button_bottom - bottom
        } else {
            0.0
        };
        let range = (node.content_size().y - node.size().y).max(0.0) * node.inverse_scale_factor();
        scroll.y = (scroll.y + delta * node.inverse_scale_factor()).clamp(0.0, range);
        break;
    }
    *previous = Some(entity);
}

#[cfg(test)]
mod tests {
    use bevy::{asset::AssetPlugin, scene::ScenePlugin};

    use super::*;

    fn test_theme() -> UiTheme {
        UiTheme {
            heading: Handle::default(),
            body: Handle::default(),
            scale: 1.0,
        }
    }

    /// 只启用 BSN 所需资产资源；生成 ECS 树时不加载字体文件、渲染器或窗口。
    fn actions(scene: impl Scene) -> Vec<UiAction> {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default(), ScenePlugin))
            .init_asset::<Font>();
        app.finish();
        app.cleanup();
        let world = app.world_mut();
        world.spawn_scene(scene).unwrap();
        let mut buttons: Vec<_> = world
            .query::<&MenuButton>()
            .iter(world)
            .map(|button| (button.index, button.action))
            .collect();
        buttons.sort_by_key(|(index, _)| *index);
        for (expected, (actual, _)) in buttons.iter().enumerate() {
            assert_eq!(*actual, expected, "Navigation indices must be consecutive");
        }
        buttons.into_iter().map(|(_, action)| action).collect()
    }

    #[test]
    fn bsn_pages_expose_supported_actions_with_stable_navigation() {
        let theme = test_theme();
        assert_eq!(
            actions(main_page(&theme, false)),
            vec![
                UiAction::StartGame,
                UiAction::OpenSettings,
                UiAction::OpenHelp,
                UiAction::Quit
            ]
        );
        assert_eq!(
            actions(main_page(&theme, true)),
            vec![
                UiAction::Resume,
                UiAction::OpenSettings,
                UiAction::OpenHelp,
                UiAction::ReturnToMenu
            ]
        );
        assert_eq!(actions(help_page(&theme, false)), vec![UiAction::Back]);
        let mut state = MenuState {
            page: MenuPage::Settings,
            ..default()
        };
        let graphics = actions(settings_page(
            &theme,
            &state,
            &SettingsDraft::default(),
            false,
        ));
        assert_eq!(
            &graphics[4..6],
            &[
                UiAction::Adjust(SettingKey::FrameRate, -1),
                UiAction::Adjust(SettingKey::FrameRate, 1)
            ]
        );
        assert_eq!(
            &graphics[6..],
            &[
                UiAction::RestoreDefaults,
                UiAction::ApplySettings,
                UiAction::Back
            ]
        );
        state.tab = SettingsTab::Controls;
        let controls = actions(settings_page(
            &theme,
            &state,
            &SettingsDraft::default(),
            true,
        ));
        assert_eq!(
            &controls[4..8],
            &[
                UiAction::Adjust(SettingKey::MouseSensitivity, -1),
                UiAction::Adjust(SettingKey::MouseSensitivity, 1),
                UiAction::Adjust(SettingKey::InvertY, -1),
                UiAction::Adjust(SettingKey::InvertY, 1)
            ]
        );
        assert_eq!(
            &controls[8..],
            &[
                UiAction::RestoreDefaults,
                UiAction::ApplySettings,
                UiAction::Back
            ]
        );
        for tab in [SettingsTab::Audio, SettingsTab::Accessibility] {
            state.tab = tab;
            let placeholders = actions(settings_page(
                &theme,
                &state,
                &SettingsDraft::default(),
                false,
            ));
            assert_eq!(
                &placeholders[4..],
                &[
                    UiAction::RestoreDefaults,
                    UiAction::ApplySettings,
                    UiAction::Back
                ]
            );
        }
    }

    #[test]
    fn keyboard_focus_is_visible_only_for_navigation_source() {
        let mut app = App::new();
        app.insert_resource(MenuFocus(1))
            .insert_resource(MenuInputSource::Navigation)
            .add_systems(Update, style_buttons);
        let category = app
            .world_mut()
            .spawn((
                Button,
                MenuButton {
                    action: UiAction::SelectTab(SettingsTab::Graphics),
                    index: 0,
                },
            ))
            .id();
        let apply = app
            .world_mut()
            .spawn((
                Button,
                MenuButton {
                    action: UiAction::ApplySettings,
                    index: 1,
                },
            ))
            .id();
        app.update();
        assert_eq!(
            app.world().get::<BackgroundColor>(category).unwrap().0,
            PAPER
        );
        assert_eq!(
            *app.world().get::<BorderColor>(category).unwrap(),
            BorderColor::all(CREAM)
        );
        assert_eq!(
            *app.world().get::<BorderColor>(apply).unwrap(),
            BorderColor::all(INK)
        );
        assert_eq!(app.world().get::<BackgroundColor>(apply).unwrap().0, GOLD);
        app.world_mut().resource_mut::<MenuFocus>().0 = 0;
        app.update();
        assert_eq!(
            *app.world().get::<BorderColor>(category).unwrap(),
            BorderColor::all(INK)
        );
        assert_eq!(
            *app.world().get::<BorderColor>(apply).unwrap(),
            BorderColor::all(CREAM)
        );
        assert_eq!(app.world().get::<BackgroundColor>(apply).unwrap().0, PAPER);
        *app.world_mut().resource_mut::<MenuInputSource>() = MenuInputSource::Pointer;
        app.update();
        for entity in [category, apply] {
            assert_eq!(app.world().get::<BackgroundColor>(entity).unwrap().0, PAPER);
            assert_eq!(
                *app.world().get::<BorderColor>(entity).unwrap(),
                BorderColor::all(CREAM)
            );
        }
    }
}
