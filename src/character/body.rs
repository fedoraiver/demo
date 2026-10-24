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
        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。
        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。
        SweptCcd::default().with_filter(CcdFilter::ALL),
        SpeculativeCcd::default(),
        TranslationInterpolation,
    )
}
