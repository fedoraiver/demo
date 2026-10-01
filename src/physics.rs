//! 统一组装 Avian 物理与刚体配置，模拟坐标由物理引擎保存，Transform 用于呈现。

use avian3d::prelude::*;
use bevy::prelude::*;

use crate::gameplay::{GameplaySystems, PrototypeConfig};

/// 世界、角色与快递的碰撞分类；持握时箱子仍碰撞世界与其他快递。
#[derive(PhysicsLayer, Default)]
pub(crate) enum GamePhysicsLayer {
    #[default]
    World,
    Character,
    Parcel,
}

/// 固定物理模拟和统一碰撞日志；可用于没有窗口和渲染器的最小 App。
pub(crate) struct DemoPhysicsPlugin;

impl Plugin for DemoPhysicsPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(PhysicsPlugins::default())
            .add_systems(FixedUpdate, sync_gravity.before(GameplaySystems::Simulate))
            .add_systems(
                FixedPostUpdate,
                log_collisions.after(PhysicsSystems::StepSimulation),
            );
    }
}

/// 检查器修改重力参数后，在本固定步求解前更新唯一的重力资源。
fn sync_gravity(config: Res<PrototypeConfig>, mut gravity: ResMut<Gravity>) {
    if config.is_changed() {
        gravity.0 = Vec3::NEG_Y * config.gravity;
    }
}

/// 静态世界接受角色与快递的碰撞。
pub(crate) fn world_collision_layers() -> CollisionLayers {
    CollisionLayers::new(GamePhysicsLayer::World, LayerMask::ALL)
}

/// 自由快递参与世界、人物与快递之间的碰撞。
pub(crate) fn parcel_collision_layers() -> CollisionLayers {
    CollisionLayers::new(GamePhysicsLayer::Parcel, LayerMask::ALL)
}

/// 当前单角色持握时排除人物层，避免手中箱子与自己的身体互相挤压。
pub(crate) fn held_collision_layers() -> CollisionLayers {
    CollisionLayers::new(
        GamePhysicsLayer::Parcel,
        [GamePhysicsLayer::World, GamePhysicsLayer::Parcel],
    )
}

/// 角色根保持脚底原点；偏移胶囊承载动态碰撞，锁旋转保证人物不翻倒。
pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {
    (
        RigidBody::Dynamic,
        Collider::compound(vec![(
            Vec3::Y * config.character_height * 0.5,
            Quat::IDENTITY,
            Collider::capsule(
                config.character_radius,
                config.character_height - 2.0 * config.character_radius,
            ),
        )]),
        Mass(config.character_mass),
        LockedAxes::ROTATION_LOCKED,
        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。
        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),
        Restitution::new(0.0),
        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),
        CollisionEventsEnabled,
        SweptCcd::default(),
        TranslationInterpolation,
    )
}

/// 快递根位于箱体中心；拿起和松手均保持动态刚体与原有动量。
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
        SweptCcd::default(),
        TransformInterpolation,
    )
}

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

/// 接触开始和结束属于离散变化，通过现有文件日志设施记录碰撞双方。
fn log_collisions(
    mut started: MessageReader<CollisionStart>,
    mut ended: MessageReader<CollisionEnd>,
) {
    for collision in started.read() {
        info!(collider1 = ?collision.collider1, collider2 = ?collision.collider2,
            reason = "physics_contact", "Collision started");
    }
    for collision in ended.read() {
        info!(collider1 = ?collision.collider1, collider2 = ?collision.collider2,
            reason = "physics_separation", "Collision ended");
    }
}
