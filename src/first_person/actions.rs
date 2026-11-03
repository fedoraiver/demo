//! 玩家动作、设备绑定与角色意图路由。

use super::*;
use bevy_enhanced_input::prelude::{Cancel, Press, *};

/// 控制者的步行输入上下文；角色实体不直接持有设备绑定。
#[derive(Component, Default, Clone)]
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

/// 为指定玩家与角色创建键盘控制者，返回本次运行的控制者实体。
///
/// 场景只为获得键盘控制权的玩家调用一次；后续手柄或远程控制者单独配置。
pub fn spawn_keyboard_controller(
    commands: &mut Commands,
    player_id: PlayerId,
    character: Entity,
) -> Entity {
    let id = player_id.id;
    let controller = commands
        .spawn_scene(bsn! {
            Name({format!("Keyboard controller {id}")})
            @keyboard_context()
        })
        .insert((player_id, ControlsCharacter { character }))
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

/// 动作和绑定使用原生关系场景，随控制者生命周期一起生成和清理。
pub(super) fn keyboard_context() -> impl Scene {
    bsn! {
        GameplayContext
        GamepadDevice::None
        Actions<GameplayContext> [
            Action::<LookAction>::new()
            ActionSettings { consume_input: true }
            Bindings [ Name("Mouse look binding") Binding::mouse_motion() ]
            --
            Action::<MoveAction>::new()
            ActionSettings { consume_input: true }
            Bindings [ {preset::cardinal::new(
                (KeyCode::KeyW, Name::new("Move forward binding")),
                (KeyCode::KeyD, Name::new("Move right binding")),
                (KeyCode::KeyS, Name::new("Move backward binding")),
                (KeyCode::KeyA, Name::new("Move left binding")),
            )} ]
            --
            Action::<JumpAction>::new()
            ActionSettings { consume_input: true, require_reset: true }
            Press
            Bindings [ Name("Jump binding") Binding(KeyCode::Space) ]
            --
            Action::<InteractAction>::new()
            ActionSettings { consume_input: true, require_reset: true }
            Press
            Bindings [ Name("Interact binding") Binding(KeyCode::KeyE) ]
        ]
    }
}

/// 按事件所属的上下文查找角色，避免把一个玩家的动作写给其他角色。
pub(super) fn record_movement(
    event: On<Fire<MoveAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.character) else {
        return;
    };
    if intent.movement != event.value {
        info!(target: "demo::input", controller = ?event.context, character = ?controlled.character,
            before = ?intent.movement, after = ?event.value, reason = "move_action",
            "Character movement input changed");
        intent.movement = event.value;
    }
}

pub(super) fn clear_completed_movement(
    event: On<Complete<MoveAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.character) else {
        return;
    };
    if intent.movement != Vec2::ZERO {
        info!(target: "demo::input", controller = ?event.context, character = ?controlled.character,
            before = ?intent.movement, after = ?Vec2::ZERO, reason = "move_action_completed",
            "Character movement input changed");
        intent.movement = Vec2::ZERO;
    }
}

pub(super) fn clear_cancelled_movement(
    event: On<Cancel<MoveAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.character) else {
        return;
    };
    if intent.movement != Vec2::ZERO {
        info!(target: "demo::input", controller = ?event.context, character = ?controlled.character,
            before = ?intent.movement, after = ?Vec2::ZERO, reason = "move_action_cancelled",
            "Character movement input changed");
        intent.movement = Vec2::ZERO;
    }
}

/// 一次性请求保留到固定步消费，即使本渲染帧没有固定步也不会丢失。
pub(super) fn request_jump(
    event: On<Fire<JumpAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.character) else {
        return;
    };
    intent.jump_pending = true;
}

pub(super) fn request_interaction(
    event: On<Fire<InteractAction>>,
    controllers: Query<&ControlsCharacter, With<GameplayContext>>,
    mut characters: Query<&mut CharacterIntent, With<Character>>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok(mut intent) = characters.get_mut(controlled.character) else {
        return;
    };
    intent.interact_pending = true;
}
