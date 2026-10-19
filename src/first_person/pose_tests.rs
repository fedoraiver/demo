use crate::character::character_body;
use crate::item_interaction::parcel_body;
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
    bounds_recovery::{BoundsRecoveryPlugin, SpawnPoint},
    character::{CharacterIntent, CharacterMotion, CharacterPlugin},
    first_person::PlayerId,
    first_person::{FirstPersonPlugin, spawn_keyboard_controller},
    item_interaction::{CarryGrip, HeldBy, HeldTarget, HoldingItems, Pickable},
    physics::ground_body,
    settings::PrototypeConfig,
};

use super::*;
use crate::{
    game_flow::configure_feature_order, item_interaction::ItemInteractionPlugin,
    physics::GamePhysicsPlugin,
};

pub(super) fn test_app() -> (App, Entity, Entity, Entity, Entity) {
    // 窗口仅作为 ECS 数据存在，不安装 WinitPlugin 或渲染插件，也不启动完整游戏。
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        InputPlugin,
        TransformPlugin,
        // 只注册可见性计算，不安装渲染或窗口后端。
        VisibilityPlugin,
        GamePhysicsPlugin,
        CharacterPlugin,
        ItemInteractionPlugin,
        bevy_enhanced_input::EnhancedInputPlugin,
        FirstPersonPlugin,
        BoundsRecoveryPlugin,
    ))
    .insert_resource(Time::<Fixed>::from_hz(60.0))
    .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO))
    .init_resource::<Assets<Mesh>>()
    .init_resource::<Assets<SkinnedMeshInverseBindposes>>();
    configure_feature_order(&mut app);
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
    let view = FirstPersonCamera::new(character);
    let transform = view.transform(Vec3::ZERO);
    let camera = app
        .world_mut()
        .spawn((view, MouseLookState::default(), transform))
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

#[path = "capture_tests.rs"]
mod capture_tests;

#[path = "view_tests.rs"]
mod view_tests;

#[path = "held_pose_tests.rs"]
mod held_pose_tests;
