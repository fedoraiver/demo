//! 角色与展示 NPC 的脚底原点、胶囊形状和动态身体配置。

use crate::{physics::GamePhysicsLayer, settings::PrototypeConfig};
use avian3d::prelude::*;
use bevy::prelude::*;

/// 玩家与展示 NPC 共享脚底原点的身体形状，刚体类型和碰撞层由装配方决定。
pub(crate) fn character_collider(config: &PrototypeConfig) -> Collider {
    Collider::compound(vec![(
        Vec3::Y * config.character_height * 0.5,
        Quat::IDENTITY,
        Collider::capsule(
            config.character_radius,
            config.character_height - 2.0 * config.character_radius,
        ),
    )])
}

/// 角色根保持脚底原点；偏移胶囊承载动态碰撞，锁旋转保证人物不翻倒。
pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {
    (
        RigidBody::Dynamic,
        character_collider(config),
        Mass(config.character_mass),
        LockedAxes::ROTATION_LOCKED,
        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。
        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),
        Restitution::new(0.0),
        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),
        CollisionEventsEnabled,
        // 正常移动与跳跃的合速度低于 8m/s，现有推测接触足以覆盖每步位移。
        // 仅高速或与旋转物体接触时执行昂贵扫掠，避免驻足时反复查询密集建筑网格。
        // 保留非线性算法：当前依赖的线性算法在非零水平朝向下会漏掉薄墙接触。
        SweptCcd::NON_LINEAR.with_velocity_threshold(8.0, 0.1),
        TranslationInterpolation,
    )
}
