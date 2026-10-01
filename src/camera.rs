//! 第一／第三人称视角：动作更新观察状态，固定步同步朝向，物理插值后同步持握目标、镜头和模型显示。

use std::f32::consts::TAU;

use avian3d::interpolation::TransformEasingSystems;
use bevy::{
    input::{InputSystems, mouse::MouseButtonInput},
    prelude::*,
    window::{CursorGrabMode, CursorOptions, PrimaryWindow, WindowFocused},
};
use bevy_enhanced_input::prelude::{ContextActivity, EnhancedInputSystems, Fire};
use bevy_inspector_egui::bevy_egui::{
    EguiContext, EguiInput, EguiPreUpdateSet, PrimaryEguiContext, egui,
};

use crate::{
    app_flow::{AppState, PlayState, gameplay_running},
    gameplay::{Character, ControlsCharacter, GameplaySystems, sync_held_objects},
    input::{GameplayContext, LookAction, ReleasePointerAction, TogglePerspectiveAction},
    settings::GameSettings,
};

/// 控制者关联的相机，输入设备绑定仍由输入模块管理。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct ControlsCamera(#[entities] pub Entity);

/// 同一台相机的观察模式，角度和目标仍由相机组件保存。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Reflect)]
pub enum CameraPerspective {
    ThirdPerson,
    FirstPerson,
}

impl CameraPerspective {
    fn name(self) -> &'static str {
        match self {
            Self::ThirdPerson => "third_person",
            Self::FirstPerson => "first_person",
        }
    }
}

/// 由视角系统控制可见性的角色视觉根；所属角色使用已有的 ChildOf 关系。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct CharacterVisual;

/// 两种视角共享水平朝向并分别记住俯仰；实际位置和朝向仅写入 Transform。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct OrbitCamera {
    #[entities]
    pub target: Entity,
    yaw: f32,
    perspective: CameraPerspective,
    third_person_pitch: f32,
    first_person_pitch: f32,
    distance: f32,
    look_height: f32,
    eye_height: f32,
    #[entities]
    #[reflect(ignore)]
    toggle_requested_by: Option<Entity>,
}

impl OrbitCamera {
    /// 从原型原有的偏移初始化，保持初始画面和跟随距离。
    pub fn new(target: Entity) -> Self {
        let relative_offset = Vec3::new(0.0, 5.2, 8.0);
        Self {
            target,
            yaw: 0.0,
            perspective: CameraPerspective::ThirdPerson,
            third_person_pitch: relative_offset.y.atan2(relative_offset.z),
            first_person_pitch: 0.0,
            distance: relative_offset.length(),
            look_height: 0.8,
            eye_height: 1.65,
            toggle_requested_by: None,
        }
    }

    /// 根据目标的世界位置计算镜头，不读取或修改其他实体。
    pub fn transform(&self, target_position: Vec3) -> Transform {
        if self.perspective == CameraPerspective::FirstPerson {
            // 眼位只跟随人物位置；俯仰直接决定观察方向，不能继续朝向第三人称的低处观察点。
            return Transform::from_translation(target_position + Vec3::Y * self.eye_height)
                .with_rotation(
                    Quat::from_rotation_y(self.yaw)
                        * Quat::from_rotation_x(-self.first_person_pitch),
                );
        }
        let pivot = target_position + Vec3::Y * self.look_height;
        let offset = Quat::from_rotation_y(self.yaw)
            * Vec3::new(
                0.0,
                self.distance * self.third_person_pitch.sin(),
                self.distance * self.third_person_pitch.cos(),
            );
        Transform::from_translation(pivot + offset).looking_at(pivot, Vec3::Y)
    }

    fn pitch(&self) -> f32 {
        match self.perspective {
            CameraPerspective::ThirdPerson => self.third_person_pitch,
            CameraPerspective::FirstPerson => self.first_person_pitch,
        }
    }

    fn apply_vertical_look(&mut self, delta: f32) {
        match self.perspective {
            // 没有镜头碰撞，第三人称保持在观察点上方；第一人称允许抬头，但都避开垂直极点。
            CameraPerspective::ThirdPerson => {
                self.third_person_pitch = (self.third_person_pitch + delta)
                    .clamp(5.0_f32.to_radians(), 80.0_f32.to_radians());
            }
            CameraPerspective::FirstPerson => {
                self.first_person_pitch = (self.first_person_pitch + delta)
                    .clamp(-85.0_f32.to_radians(), 85.0_f32.to_radians());
            }
        }
    }
}

/// 每个本地相机的鼠标捕获状态；恢复捕获的那帧不处理自由光标阶段的增量。
#[derive(Component, Default)]
pub struct MouseLookState {
    pub(crate) active: bool,
    pub(crate) initialized: bool,
    pub(crate) skip_motion: bool,
    target_available: bool,
    /// 焦点消息与窗口最终状态共同决定本帧能否切换；检查器另通过输入上下文屏蔽动作。
    focused: bool,
}

/// 注册自由视角、鼠标捕获和人物朝向同步，不创建窗口。
pub struct CameraControlPlugin;

impl Plugin for CameraControlPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GameSettings>()
            .register_type::<ControlsCamera>()
            .register_type::<CharacterVisual>()
            .register_type::<CameraPerspective>()
            .register_type::<OrbitCamera>()
            .add_message::<WindowFocused>()
            .add_observer(on_camera_look)
            .add_observer(request_perspective_toggle)
            .add_observer(release_pointer_for_inspector)
            .add_systems(
                PreUpdate,
                filter_captured_egui_input
                    .after(EguiPreUpdateSet::ProcessInput)
                    .before(EguiPreUpdateSet::BeginPass),
            )
            .add_systems(
                PreUpdate,
                sync_mouse_capture
                    // egui 输入准备后用实时光标阻止同帧穿透；默认 multipass 的焦点仍来自上一已完成 UI 帧。
                    // 延迟上下文命令必须在动作准备前应用；BeginPass 也兼容非 multipass 的上下文。
                    .after(InputSystems)
                    .after(EguiPreUpdateSet::BeginPass)
                    .before(EnhancedInputSystems::Prepare),
            )
            .add_systems(
                PreUpdate,
                // 所有动作 Observer 完成后再切换，避免 I 与鼠标同帧时依赖动作遍历顺序。
                apply_perspective_toggle
                    .after(EnhancedInputSystems::Apply)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedUpdate,
                // 默认 Main 在 PreUpdate 结束时应用动作命令，再进入固定步；此处只规定固定步内顺序。
                sync_character_facing
                    .before(GameplaySystems::Simulate)
                    .run_if(gameplay_running),
            )
            .add_systems(
                RunFixedMainLoop,
                // 插值在固定循环后执行，镜头和持握目标必须读取同一份已插值的角色位置。
                // 朝向同步在插值变化标记采样前完成，避免下一无固定步帧将它误判为位置瞬移。
                (
                    sync_character_facing,
                    sync_held_objects,
                    follow_orbit_camera,
                    sync_character_visibility,
                )
                    .chain()
                    .in_set(RunFixedMainLoopSystems::AfterFixedMainLoop)
                    .after(TransformEasingSystems::Ease)
                    .before(TransformEasingSystems::UpdateEasingTick)
                    .run_if(gameplay_running),
            );
    }
}

/// 检查器释放使用动作事件；相机捕获系统继续负责下一帧上下文与点击恢复。
fn release_pointer_for_inspector(
    event: On<Fire<ReleasePointerAction>>,
    controllers: Query<&ControlsCamera, With<GameplayContext>>,
    mut cameras: Query<&mut MouseLookState>,
    mut windows: Query<(&Window, &mut CursorOptions), With<PrimaryWindow>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut capture) = cameras.get_mut(controlled.0) else {
        return;
    };
    let Ok((window, mut cursor)) = windows.single_mut() else {
        return;
    };
    if !window.focused {
        return;
    }
    let was_captured = capture.active;
    capture.active = false;
    capture.skip_motion = true;
    cursor.visible = true;
    cursor.grab_mode = CursorGrabMode::None;
    if was_captured {
        info!(target: "demo::camera", camera = ?controlled.0, before = "captured", after = "released",
            reason = "inspector_release_action", "Mouse look capture changed");
    }
}

/// 游戏捕获鼠标时检查器仍显示，但不能接收藏在面板上的光标点击或角色操作按键。
fn filter_captured_egui_input(
    keys: Res<ButtonInput<KeyCode>>,
    windows: Query<(&Window, &CursorOptions), With<PrimaryWindow>>,
    mut contexts: Query<(&mut EguiContext, &mut EguiInput), With<PrimaryEguiContext>>,
) {
    let Ok((window, cursor)) = windows.single() else {
        return;
    };
    // Esc 必须在本帧直接放行检查器输入，不等后续捕获同步；窗口焦点仍由 egui 的原始输入设施维护。
    if !window.focused
        || cursor.visible
        || cursor.grab_mode == CursorGrabMode::None
        || keys.just_pressed(KeyCode::Escape)
    {
        return;
    }
    for (mut context, mut input) in &mut contexts {
        let context = context.get_mut();
        input.0.events.clear();
        // 面板外恢复捕获的按下已进入 egui；仅补齐仍按下的释放，再移除位置，避免过滤真实松开后状态残留。
        context.input(|state| {
            for button in [
                egui::PointerButton::Primary,
                egui::PointerButton::Secondary,
                egui::PointerButton::Middle,
                egui::PointerButton::Extra1,
                egui::PointerButton::Extra2,
            ] {
                if state.pointer.button_down(button) {
                    input.0.events.push(egui::Event::PointerButton {
                        pos: egui::pos2(-10000.0, -10000.0),
                        button,
                        pressed: false,
                        modifiers: default(),
                    });
                }
            }
            for key in &state.keys_down {
                input.0.events.push(egui::Event::Key {
                    key: *key,
                    physical_key: None,
                    pressed: false,
                    repeat: false,
                    modifiers: default(),
                });
            }
        });
        input.0.events.push(egui::Event::PointerGone);
        context.stop_dragging();
        context.memory_mut(|memory| {
            if let Some(focused) = memory.focused() {
                memory.surrender_focus(focused);
            }
        });
    }
}

/// 同时检查窗口状态和焦点消息，避免同一帧失焦后又回焦时自动恢复捕获。
fn sync_mouse_capture(
    mut commands: Commands,
    keys: Res<ButtonInput<KeyCode>>,
    mut button_events: MessageReader<MouseButtonInput>,
    mut focus_events: MessageReader<WindowFocused>,
    mut windows: Query<(Entity, &Window, &mut CursorOptions), With<PrimaryWindow>>,
    controllers: Query<
        (
            Entity,
            &ControlsCharacter,
            &ControlsCamera,
            &ContextActivity<GameplayContext>,
        ),
        With<GameplayContext>,
    >,
    characters: Query<(), With<Character>>,
    mut cameras: Query<(Entity, &OrbitCamera, &mut MouseLookState)>,
    mut egui_contexts: Query<&mut EguiContext, With<PrimaryEguiContext>>,
    app_state: Option<Res<State<AppState>>>,
    play_state: Option<Res<State<PlayState>>>,
) {
    let running = app_state.as_ref().is_none_or(|state| {
        *state.get() == AppState::InGame
            && play_state
                .as_ref()
                .is_some_and(|state| *state.get() == PlayState::Running)
    });
    let Ok((window_entity, window, mut cursor)) = windows.single_mut() else {
        focus_events.clear();
        button_events.clear();
        for (camera, _, mut state) in &mut cameras {
            if state.active {
                info!(target: "demo::camera", ?camera, before = "captured", after = "released",
                    reason = "window_unavailable", "Mouse look capture changed");
            }
            state.active = false;
            state.skip_motion = true;
            state.focused = false;
        }
        for (controller, _, _, activity) in &controllers {
            if **activity {
                commands
                    .entity(controller)
                    .insert(ContextActivity::<GameplayContext>::INACTIVE);
            }
        }
        return;
    };
    let mut lost_focus = false;
    for event in focus_events.read() {
        lost_focus |= event.window == window_entity && !event.focused;
    }
    let mut clicked = false;
    for event in button_events.read() {
        // 失焦可能漏收松开消息，直接读取点击而不依赖仍残留的 pressed 状态。
        clicked |= event.window == window_entity
            && event.button == MouseButton::Left
            && event.state.is_pressed();
    }

    // 捕获属于窗口生命周期；必须读取当前物理光标来区分同帧点击，不能用 PostUpdate 的旧输入摘要。
    let mut pointer_over_ui = false;
    let mut using_pointer = false;
    let mut wants_keyboard = false;
    let mut popup_open = false;
    if let Ok(mut context) = egui_contexts.single_mut() {
        let context = context.get_mut();
        pointer_over_ui = window.physical_cursor_position().is_some_and(|position| {
            let position = position / context.pixels_per_point();
            context
                .layer_id_at(egui::pos2(position.x, position.y))
                .is_some_and(|layer| layer.order != egui::Order::Background)
        });
        using_pointer = context.egui_is_using_pointer();
        wants_keyboard = context.egui_wants_keyboard_input();
        popup_open = context.any_popup_open();
    }
    // 拖拽跨出面板或菜单仍打开时，点击不能意外恢复鼠标锁定。
    let gameplay_clicked = clicked && !pointer_over_ui && !using_pointer && !popup_open;

    let mut any_active = false;
    for (camera, orbit, mut state) in &mut cameras {
        let available = characters.contains(orbit.target)
            && controllers
                .iter()
                .any(|(_, character, controlled_camera, _)| {
                    character.0 == orbit.target && controlled_camera.0 == camera
                });
        if !available && (!state.initialized || state.target_available) {
            warn!(target: "demo::camera", ?camera, character = ?orbit.target,
                before = "available", after = "unavailable", reason = "camera_binding_unavailable",
                "Camera target or controller unavailable");
        }
        state.target_available = available;
        state.focused = window.focused && !lost_focus;
        let before = state.active;
        let reason = if !running {
            state.active = false;
            "menu_open"
        } else if !available {
            state.active = false;
            "camera_binding_unavailable"
        } else if lost_focus || !window.focused {
            state.active = false;
            "window_focus_lost"
        } else if keys.just_pressed(KeyCode::Escape) {
            state.active = false;
            "escape_pressed"
        } else if !state.initialized || gameplay_clicked {
            state.active = true;
            if state.initialized {
                "window_clicked"
            } else {
                "initialization"
            }
        } else {
            "unchanged"
        };
        state.skip_motion = !state.initialized || before != state.active;
        if !state.initialized || before != state.active {
            info!(target: "demo::camera", ?camera, character = ?orbit.target,
                ?window_entity, before = if before { "captured" } else { "released" },
                after = if state.active { "captured" } else { "released" }, reason,
                "Mouse look capture changed");
        }
        state.initialized = true;
        any_active |= state.active;
    }
    cursor.visible = !any_active;
    // Bevy 的窗口后端会在 Locked 不受支持时尝试 Confined，并将失败写入统一日志。
    cursor.grab_mode = if any_active {
        CursorGrabMode::Locked
    } else {
        CursorGrabMode::None
    };
    // 菜单与暂停停用玩法；Esc 的菜单动作由 Enhanced Input 处理，这里的底层判断只负责光标生命周期。
    // ContextActivity 是不可变组件，按实际变化插入，使 require_reset 保留重新启用前的按键释放边界。
    let gameplay_active = running
        && window.focused
        && !lost_focus
        && !wants_keyboard
        && !popup_open
        && !using_pointer
        && (any_active || !pointer_over_ui);
    for (controller, character, controlled_camera, activity) in &controllers {
        let available = characters.contains(character.0)
            && cameras
                .get(controlled_camera.0)
                .is_ok_and(|(_, orbit, _)| orbit.target == character.0);
        let after = gameplay_active && available;
        if **activity != after {
            commands
                .entity(controller)
                .insert(ContextActivity::<GameplayContext>::new(after));
            info!(target: "demo::input", ?controller, character = ?character.0,
                before = **activity, after, reason = if after { "gameplay_input_resumed" }
                    else if !window.focused || lost_focus { "window_focus_lost" }
                    else if !available { "camera_binding_unavailable" }
                    else if !running { "menu_open" }
                    else { "inspector_input" }, "Gameplay input context activity changed");
        }
    }
}

/// Fire 已携带本帧汇总位移，直接更新角度；不缓存增量，也不乘固定步或帧时间。
fn on_camera_look(
    event: On<Fire<LookAction>>,
    settings: Res<GameSettings>,
    time: Res<Time>,
    mut next_log_at: Local<f64>,
    controllers: Query<&ControlsCamera, With<GameplayContext>>,
    mut cameras: Query<(&mut OrbitCamera, &MouseLookState)>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok((mut orbit, state)) = cameras.get_mut(controlled.0) else {
        return;
    };
    if !state.active || state.skip_motion {
        return;
    }
    let before_yaw = orbit.yaw;
    let before_pitch = orbit.pitch();
    let delta = event.value * settings.camera.mouse_sensitivity;
    orbit.yaw = (orbit.yaw - delta.x).rem_euclid(TAU);
    let vertical = if settings.camera.invert_y {
        -delta.y
    } else {
        delta.y
    };
    orbit.apply_vertical_look(vertical);
    // 连续角度只采样调试日志，捕获和失效状态仍逐次记录。
    if time.elapsed_secs_f64() >= *next_log_at {
        debug!(target: "demo::camera", camera = ?controlled.0, character = ?orbit.target,
            controller = ?event.context, yaw_before = before_yaw, yaw_after = orbit.yaw,
            pitch_before = before_pitch, pitch_after = orbit.pitch(),
            perspective = orbit.perspective.name(),
            reason = "mouse_motion_sample", "Camera look angles changed");
        *next_log_at = time.elapsed_secs_f64() + 0.5;
    }
}

/// 切换请求只来自 Enhanced Input；关联有效且窗口聚焦时接收，不改变鼠标捕获状态。
fn request_perspective_toggle(
    event: On<Fire<TogglePerspectiveAction>>,
    controllers: Query<(&ControlsCharacter, &ControlsCamera), With<GameplayContext>>,
    characters: Query<(), With<Character>>,
    mut cameras: Query<(&mut OrbitCamera, &MouseLookState)>,
) {
    let Ok((character, controlled)) = controllers.get(event.context) else {
        return;
    };
    let Ok((mut orbit, state)) = cameras.get_mut(controlled.0) else {
        warn!(target: "demo::camera", controller = ?event.context, camera = ?controlled.0,
            character = ?character.0, reason = "camera_binding_unavailable",
            "Camera perspective toggle ignored");
        return;
    };
    if orbit.target != character.0 || !characters.contains(character.0) {
        warn!(target: "demo::camera", controller = ?event.context, camera = ?controlled.0,
            character = ?character.0, reason = "camera_binding_unavailable",
            "Camera perspective toggle ignored");
        return;
    }
    if state.focused {
        orbit.toggle_requested_by = Some(event.context);
    }
}

/// 在动作应用后的同一 PreUpdate 消费请求；本帧即使没有固定步也会切换一次。
fn apply_perspective_toggle(mut cameras: Query<(Entity, &mut OrbitCamera)>) {
    for (camera, mut orbit) in &mut cameras {
        let Some(controller) = orbit.toggle_requested_by.take() else {
            continue;
        };
        let before = orbit.perspective;
        let pitch_before = orbit.pitch();
        orbit.perspective = match before {
            CameraPerspective::ThirdPerson => CameraPerspective::FirstPerson,
            CameraPerspective::FirstPerson => CameraPerspective::ThirdPerson,
        };
        info!(target: "demo::camera", ?camera, ?controller, character = ?orbit.target,
            perspective_before = before.name(), perspective_after = orbit.perspective.name(),
            yaw = orbit.yaw, pitch_before, pitch_after = orbit.pitch(),
            reason = "toggle_perspective_action", "Camera perspective changed");
    }
}

/// 在固定模拟前及逐帧持握目标同步前设置水平朝向，站立、横移和后退时也跟随视角。
pub(crate) fn sync_character_facing(
    controllers: Query<(&ControlsCharacter, &ControlsCamera), With<GameplayContext>>,
    cameras: Query<&OrbitCamera>,
    mut characters: Query<&mut Transform, With<Character>>,
) {
    for (controlled_character, controlled_camera) in &controllers {
        let Ok(orbit) = cameras.get(controlled_camera.0) else {
            continue;
        };
        if orbit.target != controlled_character.0 {
            continue;
        }
        let Ok(mut transform) = characters.get_mut(controlled_character.0) else {
            continue;
        };
        let rotation = Quat::from_rotation_y(orbit.yaw);
        if !transform.rotation.abs_diff_eq(rotation, 0.000001) {
            transform.rotation = rotation;
        }
    }
}

/// 镜头使用本帧插值后的人物位置与环绕角；互斥过滤避免 Transform 查询读写冲突。
fn follow_orbit_camera(
    characters: Query<&Transform, With<Character>>,
    mut cameras: Query<(&OrbitCamera, &mut Transform), Without<Character>>,
) {
    for (orbit, mut transform) in &mut cameras {
        if let Ok(character) = characters.get(orbit.target) {
            *transform = orbit.transform(character.translation);
        }
    }
}

/// 只隐藏角色视觉子树，保留业务根与独立木箱；相机或控制者丢失后自动恢复模型。
fn sync_character_visibility(
    controllers: Query<(&ControlsCharacter, &ControlsCamera), With<GameplayContext>>,
    cameras: Query<&OrbitCamera>,
    characters: Query<(), With<Character>>,
    mut visuals: Query<(Entity, &ChildOf, &mut Visibility), With<CharacterVisual>>,
) {
    for (visual, parent, mut visibility) in &mut visuals {
        let character = parent.parent();
        let first_person = controllers
            .iter()
            .any(|(controlled_character, controlled_camera)| {
                characters.contains(character)
                    && controlled_character.0 == character
                    && cameras.get(controlled_camera.0).is_ok_and(|orbit| {
                        orbit.target == character
                            && orbit.perspective == CameraPerspective::FirstPerson
                    })
            });
        let after = if first_person {
            Visibility::Hidden
        } else {
            Visibility::Inherited
        };
        if *visibility != after {
            info!(target: "demo::camera", ?visual, ?character, before = ?*visibility, ?after,
                reason = "camera_perspective_visibility", "Character visual visibility changed");
            *visibility = after;
        }
    }
}

#[cfg(test)]
mod tests {
    use avian3d::prelude::{LinearVelocity, Position, RigidBody};
    use std::time::Duration;

    use bevy::{
        camera::visibility::VisibilityPlugin,
        ecs::relationship::RelationshipTarget,
        input::{
            ButtonState, InputPlugin,
            keyboard::{Key, KeyboardInput},
            mouse::{MouseButtonInput, MouseMotion},
        },
        mesh::skinning::SkinnedMeshInverseBindposes,
        time::TimeUpdateStrategy,
        transform::TransformPlugin,
    };
    use bevy_enhanced_input::prelude::TriggerState;

    use crate::{
        gameplay::{
            CarryGrip, CharacterIntent, CharacterMotion, GameplayPlugin, HeldBy, HeldTarget,
            HoldingItems, Pickable, PlayerId, PrototypeConfig,
        },
        input::{PlayerInputPlugin, spawn_keyboard_controller},
        island_recovery::{IslandRecoveryPlugin, SpawnPoint},
        physics::{character_body, ground_body, parcel_body},
    };

    use super::*;

    fn test_app() -> (App, Entity, Entity, Entity, Entity) {
        // 窗口仅作为 ECS 数据存在，不安装 WinitPlugin 或渲染插件，也不启动完整游戏。
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            InputPlugin,
            TransformPlugin,
            // 只注册可见性计算，不安装渲染或窗口后端。
            VisibilityPlugin,
            GameplayPlugin,
            PlayerInputPlugin,
            CameraControlPlugin,
            IslandRecoveryPlugin,
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO))
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<SkinnedMeshInverseBindposes>>();
        app.finish();
        app.cleanup();
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut().spawn((
            ground_body(&config),
            Transform::from_xyz(0.0, config.ground_y, 0.0),
        ));
        let window = app
            .world_mut()
            .spawn((
                Window {
                    focused: true,
                    ..default()
                },
                CursorOptions::default(),
                PrimaryWindow,
            ))
            .id();
        let character = app
            .world_mut()
            .spawn((
                Character,
                CharacterIntent::default(),
                CharacterMotion { grounded: true },
                character_body(&config),
                Transform::default(),
                Visibility::default(),
            ))
            .id();
        let orbit = OrbitCamera::new(character);
        let transform = orbit.transform(Vec3::ZERO);
        let camera = app
            .world_mut()
            .spawn((orbit, MouseLookState::default(), transform))
            .id();
        let controller = {
            let mut commands = app.world_mut().commands();
            let controller = spawn_keyboard_controller(&mut commands, PlayerId(1), character);
            commands.entity(controller).insert(ControlsCamera(camera));
            controller
        };
        app.world_mut().flush();
        // 首帧初始化捕获并丢弃增量，第二帧开始接收观察输入。
        app.update();
        app.update();
        // 初始化真实物理接触和插值端点，后续输入后的帧末检查不再补跑模拟。
        for _ in 0..6 {
            fixed_step(&mut app);
        }
        (app, window, character, camera, controller)
    }

    fn fixed_step(app: &mut App) {
        // 经主调度推进一固定步，覆盖 Avian 的 FixedPostUpdate 和插值，不能只执行玩法系统。
        let strategy = app
            .world_mut()
            .remove_resource::<TimeUpdateStrategy>()
            .unwrap();
        app.insert_resource(TimeUpdateStrategy::FixedTimesteps(1));
        app.update();
        app.insert_resource(strategy);
    }

    fn spawn_test_item(app: &mut App, position: Vec3) -> Entity {
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((
                Pickable,
                parcel_body(&config),
                Transform::from_translation(position),
            ))
            .id()
    }

    /// 原型默认偏移、纸箱和木箱复用相同的帧末姿态与解除关系回归。
    fn carry_grip_cases() -> [Option<Vec3>; 3] {
        [
            None,
            Some(Vec3::new(0.0, 1.3, -0.48)),
            Some(Vec3::new(0.0, 1.3, -0.62)),
        ]
    }

    fn mouse_motion(app: &mut App, delta: Vec2) {
        app.world_mut().write_message(MouseMotion { delta });
    }

    fn mouse_button(app: &mut App, window: Entity, state: ButtonState) {
        app.world_mut().write_message(MouseButtonInput {
            button: MouseButton::Left,
            state,
            window,
        });
    }

    #[test]
    fn f3_releases_pointer_and_click_recapture_skips_free_cursor_motion() {
        // 使用实际 F3 绑定验证调试释放；窗口仍只是 ECS 数据，不创建桌面窗口。
        let (mut app, window, _, camera, _) = test_app();
        let yaw = app.world().get::<OrbitCamera>(camera).unwrap().yaw;
        app.world_mut().write_message(KeyboardInput {
            key_code: KeyCode::F3,
            logical_key: Key::F3,
            state: ButtonState::Pressed,
            text: None,
            repeat: false,
            window,
        });
        app.update();
        assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
        assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
        assert_eq!(
            app.world().get::<CursorOptions>(window).unwrap().grab_mode,
            CursorGrabMode::None
        );
        for _ in 0..3 {
            mouse_motion(&mut app, Vec2::new(50.0, 20.0));
            app.update();
            assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, yaw);
        }
        app.world_mut().write_message(KeyboardInput {
            key_code: KeyCode::F3,
            logical_key: Key::F3,
            state: ButtonState::Released,
            text: None,
            repeat: false,
            window,
        });
        mouse_button(&mut app, window, ButtonState::Pressed);
        mouse_motion(&mut app, Vec2::new(200.0, 100.0));
        app.update();
        assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
        assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, yaw);
        mouse_button(&mut app, window, ButtonState::Released);
        mouse_motion(&mut app, Vec2::new(10.0, 0.0));
        app.update();
        assert_ne!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, yaw);
    }

    fn escape(app: &mut App, window: Entity, state: ButtonState) {
        app.world_mut().write_message(KeyboardInput {
            key_code: KeyCode::Escape,
            logical_key: Key::Escape,
            state,
            text: None,
            repeat: false,
            window,
        });
    }

    fn perspective_key(app: &mut App, window: Entity, state: ButtonState) {
        app.world_mut().write_message(KeyboardInput {
            key_code: KeyCode::KeyI,
            logical_key: Key::Character("i".into()),
            state,
            text: None,
            repeat: false,
            window,
        });
    }

    fn perspective_fire(context: Entity) -> Fire<TogglePerspectiveAction> {
        Fire {
            context,
            action: Entity::PLACEHOLDER,
            value: true,
            state: TriggerState::Fired,
            fired_secs: 0.0,
            elapsed_secs: 0.0,
        }
    }

    fn fire(context: Entity, delta: Vec2) -> Fire<LookAction> {
        Fire {
            context,
            action: Entity::PLACEHOLDER,
            value: delta,
            state: TriggerState::Fired,
            fired_secs: 0.0,
            elapsed_secs: 0.0,
        }
    }

    #[derive(Resource, Default)]
    struct TestInspectorUi {
        text: String,
        text_edit_rect: Option<egui::Rect>,
    }

    /// 测试仅生成 egui 内存布局，沿用本帧输入顺序，不安装渲染、窗口后端或检查器插件。
    fn add_test_inspector(app: &mut App) -> Entity {
        app.init_resource::<TestInspectorUi>()
            .add_systems(
                PreUpdate,
                prepare_test_inspector_input
                    .after(InputSystems)
                    .in_set(EguiPreUpdateSet::ProcessInput),
            )
            // 默认主上下文的 multipass 在 PostUpdate 才消费原始输入，与真实检查器的阶段一致。
            .add_systems(
                PostUpdate,
                (
                    begin_test_inspector_pass,
                    draw_test_inspector,
                    end_test_inspector_pass,
                )
                    .chain(),
            );
        let context = app
            .world_mut()
            .spawn((EguiContext::default(), PrimaryEguiContext))
            .id();
        app.update();
        app.update();
        context
    }

    fn prepare_test_inspector_input(
        windows: Query<&Window, With<PrimaryWindow>>,
        buttons: Res<ButtonInput<MouseButton>>,
        mut keyboard_events: MessageReader<KeyboardInput>,
        mut inputs: Query<&mut EguiInput, With<PrimaryEguiContext>>,
    ) {
        let window = windows.single().unwrap();
        let mut input = egui::RawInput {
            screen_rect: Some(egui::Rect::from_min_size(
                egui::Pos2::ZERO,
                egui::vec2(640.0, 360.0),
            )),
            ..default()
        };
        // 使用两倍 DPI，让回归同时检查物理光标到 egui 点坐标的换算。
        input
            .viewports
            .get_mut(&egui::ViewportId::ROOT)
            .unwrap()
            .native_pixels_per_point = Some(2.0);
        if let Some(position) = window.physical_cursor_position() {
            let position = egui::pos2(position.x / 2.0, position.y / 2.0);
            input.events.push(egui::Event::PointerMoved(position));
            for pressed in [true, false] {
                if (pressed && buttons.just_pressed(MouseButton::Left))
                    || (!pressed && buttons.just_released(MouseButton::Left))
                {
                    input.events.push(egui::Event::PointerButton {
                        pos: position,
                        button: egui::PointerButton::Primary,
                        pressed,
                        modifiers: default(),
                    });
                }
            }
        }
        for event in keyboard_events.read() {
            let key = match event.key_code {
                KeyCode::Escape => egui::Key::Escape,
                KeyCode::KeyW => egui::Key::W,
                KeyCode::KeyE => egui::Key::E,
                KeyCode::KeyI => egui::Key::I,
                KeyCode::Space => egui::Key::Space,
                _ => continue,
            };
            input.events.push(egui::Event::Key {
                key,
                physical_key: Some(key),
                pressed: event.state.is_pressed(),
                repeat: false,
                modifiers: default(),
            });
            if event.state.is_pressed() {
                if let Some(text) = &event.text {
                    input.events.push(egui::Event::Text(text.to_string()));
                }
            }
        }
        inputs.single_mut().unwrap().0 = input;
    }

    fn begin_test_inspector_pass(
        mut contexts: Query<(&mut EguiContext, &mut EguiInput), With<PrimaryEguiContext>>,
    ) {
        let (mut context, mut input) = contexts.single_mut().unwrap();
        context.get_mut().begin_pass(input.0.take());
    }

    fn draw_test_inspector(
        mut contexts: Query<&mut EguiContext, With<PrimaryEguiContext>>,
        mut ui_state: ResMut<TestInspectorUi>,
    ) {
        let mut context = contexts.single_mut().unwrap();
        egui::Window::new("Test inspector")
            .fixed_pos(egui::pos2(20.0, 20.0))
            .fixed_size(egui::vec2(280.0, 180.0))
            .show(context.get_mut(), |ui| {
                ui.label("Inspect world data");
                ui_state.text_edit_rect = Some(ui.text_edit_singleline(&mut ui_state.text).rect);
            });
    }

    fn end_test_inspector_pass(mut contexts: Query<&mut EguiContext, With<PrimaryEguiContext>>) {
        let _ = contexts.single_mut().unwrap().get_mut().end_pass();
    }

    fn set_cursor(app: &mut App, window: Entity, position: egui::Pos2) {
        app.world_mut()
            .get_mut::<Window>(window)
            .unwrap()
            .set_physical_cursor_position(Some(bevy::math::DVec2::new(
                f64::from(position.x * 2.0),
                f64::from(position.y * 2.0),
            )));
    }

    fn inspector_keyboard(app: &mut App, window: Entity, key_code: KeyCode, state: ButtonState) {
        let text = match key_code {
            KeyCode::KeyW => "w",
            KeyCode::KeyE => "e",
            KeyCode::KeyI => "i",
            KeyCode::Space => " ",
            _ => "",
        };
        app.world_mut().write_message(KeyboardInput {
            key_code,
            logical_key: Key::Character(text.into()),
            state,
            text: Some(text.into()),
            repeat: false,
            window,
        });
    }

    #[test]
    fn captured_pointer_over_inspector_does_not_consume_gameplay_input() {
        let (mut app, window, character, camera, controller) = test_app();
        let context = add_test_inspector(&mut app);
        let input_position = app
            .world()
            .resource::<TestInspectorUi>()
            .text_edit_rect
            .unwrap()
            .center();
        set_cursor(&mut app, window, input_position);
        inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Pressed);
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        mouse_button(&mut app, window, ButtonState::Released);
        app.update();
        assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
        assert!(
            **app
                .world()
                .get::<ContextActivity<GameplayContext>>(controller)
                .unwrap()
        );
        assert_eq!(
            app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .movement,
            Vec2::Y
        );
        assert!(app.world().resource::<TestInspectorUi>().text.is_empty());
        assert!(
            !app.world_mut()
                .get_mut::<EguiContext>(context)
                .unwrap()
                .get_mut()
                .egui_wants_keyboard_input()
        );

        inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Released);
        escape(&mut app, window, ButtonState::Pressed);
        app.update();
        assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
        escape(&mut app, window, ButtonState::Released);
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        mouse_button(&mut app, window, ButtonState::Released);
        app.update();
        assert!(
            app.world_mut()
                .get_mut::<EguiContext>(context)
                .unwrap()
                .get_mut()
                .egui_wants_keyboard_input()
        );
        inspector_keyboard(&mut app, window, KeyCode::KeyE, ButtonState::Pressed);
        app.update();
        assert_eq!(app.world().resource::<TestInspectorUi>().text, "e");
        assert!(
            !app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .interact_pending
        );

        inspector_keyboard(&mut app, window, KeyCode::KeyE, ButtonState::Released);
        set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        // 恢复时 egui 已收到面板外按下；下一帧过滤松开也必须把其按下状态清干净。
        mouse_button(&mut app, window, ButtonState::Released);
        app.update();
        assert!(
            !app.world_mut()
                .get_mut::<EguiContext>(context)
                .unwrap()
                .get_mut()
                .input(|input| input.pointer.any_down())
        );
        escape(&mut app, window, ButtonState::Pressed);
        app.update();
        escape(&mut app, window, ButtonState::Released);
        set_cursor(&mut app, window, input_position);
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        mouse_button(&mut app, window, ButtonState::Released);
        app.update();
        inspector_keyboard(&mut app, window, KeyCode::KeyI, ButtonState::Pressed);
        app.update();
        assert!(app.world().resource::<TestInspectorUi>().text.contains('i'));
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::ThirdPerson
        );
    }

    #[test]
    fn inspector_click_blocks_keyboard_actions_and_blank_click_requires_key_reset() {
        let (mut app, window, character, camera, controller) = test_app();
        add_test_inspector(&mut app);
        let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
        set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
        inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Pressed);
        app.update();
        assert_eq!(
            app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .movement,
            Vec2::Y
        );
        escape(&mut app, window, ButtonState::Pressed);
        app.update();
        assert!(
            **app
                .world()
                .get::<ContextActivity<GameplayContext>>(controller)
                .unwrap()
        );

        escape(&mut app, window, ButtonState::Released);
        let input_position = app
            .world()
            .resource::<TestInspectorUi>()
            .text_edit_rect
            .unwrap()
            .center();
        set_cursor(&mut app, window, input_position);
        mouse_button(&mut app, window, ButtonState::Pressed);
        for key in [KeyCode::Space, KeyCode::KeyE, KeyCode::KeyI] {
            inspector_keyboard(&mut app, window, key, ButtonState::Pressed);
        }
        // 首次点击面板和按键同帧到达，必须在动作准备前停用上下文。
        app.update();
        assert!(
            !**app
                .world()
                .get::<ContextActivity<GameplayContext>>(controller)
                .unwrap()
        );
        assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
        assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert_eq!(intent.movement, Vec2::ZERO);
        assert!(!intent.jump_pending && !intent.interact_pending);
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::ThirdPerson
        );
        fixed_step(&mut app);
        let position = app.world().get::<Position>(character).unwrap().0;
        assert!(Vec2::new(position.x, position.z).abs_diff_eq(Vec2::ZERO, 0.00001));
        assert!(app.world().get::<LinearVelocity>(character).unwrap().y < 0.1);
        assert!(app.world().get::<HeldBy>(item).is_none());

        mouse_button(&mut app, window, ButtonState::Released);
        app.update();
        set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
        mouse_button(&mut app, window, ButtonState::Released);
        inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Released);
        app.update();
        assert!(
            **app
                .world()
                .get::<ContextActivity<GameplayContext>>(controller)
                .unwrap()
        );
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert!(!intent.jump_pending && !intent.interact_pending);
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::ThirdPerson
        );

        for state in [ButtonState::Released, ButtonState::Pressed] {
            for key in [KeyCode::Space, KeyCode::KeyE, KeyCode::KeyI] {
                inspector_keyboard(&mut app, window, key, state);
            }
            app.update();
        }
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert!(intent.jump_pending && intent.interact_pending);
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::FirstPerson
        );
        fixed_step(&mut app);
        assert!(app.world().get::<LinearVelocity>(character).unwrap().y > 0.0);
        assert_eq!(
            app.world()
                .get::<HoldingItems>(character)
                .unwrap()
                .iter()
                .next(),
            Some(item)
        );
    }

    #[test]
    fn focused_inspector_keeps_keyboard_blocked_after_pointer_leaves_panel() {
        let (mut app, window, character, camera, controller) = test_app();
        let context = add_test_inspector(&mut app);
        escape(&mut app, window, ButtonState::Pressed);
        app.update();
        escape(&mut app, window, ButtonState::Released);
        let input_position = app
            .world()
            .resource::<TestInspectorUi>()
            .text_edit_rect
            .unwrap()
            .center();
        set_cursor(&mut app, window, input_position);
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        mouse_button(&mut app, window, ButtonState::Released);
        app.update();
        assert!(
            app.world_mut()
                .get_mut::<EguiContext>(context)
                .unwrap()
                .get_mut()
                .egui_wants_keyboard_input()
        );

        set_cursor(&mut app, window, egui::pos2(500.0, 300.0));
        for key in [KeyCode::KeyW, KeyCode::Space, KeyCode::KeyE, KeyCode::KeyI] {
            inspector_keyboard(&mut app, window, key, ButtonState::Pressed);
        }
        app.update();
        assert!(
            !**app
                .world()
                .get::<ContextActivity<GameplayContext>>(controller)
                .unwrap()
        );
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert_eq!(intent.movement, Vec2::ZERO);
        assert!(!intent.jump_pending && !intent.interact_pending);
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::ThirdPerson
        );
    }

    #[test]
    fn actual_mouse_action_applies_aggregate_once_and_fixed_steps_keep_input() {
        let (mut app, _, character, camera, _) = test_app();
        mouse_motion(&mut app, Vec2::new(100.0, 0.0));
        mouse_motion(&mut app, Vec2::new(50.0, 0.0));
        app.update();
        let yaw = app.world().get::<OrbitCamera>(camera).unwrap().yaw;
        assert!((yaw - (-0.45_f32).rem_euclid(TAU)).abs() < 0.00001);
        // 一帧无固定步时，Observer 更新的角度和持续移动轴都保留至模拟消费。
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        for _ in 0..3 {
            fixed_step(&mut app);
        }
        let transform = app.world().get::<Transform>(character).unwrap();
        assert!(
            transform
                .forward()
                .dot(Quat::from_rotation_y(yaw) * Vec3::NEG_Z)
                > 0.9999
        );
        let speed = app.world().resource::<PrototypeConfig>().move_speed;
        let position = app.world().get::<Position>(character).unwrap().0;
        let displacement = Vec3::new(position.x, 0.0, position.z);
        let direction = Quat::from_rotation_y(yaw) * Vec3::NEG_Z;
        // 动态角色逐步加速，检验固定步保留输入与方向，而非旧有的瞬时满速积分。
        assert!(displacement.dot(direction) > 0.0);
        assert!(displacement.length() <= speed * 3.0 / 60.0 + 0.00001);
        assert!(displacement.normalize().dot(direction) > 0.9999);
        app.update();
        assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, yaw);
        let orbit = app.world().get::<OrbitCamera>(camera).unwrap();
        let pivot = app.world().get::<Transform>(character).unwrap().translation
            + Vec3::Y * orbit.look_height;
        let camera_transform = app.world().get::<Transform>(camera).unwrap();
        assert!((camera_transform.translation.distance(pivot) - orbit.distance).abs() < 0.00001);
        assert!(
            camera_transform
                .forward()
                .dot((pivot - camera_transform.translation).normalize())
                > 0.9999
        );
    }

    #[test]
    fn look_routes_by_controller_clamps_pitch_and_supports_inversion() {
        let (mut app, _, _, first, first_controller) = test_app();
        let second_target = app
            .world_mut()
            .spawn((Character, Transform::default()))
            .id();
        let second = app
            .world_mut()
            .spawn((
                OrbitCamera::new(second_target),
                MouseLookState {
                    active: true,
                    initialized: true,
                    ..default()
                },
            ))
            .id();
        let second_controller = app
            .world_mut()
            .spawn((GameplayContext, ControlsCamera(second)))
            .id();
        app.world_mut()
            .trigger(fire(second_controller, Vec2::new(30.0, 10000.0)));
        assert_eq!(app.world().get::<OrbitCamera>(first).unwrap().yaw, 0.0);
        assert_eq!(
            app.world().get::<OrbitCamera>(second).unwrap().pitch(),
            80.0_f32.to_radians()
        );
        app.world_mut()
            .trigger(fire(second_controller, Vec2::new(0.0, -10000.0)));
        assert_eq!(
            app.world().get::<OrbitCamera>(second).unwrap().pitch(),
            5.0_f32.to_radians()
        );
        let pitch = app.world().get::<OrbitCamera>(first).unwrap().pitch();
        app.world_mut()
            .resource_mut::<GameSettings>()
            .camera
            .invert_y = true;
        app.world_mut()
            .trigger(fire(first_controller, Vec2::new(0.0, 10.0)));
        assert!(
            (app.world().get::<OrbitCamera>(first).unwrap().pitch() - (pitch - 0.03)).abs()
                < 0.00001
        );
        app.world_mut()
            .get_mut::<MouseLookState>(first)
            .unwrap()
            .active = false;
        let yaw = app.world().get::<OrbitCamera>(first).unwrap().yaw;
        app.world_mut()
            .trigger(fire(first_controller, Vec2::new(30.0, 0.0)));
        assert_eq!(app.world().get::<OrbitCamera>(first).unwrap().yaw, yaw);
        app.world_mut().despawn(second);
        app.world_mut().trigger(fire(second_controller, Vec2::ONE));
    }

    #[test]
    fn perspective_key_switches_pose_and_restores_each_pitch() {
        let (mut app, window, character, camera, _) = test_app();
        let visual = app
            .world_mut()
            .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
            .id();
        let nested_visual = app
            .world_mut()
            .spawn((Visibility::default(), ChildOf(visual)))
            .id();
        let other_character = app
            .world_mut()
            .spawn((Character, Visibility::default()))
            .id();
        let other_visual = app
            .world_mut()
            .spawn((
                CharacterVisual,
                Visibility::default(),
                ChildOf(other_character),
            ))
            .id();
        let initial_pitch = app.world().get::<OrbitCamera>(camera).unwrap().pitch();
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::ThirdPerson
        );
        let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();
        // 同帧鼠标先更新原视角，切换系统再恢复新视角的记忆角度。
        perspective_key(&mut app, window, ButtonState::Pressed);
        mouse_motion(&mut app, Vec2::new(10.0, 20.0));
        app.update();
        let orbit = app.world().get::<OrbitCamera>(camera).unwrap();
        let yaw = (-0.03_f32).rem_euclid(TAU);
        assert_eq!(orbit.perspective, CameraPerspective::FirstPerson);
        assert_eq!(orbit.first_person_pitch, 0.0);
        assert!((orbit.third_person_pitch - (initial_pitch + 0.06)).abs() < 0.00001);
        assert!((orbit.yaw - yaw).abs() < 0.00001);
        let camera_transform = app.world().get::<Transform>(camera).unwrap();
        assert_eq!(
            camera_transform.translation,
            app.world().get::<Transform>(character).unwrap().translation + Vec3::Y * 1.65
        );
        assert!(
            camera_transform
                .forward()
                .abs_diff_eq(Quat::from_rotation_y(yaw) * Vec3::NEG_Z, 0.00001)
        );
        assert_eq!(
            app.world().get::<Visibility>(visual),
            Some(&Visibility::Hidden)
        );
        assert!(
            !app.world()
                .get::<InheritedVisibility>(nested_visual)
                .unwrap()
                .get()
        );
        assert!(
            app.world()
                .get::<InheritedVisibility>(other_visual)
                .unwrap()
                .get()
        );
        assert_eq!(
            app.world().get::<Visibility>(character),
            Some(&Visibility::Inherited)
        );
        assert!(!app.world().get::<CursorOptions>(window).unwrap().visible);
        for _ in 0..3 {
            app.update();
            assert_eq!(
                app.world().get::<OrbitCamera>(camera).unwrap().perspective,
                CameraPerspective::FirstPerson
            );
        }
        perspective_key(&mut app, window, ButtonState::Released);
        mouse_motion(&mut app, Vec2::new(0.0, -100.0));
        app.update();
        assert!((app.world().get::<OrbitCamera>(camera).unwrap().pitch() + 0.3).abs() < 0.00001);

        perspective_key(&mut app, window, ButtonState::Pressed);
        mouse_motion(&mut app, Vec2::new(0.0, 10.0));
        app.update();
        let orbit = app.world().get::<OrbitCamera>(camera).unwrap();
        assert_eq!(orbit.perspective, CameraPerspective::ThirdPerson);
        assert!((orbit.pitch() - (initial_pitch + 0.06)).abs() < 0.00001);
        assert!((orbit.first_person_pitch + 0.27).abs() < 0.00001);
        assert_eq!(orbit.yaw, yaw);
        assert_eq!(
            app.world().get::<Visibility>(visual),
            Some(&Visibility::Inherited)
        );
        assert!(
            app.world()
                .get::<InheritedVisibility>(nested_visual)
                .unwrap()
                .get()
        );
        perspective_key(&mut app, window, ButtonState::Released);
        app.update();
        perspective_key(&mut app, window, ButtonState::Pressed);
        app.update();
        assert!((app.world().get::<OrbitCamera>(camera).unwrap().pitch() + 0.27).abs() < 0.00001);
        let character_position = app.world().get::<Transform>(character).unwrap().translation;
        assert!(
            Vec2::new(character_position.x, character_position.z).abs_diff_eq(Vec2::ZERO, 0.00001)
        );
        assert_eq!(app.world().resource::<Time<Fixed>>().elapsed(), fixed_time);
    }

    #[test]
    fn first_person_look_clamps_up_and_down_and_uses_camera_settings() {
        let (mut app, window, character, camera, _) = test_app();
        perspective_key(&mut app, window, ButtonState::Pressed);
        app.update();
        app.world_mut()
            .resource_mut::<GameSettings>()
            .camera
            .mouse_sensitivity = 0.006;
        app.world_mut()
            .resource_mut::<GameSettings>()
            .camera
            .invert_y = true;
        mouse_motion(&mut app, Vec2::new(10.0, 10.0));
        app.update();
        let orbit = app.world().get::<OrbitCamera>(camera).unwrap();
        assert!((orbit.yaw - (-0.06_f32).rem_euclid(TAU)).abs() < 0.00001);
        assert!((orbit.pitch() + 0.06).abs() < 0.00001);
        assert!(app.world().get::<Transform>(camera).unwrap().forward().y > 0.0);
        for (delta_y, pitch, forward_y) in [
            (10000.0, -85.0_f32.to_radians(), 1.0),
            (-10000.0, 85.0_f32.to_radians(), -1.0),
        ] {
            mouse_motion(&mut app, Vec2::new(0.0, delta_y));
            app.update();
            assert_eq!(
                app.world().get::<OrbitCamera>(camera).unwrap().pitch(),
                pitch
            );
            let transform = app.world().get::<Transform>(camera).unwrap();
            assert_eq!(
                transform.translation,
                app.world().get::<Transform>(character).unwrap().translation + Vec3::Y * 1.65
            );
            assert!(transform.forward().y * forward_y > 0.99);
            assert!(transform.rotation.is_finite());
        }
    }

    #[test]
    fn perspective_toggle_preserves_released_capture_and_ignores_lost_focus() {
        let (mut app, window, _, camera, _) = test_app();
        escape(&mut app, window, ButtonState::Pressed);
        perspective_key(&mut app, window, ButtonState::Pressed);
        app.update();
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::FirstPerson
        );
        assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
        assert_eq!(
            app.world().get::<CursorOptions>(window).unwrap().grab_mode,
            CursorGrabMode::None
        );
        escape(&mut app, window, ButtonState::Released);
        perspective_key(&mut app, window, ButtonState::Released);
        app.update();

        app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
        perspective_key(&mut app, window, ButtonState::Pressed);
        app.update();
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::FirstPerson
        );
        perspective_key(&mut app, window, ButtonState::Released);
        app.update();
        app.world_mut().get_mut::<Window>(window).unwrap().focused = true;
        // 同帧失焦后又回焦，也不能响应切换或自动捕获鼠标。
        for focused in [false, true] {
            app.world_mut()
                .write_message(WindowFocused { window, focused });
        }
        perspective_key(&mut app, window, ButtonState::Pressed);
        app.update();
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::FirstPerson
        );
        perspective_key(&mut app, window, ButtonState::Released);
        app.update();
        perspective_key(&mut app, window, ButtonState::Pressed);
        app.update();
        assert_eq!(
            app.world().get::<OrbitCamera>(camera).unwrap().perspective,
            CameraPerspective::ThirdPerson
        );
        assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
        assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
    }

    #[test]
    fn perspective_actions_route_only_to_valid_controller_targets() {
        let (mut app, _, first_character, first, _) = test_app();
        let second_character = app
            .world_mut()
            .spawn((Character, Transform::default()))
            .id();
        let second = app
            .world_mut()
            .spawn((
                OrbitCamera::new(second_character),
                MouseLookState {
                    focused: true,
                    ..default()
                },
                Transform::default(),
            ))
            .id();
        let second_controller = app
            .world_mut()
            .spawn((
                GameplayContext,
                ControlsCharacter(second_character),
                ControlsCamera(second),
            ))
            .id();
        app.world_mut().trigger(perspective_fire(second_controller));
        app.update();
        assert_eq!(
            app.world().get::<OrbitCamera>(first).unwrap().perspective,
            CameraPerspective::ThirdPerson
        );
        assert_eq!(
            app.world().get::<OrbitCamera>(second).unwrap().perspective,
            CameraPerspective::FirstPerson
        );
        app.world_mut()
            .get_mut::<ControlsCharacter>(second_controller)
            .unwrap()
            .0 = first_character;
        app.world_mut().trigger(perspective_fire(second_controller));
        app.update();
        assert_eq!(
            app.world().get::<OrbitCamera>(second).unwrap().perspective,
            CameraPerspective::FirstPerson
        );
        app.world_mut()
            .get_mut::<ControlsCharacter>(second_controller)
            .unwrap()
            .0 = second_character;
        app.world_mut()
            .entity_mut(second_character)
            .remove::<Character>();
        app.world_mut().trigger(perspective_fire(second_controller));
        app.update();
        assert_eq!(
            app.world().get::<OrbitCamera>(second).unwrap().perspective,
            CameraPerspective::FirstPerson
        );
        app.world_mut().despawn(second);
        app.world_mut().trigger(perspective_fire(second_controller));
        app.update();
    }

    #[test]
    fn hidden_character_visuals_recover_when_camera_binding_becomes_invalid() {
        for removed in [
            "camera",
            "controller",
            "character_component",
            "target_binding",
        ] {
            let (mut app, window, character, camera, controller) = test_app();
            let visual = app
                .world_mut()
                .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
                .id();
            perspective_key(&mut app, window, ButtonState::Pressed);
            app.update();
            assert!(
                !app.world()
                    .get::<InheritedVisibility>(visual)
                    .unwrap()
                    .get()
            );
            match removed {
                "camera" => {
                    app.world_mut().despawn(camera);
                }
                "controller" => {
                    app.world_mut().despawn(controller);
                }
                "character_component" => {
                    app.world_mut().entity_mut(character).remove::<Character>();
                }
                "target_binding" => {
                    app.world_mut()
                        .get_mut::<OrbitCamera>(camera)
                        .unwrap()
                        .target = Entity::PLACEHOLDER;
                }
                _ => unreachable!(),
            }
            app.update();
            assert_eq!(
                app.world().get::<Visibility>(visual),
                Some(&Visibility::Inherited)
            );
            assert!(
                app.world()
                    .get::<InheritedVisibility>(visual)
                    .unwrap()
                    .get()
            );
        }
    }

    #[test]
    fn first_person_motion_and_toggle_follow_actual_fixed_step_count() {
        for frame_duration in [Duration::ZERO, Duration::from_millis(50)] {
            let (mut app, window, character, camera, _) = test_app();
            app.insert_resource(TimeUpdateStrategy::ManualDuration(frame_duration));
            {
                let mut intent = app
                    .world_mut()
                    .get_mut::<CharacterIntent>(character)
                    .unwrap();
                intent.movement = Vec2::Y;
                intent.jump_pending = true;
                intent.interact_pending = true;
            }
            let position_before = app.world().get::<Position>(character).unwrap().0;
            let presentation_before = app.world().get::<Transform>(character).unwrap().translation;
            let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
            perspective_key(&mut app, window, ButtonState::Pressed);
            mouse_motion(&mut app, Vec2::new(100.0, 100.0));
            app.update();
            let world = app.world();
            let simulated = world.resource::<Time<Fixed>>().elapsed() - fixed_before;
            let orbit = world.get::<OrbitCamera>(camera).unwrap();
            assert_eq!(orbit.perspective, CameraPerspective::FirstPerson);
            assert!((orbit.yaw - (-0.3_f32).rem_euclid(TAU)).abs() < 0.00001);
            let transform = world.get::<Transform>(character).unwrap();
            let position = world.get::<Position>(character).unwrap().0;
            let direction = Quat::from_rotation_y(orbit.yaw) * Vec3::NEG_Z;
            assert!(transform.forward().dot(direction) > 0.9999);
            let intent = world.get::<CharacterIntent>(character).unwrap();
            if frame_duration.is_zero() {
                assert!(simulated.is_zero());
                assert!(intent.jump_pending && intent.interact_pending);
                assert_eq!(position, position_before);
                assert_eq!(transform.translation, presentation_before);
            } else {
                assert!(simulated >= world.resource::<Time<Fixed>>().timestep() * 2);
                assert!(!intent.jump_pending && !intent.interact_pending);
                assert!(position.y > position_before.y);
                let displacement = Vec3::new(position.x, 0.0, position.z)
                    - Vec3::new(position_before.x, 0.0, position_before.z);
                assert!(displacement.dot(direction) > 0.0);
                assert!(displacement.normalize().dot(direction) > 0.9999);
                assert!(
                    displacement.length()
                        <= world.resource::<PrototypeConfig>().move_speed * simulated.as_secs_f32()
                            + 0.00001
                );
            }
            assert!(
                world
                    .get::<Transform>(camera)
                    .unwrap()
                    .translation
                    .abs_diff_eq(transform.translation + Vec3::Y * 1.65, 0.00001)
            );
        }
    }

    #[test]
    fn water_recovery_uses_current_camera_facing_for_the_same_fixed_step_movement() {
        let (mut app, window, character, camera, _) = test_app();
        let spawn = Transform::from_xyz(4.0, 0.03, 5.0).with_rotation(Quat::from_rotation_y(-0.6));
        app.world_mut()
            .entity_mut(character)
            .insert(SpawnPoint(spawn));
        // 通过真实输入上下文持续按住 W，避免下一帧 Enhanced Input 清空手写的移动意图。
        inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Pressed);
        mouse_motion(&mut app, Vec2::new(-500.0, 0.0));
        app.update();
        let yaw = app.world().get::<OrbitCamera>(camera).unwrap().yaw;
        let facing = Quat::from_rotation_y(yaw) * Vec3::NEG_Z;
        assert!((spawn.rotation * Vec3::NEG_Z).dot(facing) < 0.0);
        assert_eq!(
            app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .movement,
            Vec2::Y
        );
        let underwater = Vec3::new(40.0, -2.0, -40.0);
        app.world_mut().get_mut::<Position>(character).unwrap().0 = underwater;
        app.world_mut()
            .get_mut::<Transform>(character)
            .unwrap()
            .translation = underwater;
        app.world_mut()
            .get_mut::<LinearVelocity>(character)
            .unwrap()
            .0 = Vec3::new(5.0, -3.0, 4.0);
        let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
        fixed_step(&mut app);
        let world = app.world();
        assert_eq!(
            world.resource::<Time<Fixed>>().elapsed() - fixed_before,
            world.resource::<Time<Fixed>>().timestep()
        );
        let position = world.get::<Position>(character).unwrap().0;
        assert!(position.distance(spawn.translation) < 0.1, "{position:?}");
        let velocity = world.get::<LinearVelocity>(character).unwrap().0;
        assert!(velocity.xz().length() > 0.05, "{velocity:?}");
        assert!(
            velocity.xz().normalize().dot(facing.xz()) > 0.9999,
            "Recovery movement used the spawn facing: {velocity:?} {facing:?}"
        );
        assert!(
            world
                .get::<Transform>(character)
                .unwrap()
                .forward()
                .dot(facing)
                > 0.9999
        );
        let recovered_fixed_time = world.resource::<Time<Fixed>>().elapsed();
        for _ in 0..3 {
            // 恢复后的零固定步帧不能再次用出生朝向覆盖当前镜头方向或推进物理。
            app.update();
            let world = app.world();
            assert_eq!(
                world.resource::<Time<Fixed>>().elapsed(),
                recovered_fixed_time
            );
            assert_eq!(world.get::<Position>(character).unwrap().0, position);
            assert_eq!(world.get::<LinearVelocity>(character).unwrap().0, velocity);
            assert!(
                world
                    .get::<Transform>(character)
                    .unwrap()
                    .forward()
                    .dot(facing)
                    > 0.9999
            );
        }
    }

    #[test]
    fn turning_preserves_translation_interpolation_and_camera_reads_presented_position() {
        let (mut app, _, character, camera, _) = test_app();
        let visual_offset = Vec3::new(0.0, 0.72, 0.0);
        let visual = app
            .world_mut()
            .spawn((
                CharacterVisual,
                Visibility::default(),
                Transform::from_translation(visual_offset),
                ChildOf(character),
            ))
            .id();
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / 240.0,
        )));
        let mut start = app.world().get::<Transform>(character).unwrap().translation;
        let mut end = app.world().get::<Position>(character).unwrap().0;
        let mut moving_frames_without_fixed_step = 0;
        for _ in 0..32 {
            let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
            let physical_before = app.world().get::<Position>(character).unwrap().0;
            mouse_motion(&mut app, Vec2::new(2.0, 0.0));
            app.update();
            let world = app.world();
            let time = world.resource::<Time<Fixed>>();
            if time.elapsed() != fixed_before {
                start = physical_before;
                end = world.get::<Position>(character).unwrap().0;
            } else if start.distance(end) > 0.0001 {
                moving_frames_without_fixed_step += 1;
            }
            // 连续无固定步帧仍按同一端点插值；若转向误触发瞬移检测，此处会立即失败。
            let expected = start.lerp(end, time.overstep_fraction());
            let character_transform = world.get::<Transform>(character).unwrap();
            assert!(
                character_transform
                    .translation
                    .abs_diff_eq(expected, 0.00001)
            );
            let orbit = world.get::<OrbitCamera>(camera).unwrap();
            assert!(
                character_transform
                    .rotation
                    .abs_diff_eq(Quat::from_rotation_y(orbit.yaw), 0.00001)
            );
            let camera_transform = world.get::<Transform>(camera).unwrap();
            assert!(
                camera_transform
                    .translation
                    .abs_diff_eq(orbit.transform(expected).translation, 0.00001)
            );
            assert!(
                world
                    .get::<GlobalTransform>(character)
                    .unwrap()
                    .translation()
                    .abs_diff_eq(expected, 0.00001)
            );
            let visual_global = world.get::<GlobalTransform>(visual).unwrap();
            assert!(
                visual_global
                    .translation()
                    .abs_diff_eq(character_transform.transform_point(visual_offset), 0.00001)
            );
            assert!(
                (visual_global.compute_transform().rotation * Vec3::NEG_Z)
                    .abs_diff_eq(*character_transform.forward(), 0.00001)
            );
        }
        assert!(moving_frames_without_fixed_step >= 3);
    }

    #[test]
    fn escape_focus_and_click_gate_the_same_frames_motion() {
        let (mut app, window, _, camera, _) = test_app();
        assert!(!app.world().get::<CursorOptions>(window).unwrap().visible);
        escape(&mut app, window, ButtonState::Pressed);
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, 0.0);
        assert_eq!(
            app.world().get::<CursorOptions>(window).unwrap().grab_mode,
            CursorGrabMode::None
        );
        escape(&mut app, window, ButtonState::Released);
        mouse_button(&mut app, window, ButtonState::Pressed);
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
        assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, 0.0);
        mouse_button(&mut app, window, ButtonState::Released);
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        let yaw = app.world().get::<OrbitCamera>(camera).unwrap().yaw;
        assert!(yaw != 0.0);
        // 窗口最终仍聚焦，但消息记录曾失焦；不能自动恢复或消费本帧位移。
        app.world_mut().write_message(WindowFocused {
            window,
            focused: false,
        });
        app.world_mut().write_message(WindowFocused {
            window,
            focused: true,
        });
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
        assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
        assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, yaw);
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, yaw);
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        assert_ne!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, yaw);
    }

    #[test]
    fn first_click_recaptures_even_when_focus_loss_missed_mouse_release() {
        let (mut app, window, _, camera, _) = test_app();
        mouse_button(&mut app, window, ButtonState::Pressed);
        app.update();
        app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
        app.world_mut().write_message(WindowFocused {
            window,
            focused: false,
        });
        app.update();
        // 在窗口外松开时不一定收到 Released；回焦不能依靠缓存按下状态判断点击。
        app.world_mut().get_mut::<Window>(window).unwrap().focused = true;
        app.world_mut().write_message(WindowFocused {
            window,
            focused: true,
        });
        app.update();
        assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
        mouse_button(&mut app, window, ButtonState::Pressed);
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
        assert_eq!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, 0.0);
        mouse_motion(&mut app, Vec2::X * 50.0);
        app.update();
        assert_ne!(app.world().get::<OrbitCamera>(camera).unwrap().yaw, 0.0);
    }

    #[test]
    fn equal_mouse_distance_has_equal_rotation_at_different_render_rates() {
        let mut rotations = Vec::new();
        for fps in [60, 120] {
            let (mut app, _, _, camera, _) = test_app();
            app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
                1.0 / f64::from(fps),
            )));
            for _ in 0..fps {
                mouse_motion(&mut app, Vec2::X * (200.0 / fps as f32));
                app.update();
            }
            rotations.push(app.world().get::<OrbitCamera>(camera).unwrap().yaw);
        }
        assert!((rotations[0] - rotations[1]).abs() < 0.0001);
        assert!((rotations[0] - (-0.6_f32).rem_euclid(TAU)).abs() < 0.0001);
    }

    /// 校验视觉使用箱子本帧的真实呈现姿态，不把持握目标误当成箱子位置。
    fn assert_item_visual_matches_root(world: &World, item: Entity, visual: Entity, offset: Vec3) {
        let root = world.get::<Transform>(item).unwrap();
        let root_global = world
            .get::<GlobalTransform>(item)
            .unwrap()
            .compute_transform();
        assert!(
            root_global
                .translation
                .abs_diff_eq(root.translation, 0.00001)
        );
        let visual_global = world
            .get::<GlobalTransform>(visual)
            .unwrap()
            .compute_transform();
        assert!(
            visual_global
                .translation
                .abs_diff_eq(root.transform_point(offset), 0.00001)
        );
        // 世界矩阵分解可能得到反号四元数，比较实际前向与上向。
        for axis in [Vec3::NEG_Z, Vec3::Y] {
            assert!((root_global.rotation * axis).abs_diff_eq(root.rotation * axis, 0.00001));
            assert!((visual_global.rotation * axis).abs_diff_eq(root.rotation * axis, 0.00001));
        }
    }

    #[test]
    fn held_target_and_visuals_use_current_frame_without_teleporting_box() {
        for (frame_duration, grip) in [Duration::ZERO, Duration::from_secs_f64(1.0 / 120.0)]
            .into_iter()
            .flat_map(|duration| carry_grip_cases().map(|grip| (duration, grip)))
        {
            let (mut app, window, character, camera, _) = test_app();
            let character_visual = app
                .world_mut()
                .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
                .id();
            let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
            if let Some(grip) = grip {
                app.world_mut().entity_mut(item).insert(CarryGrip(grip));
            }
            let grip_offset =
                grip.unwrap_or_else(|| app.world().resource::<PrototypeConfig>().hold_offset);
            let visual_offset = Vec3::new(0.0, 0.18, 0.0);
            app.world_mut()
                .entity_mut(item)
                .insert(Visibility::default());
            let visual_child = app
                .world_mut()
                .spawn((
                    Transform::from_translation(visual_offset),
                    Visibility::default(),
                    ChildOf(item),
                ))
                .id();
            fixed_step(&mut app);
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .interact_pending = true;
            fixed_step(&mut app);
            assert_eq!(
                app.world()
                    .get::<HoldingItems>(character)
                    .unwrap()
                    .iter()
                    .next(),
                Some(item)
            );
            assert_eq!(
                app.world().get::<RigidBody>(item),
                Some(&RigidBody::Dynamic)
            );
            let target = app.world().get::<HeldTarget>(item).unwrap();
            assert!(
                app.world()
                    .get::<Position>(item)
                    .unwrap()
                    .0
                    .distance(target.translation)
                    > 0.1
            );

            app.insert_resource(TimeUpdateStrategy::ManualDuration(frame_duration));
            let mut frames_without_fixed_step = 0;
            for frame in 0..12 {
                let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();
                let box_position = app.world().get::<Position>(item).unwrap().0;
                perspective_key(
                    &mut app,
                    window,
                    if frame % 2 == 0 {
                        ButtonState::Pressed
                    } else {
                        ButtonState::Released
                    },
                );
                mouse_motion(&mut app, Vec2::new(25.0, 5.0));
                // 不补跑固定步，直接检查本帧目标、物理位置和视觉子实体传播结果。
                app.update();
                let world = app.world();
                if world.resource::<Time<Fixed>>().elapsed() == fixed_time {
                    frames_without_fixed_step += 1;
                    assert_eq!(world.get::<Position>(item).unwrap().0, box_position);
                }
                let orbit = world.get::<OrbitCamera>(camera).unwrap();
                assert_eq!(
                    orbit.perspective,
                    if (frame / 2) % 2 == 0 {
                        CameraPerspective::FirstPerson
                    } else {
                        CameraPerspective::ThirdPerson
                    }
                );
                assert_eq!(
                    world
                        .get::<InheritedVisibility>(character_visual)
                        .unwrap()
                        .get(),
                    orbit.perspective == CameraPerspective::ThirdPerson
                );
                assert!(
                    world
                        .get::<InheritedVisibility>(visual_child)
                        .unwrap()
                        .get()
                );
                let character_transform = world.get::<Transform>(character).unwrap();
                let rotation = Quat::from_rotation_y(orbit.yaw);
                assert!(character_transform.rotation.abs_diff_eq(rotation, 0.00001));
                let held_target = world.get::<HeldTarget>(item).unwrap();
                let expected_target = character_transform.transform_point(grip_offset);
                assert!(
                    held_target
                        .translation
                        .abs_diff_eq(expected_target, 0.00001)
                );
                assert!(held_target.rotation.abs_diff_eq(rotation, 0.00001));
                let expected_camera = orbit.transform(character_transform.translation);
                let camera_transform = world.get::<Transform>(camera).unwrap();
                assert!(
                    camera_transform
                        .translation
                        .abs_diff_eq(expected_camera.translation, 0.00001)
                );
                assert!(
                    camera_transform
                        .rotation
                        .abs_diff_eq(expected_camera.rotation, 0.00001)
                );
                assert_eq!(world.get::<RigidBody>(item), Some(&RigidBody::Dynamic));
                assert_item_visual_matches_root(world, item, visual_child, visual_offset);
            }
            assert!(
                frames_without_fixed_step > 0,
                "The regression must exercise frames without a simulation step"
            );
        }
    }

    #[test]
    fn turning_updates_grip_target_and_released_box_stops_following() {
        for (perspective, grip) in [
            CameraPerspective::ThirdPerson,
            CameraPerspective::FirstPerson,
        ]
        .into_iter()
        .flat_map(|perspective| carry_grip_cases().map(|grip| (perspective, grip)))
        {
            let (mut app, window, character, camera, _) = test_app();
            if perspective == CameraPerspective::FirstPerson {
                perspective_key(&mut app, window, ButtonState::Pressed);
                app.update();
            }
            let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
            if let Some(grip) = grip {
                app.world_mut().entity_mut(item).insert(CarryGrip(grip));
            }
            let grip_offset =
                grip.unwrap_or_else(|| app.world().resource::<PrototypeConfig>().hold_offset);
            let visual_offset = Vec3::new(0.0, 0.18, 0.0);
            let visual_child = app
                .world_mut()
                .spawn((Transform::from_translation(visual_offset), ChildOf(item)))
                .id();
            fixed_step(&mut app);
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .interact_pending = true;
            fixed_step(&mut app);
            for _ in 0..12 {
                fixed_step(&mut app);
            }
            let physical_position = app.world().get::<Position>(item).unwrap().0;
            let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
            mouse_motion(&mut app, Vec2::new(500.0, -100.0));
            app.update();
            assert_eq!(
                app.world().resource::<Time<Fixed>>().elapsed(),
                fixed_before
            );
            assert_eq!(
                app.world().get::<Position>(item).unwrap().0,
                physical_position
            );
            let yaw = app.world().get::<OrbitCamera>(camera).unwrap().yaw;
            let character_transform = app.world().get::<Transform>(character).unwrap();
            let rotation = Quat::from_rotation_y(yaw);
            assert!(character_transform.up().dot(Vec3::Y) > 0.9999);
            assert!(character_transform.rotation.abs_diff_eq(rotation, 0.00001));
            let expected_target = character_transform.transform_point(grip_offset);
            assert!(
                app.world()
                    .get::<HeldTarget>(item)
                    .unwrap()
                    .translation
                    .abs_diff_eq(expected_target, 0.00001)
            );
            assert_item_visual_matches_root(app.world(), item, visual_child, visual_offset);

            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .interact_pending = true;
            fixed_step(&mut app);
            assert!(app.world().get::<HeldBy>(item).is_none());
            assert!(app.world().get::<HeldTarget>(item).is_none());
            assert_eq!(
                app.world().get::<RigidBody>(item),
                Some(&RigidBody::Dynamic)
            );
            let released_position = app.world().get::<Position>(item).unwrap().0;
            let released_velocity = app.world().get::<LinearVelocity>(item).unwrap().0;
            let released_transform = *app.world().get::<Transform>(item).unwrap();
            assert!(
                released_position.y
                    > app.world().resource::<PrototypeConfig>().parcel_half_height + 0.1
            );
            for _ in 0..6 {
                mouse_motion(&mut app, Vec2::new(50.0, 10.0));
                app.update();
                // 没有固定步时，仅更新人物和镜头；已释放箱子不得被旧目标重新拉回。
                assert_eq!(
                    app.world().get::<Position>(item).unwrap().0,
                    released_position
                );
                assert_eq!(
                    app.world().get::<LinearVelocity>(item).unwrap().0,
                    released_velocity
                );
                assert_eq!(
                    *app.world().get::<Transform>(item).unwrap(),
                    released_transform
                );
                assert!(app.world().get::<HeldBy>(item).is_none());
                assert!(app.world().get::<HeldTarget>(item).is_none());
                assert_item_visual_matches_root(app.world(), item, visual_child, visual_offset);
            }
        }
    }

    #[test]
    fn missing_target_or_controller_releases_capture_and_keeps_camera_pose() {
        for remove_target in [true, false] {
            let (mut app, window, character, camera, controller) = test_app();
            let before = *app.world().get::<Transform>(camera).unwrap();
            app.world_mut()
                .despawn(if remove_target { character } else { controller });
            mouse_motion(&mut app, Vec2::ONE * 100.0);
            // 捕获释放应在当前无固定步帧完成，不能补跑物理后再检查鼠标生命周期。
            app.update();
            assert!(!app.world().get::<MouseLookState>(camera).unwrap().active);
            assert!(app.world().get::<CursorOptions>(window).unwrap().visible);
            assert_eq!(*app.world().get::<Transform>(camera).unwrap(), before);
        }
    }

    #[test]
    fn cameras_follow_their_own_characters_with_original_initial_offset() {
        let mut app = App::new();
        app.add_systems(Update, follow_orbit_camera);
        for position in [Vec3::new(3.0, 1.0, -2.0), Vec3::new(-4.0, 0.0, 7.0)] {
            let target = app
                .world_mut()
                .spawn((Character, Transform::from_translation(position)))
                .id();
            app.world_mut()
                .spawn((OrbitCamera::new(target), Transform::default()));
        }
        app.update();
        let world = app.world_mut();
        let mut query = world.query::<(&OrbitCamera, &Transform)>();
        for (orbit, transform) in query.iter(world) {
            let position = world.get::<Transform>(orbit.target).unwrap().translation;
            assert!(
                transform
                    .translation
                    .abs_diff_eq(position + Vec3::new(0.0, 6.0, 8.0), 0.00001)
            );
        }
    }
}
