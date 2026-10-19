//! 统一安装 Avian、重力与共享碰撞层；业务身体由角色和物品功能装配。

#[cfg(test)]
mod body;
mod collision;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use body::ground_body;
pub(crate) use collision::{
    GamePhysicsLayer, held_collision_layers, parcel_collision_layers, world_collision_layers,
};

use crate::{game_flow::FixedGameplaySystems, settings::PrototypeConfig};
use avian3d::prelude::*;
use bevy::prelude::*;

/// 注册固定物理模拟与统一碰撞日志；不加载场景、窗口或音频设备。
pub(crate) struct GamePhysicsPlugin;

impl Plugin for GamePhysicsPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(PhysicsPlugins::default())
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

/// 检查器修改重力参数后，在本固定步求解前更新唯一的重力资源。
fn sync_gravity(config: Res<PrototypeConfig>, mut gravity: ResMut<Gravity>) {
    if config.is_changed() {
        gravity.0 = Vec3::NEG_Y * config.gravity;
    }
}
