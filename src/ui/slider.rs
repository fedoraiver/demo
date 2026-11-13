//! 设置滑条共用主键捕获和局部坐标采样，业务数值仍由菜单请求更新草稿。

use super::{theme::*, widgets::*, *};
use crate::settings::{
    MAX_AUDIO_VOLUME, MAX_MOUSE_SENSITIVITY_MULTIPLIER, MOUSE_SENSITIVITY_STEPS_PER_UNIT,
    SettingsDraft,
};
use bevy::{
    picking::pointer::{PointerAction, PointerId, PointerInput},
    prelude::*,
    text::EditableTextSystems,
    window::PrimaryWindow,
};

const SETTING_SLIDER_BASIS_PX: f32 = 130.0;

/// 音量与灵敏度共用控件身份，设置键决定范围和请求语义。
#[derive(Component, Clone)]
pub(super) struct SettingsSlider {
    pub key: SettingKey,
}

impl Default for SettingsSlider {
    fn default() -> Self {
        Self {
            key: SettingKey::MasterVolume,
        }
    }
}

#[derive(Component, Clone)]
struct SliderFill {
    key: SettingKey,
}
impl Default for SliderFill {
    fn default() -> Self {
        Self {
            key: SettingKey::MasterVolume,
        }
    }
}

/// 捕获缓存设置键，目标销毁后仍能结束正确的业务手势。
pub(super) struct SliderDrag {
    entity: Entity,
    key: SettingKey,
    last_value: Option<u16>,
}

pub(super) fn register(app: &mut App) {
    app.add_message::<PointerPress>()
        .add_message::<PointerInput>()
        .add_systems(
            Update,
            (sample_slider_pointer, update_slider_fills)
                .after(UiSystems::Build)
                .after(UiSystems::Pointer)
                .before(UiSystems::Style),
        )
        // 常规输入在 PreUpdate 写回并参与本帧布局；此处补齐失焦规范或原生后续编辑的最终填充值。
        .add_systems(
            PostUpdate,
            update_slider_fills
                .after(EditableTextSystems)
                .after(super::sensitivity::normalize_blurred_text)
                .before(bevy::ui::widget::update_editable_text_layout),
        );
}

fn slider_tab(key: SettingKey) -> SettingsTab {
    if key == SettingKey::MouseSensitivity {
        SettingsTab::Controls
    } else {
        SettingsTab::Audio
    }
}
fn max_step(key: SettingKey) -> u16 {
    if key == SettingKey::MouseSensitivity {
        (MAX_MOUSE_SENSITIVITY_MULTIPLIER * f32::from(MOUSE_SENSITIVITY_STEPS_PER_UNIT)) as u16
    } else {
        u16::from(MAX_AUDIO_VOLUME)
    }
}
fn set_action(key: SettingKey, step: u16) -> UiAction {
    if key == SettingKey::MouseSensitivity {
        UiAction::SetSensitivity(step)
    } else {
        UiAction::SetVolume(key, step as u8)
    }
}
fn finish_action(key: SettingKey) -> UiAction {
    if key == SettingKey::MouseSensitivity {
        UiAction::FinishSensitivitySlider
    } else {
        UiAction::FinishVolumeEdit
    }
}

/// 纸色轨道与金色填充由两类设置复用，装饰节点不拦截真实命中。
pub(super) fn slider_control(
    theme: &UiTheme,
    key: SettingKey,
    index: usize,
    fill: f32,
    details: SettingDescription,
) -> impl Scene + use<> {
    bsn! {
        Name({format!("Settings slider: {}", details.title)})
        MenuButton { action: UiAction::Adjust(key, 0), index }
        SettingsSlider { key }
        details
        Node {
            min_height: px(theme.size(SETTING_CONTROL_MIN_HEIGHT_PX)),
            min_width: px(theme.size(95.0)),
            flex_basis: px(theme.size(SETTING_SLIDER_BASIS_PX)),
            flex_grow: 1.0,
            padding: UiRect::axes(px(theme.size(10.0)), px(theme.size(9.0))),
            border: px(2), border_radius: BorderRadius::all(px(7)),
            align_items: AlignItems::Center,
        }
        BackgroundColor(PAPER)
        BorderColor::all(CREAM)
        Children [
            Name("Settings slider track")
            Pickable::IGNORE
            Node { width: percent(100), height: px(theme.size(8.0)), border_radius: BorderRadius::MAX }
            BackgroundColor(SUBTLE)
            Children [
                Name("Settings slider fill")
                Pickable::IGNORE
                SliderFill { key }
                Node { width: percent(fill), height: percent(100), border_radius: BorderRadius::MAX }
                BackgroundColor(GOLD)
                Children [
                    Name("Settings slider handle")
                    Pickable::IGNORE
                    Node {
                        position_type: PositionType::Absolute,
                        right: px(-theme.size(5.0)), top: px(-theme.size(4.0)),
                        width: px(theme.size(10.0)), height: px(theme.size(16.0)),
                        border_radius: BorderRadius::all(px(3)),
                    }
                    BackgroundColor(INK)
                ]
            ]
        ]
    }
}

/// 使用物理像素与 UI 变换反算轨道局部坐标，兼容窗口缩放与滚动。
fn step_at_pointer(
    node: &ComputedNode,
    transform: &UiGlobalTransform,
    cursor: Vec2,
    max_step: u16,
) -> Option<u16> {
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
    let limit = f32::from(max_step);
    Some((offset / track_width * limit).round().clamp(0.0, limit) as u16)
}

/// Enhanced Input 负责菜单语义动作，但无法表示 UI 命中后的局部绝对横坐标。
/// 因此仅滑条读取底层光标与左键保持／释放；起点复用原生 PointerPress，按钮路径不再发调整请求。
pub(super) fn sample_slider_pointer(
    state: Res<MenuState>,
    windows: Query<&Window, With<PrimaryWindow>>,
    mouse: Option<Res<ButtonInput<MouseButton>>>,
    sliders: Query<(
        Entity,
        &SettingsSlider,
        &MenuButton,
        &ComputedNode,
        &UiGlobalTransform,
    )>,
    parents: Query<&ChildOf>,
    mut presses: MessageReader<PointerPress>,
    mut pointer_inputs: MessageReader<PointerInput>,
    mut focus: ResMut<MenuFocus>,
    mut source: ResMut<MenuInputSource>,
    mut requests: MessageWriter<UiRequest>,
    mut drag: Local<Option<SliderDrag>>,
) {
    let mut cancelled = false;
    for input in pointer_inputs.read() {
        cancelled |=
            input.pointer_id == PointerId::Mouse && matches!(input.action, PointerAction::Cancel);
    }
    if cancelled {
        presses.clear();
        if let Some(active) = drag.take() {
            requests.write(UiRequest {
                action: finish_action(active.key),
            });
        }
        return;
    }
    if state.page != MenuPage::Settings
        || !matches!(state.tab, SettingsTab::Audio | SettingsTab::Controls)
    {
        presses.clear();
        *drag = None;
        return;
    }
    if drag
        .as_ref()
        .is_some_and(|active| slider_tab(active.key) != state.tab)
    {
        *drag = None;
    }
    let Some(mouse) = mouse else {
        presses.clear();
        return;
    };
    let Ok(window) = windows.single() else {
        presses.clear();
        if let Some(active) = drag.take() {
            requests.write(UiRequest {
                action: finish_action(active.key),
            });
        }
        return;
    };
    // 按下消息在同帧释放后仍存在，不能依赖此时可能已移除的原生 Pressed。
    let mut target = None;
    for press in presses.read().filter(|press| {
        press.button == PointerButton::Primary && press.pointer.id == PointerId::Mouse
    }) {
        let mut entity = press.entity;
        loop {
            if let Ok((_, slider, button, _, _)) = sliders.get(entity)
                && slider_tab(slider.key) == state.tab
            {
                target = Some((entity, button.index, slider.key));
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
        && let Some((entity, index, key)) = target
    {
        *drag = Some(SliderDrag {
            entity,
            key,
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
            action: finish_action(active.key),
        });
        *drag = None;
        return;
    };
    if window.focused
        && let Some(cursor) = window.physical_cursor_position()
        && let Some(value) = step_at_pointer(node, transform, cursor, max_step(slider.key))
        && active.last_value != Some(value)
    {
        requests.write(UiRequest {
            action: set_action(slider.key, value),
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
            action: finish_action(active.key),
        });
        *drag = None;
    }
}

/// 未完成的输入不改变上次合法填充；滑条和输入框读取同一份草稿。
fn update_slider_fills(draft: Res<SettingsDraft>, mut fills: Query<(&SliderFill, &mut Node)>) {
    if !draft.is_changed() {
        return;
    }
    for (fill, mut node) in &mut fills {
        let value = if fill.key == SettingKey::MouseSensitivity {
            draft
                .sensitivity_multiplier()
                .map(|value| value / MAX_MOUSE_SENSITIVITY_MULTIPLIER * 100.0)
        } else {
            draft.volume(fill.key).map(f32::from)
        };
        if let Some(value) = value {
            let width = percent(value);
            if node.width != width {
                node.width = width;
            }
        }
    }
}
