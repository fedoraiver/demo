//! 音量滑条声明与局部鼠标拖动：精确数值仍通过统一菜单请求修改草稿。

use bevy::{prelude::*, ui::FocusPolicy, window::PrimaryWindow};

use crate::settings::SettingsDraft;

use super::{
    MenuButton, MenuFocus, MenuInputSource, MenuPage, MenuState, SettingKey, SettingsTab, UiAction,
    UiRequest, UiSystems, theme::*, widgets::*,
};

/// 滑条仍是普通菜单按钮，左右导航共用字段，鼠标数值由局部坐标决定。
#[derive(Component, Clone)]
pub(super) struct VolumeSlider {
    pub key: SettingKey,
}

/// 数字与填充各自保存设置键，草稿更新不需要重建实体树。
#[derive(Component, Clone)]
struct VolumeValue(SettingKey);

#[derive(Component, Clone)]
struct VolumeFill(SettingKey);

impl Default for VolumeSlider {
    fn default() -> Self {
        Self {
            key: SettingKey::MasterVolume,
        }
    }
}

impl Default for VolumeValue {
    fn default() -> Self {
        Self(SettingKey::MasterVolume)
    }
}

impl Default for VolumeFill {
    fn default() -> Self {
        Self(SettingKey::MasterVolume)
    }
}

/// 指针捕获只保留实体身份和上次采样值；页面销毁后立即丢弃失效实体。
struct VolumeDrag {
    entity: Entity,
    last_value: Option<u8>,
}

pub(super) fn register(app: &mut App) {
    app.add_systems(
        Update,
        (sample_slider_pointer, update_volume_visuals)
            .after(UiSystems::Build)
            .after(super::navigation::pointer_interaction)
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
    let details = SettingDescription {
        title,
        body: description,
    };
    bsn! {
        template_value(column(theme.size(8.0)))
        Node {
            width: percent(100),
            padding: px(theme.size(10.0)),
            border_radius: BorderRadius::all(px(7)),
            flex_shrink: 0.0,
        }
        BackgroundColor(SUBTLE)
        Children [
            label(theme, title, 21.0, INK),
            (
                Node {
                    width: percent(100),
                    align_items: AlignItems::Center,
                    column_gap: px(theme.size(8.0)),
                    row_gap: px(theme.size(8.0)),
                    flex_wrap: FlexWrap::Wrap,
                }
                Children [
                    (
                        small_button(theme, "<", UiAction::Adjust(key, -1), index)
                        template_value(details.clone())
                        Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)), flex_shrink: 0.0 }
                    ),
                    (
                        Button
                        template_value(MenuButton { action: UiAction::Adjust(key, 0), index: index + 1 })
                        template_value(VolumeSlider { key })
                        template_value(details.clone())
                        Node {
                            min_height: px(theme.size(43.0)),
                            min_width: px(theme.size(95.0)),
                            flex_basis: px(theme.size(130.0)),
                            flex_grow: 1.0,
                            padding: UiRect::axes(px(theme.size(10.0)), px(theme.size(9.0))),
                            border: px(2),
                            border_radius: BorderRadius::all(px(7)),
                            align_items: AlignItems::Center,
                        }
                        BackgroundColor(PAPER)
                        BorderColor::all(CREAM)
                        Children [(
                            // 填充和手柄只负责绘制，命中仍由外层 Button 统一处理。
                            Pickable::IGNORE
                            template_value(FocusPolicy::Pass)
                            Node {
                                width: percent(100),
                                height: px(theme.size(8.0)),
                                border_radius: BorderRadius::MAX,
                            }
                            BackgroundColor(SUBTLE)
                            Children [(
                                Pickable::IGNORE
                            template_value(FocusPolicy::Pass)
                                template_value(VolumeFill(key))
                                Node {
                                    width: percent(f32::from(value)),
                                    height: percent(100),
                                    border_radius: BorderRadius::MAX,
                                }
                                BackgroundColor(GOLD)
                                Children [(
                                    Pickable::IGNORE
                            template_value(FocusPolicy::Pass)
                                    Node {
                                        position_type: PositionType::Absolute,
                                        right: px(-theme.size(5.0)),
                                        top: px(-theme.size(4.0)),
                                        width: px(theme.size(10.0)),
                                        height: px(theme.size(16.0)),
                                        border_radius: BorderRadius::all(px(3)),
                                    }
                                    BackgroundColor(INK)
                                )]
                            )]
                        )]
                    ),
                    (
                        small_button(theme, ">", UiAction::Adjust(key, 1), index + 2)
                        template_value(details)
                        Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)), flex_shrink: 0.0 }
                    ),
                    (
                        Node {
                            width: px(theme.size(64.0)),
                            min_height: px(theme.size(43.0)),
                            align_items: AlignItems::Center,
                            justify_content: JustifyContent::Center,
                            flex_shrink: 0.0,
                        }
                        Children [(
                            label(theme, volume_text(value), 20.0, INK)
                            template_value(VolumeValue(key))
                        )]
                    ),
                ]
            ),
        ]
    }
}

/// 使用物理像素与 UI 变换反算轨道局部坐标，兼容窗口缩放与滚动。
fn value_at_pointer(
    node: &ComputedNode,
    transform: &UiGlobalTransform,
    cursor: Vec2,
) -> Option<u8> {
    let track_width = node.size().x
        - node.padding.min_inset.x
        - node.padding.max_inset.x
        - node.border.min_inset.x
        - node.border.max_inset.x;
    if track_width <= 0.0 {
        return None;
    }
    let local = transform.try_inverse()?.transform_point2(cursor);
    let offset = local.x + node.size().x / 2.0 - node.padding.min_inset.x - node.border.min_inset.x;
    Some((offset / track_width * 100.0).round().clamp(0.0, 100.0) as u8)
}

/// Enhanced Input 负责菜单语义动作，但无法表示 UI 命中后的局部绝对横坐标。
/// 因此仅滑条读取底层光标与左键保持／释放；命中复用 Interaction，按钮路径不再发调整请求。
fn sample_slider_pointer(
    state: Res<MenuState>,
    windows: Query<&Window, With<PrimaryWindow>>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    sliders: Query<(
        Entity,
        &VolumeSlider,
        &MenuButton,
        &Interaction,
        &ComputedNode,
        &UiGlobalTransform,
    )>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    mut requests: MessageWriter<UiRequest>,
    mut drag: Local<Option<VolumeDrag>>,
) {
    if state.page != MenuPage::Settings || state.tab != SettingsTab::Audio {
        *drag = None;
        return;
    }
    let Some(mouse) = mouse else {
        return;
    };
    let Ok(window) = windows.single() else {
        if drag.take().is_some() {
            requests.write(UiRequest(UiAction::FinishVolumeEdit));
        }
        return;
    };
    // 只有真实按下能开始捕获；重建新树生成的 Pressed 不能重新触发滑条。
    if drag.is_none()
        && window.focused
        && mouse.just_pressed(MouseButton::Left)
        && let Some((entity, _, button, _, _, _)) = sliders
            .iter()
            .find(|(_, _, _, interaction, _, _)| **interaction == Interaction::Pressed)
    {
        *drag = Some(VolumeDrag {
            entity,
            last_value: None,
        });
        focus.0 = button.index;
        *source = MenuInputSource::Pointer;
    }
    let Some(active) = drag.as_mut() else {
        return;
    };
    let Ok((_, slider, _, _, node, transform)) = sliders.get(active.entity) else {
        // 窗口宽度变化会重建实体；结束原手势，集中请求系统也清理其初值缓存。
        requests.write(UiRequest(UiAction::FinishVolumeEdit));
        *drag = None;
        return;
    };
    if window.focused
        && let Some(cursor) = window.physical_cursor_position()
        && let Some(value) = value_at_pointer(node, transform, cursor)
        && active.last_value != Some(value)
    {
        requests.write(UiRequest(UiAction::SetVolume(slider.key, value)));
        active.last_value = Some(value);
        *source = MenuInputSource::Pointer;
    }
    // 轨道外释放、离开窗口或失焦都结束捕获，避免丢失释放事件后仍残留拖动。
    if !mouse.pressed(MouseButton::Left)
        || !window.focused
        || window.physical_cursor_position().is_none()
    {
        requests.write(UiRequest(UiAction::FinishVolumeEdit));
        *drag = None;
    }
}

/// 草稿由请求系统在 PreUpdate 修改，随后同帧更新已有数字和轨道填充。
fn update_volume_visuals(
    draft: Res<SettingsDraft>,
    mut values: Query<(&VolumeValue, &mut Text)>,
    mut fills: Query<(&VolumeFill, &mut Node)>,
) {
    if !draft.is_changed() {
        return;
    }
    for (key, mut text) in &mut values {
        if let Some(value) = draft.volume(key.0) {
            let value = volume_text(value);
            if text.0 != value {
                text.0 = value;
            }
        }
    }
    for (key, mut node) in &mut fills {
        if let Some(value) = draft.volume(key.0) {
            let width = percent(f32::from(value));
            if node.width != width {
                node.width = width;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pointer_app() -> (App, Entity, Entity) {
        let mut app = App::new();
        app.insert_resource(MenuState {
            page: MenuPage::Settings,
            tab: SettingsTab::Audio,
            ..default()
        })
        .init_resource::<MenuFocus>()
        .insert_resource(MenuInputSource::Navigation)
        .init_resource::<ButtonInput<MouseButton>>()
        .add_message::<UiRequest>()
        .add_systems(Update, sample_slider_pointer);
        let window = app
            .world_mut()
            .spawn((Window::default(), PrimaryWindow))
            .id();
        let slider = app
            .world_mut()
            .spawn((
                Button,
                VolumeSlider {
                    key: SettingKey::MasterVolume,
                },
                MenuButton {
                    action: UiAction::Adjust(SettingKey::MasterVolume, 0),
                    index: 5,
                },
                Interaction::Pressed,
                ComputedNode {
                    size: Vec2::new(220.0, 43.0),
                    padding: BorderRect::all(10.0),
                    border: BorderRect::all(2.0),
                    ..default()
                },
                UiGlobalTransform::from_xy(200.0, 200.0),
            ))
            .id();
        (app, window, slider)
    }

    fn requests(app: &mut App) -> Vec<UiAction> {
        app.world_mut()
            .resource_mut::<Messages<UiRequest>>()
            .drain()
            .map(|request| request.0)
            .collect()
    }

    fn cursor(app: &mut App, window: Entity, position: Option<Vec2>) {
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_cursor_position(position);
    }

    #[test]
    fn pointer_drag_keeps_capture_outside_slider_and_finishes_once() {
        let (mut app, window, slider) = pointer_app();
        cursor(&mut app, window, Some(Vec2::new(151.0, 200.0)));
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .press(MouseButton::Left);
        app.update();
        assert_eq!(
            requests(&mut app),
            vec![UiAction::SetVolume(SettingKey::MasterVolume, 25)]
        );
        assert_eq!(app.world().resource::<MenuFocus>().0, 5);
        assert_eq!(
            *app.world().resource::<MenuInputSource>(),
            MenuInputSource::Pointer
        );
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .clear();
        *app.world_mut().get_mut::<Interaction>(slider).unwrap() = Interaction::None;
        cursor(&mut app, window, Some(Vec2::new(53.0, 240.0)));
        app.update();
        assert_eq!(
            requests(&mut app),
            vec![UiAction::SetVolume(SettingKey::MasterVolume, 0)]
        );
        cursor(&mut app, window, Some(Vec2::new(250.96, 240.0)));
        app.update();
        assert_eq!(
            requests(&mut app),
            vec![UiAction::SetVolume(SettingKey::MasterVolume, 76)]
        );
        app.update();
        assert!(
            requests(&mut app).is_empty(),
            "A stationary cursor must not repeat volume requests"
        );
        cursor(&mut app, window, Some(Vec2::new(350.0, 240.0)));
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .release(MouseButton::Left);
        app.update();
        assert_eq!(
            requests(&mut app),
            vec![
                UiAction::SetVolume(SettingKey::MasterVolume, 100),
                UiAction::FinishVolumeEdit
            ]
        );
        app.update();
        assert!(
            requests(&mut app).is_empty(),
            "Release must finish a gesture exactly once"
        );
    }

    #[test]
    fn pointer_leaving_window_or_losing_focus_finishes_capture() {
        for leave_window in [true, false] {
            let (mut app, window, _) = pointer_app();
            cursor(&mut app, window, Some(Vec2::new(200.0, 200.0)));
            app.world_mut()
                .resource_mut::<ButtonInput<MouseButton>>()
                .press(MouseButton::Left);
            app.update();
            requests(&mut app);
            app.world_mut()
                .resource_mut::<ButtonInput<MouseButton>>()
                .clear();
            if leave_window {
                cursor(&mut app, window, None);
            } else {
                app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
            }
            app.update();
            assert_eq!(requests(&mut app), vec![UiAction::FinishVolumeEdit]);
            app.update();
            assert!(requests(&mut app).is_empty());
        }
    }

    #[test]
    fn destroyed_slider_or_window_finishes_existing_capture() {
        for remove_window in [true, false] {
            let (mut app, window, slider) = pointer_app();
            cursor(&mut app, window, Some(Vec2::new(200.0, 200.0)));
            app.world_mut()
                .resource_mut::<ButtonInput<MouseButton>>()
                .press(MouseButton::Left);
            app.update();
            requests(&mut app);
            app.world_mut()
                .resource_mut::<ButtonInput<MouseButton>>()
                .clear();
            app.world_mut()
                .despawn(if remove_window { window } else { slider });
            app.update();
            assert_eq!(requests(&mut app), vec![UiAction::FinishVolumeEdit]);
            app.update();
            assert!(requests(&mut app).is_empty());
        }
    }

    #[test]
    fn pointer_uses_physical_coordinates_and_never_starts_on_old_pressed_tree() {
        let (mut app, window, _) = pointer_app();
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .resolution
            .set_scale_factor_override(Some(2.0));
        cursor(&mut app, window, Some(Vec2::new(100.0, 100.0)));
        app.update();
        assert!(
            requests(&mut app).is_empty(),
            "A stale Pressed alone is not a new gesture"
        );
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .press(MouseButton::Left);
        app.update();
        assert_eq!(
            requests(&mut app),
            vec![UiAction::SetVolume(SettingKey::MasterVolume, 50)]
        );
        app.world_mut()
            .resource_mut::<ButtonInput<MouseButton>>()
            .clear();
        app.world_mut().resource_mut::<MenuState>().tab = SettingsTab::Controls;
        app.update();
        assert!(requests(&mut app).is_empty());
        app.world_mut().resource_mut::<MenuState>().tab = SettingsTab::Audio;
        cursor(&mut app, window, Some(Vec2::new(125.0, 100.0)));
        app.update();
        assert!(
            requests(&mut app).is_empty(),
            "Changing tabs must drop the old capture"
        );
    }
}
