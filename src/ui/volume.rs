//! 音量滑条声明与局部鼠标拖动：精确数值仍通过统一菜单请求修改草稿。

use bevy::{prelude::*, window::PrimaryWindow};

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
struct VolumeValue {
    key: SettingKey,
}

#[derive(Component, Clone)]
struct VolumeFill {
    key: SettingKey,
}

impl Default for VolumeSlider {
    fn default() -> Self {
        Self {
            key: SettingKey::MasterVolume,
        }
    }
}

impl Default for VolumeValue {
    fn default() -> Self {
        Self {
            key: SettingKey::MasterVolume,
        }
    }
}

impl Default for VolumeFill {
    fn default() -> Self {
        Self {
            key: SettingKey::MasterVolume,
        }
    }
}

/// 指针捕获只保留实体身份和上次采样值；页面销毁后立即丢弃失效实体。
pub(super) struct VolumeDrag {
    entity: Entity,
    last_value: Option<u8>,
}

pub(super) fn register(app: &mut App) {
    app.add_message::<PointerPress>().add_systems(
        Update,
        (sample_slider_pointer, update_volume_visuals)
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
                Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)), flex_shrink: 0.0 }
                --
                MenuButton { action: UiAction::Adjust(key, 0), index: {index + 1} }
                VolumeSlider { key }
                details
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
                Children [
                    // 填充和手柄只负责绘制，命中仍由外层 Button 统一处理。
                    Pickable::IGNORE
                    Node {
                        width: percent(100),
                        height: px(theme.size(8.0)),
                        border_radius: BorderRadius::MAX,
                    }
                    BackgroundColor(SUBTLE)
                    Children [
                        Pickable::IGNORE
                        VolumeFill { key }
                        Node {
                            width: percent(f32::from(value)),
                            height: percent(100),
                            border_radius: BorderRadius::MAX,
                        }
                        BackgroundColor(GOLD)
                        Children [
                            Pickable::IGNORE
                            Node {
                                position_type: PositionType::Absolute,
                                right: px(-theme.size(5.0)),
                                top: px(-theme.size(4.0)),
                                width: px(theme.size(10.0)),
                                height: px(theme.size(16.0)),
                                border_radius: BorderRadius::all(px(3)),
                            }
                            BackgroundColor(INK)
                        ]
                    ]
                ]
                --
                @small_button(theme, ">", UiAction::Adjust(key, 1), index + 2)
                details
                Node { padding: px(theme.size(7.0)), min_width: px(theme.size(34.0)), flex_shrink: 0.0 }
                --
                Node {
                    width: px(theme.size(64.0)),
                    min_height: px(theme.size(43.0)),
                    align_items: AlignItems::Center,
                    justify_content: JustifyContent::Center,
                    flex_shrink: 0.0,
                }
                Children [
                    @label(theme, volume_text(value), 20.0, INK)
                    VolumeValue { key }
                ]
            ]
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
/// 因此仅滑条读取底层光标与左键保持／释放；起点复用原生 PointerPress，按钮路径不再发调整请求。
pub(super) fn sample_slider_pointer(
    state: Res<MenuState>,
    windows: Query<&Window, With<PrimaryWindow>>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    sliders: Query<(
        Entity,
        &VolumeSlider,
        &MenuButton,
        &ComputedNode,
        &UiGlobalTransform,
    )>,
    parents: Query<&ChildOf>,
    mut presses: MessageReader<PointerPress>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    mut requests: MessageWriter<UiRequest>,
    mut drag: Local<Option<VolumeDrag>>,
) {
    if state.page != MenuPage::Settings || state.tab != SettingsTab::Audio {
        presses.clear();
        *drag = None;
        return;
    }
    let Some(mouse) = mouse else {
        presses.clear();
        return;
    };
    let Ok(window) = windows.single() else {
        presses.clear();
        if drag.take().is_some() {
            requests.write(UiRequest {
                action: UiAction::FinishVolumeEdit,
            });
        }
        return;
    };
    // 按下消息在同帧释放后仍存在，不能依赖此时可能已移除的原生 Pressed。
    let mut target = None;
    for press in presses
        .read()
        .filter(|press| press.button == PointerButton::Primary)
    {
        let mut entity = press.entity;
        loop {
            if let Ok((_, _, button, _, _)) = sliders.get(entity) {
                target = Some((entity, button.index));
                break;
            }
            let Ok(parent) = parents.get(entity) else {
                break;
            };
            entity = parent.parent();
        }
    }
    // 只有真实按下消息能开始捕获；重建新树或残留按下组件不能重新触发滑条。
    if drag.is_none()
        && window.focused
        && let Some((entity, index)) = target
    {
        *drag = Some(VolumeDrag {
            entity,
            last_value: None,
        });
        focus.index = index;
        *source = MenuInputSource::Pointer;
    }
    let Some(active) = drag.as_mut() else {
        return;
    };
    let Ok((_, slider, _, node, transform)) = sliders.get(active.entity) else {
        // 窗口宽度变化会重建实体；结束原手势，集中请求系统也清理其初值缓存。
        requests.write(UiRequest {
            action: UiAction::FinishVolumeEdit,
        });
        *drag = None;
        return;
    };
    if window.focused
        && let Some(cursor) = window.physical_cursor_position()
        && let Some(value) = value_at_pointer(node, transform, cursor)
        && active.last_value != Some(value)
    {
        requests.write(UiRequest {
            action: UiAction::SetVolume(slider.key, value),
        });
        active.last_value = Some(value);
        *source = MenuInputSource::Pointer;
    }
    // 轨道外释放、离开窗口或失焦都结束捕获，避免丢失释放事件后仍残留拖动。
    if !mouse.pressed(MouseButton::Left)
        || !window.focused
        || window.physical_cursor_position().is_none()
    {
        requests.write(UiRequest {
            action: UiAction::FinishVolumeEdit,
        });
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
        if let Some(value) = draft.volume(key.key) {
            let value = volume_text(value);
            if text.0 != value {
                text.0 = value;
            }
        }
    }
    for (key, mut node) in &mut fills {
        if let Some(value) = draft.volume(key.key) {
            let width = percent(f32::from(value));
            if node.width != width {
                node.width = width;
            }
        }
    }
}
