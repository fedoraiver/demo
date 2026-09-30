//! 鼠标自由视角：输入观察者更新环绕角度，固定步同步模拟朝向，逐帧同步人物、持物和镜头。

use std::f32::consts::TAU;

use bevy::{
    input::{InputSystems, mouse::MouseButtonInput},
    prelude::*,
    window::{CursorGrabMode, CursorOptions, PrimaryWindow, WindowFocused},
};
use bevy_enhanced_input::prelude::{EnhancedInputSystems, Fire};

use crate::{
    gameplay::{Character, ControlsCharacter, GameplaySystems, sync_held_objects},
    input::{GameplayContext, LookAction},
    settings::GameSettings,
};

/// 控制者关联的相机，输入设备绑定仍由输入模块管理。
#[derive(Component)]
pub struct ControlsCamera(#[entities] pub Entity);

/// 环绕相机的持续状态；实际位置和朝向仅写入 Transform。
#[derive(Component)]
pub struct OrbitCamera {
    #[entities]
    pub target: Entity,
    yaw: f32,
    pitch: f32,
    distance: f32,
    look_height: f32,
}

impl OrbitCamera {
    /// 从原型原有的偏移初始化，保持初始画面和跟随距离。
    pub fn new(target: Entity) -> Self {
        let relative_offset = Vec3::new(0.0, 5.2, 8.0);
        Self {
            target,
            yaw: 0.0,
            pitch: relative_offset.y.atan2(relative_offset.z),
            distance: relative_offset.length(),
            look_height: 0.8,
        }
    }

    /// 根据目标的世界位置计算镜头，不读取或修改其他实体。
    pub fn transform(&self, target_position: Vec3) -> Transform {
        let pivot = target_position + Vec3::Y * self.look_height;
        let offset = Quat::from_rotation_y(self.yaw)
            * Vec3::new(
                0.0,
                self.distance * self.pitch.sin(),
                self.distance * self.pitch.cos(),
            );
        Transform::from_translation(pivot + offset).looking_at(pivot, Vec3::Y)
    }
}

/// 每个本地相机的鼠标捕获状态；恢复捕获的那帧不处理自由光标阶段的增量。
#[derive(Component, Default)]
pub struct MouseLookState {
    active: bool,
    initialized: bool,
    skip_motion: bool,
    target_available: bool,
}

/// 注册自由视角、鼠标捕获和人物朝向同步，不创建窗口。
pub struct CameraControlPlugin;

impl Plugin for CameraControlPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<GameSettings>()
            .add_message::<WindowFocused>()
            .add_observer(on_camera_look)
            .add_systems(Startup, log_pose_synchronization)
            .add_systems(
                PreUpdate,
                sync_mouse_capture
                    // 焦点和捕获状态先于动作评估生效，Esc 当帧即停止观察。
                    .after(InputSystems)
                    .before(EnhancedInputSystems::Prepare),
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
                )
                    .chain(),
            );
    }
}

/// 将模拟和逐帧姿态同步的调度约定写入统一会话日志，便于排查帧率相关问题。
fn log_pose_synchronization() {
    info!(target: "demo::camera", simulation_schedule = "FixedUpdate",
        presentation_schedule = "Update",
        presentation_order = "character_facing_held_objects_camera", reason = "initialization",
        "Camera pose synchronization configured");
}

/// 同时检查窗口状态和焦点消息，避免同一帧失焦后又回焦时自动恢复捕获。
fn sync_mouse_capture(
    keys: Res<ButtonInput<KeyCode>>,
    mut button_events: MessageReader<MouseButtonInput>,
    mut focus_events: MessageReader<WindowFocused>,
    mut windows: Query<(Entity, &Window, &mut CursorOptions), With<PrimaryWindow>>,
    controllers: Query<(&ControlsCharacter, &ControlsCamera), With<GameplayContext>>,
    characters: Query<(), With<Character>>,
    mut cameras: Query<(Entity, &OrbitCamera, &mut MouseLookState)>,
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

    let mut any_active = false;
    for (camera, orbit, mut state) in &mut cameras {
        let available = characters.contains(orbit.target)
            && controllers.iter().any(|(character, controlled_camera)| {
                character.0 == orbit.target && controlled_camera.0 == camera
            });
        if !available && (!state.initialized || state.target_available) {
            warn!(target: "demo::camera", ?camera, character = ?orbit.target,
                before = "available", after = "unavailable", reason = "camera_binding_unavailable",
                "Camera target or controller unavailable");
        }
        state.target_available = available;
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
        } else if !state.initialized || clicked {
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
    let before_pitch = orbit.pitch;
    let delta = event.value * settings.camera.mouse_sensitivity;
    orbit.yaw = (orbit.yaw - delta.x).rem_euclid(TAU);
    let vertical = if settings.camera.invert_y {
        -delta.y
    } else {
        delta.y
    };
    // 当前场景没有镜头碰撞，限制镜头保持在观察点上方并避开垂直极点。
    orbit.pitch = (orbit.pitch + vertical).clamp(5.0_f32.to_radians(), 80.0_f32.to_radians());
    // 连续角度只采样调试日志，捕获和失效状态仍逐次记录。
    if time.elapsed_secs_f64() >= *next_log_at {
        debug!(target: "demo::camera", camera = ?controlled.0, character = ?orbit.target,
            controller = ?event.context, yaw_before = before_yaw, yaw_after = orbit.yaw,
            pitch_before = before_pitch, pitch_after = orbit.pitch,
            reason = "mouse_motion_sample", "Orbit camera angles changed");
        *next_log_at = time.elapsed_secs_f64() + 0.5;
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy::{
        ecs::relationship::RelationshipTarget,
        input::{
            ButtonState, InputPlugin,
            keyboard::{Key, KeyboardInput},
            mouse::{MouseButtonInput, MouseMotion},
        },
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
            GameplayPlugin,
            PlayerInputPlugin,
            CameraControlPlugin,
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
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
            app.world().get::<OrbitCamera>(second).unwrap().pitch,
            80.0_f32.to_radians()
        );
        app.world_mut()
            .trigger(fire(second_controller, Vec2::new(0.0, -10000.0)));
        assert_eq!(
            app.world().get::<OrbitCamera>(second).unwrap().pitch,
            5.0_f32.to_radians()
        );
        let pitch = app.world().get::<OrbitCamera>(first).unwrap().pitch;
        app.world_mut()
            .resource_mut::<GameSettings>()
            .camera
            .invert_y = true;
        app.world_mut()
            .trigger(fire(first_controller, Vec2::new(0.0, 10.0)));
        assert!(
            (app.world().get::<OrbitCamera>(first).unwrap().pitch - (pitch - 0.03)).abs() < 0.00001
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
            let (mut app, _, character, camera, _) = test_app();
            let item = app
                .world_mut()
                .spawn((Pickable, Transform::from_xyz(0.0, 0.3, -1.0)))
                .id();
            let child_transform = Transform::from_xyz(0.0, 0.18, 0.0);
            let visual_child = app.world_mut().spawn((child_transform, ChildOf(item))).id();
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
            for _ in 0..12 {
                let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();
                mouse_motion(&mut app, Vec2::new(25.0, 5.0));
                // 不补跑固定步，直接检查本帧最终交给渲染的姿态与子节点传播结果。
                app.update();
                if app.world().resource::<Time<Fixed>>().elapsed() == fixed_time {
                    frames_without_fixed_step += 1;
                }
                let world = app.world();
                let orbit = world.get::<OrbitCamera>(camera).unwrap();
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
        let (mut app, _, character, camera, _) = test_app();
        let item = app
            .world_mut()
            .spawn((Pickable, Transform::from_xyz(0.0, 0.3, -1.0)))
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
