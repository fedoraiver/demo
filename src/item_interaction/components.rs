//! 可搬物品、持有关系及共享刚体挂接期间保留的生命周期状态。

use avian3d::prelude::RigidBody;
use bevy::prelude::*;

/// 通用测试物身份；拾取能力由 Pickable 单独表达。
#[derive(Component, Clone, Copy, Default, Debug, PartialEq, Eq)]
#[cfg_attr(
    any(feature = "inspector", feature = "acceptance-test"),
    derive(Reflect),
    reflect(Component)
)]
pub struct Item;

/// 允许被拾取的能力标签。
#[derive(Component, Default, Clone)]
#[cfg_attr(
    any(feature = "inspector", feature = "acceptance-test"),
    derive(Reflect),
    reflect(Component)
)]
pub struct Pickable;

/// 物品相对持有者的局部握点；未指定时使用原型配置。
#[derive(Component, Default, Clone, Copy)]
#[cfg_attr(
    any(feature = "inspector", feature = "acceptance-test"),
    derive(Reflect),
    reflect(Component)
)]
pub(crate) struct CarryGrip {
    pub offset: Vec3,
}

/// 物体的持有者；只由交互系统插入或移除。
#[derive(Component)]
#[relationship(relationship_target = HoldingItems)]
pub struct HeldBy {
    pub(super) holder: Entity,
}

/// Bevy 根据 HeldBy 自动维护的反向索引，业务代码只读取。
#[derive(Component)]
#[relationship_target(relationship = HeldBy)]
pub struct HoldingItems {
    items: Vec<Entity>,
}

/// 手前的目标姿态；对齐期间与真实局部挂接姿态分离，完成后由共享刚体保持相对位置。
#[derive(Component)]
#[cfg_attr(
    any(feature = "inspector", feature = "acceptance-test"),
    derive(Reflect),
    reflect(Component)
)]
pub(crate) struct HeldTarget {
    pub translation: Vec3,
    pub rotation: Quat,
}

/// 实际碰撞形状相对组合刚体的姿态；箱实体不成为人物的 ChildOf，避免异常销毁时连带消失。
#[derive(Component, Clone, Copy)]
pub(crate) struct HeldAttachment {
    pub(crate) local_pose: Transform,
    pub(super) pending: bool,
    pub(super) free_body: RigidBody,
    pub(super) translation_was_paused: bool,
    pub(super) rotation_was_paused: bool,
    pub(super) collider_was_disabled: bool,
    pub(super) blocked_seconds: f32,
}

/// 碰撞代理到独立业务物品的关系；改绑由 Bevy 同步唯一反向代理。
#[derive(Component)]
#[relationship(relationship_target = ItemCollider)]
pub(crate) struct HeldCollider {
    pub(crate) item: Entity,
}

/// 每个物品最多关联一个代理；不级联销毁，代理按物理卸载顺序显式清理。
#[derive(Component)]
#[relationship_target(relationship = HeldCollider)]
pub(crate) struct ItemCollider {
    collider: Entity,
}

impl ItemCollider {
    pub(crate) fn get(&self) -> Option<Entity> {
        use bevy::ecs::relationship::RelationshipTarget;
        self.iter().next()
    }
}

/// 关系端点消失后仍保留代理身份，供孤儿碰撞与空间索引清理识别。
#[derive(Component)]
pub(crate) struct HeldCollisionProxy;

/// 独立箱根不属于人物的 Children，显式保存原质量供挂接和解除时恢复。
#[derive(Component)]
pub(super) struct CarryBaseMass {
    pub(super) mass: f32,
}

/// 释放后先丢弃手持期间的插值端点，再恢复调用前未暂停的插值通道。
#[derive(Component)]
pub(super) struct ResumeInterpolation {
    pub(super) translation: bool,
    pub(super) rotation: bool,
}
