//! 设置面板的滚动条、指针滚动与键盘焦点滚入；固定区域不参与滚动。

use super::{theme::*, *};
use bevy::{
    camera::visibility::VisibilitySystems,
    input::mouse::MouseScrollUnit,
    picking::{Pickable, hover::Hovered},
    prelude::*,
    ui_widgets::{ControlOrientation, Scrollbar, ScrollbarDragState, ScrollbarThumb},
};

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
            @scroll_area(theme)
            Node {
                padding: UiRect::ZERO,
            }
            Children [
                @{content}
            ]
            --
            @settings_scrollbar(theme)
        ]
    }
}

fn settings_scrollbar(theme: &UiTheme) -> impl Scene + use<> {
    let min_thumb_length = theme.size(28.0).max(22.0);
    bsn! {
        SettingsScrollbar { min_thumb_length }
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
        Children [
            SettingsScrollbarThumb
            ScrollbarThumb {
                border_radius: BorderRadius::MAX,
                border: UiRect::all(px(1)),
            }
            // 原生滑块不带 Node，避免 UI layout 与 ScrollbarPlugin 两次写入几何。
            Hovered::default()
            Pickable::IGNORE
            BackgroundColor(CREAM)
            BorderColor::all(INK)
            on(scrollbar_pointer_source)
        ]
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
                target: "demo::ui::widgets",
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

fn scrollbar_pointer_source(_: On<PointerPress>, mut source: ResMut<MenuInputSource>) {
    *source = MenuInputSource::Pointer;
}

/// 滚轮落在右侧轨道或滑块时仍控制其目标区域，不另行消费底层 MouseWheel。
fn scroll_over_settings_scrollbar(
    mut event: On<PointerScroll>,
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
    mut event: On<PointerScroll>,
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

/// 短窗口中键盘仍能访问所有按钮；新页面先等布局完成，再滚到焦点所在区域。
pub(super) fn scroll_focused_button(
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
#[path = "scroll_tests.rs"]
mod tests;
