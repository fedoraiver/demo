//! 可搬物品、持有关系及共享刚体挂接期间保留的生命周期状态。

use avian3d::prelude::RigidBody;
use bevy::prelude::*;

/// 物品身份与种类；拾取能力由 Pickable 单独表达。
#[derive(Component, Reflect, Clone, Copy, Default, Debug, PartialEq, Eq)]
#[reflect(Component)]
pub enum Item {
    #[default]
    StandardParcel,
    FragileParcel,
    WoodenCrate,
}

impl Item {
    /// 用于实体名称与日志的稳定种类标识。
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::StandardParcel => "standard_parcel",
            Self::FragileParcel => "fragile_parcel",
            Self::WoodenCrate => "wooden_crate",
        }
    }
}

/// 允许被拾取的能力标签。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct Pickable;

/// 模型对应的手前偏移；未指定时继续使用原型配置，纸箱对齐持箱动作的双手。
#[derive(Component, Reflect, Default, Clone, Copy)]
#[reflect(Component)]
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
#[derive(Component, Reflect)]
#[reflect(Component)]
pub(crate) struct HeldTarget {
    pub translation: Vec3,
    pub rotation: Quat,
}

/// 实际碰撞形状相对组合刚体的姿态；箱实体不成为人物的 ChildOf，避免异常销毁时连带消失。
#[derive(Component, Clone, Copy)]
pub(crate) struct HeldAttachment {
    pub(crate) collider: Entity,
    pub(crate) local_pose: Transform,
    pub(super) pending: bool,
    pub(super) free_body: RigidBody,
    pub(super) translation_was_paused: bool,
    pub(super) rotation_was_paused: bool,
    pub(super) collider_was_disabled: bool,
    pub(super) blocked_seconds: f32,
}

/// 无视觉碰撞代理对应的物品身份；代理随组合体清理，业务根始终独立。
#[derive(Component)]
pub(crate) struct HeldCollider {
    pub(crate) item: Entity,
}

/// 独立箱根不属于人物的 Children，显式保存原质量供挂接和解除时恢复。
#[derive(Component)]
pub(super) struct CarryBaseMass {
    pub(super) mass: f32,
}

/// 释放后先丢弃手持期间的插值端点，再恢复调用前未暂停的插值通道。
#[derive(Component)]
pub(super) struct ResumeCarryEasing {
    pub(super) translation: bool,
    pub(super) rotation: bool,
}
