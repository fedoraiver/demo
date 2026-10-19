//! 无窗口测试复用的有厚度地面，保持运行物理插件不拥有业务身体装配。

use super::world_collision_layers;
use crate::settings::PrototypeConfig;
use avian3d::prelude::*;
use bevy::prelude::*;

/// 无窗口测试也复用有厚度的地面；调用方的 Transform 表示地面顶面。
#[cfg(test)]
pub(crate) fn ground_body(_config: &PrototypeConfig) -> impl Bundle {
    (
        RigidBody::Static,
        Collider::compound(vec![(
            Vec3::NEG_Y * 0.5,
            Quat::IDENTITY,
            Collider::cuboid(200.0, 1.0, 200.0),
        )]),
        world_collision_layers(),
    )
}
