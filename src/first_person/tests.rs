//! 第一人称动作、捕获、视角与持物姿态的无窗口回归。

use super::*;

mod action_tests {
    use crate::item_interaction::parcel_body;
    use std::time::Duration;

    use avian3d::prelude::{
        ColliderDisabled, ColliderOf, LinearVelocity, Physics, Position, RigidBody,
    };
    use bevy::{ecs::relationship::RelationshipTarget, time::TimeUpdateStrategy};

    use crate::{
        character::CharacterMotion,
        item_interaction::{HeldBy, HeldTarget, HoldingItems, Parcel, Pickable},
        settings::PrototypeConfig,
    };

    use super::actions::{InteractAction, JumpAction, MoveAction};
    use super::*;
    use bevy_enhanced_input::prelude::{Cancel, *};

    fn fire<A: InputAction>(context: Entity, value: A::Output) -> Fire<A> {
        Fire {
            context,
            action: Entity::PLACEHOLDER,
            value,
            state: TriggerState::Fired,
            fired_secs: 0.0,
            elapsed_secs: 0.0,
        }
    }

    #[test]
    fn actions_are_routed_to_their_own_character() {
        let mut app = App::new();
        app.add_observer(record_movement)
            .add_observer(request_jump)
            .add_observer(request_interaction);
        let first = app
            .world_mut()
            .spawn((Character, CharacterIntent::default()))
            .id();
        let second = app
            .world_mut()
            .spawn((Character, CharacterIntent::default()))
            .id();
        let first_context = app
            .world_mut()
            .spawn((GameplayContext, ControlsCharacter(first)))
            .id();
        let second_context = app
            .world_mut()
            .spawn((GameplayContext, ControlsCharacter(second)))
            .id();

        app.world_mut()
            .trigger(fire::<MoveAction>(first_context, Vec2::X));
        app.world_mut()
            .trigger(fire::<JumpAction>(second_context, true));
        app.world_mut()
            .trigger(fire::<InteractAction>(first_context, true));

        let first_intent = app.world().get::<CharacterIntent>(first).unwrap();
        let second_intent = app.world().get::<CharacterIntent>(second).unwrap();
        assert_eq!(first_intent.movement, Vec2::X);
        assert!(!first_intent.jump_pending);
        assert!(first_intent.interact_pending);
        assert_eq!(second_intent.movement, Vec2::ZERO);
        assert!(second_intent.jump_pending);
        assert!(!second_intent.interact_pending);
    }

    #[test]
    fn movement_completion_and_cancellation_clear_only_their_character() {
        let mut app = App::new();
        app.add_observer(clear_completed_movement)
            .add_observer(clear_cancelled_movement);
        let first = app
            .world_mut()
            .spawn((
                Character,
                CharacterIntent {
                    movement: Vec2::X,
                    ..default()
                },
            ))
            .id();
        let second = app
            .world_mut()
            .spawn((
                Character,
                CharacterIntent {
                    movement: Vec2::Y,
                    ..default()
                },
            ))
            .id();
        let first_context = app
            .world_mut()
            .spawn((GameplayContext, ControlsCharacter(first)))
            .id();
        let second_context = app
            .world_mut()
            .spawn((GameplayContext, ControlsCharacter(second)))
            .id();

        app.world_mut().trigger(Complete::<MoveAction> {
            context: first_context,
            action: Entity::PLACEHOLDER,
            value: Vec2::ZERO,
            state: TriggerState::None,
            fired_secs: 0.0,
            elapsed_secs: 0.0,
        });
        assert_eq!(
            app.world().get::<CharacterIntent>(first).unwrap().movement,
            Vec2::ZERO
        );
        assert_eq!(
            app.world().get::<CharacterIntent>(second).unwrap().movement,
            Vec2::Y
        );
        app.world_mut().trigger(Cancel::<MoveAction> {
            context: second_context,
            action: Entity::PLACEHOLDER,
            value: Vec2::ZERO,
            state: TriggerState::None,
            elapsed_secs: 0.0,
        });
        assert_eq!(
            app.world().get::<CharacterIntent>(second).unwrap().movement,
            Vec2::ZERO
        );
    }

    #[test]
    fn keyboard_press_fires_once_and_requests_survive_until_consumed() {
        // 复用真实控制关联；零固定步帧只记录请求，不让运动和交互消费者提前取走。
        let (mut app, _, character, _, _) = super::pose_tests::test_app();

        {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            keys.press(KeyCode::Space);
            keys.press(KeyCode::KeyE);
            keys.press(KeyCode::KeyW);
        }
        app.update();
        app.update();
        {
            let mut intent = app
                .world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap();
            assert!(intent.jump_pending);
            assert!(intent.interact_pending);
            assert_eq!(intent.movement, Vec2::Y);
            intent.jump_pending = false;
            intent.interact_pending = false;
        }
        app.update();
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert!(!intent.jump_pending);
        assert!(!intent.interact_pending);

        {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            keys.release(KeyCode::Space);
            keys.release(KeyCode::KeyE);
            keys.release(KeyCode::KeyW);
        }
        app.update();
        assert_eq!(
            app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .movement,
            Vec2::ZERO
        );
        {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            keys.press(KeyCode::Space);
            keys.press(KeyCode::KeyE);
        }
        app.update();
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert!(intent.jump_pending);
        assert!(intent.interact_pending);
    }

    #[test]
    fn keyboard_scene_preserves_cardinal_axes_and_cleans_up_owned_inputs() {
        let (mut app, _, character, _, controller) = super::pose_tests::test_app();
        let actions = app
            .world()
            .get::<Actions<GameplayContext>>(controller)
            .unwrap()
            .iter()
            .collect::<Vec<_>>();
        let bindings = actions
            .iter()
            .flat_map(|action| app.world().get::<Bindings>(*action).unwrap().iter())
            .collect::<Vec<_>>();

        for (pressed, released, expected) in [
            (vec![KeyCode::KeyW, KeyCode::KeyD], vec![], Vec2::ONE),
            (vec![KeyCode::KeyA], vec![], Vec2::Y),
            (vec![KeyCode::KeyS], vec![KeyCode::KeyW], Vec2::NEG_Y),
            (
                vec![],
                vec![KeyCode::KeyA, KeyCode::KeyD, KeyCode::KeyS],
                Vec2::ZERO,
            ),
        ] {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            for key in pressed {
                keys.press(key);
            }
            for key in released {
                keys.release(key);
            }
            app.update();
            assert_eq!(
                app.world()
                    .get::<CharacterIntent>(character)
                    .unwrap()
                    .movement,
                expected
            );
        }

        // Actions 与 Bindings 的 linked_spawn 关系必须随控制者清理，不能留下仍消费键盘的动作。
        app.world_mut().despawn(controller);
        for entity in actions.into_iter().chain(bindings) {
            assert!(app.world().get_entity(entity).is_err());
        }
        assert!(app.world().get::<CharacterIntent>(character).is_some());
    }

    #[test]
    fn keyboard_actions_drive_physics_pickup_jump_and_release() {
        // 使用完整输入、相机与真实物理组合，所有断言都在实际 app.update 的帧末检查。
        let (mut app, _, character, _, _) = super::pose_tests::test_app();
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / 60.0,
        )));
        let config = app.world().resource::<PrototypeConfig>().clone();
        let item = app
            .world_mut()
            .spawn((
                Parcel,
                Pickable,
                Transform::from_xyz(0.0, config.parcel_half_height, -1.0),
                parcel_body(&config),
            ))
            .id();
        // 接地由真实碰撞探测建立，测试不预先伪造 grounded。
        for _ in 0..30 {
            app.update();
        }
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded
        );
        let character_before = app.world().get::<Position>(character).unwrap().0;
        let item_before = app.world().get::<Position>(item).unwrap().0;
        let physics_before = app.world().resource::<Time<Physics>>().elapsed();

        {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            keys.press(KeyCode::KeyE);
            keys.press(KeyCode::KeyW);
            keys.press(KeyCode::Space);
        }
        app.update();

        assert!(app.world().resource::<Time<Physics>>().elapsed() > physics_before);
        assert_eq!(
            app.world()
                .get::<HoldingItems>(character)
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            vec![item]
        );
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert!(!intent.jump_pending && !intent.interact_pending);
        let character_after = app.world().get::<Position>(character).unwrap().0;
        let item_after = app.world().get::<Position>(item).unwrap().0;
        assert!(character_after.y > character_before.y);
        assert!(character_after.z < character_before.z);
        assert!(app.world().get::<LinearVelocity>(character).unwrap().y > 0.0);
        assert!(app.world().get::<RigidBody>(item).is_none());
        let proxy = app
            .world()
            .get::<crate::item_interaction::HeldAttachment>(item)
            .unwrap()
            .collider;
        assert_eq!(
            app.world().get::<ColliderOf>(proxy).unwrap().body,
            character
        );
        assert!(app.world().get::<ColliderDisabled>(item).is_some());
        // 拾取先建立整体碰撞并安全对齐，第一步箱子仍与目标有间距，不能瞬移到手中。
        let target = app.world().get::<HeldTarget>(item).unwrap();
        assert!(item_after.distance(target.translation) > 0.1);

        for _ in 0..12 {
            app.update();
            let intent = app.world().get::<CharacterIntent>(character).unwrap();
            assert!(!intent.jump_pending && !intent.interact_pending);
            assert!(app.world().get::<HeldBy>(item).is_some());
        }
        assert!(
            app.world()
                .get::<Position>(item)
                .unwrap()
                .0
                .distance(item_before)
                > 0.1
        );

        // 松开后再次按 E 才释放；下一物理步仍保留已有水平速度并自然积分。
        {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            keys.release(KeyCode::Space);
            keys.release(KeyCode::KeyE);
        }
        app.update();
        let release_position = app.world().get::<Position>(item).unwrap().0;
        let release_velocity = Vec3::new(2.0, 1.0, -1.0);
        app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = release_velocity;
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::KeyE);
        app.update();

        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(app.world().get::<HeldTarget>(item).is_none());
        assert!(
            app.world()
                .get::<HoldingItems>(character)
                .is_none_or(|items| items.is_empty())
        );
        let velocity_after_release = app.world().get::<LinearVelocity>(item).unwrap().0;
        assert!((velocity_after_release.x - release_velocity.x).abs() < 0.05);
        assert!((velocity_after_release.z - release_velocity.z).abs() < 0.05);
        assert!(app.world().get::<Position>(item).unwrap().0.x > release_position.x);
        for _ in 0..3 {
            app.update();
            assert!(app.world().get::<HeldBy>(item).is_none());
            assert!(
                !app.world()
                    .get::<CharacterIntent>(character)
                    .unwrap()
                    .interact_pending
            );
        }
    }
}

mod pose_tests {
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
        scene::ScenePlugin,
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
            AssetPlugin::default(),
            ScenePlugin,
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
        let mut output = contexts.single_mut().unwrap().get_mut().end_pass();
        // 无窗口夹具只验证输入与内存布局，不上传纹理；egui 要求显式清空未应用的更新。
        output.textures_delta.clear();
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

    mod capture_tests {
        //! capture tests 的无窗口回归。

        use super::*;

        #[test]
        fn f3_releases_pointer_and_click_recapture_skips_free_cursor_motion() {
            // 使用实际 F3 绑定验证调试释放；窗口仍只是 ECS 数据，不创建桌面窗口。
            let (mut app, window, _, camera, _) = test_app();
            let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
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
                assert_eq!(
                    app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                    yaw
                );
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
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                yaw
            );
            mouse_button(&mut app, window, ButtonState::Released);
            mouse_motion(&mut app, Vec2::new(10.0, 0.0));
            app.update();
            assert_ne!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                yaw
            );
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
            for key in [KeyCode::Space, KeyCode::KeyE] {
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

            for state in [ButtonState::Released, ButtonState::Pressed] {
                for key in [KeyCode::Space, KeyCode::KeyE] {
                    inspector_keyboard(&mut app, window, key, state);
                }
                app.update();
            }
            let intent = app.world().get::<CharacterIntent>(character).unwrap();
            assert!(intent.jump_pending && intent.interact_pending);
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
            let (mut app, window, character, _, controller) = test_app();
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
            for key in [KeyCode::KeyW, KeyCode::Space, KeyCode::KeyE] {
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
        }

        #[test]
        fn escape_focus_and_click_gate_the_same_frames_motion() {
            let (mut app, window, _, camera, _) = test_app();
            assert!(!app.world().get::<CursorOptions>(window).unwrap().visible);
            escape(&mut app, window, ButtonState::Pressed);
            mouse_motion(&mut app, Vec2::X * 50.0);
            app.update();
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                0.0
            );
            assert_eq!(
                app.world().get::<CursorOptions>(window).unwrap().grab_mode,
                CursorGrabMode::None
            );
            escape(&mut app, window, ButtonState::Released);
            mouse_button(&mut app, window, ButtonState::Pressed);
            mouse_motion(&mut app, Vec2::X * 50.0);
            app.update();
            assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                0.0
            );
            mouse_button(&mut app, window, ButtonState::Released);
            mouse_motion(&mut app, Vec2::X * 50.0);
            app.update();
            let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
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
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                yaw
            );
            mouse_motion(&mut app, Vec2::X * 50.0);
            app.update();
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                yaw
            );
            mouse_button(&mut app, window, ButtonState::Pressed);
            app.update();
            mouse_motion(&mut app, Vec2::X * 50.0);
            app.update();
            assert_ne!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                yaw
            );
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
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                0.0
            );
            mouse_motion(&mut app, Vec2::X * 50.0);
            app.update();
            assert_ne!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                0.0
            );
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
    }

    mod view_tests {
        //! view tests 的无窗口回归。

        use super::*;

        #[test]
        fn actual_mouse_action_applies_aggregate_once_and_fixed_steps_keep_input() {
            let (mut app, _, character, camera, _) = test_app();
            mouse_motion(&mut app, Vec2::new(100.0, 0.0));
            mouse_motion(&mut app, Vec2::new(50.0, 0.0));
            app.update();
            let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
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
            // 动态角色逐步加速，检验固定步保留输入与方向。
            assert!(displacement.dot(direction) > 0.0);
            assert!(displacement.length() <= speed * 3.0 / 60.0 + 0.00001);
            assert!(displacement.normalize().dot(direction) > 0.9999);
            app.update();
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().yaw,
                yaw
            );
            let view = app.world().get::<FirstPersonCamera>(camera).unwrap();
            let eye = app.world().get::<Transform>(character).unwrap().translation
                + Vec3::Y * view.eye_height;
            let camera_transform = app.world().get::<Transform>(camera).unwrap();
            assert!(camera_transform.translation.abs_diff_eq(eye, 0.00001));
            assert!(camera_transform.forward().dot(direction) > 0.9999);
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
                    FirstPersonCamera::new(second_target),
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
            assert_eq!(
                app.world().get::<FirstPersonCamera>(first).unwrap().yaw,
                0.0
            );
            assert_eq!(
                app.world().get::<FirstPersonCamera>(second).unwrap().pitch,
                85.0_f32.to_radians()
            );
            app.world_mut()
                .trigger(fire(second_controller, Vec2::new(0.0, -10000.0)));
            assert_eq!(
                app.world().get::<FirstPersonCamera>(second).unwrap().pitch,
                -85.0_f32.to_radians()
            );
            let pitch = app.world().get::<FirstPersonCamera>(first).unwrap().pitch;
            app.world_mut()
                .resource_mut::<GameSettings>()
                .camera
                .invert_y = true;
            app.world_mut()
                .trigger(fire(first_controller, Vec2::new(0.0, 10.0)));
            assert!(
                (app.world().get::<FirstPersonCamera>(first).unwrap().pitch - (pitch - 0.03)).abs()
                    < 0.00001
            );
            app.world_mut()
                .get_mut::<MouseLookState>(first)
                .unwrap()
                .active = false;
            let yaw = app.world().get::<FirstPersonCamera>(first).unwrap().yaw;
            app.world_mut()
                .trigger(fire(first_controller, Vec2::new(30.0, 0.0)));
            assert_eq!(
                app.world().get::<FirstPersonCamera>(first).unwrap().yaw,
                yaw
            );
            app.world_mut().despawn(second);
            app.world_mut().trigger(fire(second_controller, Vec2::ONE));
        }

        #[test]
        fn starts_at_eye_height_and_hides_only_the_controlled_character() {
            let (mut app, _, character, camera, _) = test_app();
            let own_visual = app
                .world_mut()
                .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
                .id();
            let other_character = app
                .world_mut()
                .spawn((Character, Transform::default(), Visibility::default()))
                .id();
            let other_visual = app
                .world_mut()
                .spawn((
                    CharacterVisual,
                    Visibility::default(),
                    ChildOf(other_character),
                ))
                .id();
            let item = spawn_test_item(&mut app, Vec3::new(0.0, 0.3, -1.0));
            app.world_mut()
                .entity_mut(item)
                .insert(Visibility::default());
            let item_visual = app
                .world_mut()
                .spawn((Transform::default(), Visibility::default(), ChildOf(item)))
                .id();

            // 首帧显示同步就使用眼位和自身隐藏，不需要任何视角输入。
            app.update();
            let pose = app.world().get::<Transform>(camera).unwrap();
            let position = app.world().get::<Transform>(character).unwrap().translation;
            assert!(
                pose.translation
                    .abs_diff_eq(position + Vec3::Y * 1.65, 0.00001)
            );
            assert!(pose.forward().dot(Vec3::NEG_Z) > 0.9999);
            assert_eq!(
                app.world().get::<FirstPersonCamera>(camera).unwrap().pitch,
                0.0
            );
            assert!(
                !app.world()
                    .get::<InheritedVisibility>(own_visual)
                    .unwrap()
                    .get()
            );
            assert!(
                app.world()
                    .get::<InheritedVisibility>(other_visual)
                    .unwrap()
                    .get()
            );
            assert!(
                app.world()
                    .get::<InheritedVisibility>(item_visual)
                    .unwrap()
                    .get()
            );
        }

        #[test]
        fn i_key_keeps_first_person_pose_visibility_and_gameplay_intent() {
            let (mut app, window, character, camera, _) = test_app();
            let visual = app
                .world_mut()
                .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
                .id();
            mouse_motion(&mut app, Vec2::new(100.0, -50.0));
            app.update();
            let pose = *app.world().get::<Transform>(camera).unwrap();
            let position = app.world().get::<Position>(character).unwrap().0;
            let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();

            // 使用真实键盘消息覆盖长按、松开和重复按下，帧末不补跑模拟。
            for state in [
                ButtonState::Pressed,
                ButtonState::Released,
                ButtonState::Pressed,
            ] {
                inspector_keyboard(&mut app, window, KeyCode::KeyI, state);
                for _ in 0..3 {
                    app.update();
                    assert_eq!(*app.world().get::<Transform>(camera).unwrap(), pose);
                    assert_eq!(app.world().get::<Position>(character).unwrap().0, position);
                    assert_eq!(app.world().resource::<Time<Fixed>>().elapsed(), fixed_time);
                    assert!(
                        !app.world()
                            .get::<InheritedVisibility>(visual)
                            .unwrap()
                            .get()
                    );
                    assert!(app.world().get::<MouseLookState>(camera).unwrap().active);
                    let intent = app.world().get::<CharacterIntent>(character).unwrap();
                    assert_eq!(intent.movement, Vec2::ZERO);
                    assert!(!intent.jump_pending && !intent.interact_pending);
                }
            }
            // I 保持按下时鼠标仍可正常观察。
            mouse_motion(&mut app, Vec2::new(10.0, 10.0));
            app.update();
            assert_ne!(
                app.world().get::<Transform>(camera).unwrap().rotation,
                pose.rotation
            );
            assert_eq!(
                app.world().get::<Transform>(camera).unwrap().translation,
                pose.translation
            );
        }

        #[test]
        fn first_person_look_clamps_up_and_down_and_uses_camera_settings() {
            let (mut app, _, character, camera, _) = test_app();
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
            let view = app.world().get::<FirstPersonCamera>(camera).unwrap();
            assert!((view.yaw - (-0.06_f32).rem_euclid(TAU)).abs() < 0.00001);
            assert!((view.pitch + 0.06).abs() < 0.00001);
            assert!(app.world().get::<Transform>(camera).unwrap().forward().y > 0.0);
            for (delta_y, pitch, forward_y) in [
                (10000.0, -85.0_f32.to_radians(), 1.0),
                (-10000.0, 85.0_f32.to_radians(), -1.0),
            ] {
                mouse_motion(&mut app, Vec2::new(0.0, delta_y));
                app.update();
                assert_eq!(
                    app.world().get::<FirstPersonCamera>(camera).unwrap().pitch,
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
        fn hidden_character_visuals_recover_when_camera_binding_becomes_invalid() {
            for removed in [
                "camera",
                "controller",
                "character_component",
                "target_binding",
            ] {
                let (mut app, _, character, camera, controller) = test_app();
                let visual = app
                    .world_mut()
                    .spawn((CharacterVisual, Visibility::default(), ChildOf(character)))
                    .id();
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
                            .get_mut::<FirstPersonCamera>(camera)
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
        fn first_person_motion_follows_actual_fixed_step_count() {
            for frame_duration in [Duration::ZERO, Duration::from_millis(50)] {
                let (mut app, _, character, camera, _) = test_app();
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
                let presentation_before =
                    app.world().get::<Transform>(character).unwrap().translation;
                let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
                mouse_motion(&mut app, Vec2::new(100.0, 100.0));
                app.update();
                let world = app.world();
                let simulated = world.resource::<Time<Fixed>>().elapsed() - fixed_before;
                let view = world.get::<FirstPersonCamera>(camera).unwrap();
                assert!((view.yaw - (-0.3_f32).rem_euclid(TAU)).abs() < 0.00001);
                let transform = world.get::<Transform>(character).unwrap();
                let position = world.get::<Position>(character).unwrap().0;
                let direction = Quat::from_rotation_y(view.yaw) * Vec3::NEG_Z;
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
                            <= world.resource::<PrototypeConfig>().move_speed
                                * simulated.as_secs_f32()
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
                rotations.push(app.world().get::<FirstPersonCamera>(camera).unwrap().yaw);
            }
            assert!((rotations[0] - rotations[1]).abs() < 0.0001);
            assert!((rotations[0] - (-0.6_f32).rem_euclid(TAU)).abs() < 0.0001);
        }

        #[test]
        fn cameras_follow_their_own_characters_at_eye_height() {
            let mut app = App::new();
            app.add_systems(Update, follow_first_person_camera);
            for position in [Vec3::new(3.0, 1.0, -2.0), Vec3::new(-4.0, 0.0, 7.0)] {
                let target = app
                    .world_mut()
                    .spawn((Character, Transform::from_translation(position)))
                    .id();
                app.world_mut()
                    .spawn((FirstPersonCamera::new(target), Transform::default()));
            }
            app.update();
            let world = app.world_mut();
            let mut query = world.query::<(&FirstPersonCamera, &Transform)>();
            for (view, transform) in query.iter(world) {
                let position = world.get::<Transform>(view.target).unwrap().translation;
                assert!(
                    transform
                        .translation
                        .abs_diff_eq(position + Vec3::Y * 1.65, 0.00001)
                );
            }
        }
    }

    mod held_pose_tests {
        //! held pose tests 的无窗口回归。

        use super::*;

        #[test]
        fn water_recovery_uses_current_camera_facing_for_the_same_fixed_step_movement() {
            let (mut app, window, character, camera, _) = test_app();
            let spawn =
                Transform::from_xyz(4.0, 0.03, 5.0).with_rotation(Quat::from_rotation_y(-0.6));
            app.world_mut()
                .entity_mut(character)
                .insert(SpawnPoint(spawn));
            // 通过真实输入上下文持续按住 W，避免下一帧 Enhanced Input 清空手写的移动意图。
            inspector_keyboard(&mut app, window, KeyCode::KeyW, ButtonState::Pressed);
            mouse_motion(&mut app, Vec2::new(-500.0, 0.0));
            app.update();
            let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
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
                let view = world.get::<FirstPersonCamera>(camera).unwrap();
                assert!(
                    character_transform
                        .rotation
                        .abs_diff_eq(Quat::from_rotation_y(view.yaw), 0.00001)
                );
                let camera_transform = world.get::<Transform>(camera).unwrap();
                assert!(
                    camera_transform
                        .translation
                        .abs_diff_eq(view.transform(expected).translation, 0.00001)
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
        fn held_box_aligns_safely_then_shares_current_frame_pose_and_visuals() {
            for (frame_duration, grip) in [Duration::ZERO, Duration::from_secs_f64(1.0 / 120.0)]
                .into_iter()
                .flat_map(|duration| carry_grip_cases().map(|grip| (duration, grip)))
            {
                let (mut app, _, character, camera, _) = test_app();
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
                assert!(app.world().get::<RigidBody>(item).is_none());
                let target = app.world().get::<HeldTarget>(item).unwrap();
                assert!(
                    app.world()
                        .get::<Position>(item)
                        .unwrap()
                        .0
                        .distance(target.translation)
                        > 0.1
                );
                // 拿起保留原位置；安全对齐完成后，转向的物理姿态和视觉都由人物直接派生。
                for _ in 0..30 {
                    fixed_step(&mut app);
                }

                app.insert_resource(TimeUpdateStrategy::ManualDuration(frame_duration));
                let mut frames_without_fixed_step = 0;
                for _ in 0..12 {
                    let fixed_time = app.world().resource::<Time<Fixed>>().elapsed();
                    mouse_motion(&mut app, Vec2::new(25.0, 5.0));
                    // 不补跑固定步，直接检查本帧目标、物理位置和视觉子实体传播结果。
                    app.update();
                    let world = app.world();
                    if world.resource::<Time<Fixed>>().elapsed() == fixed_time {
                        frames_without_fixed_step += 1;
                    }
                    let view = world.get::<FirstPersonCamera>(camera).unwrap();
                    assert!(
                        !world
                            .get::<InheritedVisibility>(character_visual)
                            .unwrap()
                            .get()
                    );
                    assert!(
                        world
                            .get::<InheritedVisibility>(visual_child)
                            .unwrap()
                            .get()
                    );
                    let character_transform = world.get::<Transform>(character).unwrap();
                    let rotation = Quat::from_rotation_y(view.yaw);
                    assert!(character_transform.rotation.abs_diff_eq(rotation, 0.00001));
                    let held_target = world.get::<HeldTarget>(item).unwrap();
                    let expected_target = character_transform.transform_point(grip_offset);
                    assert!(
                        held_target
                            .translation
                            .abs_diff_eq(expected_target, 0.00001)
                    );
                    assert!(held_target.rotation.abs_diff_eq(rotation, 0.00001));
                    let expected_camera = view.transform(character_transform.translation);
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
                    assert!(world.get::<RigidBody>(item).is_none());
                    let physical_target =
                        world.get::<Position>(character).unwrap().0 + rotation * grip_offset;
                    assert!(
                        world
                            .get::<Position>(item)
                            .unwrap()
                            .0
                            .abs_diff_eq(physical_target, 0.0001)
                    );
                    assert!(
                        world
                            .get::<Transform>(item)
                            .unwrap()
                            .translation
                            .abs_diff_eq(expected_target, 0.0001)
                    );
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
            for grip in carry_grip_cases() {
                let (mut app, _, character, camera, _) = test_app();
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
                for _ in 0..30 {
                    fixed_step(&mut app);
                }
                let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
                mouse_motion(&mut app, Vec2::new(500.0, -100.0));
                app.update();
                assert_eq!(
                    app.world().resource::<Time<Fixed>>().elapsed(),
                    fixed_before
                );
                let yaw = app.world().get::<FirstPersonCamera>(camera).unwrap().yaw;
                let character_transform = app.world().get::<Transform>(character).unwrap();
                let rotation = Quat::from_rotation_y(yaw);
                assert!(character_transform.up().dot(Vec3::Y) > 0.9999);
                assert!(character_transform.rotation.abs_diff_eq(rotation, 0.00001));
                let expected_target = character_transform.transform_point(grip_offset);
                let physical_target =
                    app.world().get::<Position>(character).unwrap().0 + rotation * grip_offset;
                assert!(
                    app.world()
                        .get::<Position>(item)
                        .unwrap()
                        .0
                        .abs_diff_eq(physical_target, 0.0001)
                );
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
    }
}
