//! 统一安装 Avian、重力与共享碰撞层；业务身体由角色和物品功能装配。

mod collision;
#[cfg(test)]
mod tests;

pub(crate) use collision::{
    GamePhysicsLayer, held_collision_layers, parcel_collision_layers, world_collision_layers,
};
#[cfg(test)]
pub(crate) use tests::ground_body;

use crate::{game_flow::FixedGameplaySystems, settings::PrototypeConfig};
use avian3d::{prelude::*, schedule::LastPhysicsTick};
use bevy::{ecs::system::SystemChangeTick, prelude::*};

/// 注册固定物理模拟与统一碰撞日志；不加载场景、窗口或音频设备。
pub(crate) struct GamePhysicsPlugin;

impl Plugin for GamePhysicsPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(PhysicsPlugins::default())
            .add_systems(
                FixedPostUpdate,
                wake_changed_bodies
                    .in_set(PhysicsSystems::First)
                    .before(PhysicsSystems::Prepare),
            )
            .add_systems(
                FixedUpdate,
                sync_gravity.before(FixedGameplaySystems::Motion),
            )
            .add_systems(
                FixedPostUpdate,
                collision::log_collisions.after(PhysicsSystems::StepSimulation),
            );
    }
}

/// Avian 的自动唤醒在求解之后；外部冲量和施力应在本步准备求解器之前生效。
fn wake_changed_bodies(
    mut commands: Commands,
    bodies: Query<
        (
            Entity,
            Ref<Position>,
            Ref<Rotation>,
            Ref<LinearVelocity>,
            Ref<AngularVelocity>,
            Ref<SleepTimer>,
        ),
        (
            With<Sleeping>,
            Or<(
                Changed<Position>,
                Changed<Rotation>,
                Changed<LinearVelocity>,
                Changed<AngularVelocity>,
                Changed<SleepTimer>,
            )>,
        ),
    >,
    last_physics_tick: Res<LastPhysicsTick>,
    system_tick: SystemChangeTick,
) {
    let this_run = system_tick.this_run();
    for (entity, position, rotation, velocity, angular, timer) in &bodies {
        // 物理解算自身的写入早于 LastPhysicsTick，不能把静置身体每帧重新唤醒。
        if [
            position.last_changed(),
            rotation.last_changed(),
            velocity.last_changed(),
            angular.last_changed(),
            timer.last_changed(),
        ]
        .into_iter()
        .any(|tick| tick.is_newer_than(last_physics_tick.0, this_run))
        {
            commands.queue(WakeBody(entity));
            debug!(target: "demo::physics", ?entity, reason = "external_physics_change",
                "Physics body scheduled to wake before simulation");
        }
    }
}

/// 检查器修改重力参数后，在本固定步求解前更新唯一的重力资源。
fn sync_gravity(config: Res<PrototypeConfig>, mut gravity: ResMut<Gravity>) {
    if config.is_changed() {
        gravity.0 = Vec3::NEG_Y * config.gravity;
    }
}
