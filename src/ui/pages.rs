//! 菜单的 BSN 页面与结构重建；数值、焦点与保存提示由视觉系统原位刷新。

use bevy::{prelude::*, window::PrimaryWindow};

use crate::settings::SettingsDraft;

use super::{
    MenuPage, MenuRoot, MenuState, SettingKey, SettingsTab, UiAction, UiSystems,
    scroll::settings_scroll_frame, style::setting_value, theme::*, volume::volume_row, widgets::*,
};

#[derive(Component, Default, Clone)]
pub(super) struct DescriptionTitle;

#[derive(Component, Default, Clone)]
pub(super) struct DescriptionBody;

/// 只有纸色设置面板包含滚动内容；分类菜单与底部操作保持为外部兄弟节点。
#[derive(Component, Default, Clone)]
pub(super) struct SettingsPanel;

/// 保存结果和草稿提示原位更新，不改变滚动区域或按钮的实体身份。
#[derive(Component, Default, Clone)]
pub(super) struct SettingsStatus;

pub(super) const DEFAULT_SETTINGS_STATUS: &str = "Changes are saved only when you choose Apply.";

pub(super) fn register(app: &mut App) {
    app.init_resource::<UiTheme>()
        .add_systems(Update, rebuild_page.in_set(UiSystems::Build));
}

/// 只在页面结构或视口变化时重建；数值、提示与焦点变化保留现有滚动控件。
pub(super) fn rebuild_page(
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
pub(super) fn page_scene(
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
            // 根固定在视口内；正文由内层滚动区承接，避免自动最小高度把整页撑出窗口。
            min_height: px(0),
            flex_direction: FlexDirection::Column,
        }
        BackgroundColor({if state.page == MenuPage::Pause {
                    Color::srgba(0.06, 0.10, 0.15, 0.68)
                } else {
                    Color::NONE
        }})
        Children [
            @{content}
            --
            @footer(&theme)
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

/// 主菜单与暂停页复用相同结构，根据会话状态选择动作。
pub(super) fn main_page(theme: &UiTheme, paused: bool) -> impl Scene + use<> {
    let scale = theme.scale;
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
        Box::new(bsn_list! {})
    } else {
        Box::new(bsn_list! {
            @placeholder_row(theme, "Continue", true)
            --
            @placeholder_row(theme, "Multiplayer", true)
        })
    };
    bsn! {
        @fixed_page_area(theme)
        Node { flex_direction: FlexDirection::Row, align_items: AlignItems::FlexStart }
        Children [
            column(16.0 * scale)
            Node {
                width: percent(32),
                min_width: px(theme.size(280.0)),
                max_width: px(theme.size(490.0)),
                flex_shrink: 0.0,
            }
            Children [
                @logo(theme, false)
                --
                column(8.0 * scale)
                Children [
                    @fixed_menu_button(theme, first_title, ">", first_action, 0)
                    --
                    {placeholders}
                    --
                    @fixed_menu_button(theme, "Settings", "+", UiAction::OpenSettings, 1)
                    --
                    @fixed_menu_button(theme, "How to Play", "?", UiAction::OpenHelp, 2)
                    --
                    @fixed_menu_button(theme, last_title, "<", last_action, 3)
                ]
                --
                Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
                Children [
                    Node {
                        width: px(theme.size(9.0)),
                        height: px(theme.size(9.0)),
                        border_radius: BorderRadius::MAX,
                    }
                    BackgroundColor(GOLD)
                    --
                    @label(theme, if paused { "DELIVERIES ON HOLD" } else { "SINGLE PLAYER" }, 15.0, CREAM)
                ]
            ]
            --
            Node {
                flex_grow: 1.0,
                min_width: px(0),
                align_self: AlignSelf::FlexEnd,
                justify_content: JustifyContent::FlexEnd,
                padding: UiRect::bottom(px(theme.size(20.0))),
            }
            Children [
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
                    @heading(theme, tag_title, 24.0, GOLD)
                    --
                    @label(theme, tag_body, 17.0, CREAM)
                ]
            ]
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
            @label(theme, "ISLAND DELIVERY CO.  /  HANDLE WITH CARE", 14.0, CREAM)
            --
            Node {
                column_gap: px(theme.size(17.0)),
                row_gap: px(theme.size(8.0)),
                flex_wrap: FlexWrap::Wrap,
                align_items: AlignItems::Center,
            }
            Children [
                @input_hint(theme, "Arrows", "Navigate")
                --
                @input_hint(theme, "Enter", "Confirm")
                --
                @input_hint(theme, "Esc", "Back")
            ]
        ]
    }
}

fn input_hint(theme: &UiTheme, key: &'static str, title: &'static str) -> impl Scene + use<> {
    bsn! {
        Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
        Children [
            @keycap(theme, key, true)
            --
            @label(theme, title, 17.0, CREAM)
        ]
    }
}

fn sidebar(theme: &UiTheme, state: &MenuState) -> impl Scene + use<> {
    let scale = theme.scale;
    bsn! {
        column(25.0 * scale)
        Node { width: percent(24), min_width: px(theme.size(205.0)), flex_shrink: 0.0 }
        Children [
            @logo(theme, true)
            --
            column(12.0 * scale)
            Children [
                @menu_button(theme, "Graphics", "+", UiAction::SelectTab(SettingsTab::Graphics), 0)
                --
                @menu_button(theme, "Audio", "~", UiAction::SelectTab(SettingsTab::Audio), 1)
                --
                @menu_button(theme, "Controls", ">", UiAction::SelectTab(SettingsTab::Controls), 2)
                --
                @menu_button(theme, "Accessibility", "+", UiAction::SelectTab(SettingsTab::Accessibility), 3)
            ]
            --
            @label(theme, if state.return_page == MenuPage::Pause {
                    "Your game is paused."
                } else {
                    "Make yourself at home."
                }, 17.0, CREAM)
            TextShadow { offset: {Vec2::new(1.0, 1.0)}, color: INK }
        ]
    }
}

/// 按当前分类和草稿声明设置页面，紧凑模式适配较窄窗口。
pub(super) fn settings_page(
    theme: &UiTheme,
    state: &MenuState,
    draft: &SettingsDraft,
    compact: bool,
) -> impl Scene + use<> {
    let scale = theme.scale;
    let (category, next_index) = match state.tab {
        SettingsTab::Graphics => ("GRAPHICS", 6),
        SettingsTab::Audio => ("AUDIO", 14),
        SettingsTab::Controls => ("CONTROLS", 8),
        SettingsTab::Accessibility => ("ACCESSIBILITY", 4),
    };
    let rows: Box<dyn Scene> = match state.tab {
        SettingsTab::Graphics => Box::new(bsn! {
            column(13.0 * scale)
            Children [
                @placeholder_row(theme, "Window Mode", false)
                --
                @placeholder_row(theme, "Resolution", false)
                --
                @placeholder_row(theme, "VSync", false)
                --
                @setting_row(theme, "Frame Rate Limit", setting_value(draft, SettingKey::FrameRate), SettingKey::FrameRate, 4,
                    "Choose the maximum frame rate. A higher limit feels smoother when your computer can keep up. This setting does not change movement speed.")
                --
                @placeholder_row(theme, "Shadow Quality", false)
                --
                @placeholder_row(theme, "Anti-Aliasing", false)
                --
                @placeholder_row(theme, "View Distance", false)
            ]
        }),
        SettingsTab::Audio => Box::new(bsn! {
            column(13.0 * scale)
            Children [
                @volume_row(theme, "Master Volume", draft.audio.master_volume, SettingKey::MasterVolume, 4,
                    "Adjust every sound together. Changes are heard immediately. Choose Apply to save, or Back to restore the last applied volumes.")
                --
                @volume_row(theme, "SFX Volume", draft.audio.sfx_volume, SettingKey::SfxVolume, 7,
                    "Adjust pickup, release, landing and carry warning sounds. Use Test SFX to hear a pickup sample in this menu.")
                --
                @volume_row(theme, "UI Volume", draft.audio.ui_volume, SettingKey::UiVolume, 10,
                    "Adjust menu navigation, confirmation and back sounds. Dragging previews the volume without repeated confirmation sounds.")
                --
                @placeholder_row(theme, "Music Volume", false)
                --
                @small_button(theme, "Test SFX", UiAction::TestSfx, 13)
                --
                @label(theme, "Preview changes now. Choose Apply to save.", 17.0, MUTED)
            ]
        }),
        SettingsTab::Controls => Box::new(bsn! {
            column(13.0 * scale)
            Children [
                @setting_row(theme, "Mouse Sensitivity", setting_value(draft, SettingKey::MouseSensitivity), SettingKey::MouseSensitivity, 4,
                    "Adjust how far the first-person camera turns when you move the mouse. 100% is the default sensitivity.")
                --
                @setting_row(theme, "Invert Camera Y", setting_value(draft, SettingKey::InvertY), SettingKey::InvertY, 6,
                    "Reverse vertical mouse movement. When enabled, moving the mouse upward tilts the camera downward.")
                --
                @placeholder_row(theme, "Rebind Keys", false)
                --
                @label(theme, "Move with WASD. Look around with the mouse.", 17.0, MUTED)
            ]
        }),
        SettingsTab::Accessibility => Box::new(bsn! {
            column(13.0 * scale)
            Children [
                @placeholder_row(theme, "UI Scale", false)
                --
                @placeholder_row(theme, "Camera Shake", false)
                --
                @label(theme, "More ways to make the island yours.", 17.0, MUTED)
            ]
        }),
    };
    let status = state.status.as_deref().unwrap_or(DEFAULT_SETTINGS_STATUS);
    // 纸色设置面板中的内容整体滚动，页面外壳、分类菜单和底部操作始终固定。
    let content = bsn! {
        column(18.0 * scale)
        Node { width: percent(100), flex_shrink: 0.0 }
        Children [
            @heading(theme, "SETTINGS", 44.0, INK)
            --
            Node {
                height: px(theme.size(4.0)),
                width: px(theme.size(70.0)),
                border_radius: BorderRadius::MAX,
                flex_shrink: 0.0,
            }
            BackgroundColor(GOLD)
            --
            Node {
                column_gap: px(theme.size(18.0)),
                row_gap: px(theme.size(19.0)),
                flex_direction: {if compact { FlexDirection::Column } else { FlexDirection::Row }},
                flex_shrink: 0.0,
            }
            Children [
                column(21.0 * scale)
                Node {
                    flex_grow: 1.0,
                    flex_basis: {if compact { Val::Auto } else { percent(66) }},
                    min_width: px(0),
                }
                Children [
                    @heading(theme, category, 27.0, INK)
                    --
                    @{rows}
                ]
                --
                @description_panel(theme, compact)
            ]
            --
            @label(theme, status.to_owned(), 17.0, MUTED) SettingsStatus
        ]
    };
    bsn! {
        @fixed_page_area(theme)
        Node {
            column_gap: px(theme.size(27.0)),
            align_items: AlignItems::Stretch,
            min_width: px(0),
        }
        Children [
            @sidebar(theme, state)
            --
            column(18.0 * scale)
            Node { flex_grow: 1.0, flex_basis: px(0), min_height: px(0) }
            Children [
                SettingsPanel
                @paper_panel(theme)
                Node {
                    flex_grow: 1.0,
                    flex_basis: px(0),
                    min_height: px(0),
                    min_width: px(0),
                    // 固定面板高度由页面剩余空间决定，内容不会撑高整个页面。
                    overflow: Overflow::clip(),
                }
                Children [
                    @settings_scroll_frame(theme, content)
                ]
                --
                Node {
                    width: percent(100),
                    justify_content: JustifyContent::SpaceBetween,
                    column_gap: px(theme.size(12.0)),
                    row_gap: px(theme.size(10.0)),
                    flex_wrap: FlexWrap::Wrap,
                    flex_shrink: 0.0,
                }
                Children [
                    @small_button(theme, "Restore Defaults", UiAction::RestoreDefaults, next_index)
                    --
                    Node {
                        column_gap: px(theme.size(12.0)),
                        row_gap: px(theme.size(10.0)),
                        flex_wrap: FlexWrap::Wrap,
                    }
                    Children [
                        @small_button(theme, "Apply", UiAction::ApplySettings, next_index + 1)
                        --
                        @small_button(theme, "Back", UiAction::Back, next_index + 2)
                    ]
                ]
            ]
        ]
    }
}

fn description_panel(theme: &UiTheme, compact: bool) -> impl Scene + use<> {
    let scale = theme.scale;
    bsn! {
        column(14.0 * scale)
        Node {
            flex_basis: {if compact { Val::Auto } else { percent(30) }},
            flex_grow: 1.0,
            min_width: px(0),
            padding: px(theme.size(18.0)),
            border_radius: BorderRadius::all(px(7)),
        }
        BackgroundColor(SUBTLE)
        Children [
            @heading(theme, "A LITTLE FINE-TUNING", 25.0, INK)
            DescriptionTitle
            --
            @label(theme, "Select a setting to see what it does. Use the arrows to change its value, then Apply to save.", 18.0, MUTED)
            DescriptionBody
            --
            Node {
                margin: UiRect::top(px(theme.size(12.0))),
                align_items: AlignItems::Center,
                column_gap: px(theme.size(9.0)),
            }
            Children [
                @parcel_stamp(theme)
                --
                @heading(theme, "HANDLE WITH CARE", 17.0, INK)
            ]
        ]
    }
}

/// 支持的 16:9 窗口始终显示三列说明；减少重复品牌标题，完整保留正文和键位。
pub(super) fn help_page(theme: &UiTheme) -> impl Scene + use<> {
    let scale = theme.scale;
    bsn! {
        @fixed_page_area(theme)
        Node {
            flex_direction: FlexDirection::Column,
            row_gap: px(theme.size(16.0)),
        }
        Children [
            @paper_panel(theme)
            Node {
                flex_direction: FlexDirection::Row,
                align_items: AlignItems::Center,
                padding: px(theme.size(12.0)),
                column_gap: px(theme.size(18.0)),
                flex_shrink: 0.0,
            }
            Children [
                @parcel_stamp(theme)
                --
                column(5.0 * scale)
                Node { flex_grow: 1.0 }
                Children [
                    @heading(theme, "HOW TO PLAY", 36.0, INK)
                    --
                    @label(theme, "Grab a parcel. Find your stride. Enjoy the island.", 18.0, MUTED)
                ]
            ]
            --
            Node {
                width: percent(100),
                column_gap: px(theme.size(16.0)),
                flex_shrink: 0.0,
            }
            Children [
                @help_card(theme, "01", "MOVE & JUMP", "WASD", "Space", "Move", "Jump",
                    "Move relative to the camera. Build up speed, coast to a stop, and jump while grounded.")
                --
                @help_card(theme, "02", "CARRY & DROP", "E", "E again", "Pick up", "Release",
                    "Get close to a parcel with a clear path. Hold it with physics, then release it to let gravity do the rest.")
                --
                @help_card(theme, "03", "CAMERA & PAUSE", "Mouse", "Esc", "Look around", "Pause",
                    "Use the mouse to look around in first-person. Press Esc to pause and resume.")
            ]
            --
            @paper_panel(theme)
            Node {
                flex_direction: FlexDirection::Row,
                align_items: AlignItems::Center,
                padding: px(theme.size(12.0)),
                flex_shrink: 0.0,
            }
            Children [
                @label(theme, "One courier. One box at a time. Take it easy out there.", 19.0, INK)
                Node { flex_grow: 1.0 }
                --
                @small_button(theme, "Back", UiAction::Back, 0)
            ]
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
        @paper_panel(theme)
        Node {
            flex_grow: 1.0,
            flex_basis: px(0),
            min_height: px(theme.size(275.0)),
            padding: px(theme.size(14.0)),
            row_gap: px(theme.size(12.0)),
        }
        Children [
            Node { align_items: AlignItems::Center, column_gap: px(theme.size(12.0)) }
            Children [
                Node {
                    width: px(theme.size(34.0)),
                    height: px(theme.size(34.0)),
                    border_radius: BorderRadius::all(px(5)),
                    justify_content: JustifyContent::Center,
                    align_items: AlignItems::Center,
                    flex_shrink: 0.0,
                }
                BackgroundColor(GOLD)
                Children [
                    @heading(theme, number, 26.0, INK)
                ]
                --
                @heading(theme, title, 26.0, INK)
            ]
            --
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: px(theme.size(6.0)),
            }
            Children [
                @help_hint(theme, key_one, action_one)
                --
                @help_hint(theme, key_two, action_two)
            ]
            --
            @label(theme, details, 19.0, MUTED)
            // 文字测量宽度不含行尾空白，而 Parley 字形布局尺寸会计入其 advance。
            // 正文明确占满卡片，并预留少量右侧换行余量，避免尾部越过文本节点。
            Node {
                width: percent(100),
                padding: UiRect::right(px(theme.size(8.0).max(8.0))),
            }
        ]
    }
}

fn help_hint(theme: &UiTheme, key: &'static str, title: &'static str) -> impl Scene + use<> {
    bsn! {
        Node { align_items: AlignItems::Center, column_gap: px(theme.size(8.0)) }
        Children [
            @keycap(theme, key, false)
            --
            @label(theme, title, 18.0, INK)
        ]
    }
}
