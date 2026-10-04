//! BSN 控件只声明实体结构；按钮行为由菜单输入与请求系统处理。
//! Scene 拥有已复制的组件与句柄；精确捕获声明避免 Rust 2024 延长装配参数的借用。

use bevy::{
    camera::visibility::VisibilitySystems,
    input::mouse::MouseScrollUnit,
    picking::{Pickable, hover::Hovered},
    prelude::*,
    text::FontSourceTemplate,
    ui_widgets::{ControlOrientation, Scrollbar, ScrollbarDragState, ScrollbarThumb},
};

use super::{
    MenuButton, MenuInputSource, MenuPage, MenuState, SettingKey, UiAction, UiSystems, theme::*,
};

/// 说明文本属于按钮实体，焦点变化时只更新右侧说明，不重建页面。
#[derive(Component, Default, Clone)]
pub(super) struct SettingDescription {
    pub title: &'static str,
    pub body: &'static str,
}

/// 数值文字只保存对应字段；草稿变化时原位更新 Text，不销毁滚动区域和焦点实体。
#[derive(Component, Clone)]
pub(super) struct SettingValue(pub SettingKey);

impl Default for SettingValue {
    fn default() -> Self {
        // BSN 模板需要组件初值；setting_row 装配时始终用实际字段 key 覆盖它。
        Self(SettingKey::FrameRate)
    }
}

/// 可滚动区域的标记；用于键盘导航时把当前按钮滚入视野。
#[derive(Component, Default, Clone)]
pub(super) struct MenuScroll;

/// 轨道和滚动区域为同一 BSN 容器的子实体，绑定系统只为设置控件建立原生 target。
#[derive(Component, Clone, Default)]
pub(super) struct SettingsScrollbar {
    min_thumb_length: f32,
}

/// 滑块无按钮动作或导航序号，拖拽生命周期由 Bevy 原生 ScrollbarPlugin 管理。
#[derive(Component, Clone, Default)]
struct SettingsScrollbarThumb;

pub(super) fn register(app: &mut App) {
    app.init_resource::<MenuInputSource>()
        // BSN 子树先生成并应用延迟命令，之后再用真实 sibling 实体绑定原生滚动条。
        .add_systems(
            Update,
            bind_settings_scrollbars
                .after(UiSystems::Build)
                .before(UiSystems::Style),
        )
        .add_systems(
            PostUpdate,
            // 原生滑块在 Layout 内已根据本帧几何定位；源偏移按相同范围夹取不会改变其结果。
            // 显隐先于可见性传播，同帧裁切和下一帧命中均能得到一致状态。
            sync_settings_scrollbars
                .after(bevy::ui::UiSystems::Layout)
                .before(VisibilitySystems::VisibilityPropagate),
        );
}

/// 纸色面板内的内容与轨道共用剩余高度，外层负责固定分类和操作行。
/// 保留窄 gutter，显隐不改变正文宽度或触发溢出振荡；内边距由纸色面板提供。
pub(super) fn settings_scroll_frame<Content: Scene>(
    theme: &UiTheme,
    content: Content,
) -> impl Scene + use<Content> {
    bsn! {
        Node {
            width: percent(100),
            min_width: px(0),
            min_height: px(0),
            flex_grow: 1.0,
            flex_basis: px(0),
            padding: UiRect::right(px(theme.size(24.0).max(20.0))),
        }
        Children [
            (
                scroll_area(theme)
                Node {
                    padding: UiRect::ZERO,
                }
                Children [({content})]
            ),
            settings_scrollbar(theme),
        ]
    }
}

fn settings_scrollbar(theme: &UiTheme) -> impl Scene + use<> {
    bsn! {
        template_value(SettingsScrollbar { min_thumb_length: theme.size(28.0).max(22.0) })
        Node {
            position_type: PositionType::Absolute,
            right: px(theme.size(7.0).max(5.0)),
            top: px(0),
            bottom: px(0),
            width: px(theme.size(10.0).max(10.0)),
            border_radius: BorderRadius::MAX,
        }
        BackgroundColor(Color::srgba(0.06, 0.10, 0.15, 0.45))
        Visibility::Hidden
        Pickable::IGNORE
        // Enhanced Input 负责菜单语义，控件的命中坐标、拖拽和轨道分页复用 Bevy 指针事件。
        on(scrollbar_pointer_source)
        on(scroll_over_settings_scrollbar)
        Children [(
            SettingsScrollbarThumb
            template_value(ScrollbarThumb {
                border_radius: BorderRadius::MAX,
                border: UiRect::all(px(1)),
            })
            // 原生滑块不带 Node，避免 UI layout 与 ScrollbarPlugin 两次写入几何。
            template_value(Hovered::default())
            Pickable::IGNORE
            BackgroundColor(CREAM)
            BorderColor::all(INK)
            on(scrollbar_pointer_source)
        )]
    }
}

fn bind_settings_scrollbars(
    mut commands: Commands,
    tracks: Query<(Entity, &ChildOf, &SettingsScrollbar), Without<Scrollbar>>,
    children: Query<&Children>,
    areas: Query<(), With<MenuScroll>>,
) {
    for (entity, parent, style) in &tracks {
        let Ok(siblings) = children.get(parent.parent()) else {
            continue;
        };
        let Some(target) = siblings.iter().find(|sibling| areas.contains(*sibling)) else {
            continue;
        };
        commands.entity(entity).insert(Scrollbar::new(
            target,
            ControlOrientation::Vertical,
            style.min_thumb_length,
        ));
    }
}

fn sync_settings_scrollbars(
    state: Option<Res<MenuState>>,
    source: Res<MenuInputSource>,
    mut areas: Query<(&ComputedNode, &mut ScrollPosition), With<MenuScroll>>,
    mut tracks: Query<
        (&Scrollbar, &Children, &mut Visibility, &mut Pickable),
        (With<SettingsScrollbar>, Without<SettingsScrollbarThumb>),
    >,
    mut thumbs: Query<
        (
            &Hovered,
            &mut ScrollbarDragState,
            &mut BackgroundColor,
            &mut Pickable,
        ),
        (With<SettingsScrollbarThumb>, Without<SettingsScrollbar>),
    >,
) {
    let settings_active = state.is_none_or(|state| state.page == MenuPage::Settings);
    for (scrollbar, children, mut visibility, mut pickable) in &mut tracks {
        let Ok((node, mut position)) = areas.get_mut(scrollbar.target) else {
            continue;
        };
        let range = vertical_scroll_range(node);
        let shown = settings_active && node.size().y > 0.0 && range > 0.0;
        let normalized = Vec2::new(
            0.0,
            if settings_active {
                position.y.clamp(0.0, range)
            } else {
                0.0
            },
        );
        if position.0 != normalized {
            position.0 = normalized;
        }
        let next_visibility = if shown {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        };
        if *visibility != next_visibility {
            *visibility = next_visibility;
            debug!(
                scroll_area = ?scrollbar.target,
                visible = shown,
                content_height = node.content_size().y * node.inverse_scale_factor(),
                viewport_height = (node.size().y - node.scrollbar_size.y) * node.inverse_scale_factor(),
                reason = "layout_overflow",
                "Settings scrollbar visibility changed"
            );
        }
        pickable.set_if_neq(if shown {
            Pickable::default()
        } else {
            Pickable::IGNORE
        });
        for child in children {
            let Ok((Hovered(hovered), mut drag, mut background, mut thumb_pickable)) =
                thumbs.get_mut(*child)
            else {
                continue;
            };
            if !shown && drag.dragging {
                drag.dragging = false;
            }
            thumb_pickable.set_if_neq(if shown {
                Pickable::default()
            } else {
                Pickable::IGNORE
            });
            let highlighted = drag.dragging || (*source == MenuInputSource::Pointer && *hovered);
            let color = if highlighted { GOLD } else { CREAM };
            if background.0 != color {
                background.0 = color;
            }
        }
    }
}

fn scrollbar_pointer_source(_: On<Pointer<Press>>, mut source: ResMut<MenuInputSource>) {
    *source = MenuInputSource::Pointer;
}

/// 滚轮落在右侧轨道或滑块时仍控制其目标区域，不另行消费底层 MouseWheel。
fn scroll_over_settings_scrollbar(
    mut event: On<Pointer<Scroll>>,
    state: Option<Res<MenuState>>,
    tracks: Query<&Scrollbar, With<SettingsScrollbar>>,
    mut areas: Query<(&mut ScrollPosition, &ComputedNode), With<MenuScroll>>,
) {
    if state.is_some_and(|state| state.page != MenuPage::Settings) {
        return;
    }
    let Ok(scrollbar) = tracks.get(event.entity) else {
        return;
    };
    let Ok((mut position, node)) = areas.get_mut(scrollbar.target) else {
        return;
    };
    position.y =
        (position.y - wheel_delta(event.unit, event.y)).clamp(0.0, vertical_scroll_range(node));
    event.propagate(false);
}

fn vertical_scroll_range(node: &ComputedNode) -> f32 {
    (node.content_size().y - (node.size().y - node.scrollbar_size.y)).max(0.0)
        * node.inverse_scale_factor()
}

fn wheel_delta(unit: MouseScrollUnit, y: f32) -> f32 {
    match unit {
        MouseScrollUnit::Line => y * 32.0,
        MouseScrollUnit::Pixel => y,
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
        // 文字保留自动最小宽度；显式设为 0 会让 Bevy 0.19 把横排测量宽度也解析成 0。
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
    bsn! {
        Button
        template_value(MenuButton { action, index })
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
        template_value(paper_shadow(theme.scale))
        Children [
            (
                Node {
                    width: px(theme.size(if fixed_menu { 30.0 } else { 36.0 })),
                    justify_content: JustifyContent::Center,
                    flex_shrink: 0.0,
                }
                Children [heading(theme, icon, if fixed_menu { 27.0 } else { 31.0 }, INK)]
            ),
            (
                label(theme, title, if fixed_menu { 24.0 } else { 27.0 }, INK)
                Node { flex_grow: 1.0 }
            ),
            heading(theme, ">", if fixed_menu { 22.0 } else { 24.0 }, INK),
        ]
    }
}

pub(super) fn small_button(
    theme: &UiTheme,
    title: &'static str,
    action: UiAction,
    index: usize,
) -> impl Scene + use<> {
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
            (
                label(theme, title, if menu { 22.0 } else { 20.0 }, MUTED)
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
                        Children [(
                            label(theme, value, 20.0, INK)
                            template_value(SettingValue(key))
                        )]
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
        Children [label(theme, key, 17.0, color)]
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

pub(super) fn logo(theme: &UiTheme, compact: bool) -> impl Scene + use<> {
    // 固定菜单标题留出六行按钮的高度；设置与帮助的小标志保持原样。
    let title_size = if compact { 50.0 } else { 56.0 };
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
pub(super) fn scroll_area(theme: &UiTheme) -> impl Scene + use<> {
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
    state: Option<Res<MenuState>>,
    mut areas: Query<(&mut ScrollPosition, &ComputedNode), With<MenuScroll>>,
) {
    if state.is_some_and(|state| state.page != MenuPage::Settings) {
        return;
    }
    let Ok((mut position, node)) = areas.get_mut(event.entity) else {
        return;
    };
    position.y =
        (position.y - wheel_delta(event.unit, event.y)).clamp(0.0, vertical_scroll_range(node));
    event.propagate(false);
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use bevy::{
        app::{HierarchyPropagatePlugin, PropagateSet},
        asset::{AssetEventSystems, AssetPlugin},
        camera::{ComputedCameraValues, NormalizedRenderTarget, RenderTargetInfo, Viewport},
        input::touch::TouchPhase,
        picking::{
            backend::HitData,
            pointer::{Location, PointerId},
        },
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
        ui_widgets::ScrollbarPlugin,
    };

    /// 使用真实字体测量与字形布局；虚拟相机只提供尺寸，不安装窗口或渲染器。
    pub(in crate::ui) fn layout_app(size: UVec2) -> App {
        layout_app_with(size, |_| {})
    }

    /// 额外输入和状态插件须在 finish 前注册，仍然不安装窗口后端或渲染器。
    pub(in crate::ui) fn layout_app_with(size: UVec2, configure: impl FnOnce(&mut App)) -> App {
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            AssetPlugin::default(),
            ScenePlugin,
            TextPlugin,
            ScrollbarPlugin,
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
                ui_layout_system.in_set(bevy::ui::UiSystems::Layout),
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
        super::register(&mut app);
        // PointerTraversal 读取 Option<&Window>；只注册组件元数据即可支持指针冒泡，
        // 否则无窗口 World 的 get_components 会因类型未注册而提前停止遍历。
        app.world_mut().register_component::<Window>();
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
        configure(&mut app);
        app.finish();
        app.cleanup();
        app
    }

    #[derive(Component, Clone, Default)]
    struct ScrollbarTestRoot;

    #[derive(Component, Clone, Default)]
    struct ScrollbarTestContent;

    #[derive(Component, Clone, Default)]
    struct ScrollbarTestPanel;

    #[derive(Component, Clone, Default)]
    struct ScrollbarTestFixedSibling;

    fn spawn_scrollbar_fixture(app: &mut App) {
        let theme = UiTheme {
            heading: default(),
            body: default(),
            scale: 1.0,
        };
        app.world_mut()
            .spawn_scene(bsn! {
                ScrollbarTestRoot
                Node {
                    width: percent(100), height: percent(100),
                    flex_direction: FlexDirection::Column,
                    row_gap: px(12), padding: px(16),
                }
                Children [
                    (
                        ScrollbarTestFixedSibling
                        Node { height: px(24), flex_shrink: 0.0 }
                    ),
                    (
                        ScrollbarTestPanel
                        paper_panel(&theme)
                        Node { width: percent(100), min_height: px(0), flex_grow: 1.0, flex_basis: px(0) }
                        Children [settings_scroll_frame(&theme, bsn! {
                            ScrollbarTestContent
                            Node { width: percent(100), height: px(1000), flex_shrink: 0.0 }
                        })]
                    ),
                    (
                        ScrollbarTestFixedSibling
                        Node { height: px(36), flex_shrink: 0.0 }
                    ),
                ]
            })
            .unwrap();
        for _ in 0..3 {
            app.update();
        }
    }

    fn scrollbar_entities(app: &mut App) -> (Entity, Entity, Entity) {
        let world = app.world_mut();
        let (track, scrollbar, children) = world
            .query_filtered::<(Entity, &Scrollbar, &Children), With<SettingsScrollbar>>()
            .single(world)
            .unwrap();
        let thumb = children
            .iter()
            .find(|entity| world.get::<ScrollbarThumb>(*entity).is_some())
            .unwrap();
        (scrollbar.target, track, thumb)
    }

    // 只向无窗口 World 注入 UI 事件，验证真正的 Bevy Observer，不模拟桌面输入。
    fn send_pointer<E: std::fmt::Debug + Clone + Reflect>(
        app: &mut App,
        entity: Entity,
        position: Vec2,
        event: E,
    ) {
        app.world_mut().trigger(Pointer::new(
            PointerId::Mouse,
            Location {
                target: NormalizedRenderTarget::None {
                    width: 480,
                    height: 400,
                },
                position,
            },
            event,
            entity,
        ));
    }

    fn pointer_hit(app: &mut App) -> HitData {
        let world = app.world_mut();
        let camera = world
            .query_filtered::<Entity, With<Camera>>()
            .single(world)
            .unwrap();
        HitData::new(camera, 0.0, None, None)
    }

    fn pointer_scroll(app: &mut App, entity: Entity, unit: MouseScrollUnit, y: f32) {
        let hit = pointer_hit(app);
        send_pointer(
            app,
            entity,
            Vec2::ZERO,
            Scroll {
                unit,
                x: 0.0,
                y,
                hit,
                phase: TouchPhase::Moved,
            },
        );
    }

    fn node_rect(world: &World, entity: Entity) -> Rect {
        let center = world
            .get::<UiGlobalTransform>(entity)
            .unwrap()
            .affine()
            .translation;
        let half_size = world.get::<ComputedNode>(entity).unwrap().size() * 0.5;
        Rect::from_corners(center - half_size, center + half_size)
    }

    #[test]
    fn settings_scrollbar_stays_inside_the_paper_panel_and_keeps_outer_siblings_fixed() {
        let mut app = layout_app(UVec2::new(480, 400));
        app.insert_resource(MenuState {
            page: MenuPage::Settings,
            ..default()
        });
        spawn_scrollbar_fixture(&mut app);
        let (area, track, _) = scrollbar_entities(&mut app);
        let world = app.world_mut();
        let panel = world
            .query_filtered::<Entity, With<ScrollbarTestPanel>>()
            .single(world)
            .unwrap();
        let content = world
            .query_filtered::<Entity, With<ScrollbarTestContent>>()
            .single(world)
            .unwrap();
        let fixed: Vec<_> = world
            .query_filtered::<Entity, With<ScrollbarTestFixedSibling>>()
            .iter(world)
            .map(|entity| (entity, node_rect(world, entity)))
            .collect();
        let panel_rect = node_rect(world, panel);
        let area_rect = node_rect(world, area);
        let track_rect = node_rect(world, track);
        let content_rect = node_rect(world, content);
        assert_eq!(world.get::<Node>(area).unwrap().padding, UiRect::ZERO);
        assert!(area_rect.min.y > panel_rect.min.y && area_rect.max.y < panel_rect.max.y);
        assert!(area_rect.max.x <= track_rect.min.x);
        assert!(track_rect.min.x > panel_rect.min.x && track_rect.max.x < panel_rect.max.x);
        assert!((track_rect.min.y - area_rect.min.y).abs() < 1.0);
        assert!((track_rect.max.y - area_rect.max.y).abs() < 1.0);

        pointer_scroll(&mut app, area, MouseScrollUnit::Line, -4.0);
        app.update();
        assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 128.0);
        assert!(node_rect(app.world(), content).min.y < content_rect.min.y);
        assert_eq!(node_rect(app.world(), panel), panel_rect);
        assert_eq!(node_rect(app.world(), track), track_rect);
        for (entity, rect) in fixed {
            assert_eq!(node_rect(app.world(), entity), rect);
            pointer_scroll(&mut app, entity, MouseScrollUnit::Line, -4.0);
        }
        assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 128.0);
    }

    #[test]
    fn settings_scrollbar_native_pointer_actions_follow_the_scroll_position_at_multiple_scales() {
        for (dpi, ui_scale) in [(1.0_f32, 1.0_f32), (2.0, 1.0), (2.0, 1.25)] {
            let mut app = layout_app((Vec2::new(480.0, 400.0) * dpi).as_uvec2());
            app.world_mut().resource_mut::<UiScale>().0 = ui_scale;
            let world = app.world_mut();
            for mut camera in world.query::<&mut Camera>().iter_mut(world) {
                camera.computed.target_info.as_mut().unwrap().scale_factor = dpi;
            }
            app.insert_resource(MenuState {
                page: MenuPage::Settings,
                ..default()
            });
            spawn_scrollbar_fixture(&mut app);
            let (area, track, thumb) = scrollbar_entities(&mut app);
            assert_eq!(
                *app.world().get::<Visibility>(track).unwrap(),
                Visibility::Inherited
            );
            assert!(app.world().get::<Node>(thumb).is_none());
            assert!(app.world().get::<MenuButton>(thumb).is_none());
            let initial_thumb = node_rect(app.world(), thumb);
            let initial_track = node_rect(app.world(), track);
            assert!((initial_thumb.min.y - initial_track.min.y).abs() < 1.0);

            pointer_scroll(&mut app, area, MouseScrollUnit::Line, -4.0);
            pointer_scroll(&mut app, thumb, MouseScrollUnit::Pixel, -16.0);
            app.update();
            assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, 144.0);
            assert!(node_rect(app.world(), thumb).min.y > initial_thumb.min.y);

            // 键盘导航直接写同一个 ScrollPosition，原生滑块应随源偏移更新。
            app.world_mut().get_mut::<ScrollPosition>(area).unwrap().y = 0.0;
            app.world_mut()
                .resource_mut::<MenuInputSource>()
                .clone_from(&MenuInputSource::Navigation);
            app.update();
            let track_rect = node_rect(app.world(), track);
            let render_scale = app
                .world()
                .get::<ComputedUiRenderTargetInfo>(track)
                .unwrap()
                .scale_factor();
            let click =
                Vec2::new(track_rect.center().x, track_rect.max.y - 1.0) * ui_scale / render_scale;
            let hit = pointer_hit(&mut app);
            send_pointer(
                &mut app,
                track,
                click,
                Press {
                    button: PointerButton::Primary,
                    hit,
                    count: 1,
                },
            );
            let area_node = app.world().get::<ComputedNode>(area).unwrap();
            let page_size = (area_node.size().y - area_node.scrollbar_size.y)
                * area_node.inverse_scale_factor();
            assert!((app.world().get::<ScrollPosition>(area).unwrap().y - page_size).abs() < 0.1);
            assert_eq!(
                *app.world().resource::<MenuInputSource>(),
                MenuInputSource::Pointer
            );

            let before = app.world().get::<ScrollPosition>(area).unwrap().y;
            let hit = pointer_hit(&mut app);
            send_pointer(
                &mut app,
                thumb,
                click,
                Press {
                    button: PointerButton::Primary,
                    hit,
                    count: 1,
                },
            );
            assert_eq!(app.world().get::<ScrollPosition>(area).unwrap().y, before);
            let hit = pointer_hit(&mut app);
            send_pointer(
                &mut app,
                thumb,
                click,
                DragStart {
                    button: PointerButton::Primary,
                    hit,
                },
            );
            assert!(
                app.world()
                    .get::<ScrollbarDragState>(thumb)
                    .unwrap()
                    .dragging
            );
            let distance = Vec2::new(0.0, 18.0 * ui_scale);
            send_pointer(
                &mut app,
                thumb,
                click,
                Drag {
                    button: PointerButton::Primary,
                    distance,
                    delta: distance,
                },
            );
            let area_node = app.world().get::<ComputedNode>(area).unwrap();
            let track_node = app.world().get::<ComputedNode>(track).unwrap();
            let content_height = area_node.content_size().y * area_node.inverse_scale_factor();
            let track_height = track_node.size().y * track_node.inverse_scale_factor();
            let range = vertical_scroll_range(area_node);
            let expected = (before + 18.0 * content_height / track_height).min(range);
            assert!((app.world().get::<ScrollPosition>(area).unwrap().y - expected).abs() < 0.1);
            send_pointer(
                &mut app,
                thumb,
                click,
                Drag {
                    button: PointerButton::Primary,
                    distance: Vec2::new(0.0, 10000.0),
                    delta: Vec2::new(0.0, 10000.0),
                },
            );
            app.update();
            assert!((app.world().get::<ScrollPosition>(area).unwrap().y - range).abs() < 0.1);
            assert!(
                (node_rect(app.world(), thumb).max.y - node_rect(app.world(), track).max.y).abs()
                    < 1.0
            );
            send_pointer(
                &mut app,
                thumb,
                click,
                DragEnd {
                    button: PointerButton::Primary,
                    distance,
                },
            );
            assert!(
                !app.world()
                    .get::<ScrollbarDragState>(thumb)
                    .unwrap()
                    .dragging
            );
            let hit = pointer_hit(&mut app);
            send_pointer(
                &mut app,
                thumb,
                click,
                DragStart {
                    button: PointerButton::Primary,
                    hit,
                },
            );
            let hit = pointer_hit(&mut app);
            send_pointer(&mut app, thumb, click, Cancel { hit });
            assert!(
                !app.world()
                    .get::<ScrollbarDragState>(thumb)
                    .unwrap()
                    .dragging
            );
        }
    }

    #[test]
    fn settings_scrollbar_hides_clamps_and_clears_drag_when_layout_or_page_changes() {
        let mut app = layout_app(UVec2::new(480, 400));
        app.insert_resource(MenuState {
            page: MenuPage::Settings,
            ..default()
        });
        spawn_scrollbar_fixture(&mut app);
        let (area, track, thumb) = scrollbar_entities(&mut app);
        pointer_scroll(&mut app, area, MouseScrollUnit::Line, -8.0);
        let hit = pointer_hit(&mut app);
        send_pointer(
            &mut app,
            thumb,
            Vec2::ZERO,
            DragStart {
                button: PointerButton::Primary,
                hit,
            },
        );
        let world = app.world_mut();
        let content = world
            .query_filtered::<Entity, With<ScrollbarTestContent>>()
            .single(world)
            .unwrap();
        world.get_mut::<Node>(content).unwrap().height = px(40);
        app.update();
        assert_eq!(
            *app.world().get::<Visibility>(track).unwrap(),
            Visibility::Hidden
        );
        assert_eq!(
            *app.world().get::<Pickable>(track).unwrap(),
            Pickable::IGNORE
        );
        assert_eq!(
            *app.world().get::<Pickable>(thumb).unwrap(),
            Pickable::IGNORE
        );
        assert_eq!(
            app.world().get::<ScrollPosition>(area).unwrap().0,
            Vec2::ZERO
        );
        assert!(
            !app.world()
                .get::<ScrollbarDragState>(thumb)
                .unwrap()
                .dragging
        );

        app.world_mut().get_mut::<Node>(content).unwrap().height = px(1000);
        app.update();
        assert_eq!(
            *app.world().get::<Visibility>(track).unwrap(),
            Visibility::Inherited
        );
        pointer_scroll(&mut app, area, MouseScrollUnit::Line, -8.0);
        let hit = pointer_hit(&mut app);
        send_pointer(
            &mut app,
            thumb,
            Vec2::ZERO,
            DragStart {
                button: PointerButton::Primary,
                hit,
            },
        );
        app.world_mut().resource_mut::<MenuState>().page = MenuPage::Main;
        app.update();
        pointer_scroll(&mut app, area, MouseScrollUnit::Line, -8.0);
        pointer_scroll(&mut app, thumb, MouseScrollUnit::Line, -8.0);
        assert_eq!(
            app.world().get::<ScrollPosition>(area).unwrap().0,
            Vec2::ZERO
        );
        assert_eq!(
            *app.world().get::<Visibility>(track).unwrap(),
            Visibility::Hidden
        );
        assert!(
            !app.world()
                .get::<ScrollbarDragState>(thumb)
                .unwrap()
                .dragging
        );

        // 页签重建销毁整个旧子树，原生拖拽状态不会跨实体存活。
        let world = app.world_mut();
        let root = world
            .query_filtered::<Entity, With<ScrollbarTestRoot>>()
            .single(world)
            .unwrap();
        world.despawn(root);
        assert!(world.get_entity(thumb).is_err());
        world.resource_mut::<MenuState>().page = MenuPage::Settings;
        spawn_scrollbar_fixture(&mut app);
        let (_, new_track, new_thumb) = scrollbar_entities(&mut app);
        assert_ne!(new_thumb, thumb);
        assert_eq!(
            *app.world().get::<Visibility>(new_track).unwrap(),
            Visibility::Inherited
        );
        assert!(
            !app.world()
                .get::<ScrollbarDragState>(new_thumb)
                .unwrap()
                .dragging
        );
    }

    #[test]
    fn slider_visual_children_pass_real_ui_focus_to_the_parent_button() {
        use super::super::{
            MenuFocus, MenuInputSource, MenuPage, MenuState, SettingsTab, UiRequest,
            volume::VolumeSlider,
        };
        use crate::settings::SettingsDraft;
        use bevy::{
            input::touch::Touches,
            ui::{FocusPolicy, UiStack, ui_focus_system},
            window::PrimaryWindow,
        };
        let mut app = layout_app(UVec2::new(1280, 720));
        app.init_resource::<ButtonInput<MouseButton>>()
            .init_resource::<Touches>()
            .init_resource::<UiStack>()
            .init_resource::<UiScale>()
            .init_resource::<MenuFocus>()
            .init_resource::<MenuInputSource>()
            .init_resource::<SettingsDraft>()
            .insert_resource(MenuState {
                page: MenuPage::Settings,
                tab: SettingsTab::Audio,
                ..default()
            })
            .add_message::<UiRequest>()
            .add_systems(PreUpdate, ui_focus_system);
        super::super::volume::register(&mut app);
        let window = app
            .world_mut()
            .spawn((Window::default(), PrimaryWindow))
            .id();
        let theme = UiTheme {
            heading: default(),
            body: default(),
            scale: 1.0,
        };
        let root = app.world_mut().spawn_scene(bsn! {
            Node { width: px(400), height: px(120) }
            Children [super::super::volume::volume_row(&theme, "Master Volume", 50, SettingKey::MasterVolume, 0, "Adjust every sound.")]
        }).unwrap().id();
        // 单相机且无 ZIndex 的固定树按父先子后绘制；仅绘制栈是测试数据。
        // 真实字体测量、UI 布局与 ui_focus_system 仍负责尺寸和命中，不伪造 Interaction。
        fn collect_stack(world: &World, entity: Entity, nodes: &mut Vec<Entity>) {
            if world.get::<Node>(entity).is_some() {
                nodes.push(entity);
            }
            if let Some(children) = world.get::<Children>(entity) {
                for child in children.iter() {
                    collect_stack(world, child, nodes);
                }
            }
        }
        let mut stack_nodes = Vec::new();
        collect_stack(app.world(), root, &mut stack_nodes);
        app.insert_resource(UiStack {
            partition: vec![0..stack_nodes.len()],
            uinodes: stack_nodes,
        });
        // UI focus读真实布局、可见性和栈；无窗口数据实体仅提供坐标来源。
        let nodes: Vec<_> = app
            .world_mut()
            .query_filtered::<Entity, With<Node>>()
            .iter(app.world())
            .collect();
        for entity in nodes {
            app.world_mut()
                .entity_mut(entity)
                .insert(InheritedVisibility::VISIBLE);
        }
        app.world_mut()
            .resource_mut::<SettingsDraft>()
            .set_volume(SettingKey::MasterVolume, 50);
        for _ in 0..3 {
            app.update();
        }
        let slider = app
            .world_mut()
            .query_filtered::<Entity, With<VolumeSlider>>()
            .single(app.world())
            .unwrap();
        let track = app.world().get::<Children>(slider).unwrap()[0];
        let fill = app.world().get::<Children>(track).unwrap()[0];
        let thumb = app.world().get::<Children>(fill).unwrap()[0];
        for target in [track, fill, thumb] {
            assert_eq!(
                *app.world().get::<FocusPolicy>(target).unwrap(),
                FocusPolicy::Pass
            );
            let position = app
                .world()
                .get::<UiGlobalTransform>(target)
                .unwrap()
                .affine()
                .translation;
            app.world_mut()
                .get_mut::<Window>(window)
                .unwrap()
                .set_physical_cursor_position(Some(position.as_dvec2()));
            app.world_mut()
                .resource_mut::<ButtonInput<MouseButton>>()
                .press(MouseButton::Left);
            app.update();
            assert_eq!(
                *app.world().get::<Interaction>(slider).unwrap(),
                Interaction::Pressed,
                "A visual child must not block its slider"
            );
            let actions: Vec<_> = app
                .world_mut()
                .resource_mut::<Messages<UiRequest>>()
                .drain()
                .map(|request| request.0)
                .collect();
            assert!(
                matches!(
                    actions.as_slice(),
                    [UiAction::SetVolume(SettingKey::MasterVolume, _)]
                ),
                "Real UI focus must reach precise volume sampling: {actions:?}"
            );
            app.world_mut()
                .resource_mut::<ButtonInput<MouseButton>>()
                .release(MouseButton::Left);
            app.update();
            let actions: Vec<_> = app
                .world_mut()
                .resource_mut::<Messages<UiRequest>>()
                .drain()
                .map(|request| request.0)
                .collect();
            assert_eq!(actions, [UiAction::FinishVolumeEdit]);
            app.world_mut()
                .resource_mut::<ButtonInput<MouseButton>>()
                .clear();
        }
    }

    #[test]
    fn bsn_row_text_keeps_intrinsic_width_and_column_text_wraps() {
        let mut app = layout_app(UVec2::new(900, 900));
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
                    super::super::volume::volume_row(&theme, "Master Volume", 100, SettingKey::MasterVolume, 5, "Adjust every sound."),
                    super::super::volume::volume_row(&theme, "SFX Volume", 0, SettingKey::SfxVolume, 8, "Adjust gameplay sounds."),
                    super::super::volume::volume_row(&theme, "UI Volume", 37, SettingKey::UiVolume, 11, "Adjust menu sounds."),
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
