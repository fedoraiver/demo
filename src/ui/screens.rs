//! 主菜单、暂停、设置与操作说明的 BSN 页面，以及焦点的视觉呈现。

use bevy::{prelude::*, window::PrimaryWindow};

use crate::settings::SettingsDraft;

use super::{
    MenuButton, MenuFocus, MenuInputSource, MenuPage, MenuRoot, MenuState, SettingKey, SettingsTab,
    UiAction, UiSystems, theme::*, volume::volume_row, widgets::*,
};

#[derive(Component, Default, Clone)]
struct DescriptionTitle;

#[derive(Component, Default, Clone)]
struct DescriptionBody;

/// 只有纸色设置面板包含滚动内容；分类菜单与底部操作保持为外部兄弟节点。
#[derive(Component, Default, Clone)]
struct SettingsPanel;

/// 保存结果和草稿提示原位更新，不改变滚动区域或按钮的实体身份。
#[derive(Component, Default, Clone)]
struct SettingsStatus;

const DEFAULT_SETTINGS_STATUS: &str = "Changes are saved only when you choose Apply.";

pub(super) fn register(app: &mut App) {
    app.init_resource::<UiTheme>()
        .add_systems(Update, rebuild_page.in_set(UiSystems::Build))
        // Build 与 Style 由插件串联，保证新 BSN 子树的延迟命令先应用。
        .add_systems(
            Update,
            (
                style_buttons,
                update_settings_text,
                update_description,
                scroll_focused_button,
            )
                .in_set(UiSystems::Style),
        );
}

/// 只在页面结构或视口变化时重建；数值、提示与焦点变化保留现有滚动控件。
fn rebuild_page(
    mut commands: Commands,
    state: Res<MenuState>,
    draft: Res<SettingsDraft>,
    theme: Res<UiTheme>,
    windows: Query<&Window, With<PrimaryWindow>>,
    roots: Query<Entity, With<MenuRoot>>,
    mut previous_layout: Local<Option<(MenuPage, SettingsTab, MenuPage, UVec2)>>,
) {
    let viewport = windows.single().map_or(Vec2::new(1440.0, 810.0), |window| {
        Vec2::new(window.width(), window.height())
    });
    let layout = (
        state.page,
        state.tab,
        state.return_page,
        viewport.round().as_uvec2(),
    );
    // 草稿和保存提示只改变文字，不应重建导致 ScrollPosition、悬停与拖动状态丢失。
    if *previous_layout == Some(layout) && (state.page == MenuPage::Hidden || !roots.is_empty()) {
        return;
    }
    *previous_layout = Some(layout);
    for entity in &roots {
        commands.entity(entity).despawn();
    }
    if state.page == MenuPage::Hidden {
        return;
    }
    // 高度变化也重建，固定菜单的内容预算不能沿用此前较高窗口的缩放。
    commands.spawn_scene(page_scene(&theme, &state, &draft, viewport));
}

/// 实际页面与无窗口布局回归共用同一 BSN 树，避免测试复制出不同的排版。
fn page_scene(
    theme: &UiTheme,
    state: &MenuState,
    draft: &SettingsDraft,
    viewport: Vec2,
) -> impl Scene + use<> {
    let theme = if matches!(
        state.page,
        MenuPage::Main | MenuPage::Pause | MenuPage::Help
    ) {
        theme.for_fixed_menu(viewport)
    } else {
        theme.for_width(viewport.x)
    };
    let compact = viewport.x < 1000.0;
    let content: Box<dyn Scene> = match state.page {
        MenuPage::Main => Box::new(main_page(&theme, false)),
        MenuPage::Pause => Box::new(main_page(&theme, true)),
        MenuPage::Settings => Box::new(settings_page(&theme, &state, &draft, compact)),
        MenuPage::Help => Box::new(help_page(&theme)),
        MenuPage::Hidden => unreachable!(),
    };
    // 句柄作为现成组件写入 BSN，spawn_scene 不依赖异步加载任务，旧页面不会复活。
    bsn! {
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
    }
}

/// 主菜单、暂停和帮助使用固定内容区；不注册滚轮 Observer，也不参与焦点滚入。
fn fixed_page_area(theme: &UiTheme) -> impl Scene + use<> {
    bsn! {
        Node {
            width: percent(100),
            min_height: px(0),
            flex_grow: 1.0,
            flex_basis: px(0),
            padding: {UiRect::axes(percent(3.5), px(theme.size(22.0)))},
        }
    }
}

fn main_page(theme: &UiTheme, paused: bool) -> impl Scene + use<> {
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
        fixed_page_area(theme)
        Node { flex_direction: FlexDirection::Row, align_items: AlignItems::FlexStart }
        Children [
            (
                template_value(column(theme.size(16.0)))
                Node {
                    width: percent(32),
                    min_width: px(theme.size(280.0)),
                    max_width: px(theme.size(490.0)),
                    flex_shrink: 0.0,
                }
                Children [
                    logo(theme, false),
                    (
                        template_value(column(theme.size(8.0)))
                        Children [
                            fixed_menu_button(theme, first_title, ">", first_action, 0),
                            {placeholders},
                            fixed_menu_button(theme, "Settings", "+", UiAction::OpenSettings, 1),
                            fixed_menu_button(theme, "How to Play", "?", UiAction::OpenHelp, 2),
                            fixed_menu_button(theme, last_title, "<", last_action, 3),
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

fn footer(theme: &UiTheme) -> impl Scene + use<> {
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

fn input_hint(theme: &UiTheme, key: &'static str, title: &'static str) -> impl Scene + use<> {
    bsn! {
        Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
        Children [keycap(theme, key, true), label(theme, title, 17.0, CREAM)]
    }
}

fn sidebar(theme: &UiTheme, state: &MenuState) -> impl Scene + use<> {
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
) -> impl Scene + use<> {
    let (category, next_index) = match state.tab {
        SettingsTab::Graphics => ("GRAPHICS", 6),
        SettingsTab::Audio => ("AUDIO", 14),
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
                setting_row(theme, "Frame Rate Limit", setting_value(draft, SettingKey::FrameRate), SettingKey::FrameRate, 4,
                    "Choose the maximum frame rate. A higher limit feels smoother when your computer can keep up. This setting does not change movement speed."),
                placeholder_row(theme, "Shadow Quality", false),
                placeholder_row(theme, "Anti-Aliasing", false),
                placeholder_row(theme, "View Distance", false),
            ]
        }),
        SettingsTab::Audio => Box::new(bsn! {
            template_value(column(theme.size(13.0)))
            Children [
                volume_row(theme, "Master Volume", draft.audio.master_volume, SettingKey::MasterVolume, 4,
                    "Adjust every sound together. Changes are heard immediately. Choose Apply to save, or Back to restore the last applied volumes."),
                volume_row(theme, "SFX Volume", draft.audio.sfx_volume, SettingKey::SfxVolume, 7,
                    "Adjust pickup, release, landing and carry warning sounds. Use Test SFX to hear a pickup sample in this menu."),
                volume_row(theme, "UI Volume", draft.audio.ui_volume, SettingKey::UiVolume, 10,
                    "Adjust menu navigation, confirmation and back sounds. Dragging previews the volume without repeated confirmation sounds."),
                placeholder_row(theme, "Music Volume", false),
                small_button(theme, "Test SFX", UiAction::TestSfx, 13),
                label(theme, "Preview changes now. Choose Apply to save.", 17.0, MUTED),
            ]
        }),
        SettingsTab::Controls => Box::new(bsn! {
            template_value(column(theme.size(13.0)))
            Children [
                setting_row(theme, "Mouse Sensitivity", setting_value(draft, SettingKey::MouseSensitivity), SettingKey::MouseSensitivity, 4,
                    "Adjust how far the camera turns when you move the mouse. 100% is the default sensitivity. This affects both first-person and third-person views."),
                setting_row(theme, "Invert Camera Y", setting_value(draft, SettingKey::InvertY), SettingKey::InvertY, 6,
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
    let status = state.status.as_deref().unwrap_or(DEFAULT_SETTINGS_STATUS);
    // 纸色设置面板中的内容整体滚动，页面外壳、分类菜单和底部操作始终固定。
    let content = bsn! {
        template_value(column(theme.size(18.0)))
        Node { width: percent(100), flex_shrink: 0.0 }
        Children [
            heading(theme, "SETTINGS", 44.0, INK),
            (
                Node {
                    height: px(theme.size(4.0)),
                    width: px(theme.size(70.0)),
                    border_radius: BorderRadius::MAX,
                    flex_shrink: 0.0,
                }
                BackgroundColor(GOLD)
            ),
            (
                Node {
                    column_gap: px(theme.size(18.0)),
                    row_gap: px(theme.size(19.0)),
                    flex_direction: {if compact { FlexDirection::Column } else { FlexDirection::Row }},
                    flex_shrink: 0.0,
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
            (label(theme, status.to_owned(), 17.0, MUTED) SettingsStatus),
        ]
    };
    bsn! {
        fixed_page_area(theme)
        Node {
            column_gap: px(theme.size(27.0)),
            align_items: AlignItems::Stretch,
            min_width: px(0),
        }
        Children [
            sidebar(theme, state),
            (
                template_value(column(theme.size(18.0)))
                Node { flex_grow: 1.0, flex_basis: px(0), min_height: px(0) }
                Children [
                    (
                        SettingsPanel
                        paper_panel(theme)
                        Node {
                            flex_grow: 1.0,
                            flex_basis: px(0),
                            min_height: px(0),
                            min_width: px(0),
                            // 固定面板高度由页面剩余空间决定，内容不会撑高整个页面。
                            overflow: Overflow::clip(),
                        }
                        Children [settings_scroll_frame(theme, content)]
                    ),
                    (
                        Node {
                            width: percent(100),
                            justify_content: JustifyContent::SpaceBetween,
                            column_gap: px(theme.size(12.0)),
                            row_gap: px(theme.size(10.0)),
                            flex_wrap: FlexWrap::Wrap,
                            flex_shrink: 0.0,
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
    }
}

fn description_panel(theme: &UiTheme, compact: bool) -> impl Scene + use<> {
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

/// 支持的 16:9 窗口始终显示三列说明；减少重复品牌标题，完整保留正文和键位。
fn help_page(theme: &UiTheme) -> impl Scene + use<> {
    bsn! {
        fixed_page_area(theme)
        Node {
            flex_direction: FlexDirection::Column,
            row_gap: px(theme.size(16.0)),
        }
        Children [
            (
                paper_panel(theme)
                Node {
                    flex_direction: FlexDirection::Row,
                    align_items: AlignItems::Center,
                    padding: px(theme.size(12.0)),
                    column_gap: px(theme.size(18.0)),
                    flex_shrink: 0.0,
                }
                Children [
                    parcel_stamp(theme),
                    (
                        template_value(column(theme.size(5.0)))
                        Node { flex_grow: 1.0 }
                        Children [
                            heading(theme, "HOW TO PLAY", 36.0, INK),
                            label(theme, "Grab a parcel. Find your stride. Enjoy the island.", 18.0, MUTED),
                        ]
                    ),
                ]
            ),
            (
                Node {
                    width: percent(100),
                    column_gap: px(theme.size(16.0)),
                    flex_shrink: 0.0,
                }
                Children [
                    help_card(theme, "01", "MOVE & JUMP", "WASD", "Space", "Move", "Jump",
                        "Move relative to the camera. Build up speed, coast to a stop, and jump while grounded."),
                    help_card(theme, "02", "CARRY & DROP", "E", "E again", "Pick up", "Release",
                        "Get close to a parcel with a clear path. Hold it with physics, then release it to let gravity do the rest."),
                    help_card(theme, "03", "CAMERA", "Mouse", "I", "Look around", "Switch view",
                        "Use the mouse to look around. Switch between first-person and third-person. Press Esc to pause."),
                ]
            ),
            (
                paper_panel(theme)
                Node {
                    flex_direction: FlexDirection::Row,
                    align_items: AlignItems::Center,
                    padding: px(theme.size(12.0)),
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
) -> impl Scene + use<> {
    bsn! {
        paper_panel(theme)
        Node {
            flex_grow: 1.0,
            flex_basis: px(0),
            min_height: px(theme.size(275.0)),
            padding: px(theme.size(14.0)),
            row_gap: px(theme.size(12.0)),
        }
        Children [
            (
                Node { align_items: AlignItems::Center, column_gap: px(theme.size(12.0)) }
                Children [
                    (
                        Node {
                            width: px(theme.size(34.0)),
                            height: px(theme.size(34.0)),
                            border_radius: BorderRadius::all(px(5)),
                            justify_content: JustifyContent::Center,
                            align_items: AlignItems::Center,
                            flex_shrink: 0.0,
                        }
                        BackgroundColor(GOLD)
                        Children [heading(theme, number, 26.0, INK)]
                    ),
                    heading(theme, title, 26.0, INK),
                ]
            ),
            (
                Node {
                    flex_direction: FlexDirection::Column,
                    row_gap: px(theme.size(6.0)),
                }
                Children [
                    help_hint(theme, key_one, action_one),
                    help_hint(theme, key_two, action_two),
                ]
            ),
            (
                label(theme, details, 19.0, MUTED)
                // 文字测量宽度不含行尾空白，而 Parley 字形布局尺寸会计入其 advance。
                // 正文明确占满卡片，并预留少量右侧换行余量，避免尾部越过文本节点。
                Node {
                    width: percent(100),
                    padding: UiRect::right(px(theme.size(8.0).max(8.0))),
                }
            ),
        ]
    }
}

fn help_hint(theme: &UiTheme, key: &'static str, title: &'static str) -> impl Scene + use<> {
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

/// 初次装配与实时更新共用格式，确保显示值始终来自同一份设置草稿。
fn setting_value(draft: &SettingsDraft, key: SettingKey) -> String {
    match key {
        SettingKey::FrameRate => format!("{} FPS", draft.max_fps),
        SettingKey::MouseSensitivity => format!("{:.0}%", draft.mouse_sensitivity / 0.003 * 100.0),
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
            |key| setting_value(&draft, key.0),
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
    use bevy::{
        asset::AssetPlugin,
        camera::NormalizedRenderTarget,
        input::{mouse::MouseScrollUnit, touch::TouchPhase},
        picking::{
            backend::HitData,
            pointer::{Location, PointerId},
        },
        scene::ScenePlugin,
        text::TextLayoutInfo,
        ui_widgets::{Scrollbar, ScrollbarThumb},
    };

    use super::*;

    /// 直接放入游戏实际字体资产，布局检查不依赖异步加载，也不安装窗口后端。
    fn layout_theme(app: &mut App) -> UiTheme {
        let mut fonts = app.world_mut().resource_mut::<Assets<Font>>();
        UiTheme {
            heading: fonts.add(Font::from_bytes(
                include_bytes!("../../assets/ui/fonts/heading.ttf").to_vec(),
            )),
            body: fonts.add(Font::from_bytes(
                include_bytes!("../../assets/ui/fonts/body.ttf").to_vec(),
            )),
            scale: 1.0,
        }
    }

    fn page_layout_app(size: UVec2, page: MenuPage) -> App {
        page_layout_app_with_state(size, &MenuState { page, ..default() })
    }

    fn page_layout_app_with_state(size: UVec2, state: &MenuState) -> App {
        let mut app = crate::ui::widgets::tests::layout_app(size);
        let theme = layout_theme(&mut app);
        app.init_resource::<MenuFocus>();
        app.world_mut()
            .spawn_scene(page_scene(
                &theme,
                state,
                &SettingsDraft::default(),
                size.as_vec2(),
            ))
            .unwrap();
        // 字体集合、测量与最终几何均经过实际 UI 调度，不能只检查声明组件。
        for _ in 0..3 {
            app.update();
        }
        app
    }

    fn node_rect(node: &ComputedNode, transform: &UiGlobalTransform) -> Rect {
        let center = transform.affine().translation;
        let half_size = node.size() / 2.0;
        Rect {
            min: center - half_size,
            max: center + half_size,
        }
    }

    fn rect_in_viewport(rect: Rect, viewport: Vec2) -> bool {
        rect.min.x >= -1.0
            && rect.min.y >= -1.0
            && rect.max.x <= viewport.x + 1.0
            && rect.max.y <= viewport.y + 1.0
    }

    fn descends_from(world: &World, mut entity: Entity, ancestor: Entity) -> bool {
        loop {
            if entity == ancestor {
                return true;
            }
            let Some(parent) = world.get::<ChildOf>(entity) else {
                return false;
            };
            entity = parent.parent();
        }
    }

    /// 触发真实的 Bevy 指针滚轮事件，检查事件冒泡到页面区域后的行为。
    fn wheel_over(app: &mut App, target: Entity, unit: MouseScrollUnit, y: f32) -> Entity {
        let camera = app
            .world_mut()
            .query_filtered::<Entity, With<Camera>>()
            .single(app.world())
            .unwrap();
        let mut event = Pointer::new(
            PointerId::Mouse,
            Location {
                target: NormalizedRenderTarget::None {
                    width: 960,
                    height: 540,
                },
                position: Vec2::new(100.0, 100.0),
            },
            Scroll {
                unit,
                x: 0.0,
                y,
                hit: HitData::new(camera, 0.0, None, None),
                phase: TouchPhase::Moved,
            },
            target,
        );
        app.world_mut().trigger_ref(&mut event);
        event.entity
    }

    #[test]
    fn fixed_menus_fit_supported_viewports_with_real_fonts() {
        for size in [
            UVec2::new(960, 540),
            UVec2::new(1280, 720),
            UVec2::new(1920, 1080),
        ] {
            for page in [MenuPage::Main, MenuPage::Pause, MenuPage::Help] {
                let mut app = page_layout_app(size, page);
                let world = app.world_mut();
                let root_children = world
                    .query_filtered::<&Children, With<MenuRoot>>()
                    .single(world)
                    .unwrap();
                let footer = root_children[1];
                let footer_rect = node_rect(
                    world.get::<ComputedNode>(footer).unwrap(),
                    world.get::<UiGlobalTransform>(footer).unwrap(),
                );
                assert!(
                    rect_in_viewport(footer_rect, size.as_vec2()),
                    "Footer is outside viewport: {page:?} {size:?} {footer_rect:?}"
                );
                let buttons: Vec<_> = world
                    .query::<(&MenuButton, &ComputedNode, &UiGlobalTransform)>()
                    .iter(world)
                    .map(|(button, node, transform)| {
                        (button.action, node.size(), node_rect(node, transform))
                    })
                    .collect();
                assert_eq!(buttons.len(), if page == MenuPage::Help { 1 } else { 4 });
                for (action, dimensions, rect) in buttons {
                    assert!(dimensions.x > 0.0 && dimensions.y > 0.0);
                    assert!(
                        rect_in_viewport(rect, size.as_vec2())
                            && rect.max.y <= footer_rect.min.y + 1.0,
                        "Button overlaps footer or viewport: {page:?} {size:?} {action:?} {rect:?}"
                    );
                }
                let invalid: Vec<_> = world
                    .query::<(
                        Entity,
                        &Text,
                        &ComputedNode,
                        &UiGlobalTransform,
                        &TextLayoutInfo,
                    )>()
                    .iter(world)
                    .filter(|(entity, text, node, transform, glyphs)| {
                        !text.0.is_empty()
                            && (node.size().x <= 0.0
                                || node.size().y <= 0.0
                                || glyphs.glyphs.is_empty()
                                || !rect_in_viewport(node_rect(node, transform), size.as_vec2())
                                || (page == MenuPage::Help
                                    && (glyphs.size.x > node.size().x + 1.0
                                        || glyphs.size.y > node.size().y + 1.0
                                        || (!descends_from(world, *entity, footer)
                                            && node_rect(node, transform).max.y
                                                > footer_rect.min.y + 1.0))))
                    })
                    .map(|(_, text, node, transform, glyphs)| {
                        (
                            text.0.clone(),
                            node_rect(node, transform),
                            glyphs.glyphs.len(),
                            glyphs.size,
                        )
                    })
                    .collect();
                assert!(
                    invalid.is_empty(),
                    "Text needs visible layout: {page:?} {size:?} {invalid:?}"
                );
                if page == MenuPage::Help {
                    let back_rect = world
                        .query::<(&MenuButton, &ComputedNode, &UiGlobalTransform)>()
                        .iter(world)
                        .find(|(button, _, _)| button.action == UiAction::Back)
                        .map(|(_, node, transform)| node_rect(node, transform))
                        .unwrap();
                    for paragraph in [
                        "Move relative to the camera. Build up speed, coast to a stop, and jump while grounded.",
                        "Get close to a parcel with a clear path. Hold it with physics, then release it to let gravity do the rest.",
                        "Use the mouse to look around. Switch between first-person and third-person. Press Esc to pause.",
                    ] {
                        let (_, node, transform, parent) = world
                            .query::<(&Text, &ComputedNode, &UiGlobalTransform, &ChildOf)>()
                            .iter(world)
                            .find(|(text, _, _, _)| text.0 == paragraph)
                            .expect("Help must retain each complete instruction paragraph");
                        let text_rect = node_rect(node, transform);
                        let card_rect = node_rect(
                            world.get::<ComputedNode>(parent.parent()).unwrap(),
                            world.get::<UiGlobalTransform>(parent.parent()).unwrap(),
                        );
                        assert!(
                            text_rect.min.x >= card_rect.min.x - 1.0
                                && text_rect.max.x <= card_rect.max.x + 1.0
                                && text_rect.min.y >= card_rect.min.y - 1.0
                                && text_rect.max.y <= card_rect.max.y + 1.0
                                && card_rect.max.y <= back_rect.min.y + 1.0,
                            "Help paragraph overflows its card: {size:?} {paragraph} {text_rect:?} {card_rect:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn fixed_menus_ignore_wheel_and_focus_scrolling() {
        for page in [MenuPage::Main, MenuPage::Pause, MenuPage::Help] {
            let mut app = page_layout_app(UVec2::new(960, 540), page);
            app.add_systems(Update, scroll_focused_button);
            let buttons: Vec<_> = app
                .world_mut()
                .query::<(Entity, &MenuButton)>()
                .iter(app.world())
                .map(|(entity, button)| (entity, button.index))
                .collect();
            let before: Vec<_> = buttons
                .iter()
                .map(|(entity, _)| {
                    (
                        *entity,
                        *app.world().get::<UiGlobalTransform>(*entity).unwrap(),
                    )
                })
                .collect();
            for (entity, index) in buttons {
                wheel_over(&mut app, entity, MouseScrollUnit::Line, -10.0);
                wheel_over(&mut app, entity, MouseScrollUnit::Pixel, 100.0);
                app.world_mut().resource_mut::<MenuFocus>().0 = index;
                app.update();
            }
            let world = app.world_mut();
            assert_eq!(world.query::<&MenuScroll>().iter(world).count(), 0);
            assert_eq!(world.query::<&Scrollbar>().iter(world).count(), 0);
            // Node 自动要求 ScrollPosition，因此验证零偏移而非断言组件不存在。
            assert!(
                world
                    .query::<(&Node, &ScrollPosition, &ComputedNode)>()
                    .iter(world)
                    .all(|(node, position, computed)| {
                        node.overflow.y != OverflowAxis::Scroll
                            && position.0 == Vec2::ZERO
                            && computed.scroll_position == Vec2::ZERO
                    })
            );
            for (entity, transform) in before {
                assert_eq!(*world.get::<UiGlobalTransform>(entity).unwrap(), transform);
            }
        }
    }

    #[test]
    fn settings_panel_scrolls_without_moving_the_page_or_fixed_controls() {
        let mut saw_overflow = false;
        for tab in [
            SettingsTab::Graphics,
            SettingsTab::Audio,
            SettingsTab::Controls,
            SettingsTab::Accessibility,
        ] {
            let mut app = page_layout_app_with_state(
                UVec2::new(960, 540),
                &MenuState {
                    page: MenuPage::Settings,
                    tab,
                    ..default()
                },
            );
            let world = app.world_mut();
            let panel = world
                .query_filtered::<Entity, With<SettingsPanel>>()
                .single(world)
                .unwrap();
            let (area, range) = world
                .query_filtered::<(Entity, &ComputedNode), With<MenuScroll>>()
                .iter(world)
                .map(|(entity, node)| {
                    (
                        entity,
                        (node.content_size().y - node.size().y).max(0.0)
                            * node.inverse_scale_factor(),
                    )
                })
                .next()
                .unwrap();
            assert!(descends_from(world, area, panel));
            let title = world
                .query::<(Entity, &Text)>()
                .iter(world)
                .find(|(entity, text)| text.0 == "SETTINGS" && descends_from(world, *entity, area))
                .unwrap()
                .0;
            let fixed_nodes: Vec<_> = world
                .query::<(Entity, &ComputedNode, &UiGlobalTransform)>()
                .iter(world)
                .filter(|(entity, _, _)| {
                    !descends_from(world, *entity, area)
                        && world.get::<ScrollbarThumb>(*entity).is_none()
                })
                .map(|(entity, _, transform)| (entity, *transform))
                .collect();
            let buttons: Vec<_> = world
                .query::<(Entity, &MenuButton)>()
                .iter(world)
                .map(|(entity, button)| (entity, button.action, button.index))
                .collect();
            let fixed_buttons: Vec<_> = buttons
                .iter()
                .copied()
                .filter(|(_, action, _)| {
                    matches!(
                        action,
                        UiAction::SelectTab(_)
                            | UiAction::RestoreDefaults
                            | UiAction::ApplySettings
                            | UiAction::Back
                    )
                })
                .collect();
            assert_eq!(fixed_buttons.len(), 7);
            for (entity, _, _) in &fixed_buttons {
                assert!(
                    !descends_from(world, *entity, panel),
                    "Fixed button belongs outside paper panel"
                );
            }
            let adjustment = buttons
                .iter()
                .copied()
                .filter(|(entity, _, _)| descends_from(world, *entity, area))
                .max_by_key(|(_, _, index)| *index);
            assert_eq!(
                wheel_over(&mut app, title, MouseScrollUnit::Line, -3.0),
                area
            );
            saw_overflow |= range > 0.0;
            assert_eq!(
                app.world().get::<ScrollPosition>(area).unwrap().y,
                96.0_f32.min(range)
            );
            wheel_over(&mut app, title, MouseScrollUnit::Pixel, -100_000.0);
            assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, range);
            app.update();
            let world = app.world_mut();
            let (_, status_node, status_transform) = world
                .query::<(&Text, &ComputedNode, &UiGlobalTransform)>()
                .iter(world)
                .find(|(text, _, _)| text.0 == "Changes are saved only when you choose Apply.")
                .unwrap();
            let status_rect = node_rect(status_node, status_transform);
            let viewport_rect = node_rect(
                world.get::<ComputedNode>(area).unwrap(),
                world.get::<UiGlobalTransform>(area).unwrap(),
            );
            assert!(
                status_rect.min.y >= viewport_rect.min.y - 1.0
                    && status_rect.max.y <= viewport_rect.max.y + 1.0,
                "Saving hint must be reachable at panel bottom: {tab:?} {status_rect:?} {viewport_rect:?}"
            );
            let title_rect = node_rect(
                app.world().get::<ComputedNode>(title).unwrap(),
                app.world().get::<UiGlobalTransform>(title).unwrap(),
            );
            if range > 0.0 {
                assert!(
                    title_rect.min.y
                        < node_rect(
                            app.world().get::<ComputedNode>(area).unwrap(),
                            app.world().get::<UiGlobalTransform>(area).unwrap()
                        )
                        .min
                        .y,
                    "SETTINGS header is part of scrolling panel content"
                );
            }
            for (entity, _, _) in &fixed_buttons {
                wheel_over(&mut app, *entity, MouseScrollUnit::Line, 4.0);
                assert_eq!(
                    app.world().get::<ScrollPosition>(area).unwrap().y,
                    range,
                    "Wheel outside paper panel must not move it: {tab:?}"
                );
            }
            let root = app
                .world_mut()
                .query_filtered::<Entity, With<MenuRoot>>()
                .single(app.world())
                .unwrap();
            wheel_over(&mut app, root, MouseScrollUnit::Line, 4.0);
            assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, range);
            app.add_systems(Update, scroll_focused_button);
            for (_, _, index) in &fixed_buttons {
                app.world_mut().resource_mut::<MenuFocus>().0 = *index;
                app.update();
                assert_eq!(
                    app.world().get::<ScrollPosition>(area).unwrap().y,
                    range,
                    "Fixed button focus must not scroll panel: {tab:?}"
                );
            }
            if let Some((entity, _, index)) = adjustment {
                app.world_mut().resource_mut::<MenuFocus>().0 = index;
                app.update();
                let area_rect = node_rect(
                    app.world().get::<ComputedNode>(area).unwrap(),
                    app.world().get::<UiGlobalTransform>(area).unwrap(),
                );
                let button_rect = node_rect(
                    app.world().get::<ComputedNode>(entity).unwrap(),
                    app.world().get::<UiGlobalTransform>(entity).unwrap(),
                );
                assert!(
                    button_rect.min.y >= area_rect.min.y - 1.0
                        && button_rect.max.y <= area_rect.max.y + 1.0,
                    "Setting adjustment must scroll into panel viewport: {tab:?} {button_rect:?} {area_rect:?}"
                );
            }
            wheel_over(&mut app, title, MouseScrollUnit::Pixel, 100_000.0);
            app.update();
            assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 0.0);
            for (entity, transform) in fixed_nodes {
                assert_eq!(
                    *app.world().get::<UiGlobalTransform>(entity).unwrap(),
                    transform,
                    "Panel scrolling must leave page, sidebar, actions and rail fixed: {tab:?} {entity:?}"
                );
            }
        }
        assert!(saw_overflow, "Long panel must exercise wheel scrolling");
    }

    #[test]
    fn offscreen_setting_focus_scrolls_only_the_paper_panel() {
        let mut app = page_layout_app(UVec2::new(960, 540), MenuPage::Settings);
        let world = app.world_mut();
        let panel = world
            .query_filtered::<Entity, With<SettingsPanel>>()
            .single(world)
            .unwrap();
        // 限制真实面板的内容视口，让已有字段确实越界，不能用已可见字段冒充滚入验证。
        // 这里只改变无窗口布局 fixture，不改变游戏窗口的最小尺寸。
        world.get_mut::<Node>(panel).unwrap().max_height = px(180);
        app.update();
        let world = app.world_mut();
        let area = world
            .query_filtered::<Entity, With<MenuScroll>>()
            .single(world)
            .unwrap();
        let (button, index) = world
            .query::<(Entity, &MenuButton)>()
            .iter(world)
            .find(|(_, button)| button.action == UiAction::Adjust(SettingKey::FrameRate, 1))
            .map(|(entity, button)| (entity, button.index))
            .unwrap();
        let viewport = node_rect(
            world.get::<ComputedNode>(area).unwrap(),
            world.get::<UiGlobalTransform>(area).unwrap(),
        );
        let original_button = node_rect(
            world.get::<ComputedNode>(button).unwrap(),
            world.get::<UiGlobalTransform>(button).unwrap(),
        );
        assert!(
            original_button.max.y > viewport.max.y,
            "Fixture must put setting adjustment below panel viewport"
        );
        let fixed: Vec<_> = world
            .query::<(Entity, &MenuButton, &UiGlobalTransform)>()
            .iter(world)
            .filter(|(entity, _, _)| !descends_from(world, *entity, area))
            .map(|(entity, button, transform)| (entity, button.index, *transform))
            .collect();
        app.add_systems(Update, scroll_focused_button);
        app.world_mut().resource_mut::<MenuFocus>().0 = index;
        app.update();
        let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        assert!(
            offset > 0.0,
            "Offscreen setting must trigger positive panel scrolling"
        );
        let focused = node_rect(
            app.world().get::<ComputedNode>(button).unwrap(),
            app.world().get::<UiGlobalTransform>(button).unwrap(),
        );
        assert!(
            focused.min.y >= viewport.min.y - 1.0 && focused.max.y <= viewport.max.y + 1.0,
            "Setting adjustment must finish inside panel: {focused:?} {viewport:?}"
        );
        for (entity, index, transform) in fixed {
            assert_eq!(
                *app.world().get::<UiGlobalTransform>(entity).unwrap(),
                transform
            );
            app.world_mut().resource_mut::<MenuFocus>().0 = index;
            app.update();
            assert_eq!(
                app.world().get::<ScrollPosition>(area).unwrap().y,
                offset,
                "Fixed menu and action focus must leave panel offset unchanged"
            );
        }
    }

    #[test]
    fn settings_scrollbar_matches_real_overflow_without_covering_content() {
        let mut saw_overflow = false;
        let mut saw_fitting_content = false;
        for size in [
            UVec2::new(960, 540),
            UVec2::new(1280, 720),
            UVec2::new(1920, 1080),
        ] {
            for tab in [
                SettingsTab::Graphics,
                SettingsTab::Audio,
                SettingsTab::Controls,
                SettingsTab::Accessibility,
            ] {
                let mut app = page_layout_app_with_state(
                    size,
                    &MenuState {
                        page: MenuPage::Settings,
                        tab,
                        ..default()
                    },
                );
                let world = app.world_mut();
                let panel = world
                    .query_filtered::<Entity, With<SettingsPanel>>()
                    .single(world)
                    .unwrap();
                let panel_rect = node_rect(
                    world.get::<ComputedNode>(panel).unwrap(),
                    world.get::<UiGlobalTransform>(panel).unwrap(),
                );
                assert!(rect_in_viewport(panel_rect, size.as_vec2()));
                let footer = world
                    .query_filtered::<&Children, With<MenuRoot>>()
                    .single(world)
                    .unwrap()[1];
                let footer_rect = node_rect(
                    world.get::<ComputedNode>(footer).unwrap(),
                    world.get::<UiGlobalTransform>(footer).unwrap(),
                );
                let (track, target, visibility, track_rect) = world
                    .query::<(
                        Entity,
                        &Scrollbar,
                        &ComputedNode,
                        &UiGlobalTransform,
                        &Visibility,
                    )>()
                    .single(world)
                    .map(|(entity, scrollbar, node, transform, visibility)| {
                        (
                            entity,
                            scrollbar.target,
                            *visibility,
                            node_rect(node, transform),
                        )
                    })
                    .unwrap();
                assert!(world.get::<MenuScroll>(target).is_some());
                assert!(descends_from(world, target, panel));
                assert!(descends_from(world, track, panel));
                assert_eq!(world.query::<&MenuScroll>().iter(world).count(), 1);
                for (entity, button, node, transform) in world
                    .query::<(Entity, &MenuButton, &ComputedNode, &UiGlobalTransform)>()
                    .iter(world)
                {
                    if !matches!(
                        button.action,
                        UiAction::SelectTab(_)
                            | UiAction::RestoreDefaults
                            | UiAction::ApplySettings
                            | UiAction::Back
                    ) {
                        continue;
                    }
                    assert!(!descends_from(world, entity, panel));
                    let rect = node_rect(node, transform);
                    assert!(
                        rect_in_viewport(rect, size.as_vec2())
                            && rect.max.y <= footer_rect.min.y + 1.0,
                        "Fixed settings controls must fit: {size:?} {tab:?} {:?} {rect:?}",
                        button.action
                    );
                }
                let invalid_fixed_text: Vec<_> = world
                    .query::<(
                        Entity,
                        &Text,
                        &ComputedNode,
                        &UiGlobalTransform,
                        &TextLayoutInfo,
                    )>()
                    .iter(world)
                    .filter(|(entity, text, node, transform, glyphs)| {
                        !descends_from(world, *entity, target)
                            && !text.0.is_empty()
                            && (node.size().x <= 0.0
                                || node.size().y <= 0.0
                                || glyphs.glyphs.is_empty()
                                || !rect_in_viewport(node_rect(node, transform), size.as_vec2())
                                || (!descends_from(world, *entity, footer)
                                    && node_rect(node, transform).max.y > footer_rect.min.y + 1.0))
                    })
                    .map(|(_, text, node, transform, _)| {
                        (text.0.clone(), node_rect(node, transform))
                    })
                    .collect();
                assert!(
                    invalid_fixed_text.is_empty(),
                    "Settings shell text must stay visible: {size:?} {tab:?} {invalid_fixed_text:?}"
                );
                let area_node = world.get::<ComputedNode>(target).unwrap();
                let area_rect =
                    node_rect(area_node, world.get::<UiGlobalTransform>(target).unwrap());
                let overflow = area_node.content_size().y > area_node.size().y + 1.0;
                saw_overflow |= overflow;
                saw_fitting_content |= !overflow;
                assert_eq!(
                    visibility,
                    if overflow {
                        Visibility::Inherited
                    } else {
                        Visibility::Hidden
                    },
                    "Scrollbar visibility must follow real content overflow: {size:?} {tab:?}"
                );
                assert!(
                    rect_in_viewport(track_rect, size.as_vec2())
                        && track_rect.min.x >= panel_rect.min.x
                        && track_rect.max.x <= panel_rect.max.x
                        && track_rect.min.y >= panel_rect.min.y
                        && track_rect.max.y <= panel_rect.max.y
                        && area_rect.max.x <= track_rect.min.x + 1.0
                        && (area_rect.min.y - track_rect.min.y).abs() <= 1.0
                        && (area_rect.max.y - track_rect.max.y).abs() <= 1.0,
                    "Scrollbar must stay inside paper panel beside its content: {size:?} {tab:?} {area_rect:?} {track_rect:?} {panel_rect:?}"
                );
                if overflow {
                    let thumb = world
                        .get::<Children>(track)
                        .unwrap()
                        .iter()
                        .find(|child| world.get::<ScrollbarThumb>(*child).is_some())
                        .unwrap();
                    let thumb_node = world.get::<ComputedNode>(thumb).unwrap();
                    let thumb_rect =
                        node_rect(thumb_node, world.get::<UiGlobalTransform>(thumb).unwrap());
                    assert!(
                        thumb_node.size().x > 0.0
                            && thumb_node.size().y > 0.0
                            && thumb_node.size().y < track_rect.height()
                            && thumb_rect.min.x >= track_rect.min.x - 1.0
                            && thumb_rect.max.x <= track_rect.max.x + 1.0
                            && thumb_rect.min.y >= track_rect.min.y - 1.0
                            && thumb_rect.max.y <= track_rect.max.y + 1.0,
                        "Native thumb must fit its visible track: {size:?} {tab:?} {thumb_rect:?} {track_rect:?}"
                    );
                }
            }
        }
        assert!(
            saw_overflow,
            "Regression must cover an overflowing Settings page"
        );
        assert!(
            saw_fitting_content,
            "Regression must cover a fitting Settings page"
        );
    }

    /// 请求、鼠标状态、真实字体和原生滚动条共同运行；只有虚拟相机和窗口组件数据。
    fn live_settings_app() -> App {
        let size = UVec2::new(960, 540);
        let mut app = crate::ui::widgets::tests::layout_app_with(size, |app| {
            app.add_plugins((
                bevy::input::InputPlugin,
                bevy_enhanced_input::prelude::EnhancedInputPlugin,
                crate::app_flow::AppFlowPlugin,
            ));
            let theme = layout_theme(app);
            app.insert_resource(theme)
                .init_resource::<crate::settings::GameSettings>()
                .init_resource::<SettingsDraft>()
                .init_resource::<crate::settings::SettingsFile>()
                .add_message::<super::super::UiRequest>()
                .add_message::<crate::audio_events::SoundRequest>()
                .add_message::<AppExit>()
                .configure_sets(Update, (UiSystems::Build, UiSystems::Style).chain());
            super::register(app);
            crate::ui::navigation::register(app);
            crate::ui::volume::register(app);
            app.world_mut().spawn((
                Window {
                    resolution: (960, 540).into(),
                    ..default()
                },
                PrimaryWindow,
            ));
        });
        for _ in 0..3 {
            app.update();
        }
        request_action(&mut app, UiAction::OpenSettings);
        app
    }

    fn request_action(app: &mut App, action: UiAction) {
        app.world_mut()
            .write_message(super::super::UiRequest(action));
        app.update();
    }

    fn settings_identity(app: &mut App) -> Vec<Entity> {
        let world = app.world_mut();
        let mut entities: Vec<_> = world
            .query_filtered::<Entity, Or<(
                With<MenuRoot>,
                With<SettingsPanel>,
                With<MenuScroll>,
                With<SettingsScrollbar>,
                With<ScrollbarThumb>,
                With<MenuButton>,
                With<SettingValue>,
                With<SettingsStatus>,
            )>>()
            .iter(world)
            .collect();
        entities.sort();
        entities
    }

    fn scroll_settings_for_edit(app: &mut App) -> (Entity, f32) {
        let world = app.world_mut();
        let area = world
            .query_filtered::<Entity, With<MenuScroll>>()
            .single(world)
            .unwrap();
        let title = world
            .query::<(Entity, &Text)>()
            .iter(world)
            .find(|(_, text)| text.0 == "SETTINGS")
            .unwrap()
            .0;
        assert_eq!(wheel_over(app, title, MouseScrollUnit::Line, -3.0), area);
        app.update();
        let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        assert!(
            offset > 0.0,
            "Regression must start at a nonzero panel offset"
        );
        (area, offset)
    }

    fn assert_panel_preserved(app: &mut App, identity: &[Entity], area: Entity, old_offset: f32) {
        assert_eq!(
            settings_identity(app),
            identity,
            "Editing must preserve UI entity identities"
        );
        let world = app.world_mut();
        let node = world.get::<ComputedNode>(area).unwrap();
        let range = (node.content_size().y - node.size().y).max(0.0) * node.inverse_scale_factor();
        let expected = old_offset.min(range);
        assert!(
            (world.get::<ScrollPosition>(area).unwrap().y - expected).abs() < 0.01,
            "Text updates may clamp to the new range, never reset an overflowing panel to zero"
        );
        let (track, scrollbar, children) = world
            .query::<(Entity, &Scrollbar, &Children)>()
            .single(world)
            .unwrap();
        assert_eq!(scrollbar.target, area);
        if expected > 0.0 {
            let thumb = children
                .iter()
                .find(|entity| world.get::<ScrollbarThumb>(*entity).is_some())
                .unwrap();
            let track_rect = node_rect(
                world.get::<ComputedNode>(track).unwrap(),
                world.get::<UiGlobalTransform>(track).unwrap(),
            );
            let thumb_rect = node_rect(
                world.get::<ComputedNode>(thumb).unwrap(),
                world.get::<UiGlobalTransform>(thumb).unwrap(),
            );
            assert!(
                thumb_rect.min.y > track_rect.min.y + 0.1,
                "Nonzero offset must leave scrollbar thumb below the top"
            );
        }
    }

    fn setting_text(app: &mut App, key: SettingKey) -> String {
        let world = app.world_mut();
        let (_, text, node, layout) = world
            .query::<(&SettingValue, &Text, &ComputedNode, &TextLayoutInfo)>()
            .iter(world)
            .find(|(value, _, _, _)| value.0 == key)
            .unwrap();
        assert!(node.size().x > 0.0 && node.size().y > 0.0 && !layout.glyphs.is_empty());
        text.0.clone()
    }

    #[test]
    fn frame_rate_clicks_refresh_values_without_resetting_scroll_or_focus() {
        let mut app = live_settings_app();
        // 先建立此字段的真实说明与焦点，按钮调整时不能借重建重新滚入或回到顶部。
        app.world_mut().resource_mut::<MenuFocus>().0 = 5;
        app.update();
        let (area, _) = scroll_settings_for_edit(&mut app);
        let identity = settings_identity(&mut app);
        for (direction, expected) in [(1, "90 FPS"), (1, "120 FPS"), (-1, "90 FPS")] {
            let world = app.world_mut();
            let button = world
                .query::<(Entity, &MenuButton)>()
                .iter(world)
                .find(|(_, button)| {
                    button.action == UiAction::Adjust(SettingKey::FrameRate, direction)
                })
                .map(|(entity, _)| entity)
                .unwrap();
            let offset = world.get::<ScrollPosition>(area).unwrap().y;
            *world.get_mut::<Interaction>(button).unwrap() = Interaction::Pressed;
            app.update(); // 真实 pointer_interaction 将鼠标状态转为 UiRequest。
            app.update(); // 下一帧消费请求、原位更新文字，帧末布局和滑块必须已经一致。
            assert_eq!(setting_text(&mut app, SettingKey::FrameRate), expected);
            assert_panel_preserved(&mut app, &identity, area, offset);
            assert_eq!(
                app.world().resource::<MenuFocus>().0,
                app.world().get::<MenuButton>(button).unwrap().index
            );
            assert_eq!(
                *app.world().resource::<MenuInputSource>(),
                MenuInputSource::Pointer
            );
            *app.world_mut().get_mut::<Interaction>(button).unwrap() = Interaction::None;
            app.update();
        }
        // 数值边界 no-op 也不能因资源的 changed 标记而销毁页面。
        app.world_mut().resource_mut::<SettingsDraft>().max_fps = 240;
        app.update();
        let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        request_action(&mut app, UiAction::Adjust(SettingKey::FrameRate, 1));
        assert_eq!(setting_text(&mut app, SettingKey::FrameRate), "240 FPS");
        assert_panel_preserved(&mut app, &identity, area, offset);
    }

    #[test]
    fn defaults_apply_errors_and_other_values_preserve_scroll_but_real_page_changes_rebuild() {
        let mut app = live_settings_app();
        let folder = std::path::PathBuf::from("tmp/ui-scroll-edit-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&folder).unwrap();
        let saved = folder.join("settings.json");
        app.world_mut()
            .insert_resource(crate::settings::SettingsFile(saved.clone()));
        let (area, _) = scroll_settings_for_edit(&mut app);
        let identity = settings_identity(&mut app);
        for action in [
            UiAction::Adjust(SettingKey::FrameRate, 1),
            UiAction::RestoreDefaults,
            UiAction::ApplySettings,
        ] {
            let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
            request_action(&mut app, action);
            assert_panel_preserved(&mut app, &identity, area, offset);
            let world = app.world_mut();
            let status = world
                .query_filtered::<&Text, With<SettingsStatus>>()
                .single(world)
                .unwrap();
            assert_eq!(
                status.0,
                world
                    .resource::<MenuState>()
                    .status
                    .as_deref()
                    .unwrap_or(DEFAULT_SETTINGS_STATUS)
            );
        }
        assert!(saved.is_file());
        // 真实保存失败提示更长，但也只能更改文字和合法滚动范围。
        app.world_mut()
            .insert_resource(crate::settings::SettingsFile(folder.clone()));
        let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        request_action(&mut app, UiAction::ApplySettings);
        assert_panel_preserved(&mut app, &identity, area, offset);
        assert!(
            app.world()
                .resource::<MenuState>()
                .status
                .as_ref()
                .unwrap()
                .starts_with("Could not save")
        );
        let world = app.world_mut();
        let status = world
            .query_filtered::<&Text, With<SettingsStatus>>()
            .single(world)
            .unwrap();
        assert_eq!(
            status.0,
            world
                .resource::<MenuState>()
                .status
                .as_ref()
                .unwrap()
                .as_str()
        );
        assert!(status.0.starts_with("Could not save"));
        request_action(&mut app, UiAction::SelectTab(SettingsTab::Controls));
        assert!(app.world().get_entity(area).is_err());
        let new_area = app
            .world_mut()
            .query_filtered::<Entity, With<MenuScroll>>()
            .single(app.world())
            .unwrap();
        assert_eq!(app.world().get::<ScrollPosition>(new_area).unwrap().y, 0.0);
        let (area, _) = scroll_settings_for_edit(&mut app);
        let identity = settings_identity(&mut app);
        for (key, expected) in [
            (SettingKey::MouseSensitivity, "117%"),
            (SettingKey::InvertY, "On"),
        ] {
            let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
            request_action(&mut app, UiAction::Adjust(key, 1));
            assert_eq!(setting_text(&mut app, key), expected);
            assert_panel_preserved(&mut app, &identity, area, offset);
        }
        // 重选当前分类保持同一树；退出再进入则仍应建立新页面并从顶部开始。
        let offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        request_action(&mut app, UiAction::SelectTab(SettingsTab::Controls));
        assert_panel_preserved(&mut app, &identity, area, offset);
        request_action(&mut app, UiAction::Back);
        assert!(app.world().get_entity(area).is_err());
        request_action(&mut app, UiAction::OpenSettings);
        let new_area = app
            .world_mut()
            .query_filtered::<Entity, With<MenuScroll>>()
            .single(app.world())
            .unwrap();
        assert_eq!(app.world().get::<ScrollPosition>(new_area).unwrap().y, 0.0);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn volume_updates_preserve_scrolled_panel_slider_and_navigation_focus() {
        use crate::ui::volume::VolumeSlider;

        let mut app = live_settings_app();
        request_action(&mut app, UiAction::SelectTab(SettingsTab::Audio));
        // 先让真实布局完成并建立导航焦点，再滚出非零偏移，避免焦点滚入掩盖重建。
        app.world_mut().resource_mut::<MenuFocus>().0 = 5;
        for _ in 0..3 {
            app.update();
        }
        let (area, _) = scroll_settings_for_edit(&mut app);
        let identity = settings_identity(&mut app);
        let slider = app
            .world_mut()
            .query::<(Entity, &VolumeSlider)>()
            .iter(app.world())
            .find_map(|(entity, slider)| (slider.key == SettingKey::MasterVolume).then_some(entity))
            .unwrap();
        let old_offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        request_action(&mut app, UiAction::SetVolume(SettingKey::MasterVolume, 37));
        assert_panel_preserved(&mut app, &identity, area, old_offset);
        assert!(app.world().get::<VolumeSlider>(slider).is_some());
        assert_eq!(app.world().resource::<MenuFocus>().0, 5);
        let group = app.world().get::<ChildOf>(slider).unwrap().parent();
        let world = app.world_mut();
        let value = world
            .query::<(Entity, &Text, &ComputedNode, &TextLayoutInfo)>()
            .iter(world)
            .find(|(entity, text, _, _)| descends_from(world, *entity, group) && text.0 == "37%")
            .unwrap();
        assert!(value.2.size().x > 0.0 && value.2.size().y > 0.0 && !value.3.glyphs.is_empty());
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            37
        );
        let old_offset = app.world().get::<ScrollPosition>(area).unwrap().y;
        request_action(&mut app, UiAction::RestoreDefaults);
        assert_panel_preserved(&mut app, &identity, area, old_offset);
        assert!(app.world().get::<VolumeSlider>(slider).is_some());
        assert_eq!(
            app.world().resource::<SettingsDraft>().audio.master_volume,
            100
        );
    }

    #[test]
    fn height_only_resize_rebuilds_fixed_menu() {
        let mut app = crate::ui::widgets::tests::layout_app(UVec2::new(1440, 810));
        let theme = layout_theme(&mut app);
        app.insert_resource(theme)
            .init_resource::<MenuState>()
            .init_resource::<SettingsDraft>()
            .add_systems(Update, rebuild_page);
        let window = app
            .world_mut()
            .spawn((
                Window {
                    resolution: (1440, 810).into(),
                    ..default()
                },
                PrimaryWindow,
            ))
            .id();
        app.update();
        let original_root = app
            .world_mut()
            .query_filtered::<Entity, With<MenuRoot>>()
            .single(app.world())
            .unwrap();
        app.update();
        assert!(app.world().get_entity(original_root).is_ok());
        let original_font_size = app
            .world_mut()
            .query::<(&Text, &TextFont)>()
            .iter(app.world())
            .find(|(text, _)| text.0 == "ISLAND")
            .unwrap()
            .1
            .font_size;
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .resolution
            .set(1440.0, 720.0);
        app.update();
        assert!(app.world().get_entity(original_root).is_err());
        let resized_font_size = app
            .world_mut()
            .query::<(&Text, &TextFont)>()
            .iter(app.world())
            .find(|(text, _)| text.0 == "ISLAND")
            .unwrap()
            .1
            .font_size;
        assert_ne!(original_font_size, resized_font_size);
    }

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
        assert_eq!(actions(help_page(&theme)), vec![UiAction::Back]);
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
        state.tab = SettingsTab::Audio;
        let audio = actions(settings_page(
            &theme,
            &state,
            &SettingsDraft::default(),
            false,
        ));
        assert_eq!(
            &audio[4..14],
            &[
                UiAction::Adjust(SettingKey::MasterVolume, -1),
                UiAction::Adjust(SettingKey::MasterVolume, 0),
                UiAction::Adjust(SettingKey::MasterVolume, 1),
                UiAction::Adjust(SettingKey::SfxVolume, -1),
                UiAction::Adjust(SettingKey::SfxVolume, 0),
                UiAction::Adjust(SettingKey::SfxVolume, 1),
                UiAction::Adjust(SettingKey::UiVolume, -1),
                UiAction::Adjust(SettingKey::UiVolume, 0),
                UiAction::Adjust(SettingKey::UiVolume, 1),
                UiAction::TestSfx,
            ]
        );
        assert_eq!(
            &audio[14..],
            &[
                UiAction::RestoreDefaults,
                UiAction::ApplySettings,
                UiAction::Back
            ]
        );
        state.tab = SettingsTab::Accessibility;
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

    #[test]
    fn volume_and_status_changes_keep_the_current_bsn_tree_and_focus() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default(), ScenePlugin))
            .init_asset::<Font>()
            .insert_resource(test_theme())
            .insert_resource(MenuState {
                page: MenuPage::Settings,
                tab: SettingsTab::Audio,
                ..default()
            })
            .init_resource::<SettingsDraft>()
            .insert_resource(MenuFocus(5))
            .insert_resource(MenuInputSource::Navigation)
            .add_message::<super::super::UiRequest>()
            .configure_sets(Update, (UiSystems::Build, UiSystems::Style).chain());
        register(&mut app);
        super::super::volume::register(&mut app);
        app.finish();
        app.cleanup();
        app.update();
        let root = app
            .world_mut()
            .query_filtered::<Entity, With<MenuRoot>>()
            .single(app.world())
            .unwrap();
        let slider = app
            .world_mut()
            .query::<(Entity, &super::super::volume::VolumeSlider)>()
            .iter(app.world())
            .find_map(|(entity, slider)| (slider.key == SettingKey::MasterVolume).then_some(entity))
            .unwrap();
        app.world_mut()
            .resource_mut::<SettingsDraft>()
            .set_volume(SettingKey::MasterVolume, 0);
        app.world_mut().resource_mut::<MenuState>().status = Some("Settings applied.".into());
        app.update();
        assert!(app.world().get::<MenuRoot>(root).is_some());
        assert!(
            app.world()
                .get::<super::super::volume::VolumeSlider>(slider)
                .is_some()
        );
        assert_eq!(app.world().resource::<MenuFocus>().0, 5);
        assert_eq!(app.world().get::<BackgroundColor>(slider).unwrap().0, GOLD);
        let mut text = app.world_mut().query::<&Text>();
        assert!(text.iter(app.world()).any(|text| text.0 == "Muted"));
        assert!(
            text.iter(app.world())
                .any(|text| text.0 == "Settings applied.")
        );
        app.world_mut().resource_mut::<MenuState>().tab = SettingsTab::Controls;
        app.update();
        assert!(
            app.world().get_entity(root).is_err(),
            "Changing category must still rebuild the page"
        );
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
