//! 自由物品的质量、箱体形状、表面与连续碰撞配置。

use crate::{physics::parcel_collision_layers, settings::PrototypeConfig};
use avian3d::prelude::*;
use bevy::prelude::*;

/// 自由快递根位于箱体中心；持握时归属人物刚体，释放后恢复这份独立物理配置。
pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {
    let size = 2.0 * config.parcel_half_height;
    (
        RigidBody::Dynamic,
        Collider::cuboid(size, size, size),
        Mass(config.parcel_mass),
        Friction::new(0.65),
        Restitution::new(0.08),
        AngularDamping(0.15),
        parcel_collision_layers(),
        CollisionEventsEnabled,
        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。
        SweptCcd::default().with_filter(CcdFilter::ALL),
        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。
        SpeculativeCcd::default(),
        TransformInterpolation,
    )
}
