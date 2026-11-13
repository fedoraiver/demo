//! 拾取与持物同步的具名查询数据；实体筛选和互斥条件仍由各系统声明。

use super::{CarryGrip, HeldAttachment, HeldBy, HeldTarget, HoldingItems};
use crate::character::CharacterIntent;
use avian3d::prelude::*;
use bevy::{ecs::query::QueryData, prelude::*};

#[derive(QueryData)]
pub(super) struct BodyPose {
    pub position: &'static Position,
    pub rotation: &'static Rotation,
}

#[derive(QueryData)]
pub(super) struct RotationObstacle {
    pub pose: BodyPose,
    pub collider: &'static Collider,
    pub layers: Option<&'static CollisionLayers>,
    pub owner: Option<&'static ColliderOf>,
    pub sensor: Has<Sensor>,
}

/// 持物同步可写真实姿态与速度，释放路径使用派生的只读视图。
#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct BodyKinematics {
    pub position: &'static mut Position,
    pub rotation: &'static mut Rotation,
    pub transform: &'static mut Transform,
    pub velocity: &'static mut LinearVelocity,
    pub angular_velocity: &'static mut AngularVelocity,
}

#[derive(QueryData)]
pub(super) struct HolderPhysics {
    pub pose: BodyPose,
    pub velocity: &'static LinearVelocity,
    pub angular_velocity: &'static AngularVelocity,
    pub center: &'static ComputedCenterOfMass,
}

#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct HeldPhysics {
    pub held_by: &'static HeldBy,
    pub attachment: &'static HeldAttachment,
    pub body: BodyKinematics,
}

#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct HeldColliderPose {
    pub local: &'static mut ColliderTransform,
    pub position: &'static mut Position,
    pub rotation: &'static mut Rotation,
    pub transform: &'static mut Transform,
}

#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct HeldPresentation {
    pub held_by: &'static HeldBy,
    pub attachment: Option<&'static HeldAttachment>,
    pub grip: Option<&'static CarryGrip>,
    pub target: &'static mut HeldTarget,
    pub transform: &'static mut Transform,
}

#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct InteractingCharacter {
    pub entity: Entity,
    pub pose: BodyPose,
    pub transform: &'static Transform,
    pub intent: &'static mut CharacterIntent,
    pub holding: Option<&'static HoldingItems>,
}

#[derive(QueryData)]
pub(super) struct FreePickable {
    pub entity: Entity,
    pub pose: BodyPose,
    pub transform: &'static Transform,
    pub rigid_body: &'static RigidBody,
    pub translation_paused: Has<NoTranslationEasing>,
    pub rotation_paused: Has<NoRotationEasing>,
    pub collider_disabled: Has<ColliderDisabled>,
}
