//! 世界、角色与物品的碰撞层约定，以及接触开始和结束的离散日志。

use avian3d::prelude::*;
use bevy::prelude::*;

/// 世界、角色与快递的碰撞分类。
#[derive(PhysicsLayer, Default)]
pub(crate) enum GamePhysicsLayer {
    #[default]
    World,
    Character,
    Parcel,
}

/// 静态世界接受角色与快递的碰撞。
pub(crate) fn world_collision_layers() -> CollisionLayers {
    CollisionLayers::new(GamePhysicsLayer::World, LayerMask::ALL)
}

/// 自由快递参与世界、人物与快递之间的碰撞。
pub(crate) fn parcel_collision_layers() -> CollisionLayers {
    CollisionLayers::new(GamePhysicsLayer::Parcel, LayerMask::ALL)
}

/// 持箱保留全部外部碰撞；同一刚体内部的身体和箱体由 Avian 自动排除接触。
pub(crate) fn held_collision_layers() -> CollisionLayers {
    parcel_collision_layers()
}

/// 接触开始和结束属于离散变化，通过现有文件日志设施记录碰撞双方。
pub(super) fn log_collisions(
    mut started: MessageReader<CollisionStart>,
    mut ended: MessageReader<CollisionEnd>,
) {
    for collision in started.read() {
        info!(target: "demo::physics", collider1 = ?collision.collider1, collider2 = ?collision.collider2,
            reason = "physics_contact", "Collision started");
    }
    for collision in ended.read() {
        info!(target: "demo::physics", collider1 = ?collision.collider1, collider2 = ?collision.collider2,
            reason = "physics_separation", "Collision ended");
    }
}
