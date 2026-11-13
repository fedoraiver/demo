//! 固定模拟按各步骤所需权限读取角色数据；Forces 继续使用 Avian 的查询契约。

use super::{CharacterIntent, CharacterMotion};
use crate::item_interaction::{HeldBy, HeldCollider};
use avian3d::prelude::*;
use bevy::{ecs::query::QueryData, prelude::*};

#[derive(QueryData)]
pub(super) struct GroundSupport {
    pub layers: Option<&'static CollisionLayers>,
    pub held: Has<HeldBy>,
    pub held_proxy: Has<HeldCollider>,
    pub sensor: Has<Sensor>,
}

#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct GroundedCharacter {
    pub entity: Entity,
    pub position: &'static Position,
    pub velocity: &'static LinearVelocity,
    pub layers: Option<&'static CollisionLayers>,
    pub motion: &'static mut CharacterMotion,
}

#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct MovingCharacter {
    pub forces: Forces,
    pub transform: &'static Transform,
    pub intent: &'static CharacterIntent,
    pub motion: &'static CharacterMotion,
}

#[derive(QueryData)]
#[query_data(mutable)]
pub(super) struct JumpingCharacter {
    pub entity: Entity,
    pub forces: Forces,
    pub mass: &'static ComputedMass,
    pub intent: &'static mut CharacterIntent,
    pub motion: &'static mut CharacterMotion,
}
