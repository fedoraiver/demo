//! 注册 Enhanced Input 动作；键盘意图按控制者路由，观察与视角切换动作由相机模块消费。

use bevy::prelude::*;
use bevy_enhanced_input::prelude::{Cancel, Press, *};

use crate::gameplay::{Character, CharacterIntent, ControlsCharacter, PlayerId};

/// 注册玩家输入上下文和动作观察者。
pub struct PlayerInputPlugin;

impl Plugin for PlayerInputPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(EnhancedInputPlugin)
            // 默认在 PreUpdate 评估；玩法请求交给 FixedUpdate，相机动作在同帧更新。
            .add_input_context::<GameplayContext>()
            .add_observer(record_movement)
            .add_observer(clear_completed_movement)
            .add_observer(clear_cancelled_movement)
            .add_observer(request_jump)
            .add_observer(request_interaction);
    }
}

/// 控制者的步行输入上下文；角色实体不直接持有设备绑定。
#[derive(Component)]
pub struct GameplayContext;

/// 地面移动方向，X 为左右、Y 为前后。
#[derive(InputAction)]
#[action_output(Vec2)]
pub struct MoveAction;

/// 鼠标观察动作，输出本帧汇总位移，由相机 Observer 直接处理。
#[derive(InputAction)]
#[action_output(Vec2)]
pub struct LookAction;

/// 每次按下产生一次跳跃请求。
#[derive(InputAction)]
#[action_output(bool)]
pub struct JumpAction;

/// 每次按下产生一次拾取或放下请求。
#[derive(InputAction)]
#[action_output(bool)]
pub struct InteractAction;

/// 每次按下请求切换第一人称与第三人称，由相机 Observer 接收，再由同帧系统消费。
#[derive(InputAction)]
#[action_output(bool)]
pub struct TogglePerspectiveAction;

/// 为指定玩家与角色创建键盘控制者，返回本次运行的控制者实体。
///
/// 场景只为获得键盘控制权的玩家调用一次；后续手柄或远程控制者单独配置。
pub fn spawn_keyboard_controller(
    commands: &mut Commands,
    player_id: PlayerId,
    character: Entity,
) -> Entity {
    let id = player_id.0;
    let controller = commands
        .spawn((
            Name::new(format!("Keyboard controller {id}")),
            player_id,
            ControlsCharacter(character),
            keyboard_context(),
        ))
        .id();
    info!(
        target: "demo::input",
        player_id = id,
        ?controller,
        ?character,
        "Keyboard controller spawned: WASD to move, Space to jump, E to pick up or drop, I to toggle perspective"
    );
    controller
}

fn keyboard_context() -> impl Bundle {
    (
        GameplayContext,
        GamepadDevice::None,
        actions!(GameplayContext[
            (
                Action::<LookAction>::new(),
                ActionSettings {
                    consume_input: true,
                    ..default()
                },
                bindings![Binding::mouse_motion()],
            ),
            (
                Action::<MoveAction>::new(),
                ActionSettings {
                    consume_input: true,
                    ..default()
                },
                Bindings::spawn(Cardinal::wasd_keys()),
            ),
            (
                Action::<JumpAction>::new(),
                ActionSettings {
                    consume_input: true,
                    require_reset: true,
                    ..default()
                },
                Press::default(),
                bindings![KeyCode::Space],
            ),
            (
                Action::<InteractAction>::new(),
                ActionSettings {
                    consume_input: true,
                    require_reset: true,
                    ..default()
                },
                Press::default(),
                bindings![KeyCode::KeyE],
            ),
            (
                Action::<TogglePerspectiveAction>::new(),
                ActionSettings {
                    consume_input: true,
                    require_reset: true,
                    ..default()
                },
                Press::default(),
                bindings![KeyCode::KeyI],
            ),
        ]),
    )
}

/// 按事件所属的上下文查找角色，避免把一个玩家的动作写给其他角色。
fn record_movement(
    event: On<Fire<MoveAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.0) else {
        return;
    };
    if intent.movement != event.value {
        info!(target: "demo::input", controller = ?event.context, character = ?controlled.0,
            before = ?intent.movement, after = ?event.value, reason = "move_action",
            "Character movement input changed");
        intent.movement = event.value;
    }
}

fn clear_completed_movement(
    event: On<Complete<MoveAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.0) else {
        return;
    };
    if intent.movement != Vec2::ZERO {
        info!(target: "demo::input", controller = ?event.context, character = ?controlled.0,
            before = ?intent.movement, after = ?Vec2::ZERO, reason = "move_action_completed",
            "Character movement input changed");
        intent.movement = Vec2::ZERO;
    }
}

fn clear_cancelled_movement(
    event: On<Cancel<MoveAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.0) else {
        return;
    };
    if intent.movement != Vec2::ZERO {
        info!(target: "demo::input", controller = ?event.context, character = ?controlled.0,
            before = ?intent.movement, after = ?Vec2::ZERO, reason = "move_action_cancelled",
            "Character movement input changed");
        intent.movement = Vec2::ZERO;
    }
}

/// 一次性请求保留到固定步消费，即使本渲染帧没有固定步也不会丢失。
fn request_jump(
    event: On<Fire<JumpAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.0) else {
        return;
    };
    intent.jump_pending = true;
}

fn request_interaction(
    event: On<Fire<InteractAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.0) else {
        return;
    };
    intent.interact_pending = true;
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use avian3d::prelude::{LinearVelocity, Physics, Position, RigidBody};
    use bevy::{
        ecs::relationship::RelationshipTarget, input::InputPlugin, time::TimeUpdateStrategy,
    };

    use crate::{
        gameplay::{
            CharacterMotion, GameplayPlugin, HeldBy, HeldTarget, HoldingItems, Parcel, Pickable,
            PrototypeConfig,
        },
        physics::{character_body, ground_body, parcel_body},
    };

    use super::*;

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
        // 仅初始化时间、输入和动作插件，不创建窗口或完整游戏场景。
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, InputPlugin, PlayerInputPlugin));
        // Enhanced Input 在 finish 创建上下文运行资源，完成后才能插入上下文。
        app.finish();
        app.cleanup();
        let character = app
            .world_mut()
            .spawn((Character, CharacterIntent::default()))
            .id();
        app.world_mut()
            .spawn((ControlsCharacter(character), keyboard_context()));
        app.update();

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
    fn perspective_key_fires_once_per_press() {
        // 只观察实际键盘绑定产生的动作，验证长按不会重复切换。
        #[derive(Resource, Default)]
        struct PerspectivePresses(u32);

        fn count_perspective_presses(
            _event: On<Fire<TogglePerspectiveAction>>,
            mut presses: ResMut<PerspectivePresses>,
        ) {
            presses.0 += 1;
        }

        let mut app = App::new();
        app.add_plugins((MinimalPlugins, InputPlugin, PlayerInputPlugin))
            .init_resource::<PerspectivePresses>()
            .add_observer(count_perspective_presses);
        app.finish();
        app.cleanup();
        // 上下文激活时已按住 I，require_reset 应阻止意外切换，直到松开后重新按下。
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::KeyI);
        app.world_mut().spawn(keyboard_context());
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(app.world().resource::<PerspectivePresses>().0, 0);

        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .release(KeyCode::KeyI);
        app.update();

        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::KeyI);
        for _ in 0..3 {
            app.update();
        }
        assert_eq!(app.world().resource::<PerspectivePresses>().0, 1);

        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .release(KeyCode::KeyI);
        app.update();
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::KeyI);
        app.update();
        assert_eq!(app.world().resource::<PerspectivePresses>().0, 2);
    }

    #[test]
    fn keyboard_actions_drive_physics_pickup_jump_and_release() {
        // 实际 app.update 同时经过玩法和物理固定调度，不补跑系统掩盖帧末状态。
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            TransformPlugin,
            InputPlugin,
            PlayerInputPlugin,
            GameplayPlugin,
        ))
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / 60.0,
        )));
        app.finish();
        app.cleanup();
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut().spawn((
            Transform::from_xyz(0.0, config.ground_y, 0.0),
            ground_body(&config),
        ));
        let character = app
            .world_mut()
            .spawn((
                Character,
                CharacterIntent::default(),
                CharacterMotion::default(),
                Transform::default(),
                character_body(&config),
            ))
            .id();
        let item = app
            .world_mut()
            .spawn((
                Parcel,
                Pickable,
                Transform::from_xyz(0.0, config.parcel_half_height, -1.0),
                parcel_body(&config),
            ))
            .id();
        app.world_mut()
            .spawn((ControlsCharacter(character), keyboard_context()));
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
        assert_eq!(
            app.world().get::<RigidBody>(item),
            Some(&RigidBody::Dynamic)
        );
        // 拾取只建立目标和施力，第一步木箱仍与目标有间距，不能瞬移到手中。
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
