//! 将 Enhanced Input 动作路由到对应控制者的角色意图。

use bevy::prelude::*;
use bevy_enhanced_input::prelude::{Cancel, Press, *};

use crate::gameplay::{Character, CharacterIntent, ControlsCharacter, PlayerId};

/// 注册玩家输入上下文和动作观察者。
pub struct PlayerInputPlugin;

impl Plugin for PlayerInputPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(EnhancedInputPlugin)
            // 默认在 PreUpdate 评估，先记录意图，再由 FixedUpdate 消费。
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

/// 每次按下产生一次跳跃请求。
#[derive(InputAction)]
#[action_output(bool)]
pub struct JumpAction;

/// 每次按下产生一次拾取或放下请求。
#[derive(InputAction)]
#[action_output(bool)]
pub struct InteractAction;

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
        "Keyboard controller spawned: WASD to move, Space to jump, E to pick up or drop"
    );
    controller
}

fn keyboard_context() -> impl Bundle {
    (
        GameplayContext,
        GamepadDevice::None,
        actions!(GameplayContext[
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
    intent.movement = event.value;
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
    intent.movement = Vec2::ZERO;
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
    intent.movement = Vec2::ZERO;
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

    use bevy::{ecs::relationship::RelationshipTarget, input::InputPlugin};

    use crate::gameplay::{
        CharacterMotion, GameplayPlugin, HoldingItems, Pickable, PrototypeConfig,
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
    fn keyboard_actions_drive_fixed_step_pickup_jump_and_following() {
        // 串起实际输入与玩法插件，显式推进固定步；不加载场景或窗口插件。
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            InputPlugin,
            PlayerInputPlugin,
            GameplayPlugin,
        ));
        app.finish();
        app.cleanup();
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
        let item = app
            .world_mut()
            .spawn((Pickable, Transform::from_xyz(0.0, 0.3, -1.0)))
            .id();
        app.world_mut()
            .spawn((ControlsCharacter(character), keyboard_context()));
        app.update();

        {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            keys.press(KeyCode::KeyE);
            keys.press(KeyCode::KeyW);
            keys.press(KeyCode::Space);
        }
        app.world_mut().run_schedule(PreUpdate);
        let intent = app.world().get::<CharacterIntent>(character).unwrap();
        assert!(intent.jump_pending && intent.interact_pending);
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f64(1.0 / 60.0));
        app.world_mut().run_schedule(FixedUpdate);

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
        let character_before = *app.world().get::<Transform>(character).unwrap();
        let item_before = *app.world().get::<Transform>(item).unwrap();
        assert!(character_before.translation.y > 0.0);
        assert!(character_before.translation.z < 0.0);
        let offset = app.world().resource::<PrototypeConfig>().hold_offset;
        assert!(item_before.translation.abs_diff_eq(
            character_before.translation + character_before.rotation * offset,
            0.0001,
        ));

        {
            let mut keys = app.world_mut().resource_mut::<ButtonInput<KeyCode>>();
            keys.release(KeyCode::Space);
            keys.release(KeyCode::KeyE);
        }
        app.world_mut().run_schedule(PreUpdate);
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f64(1.0 / 60.0));
        app.world_mut().run_schedule(FixedUpdate);
        let character_after = app.world().get::<Transform>(character).unwrap();
        let item_after = app.world().get::<Transform>(item).unwrap();
        assert!(character_after.translation.z < character_before.translation.z);
        assert!(
            (item_after.translation - item_before.translation).abs_diff_eq(
                character_after.translation - character_before.translation,
                0.0001,
            )
        );
    }
}
