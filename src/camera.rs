//! 第一／第三人称视角：动作更新观察状态，固定步同步朝向，逐帧同步人物、持物、镜头和模型显示。

use std::f32::consts::TAU;

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
    gameplay::{Character, ControlsCharacter, GameplaySystems, sync_held_objects},
    input::{GameplayContext, LookAction, TogglePerspectiveAction},
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
#[derive(Component, Reflect)]
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
    active: bool,
    initialized: bool,
    skip_motion: bool,
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
                apply_perspective_toggle.after(EnhancedInputSystems::Apply),
            )
            .add_systems(
                FixedUpdate,
                // 默认 Main 在 PreUpdate 结束时应用动作命令，再进入固定步；此处只规定固定步内顺序。
                sync_character_facing.before(GameplaySystems::Simulate),
            )
            .add_systems(
                Update,
                // 渲染帧可能没有固定步，先补齐人物与持物姿态，避免镜头读取新角度而箱子仍停在旧角度。
                // 只同步派生姿态；位置积分与交互仍在固定步，随后由 PostUpdate 传播模型世界坐标。
                (
                    sync_character_facing,
                    sync_held_objects,
                    follow_orbit_camera,
                    sync_character_visibility,
                )
                    .chain(),
            );
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
) {
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
        let reason = if !available {
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
    // Esc 单独释放鼠标仍保留原有键盘操作；操作检查器时才停用整个动作上下文，取消事件会清空移动轴。
    // ContextActivity 是不可变组件，按实际变化插入，使 require_reset 保留重新启用前的按键释放边界。
    let gameplay_active = window.focused
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

/// 在固定模拟前及逐帧持物同步前设置水平朝向，站立、横移和后退时也跟随视角。
fn sync_character_facing(
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

/// 镜头使用最新人物位置与本帧环绕角；互斥过滤避免 Transform 查询读写冲突。
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
            CharacterIntent, CharacterMotion, GameplayPlugin, HeldBy, HoldingItems, Pickable,
            PlayerId, PrototypeConfig,
        },
        input::{PlayerInputPlugin, spawn_keyboard_controller},
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
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO))
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<SkinnedMeshInverseBindposes>>();
        app.finish();
        app.cleanup();
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
                CharacterMotion {
                    grounded: true,
                    ..default()
                },
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
        (app, window, character, camera, controller)
    }

    fn fixed_step(app: &mut App) {
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f64(1.0 / 60.0));
        app.world_mut().run_schedule(FixedUpdate);
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
        let item = app
            .world_mut()
            .spawn((Pickable, Transform::from_xyz(0.0, 0.3, -1.0)))
            .id();
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
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
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
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .vertical_velocity
                > 0.0
        );
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
        assert!(transform.translation.abs_diff_eq(
            Quat::from_rotation_y(yaw) * Vec3::NEG_Z * speed * 3.0 / 60.0,
            0.00001
        ));
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
        assert_eq!(camera_transform.translation, Vec3::Y * 1.65);
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
        assert_eq!(
            app.world().get::<Transform>(character).unwrap().translation,
            Vec3::ZERO
        );
        assert_eq!(app.world().resource::<Time<Fixed>>().elapsed(), fixed_time);
    }

    #[test]
    fn first_person_look_clamps_up_and_down_and_uses_camera_settings() {
        let (mut app, window, _, camera, _) = test_app();
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
            assert_eq!(transform.translation, Vec3::Y * 1.65);
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
            let expected = Quat::from_rotation_y(orbit.yaw)
                * Vec3::NEG_Z
                * world.resource::<PrototypeConfig>().move_speed
                * simulated.as_secs_f32();
            assert!(
                Vec2::new(transform.translation.x, transform.translation.z)
                    .abs_diff_eq(Vec2::new(expected.x, expected.z), 0.00001)
            );
            let intent = world.get::<CharacterIntent>(character).unwrap();
            if frame_duration.is_zero() {
                assert!(simulated.is_zero());
                assert!(intent.jump_pending && intent.interact_pending);
                assert_eq!(transform.translation.y, 0.0);
            } else {
                assert!(simulated >= world.resource::<Time<Fixed>>().timestep() * 2);
                assert!(!intent.jump_pending && !intent.interact_pending);
                assert!(transform.translation.y > 0.0);
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

    #[test]
    fn held_item_and_visual_child_follow_look_on_frames_without_fixed_steps() {
        for frame_duration in [Duration::ZERO, Duration::from_secs_f64(1.0 / 120.0)] {
            let (mut app, window, character, camera, _) = test_app();
            let character_visual = app
                .world_mut()
                .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
                .id();
            let item = app
                .world_mut()
                .spawn((Pickable, Transform::from_xyz(0.0, 0.3, -1.0)))
                .id();
            let child_transform = Transform::from_xyz(0.0, 0.18, 0.0);
            app.world_mut()
                .entity_mut(item)
                .insert(Visibility::default());
            let visual_child = app
                .world_mut()
                .spawn((child_transform, Visibility::default(), ChildOf(item)))
                .id();
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
            app.insert_resource(TimeUpdateStrategy::ManualDuration(frame_duration));
            let mut frames_without_fixed_step = 0;
            for frame in 0..12 {
                let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();
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
                // 不补跑固定步，直接检查本帧最终交给渲染的姿态与子节点传播结果。
                app.update();
                if app.world().resource::<Time<Fixed>>().elapsed() == fixed_time {
                    frames_without_fixed_step += 1;
                }
                let world = app.world();
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
                assert_eq!(character_transform.translation, Vec3::ZERO);
                assert!(
                    character_transform.rotation.abs_diff_eq(rotation, 0.00001),
                    "Character facing must match the current render frame's camera yaw"
                );
                let hold_offset = world.resource::<PrototypeConfig>().hold_offset;
                let held_transform =
                    Transform::from_translation(rotation * hold_offset).with_rotation(rotation);
                let camera_transform = orbit.transform(character_transform.translation);
                for (entity, expected) in [(item, held_transform), (camera, camera_transform)] {
                    let local = world.get::<Transform>(entity).unwrap();
                    assert!(local.translation.abs_diff_eq(expected.translation, 0.00001));
                    assert!(local.rotation.abs_diff_eq(expected.rotation, 0.00001));
                    let global = world
                        .get::<GlobalTransform>(entity)
                        .unwrap()
                        .compute_transform();
                    assert!(
                        global
                            .translation
                            .abs_diff_eq(expected.translation, 0.00001)
                    );
                    // 世界矩阵分解可能得到反号四元数，二者表示同一旋转，应比较实际朝向。
                    assert!(
                        (global.rotation * Vec3::NEG_Z)
                            .abs_diff_eq(expected.rotation * Vec3::NEG_Z, 0.00001)
                    );
                    assert!(
                        (global.rotation * Vec3::Y)
                            .abs_diff_eq(expected.rotation * Vec3::Y, 0.00001)
                    );
                }
                let child = world.get::<GlobalTransform>(visual_child).unwrap();
                assert!(child.translation().abs_diff_eq(
                    held_transform.transform_point(child_transform.translation),
                    0.00001
                ));
                let child_rotation = child.compute_transform().rotation;
                assert!(
                    (child_rotation * Vec3::NEG_Z).abs_diff_eq(rotation * Vec3::NEG_Z, 0.00001)
                );
            }
            assert!(
                frames_without_fixed_step > 0,
                "The regression must exercise frames without a simulation step"
            );
        }
    }

    #[test]
    fn standing_character_and_held_item_turn_before_interaction() {
        for perspective in [
            CameraPerspective::ThirdPerson,
            CameraPerspective::FirstPerson,
        ] {
            let (mut app, window, character, camera, _) = test_app();
            if perspective == CameraPerspective::FirstPerson {
                perspective_key(&mut app, window, ButtonState::Pressed);
                app.update();
            }
            let item = app
                .world_mut()
                .spawn((Pickable, Transform::from_xyz(0.0, 0.3, -1.0)))
                .id();
            let visual_offset = Vec3::new(0.0, 0.18, 0.0);
            let visual_child = app
                .world_mut()
                .spawn((Transform::from_translation(visual_offset), ChildOf(item)))
                .id();
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
            mouse_motion(&mut app, Vec2::new(500.0, -100.0));
            app.update();
            let yaw = app.world().get::<OrbitCamera>(camera).unwrap().yaw;
            let transform = app.world().get::<Transform>(character).unwrap();
            assert_eq!(transform.translation, Vec3::ZERO);
            assert!(transform.up().dot(Vec3::Y) > 0.9999);
            assert!(
                transform
                    .rotation
                    .abs_diff_eq(Quat::from_rotation_y(yaw), 0.00001)
            );
            let offset = app.world().resource::<PrototypeConfig>().hold_offset;
            assert!(
                app.world()
                    .get::<Transform>(item)
                    .unwrap()
                    .translation
                    .abs_diff_eq(transform.rotation * offset, 0.00001)
            );
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .interact_pending = true;
            fixed_step(&mut app);
            let mut expected = Quat::from_rotation_y(yaw) * Vec3::new(0.0, 0.0, -1.2);
            expected.y = 0.3;
            assert!(
                app.world()
                    .get::<Transform>(item)
                    .unwrap()
                    .translation
                    .abs_diff_eq(expected, 0.00001)
            );
            assert!(app.world().get::<HeldBy>(item).is_none());
            let dropped_rotation = app.world().get::<Transform>(item).unwrap().rotation;
            for _ in 0..6 {
                mouse_motion(&mut app, Vec2::new(50.0, 10.0));
                app.update();
                // 固定步已解除持有关系，逐帧姿态同步不能把放下的箱子重新拉回人物身前。
                let item_transform = app.world().get::<Transform>(item).unwrap();
                assert!(item_transform.translation.abs_diff_eq(expected, 0.00001));
                assert_eq!(item_transform.rotation, dropped_rotation);
                assert!(app.world().get::<HeldBy>(item).is_none());
                assert!(
                    app.world()
                        .get::<GlobalTransform>(item)
                        .unwrap()
                        .translation()
                        .abs_diff_eq(expected, 0.00001)
                );
                let visual = app.world().get::<GlobalTransform>(visual_child).unwrap();
                assert!(
                    visual
                        .translation()
                        .abs_diff_eq(expected + dropped_rotation * visual_offset, 0.00001)
                );
                assert!(
                    (visual.compute_transform().rotation * Vec3::NEG_Z)
                        .abs_diff_eq(dropped_rotation * Vec3::NEG_Z, 0.00001)
                );
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
            app.update();
            fixed_step(&mut app);
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
