//! 控制者的成对目标供朝向、可见性和捕获校验共用，单目标动作仍只查询所需组件。

use super::{ControlsCamera, ControlsCharacter};
use bevy::ecs::query::QueryData;

#[derive(QueryData)]
pub(super) struct ControllerTargets {
    pub character: &'static ControlsCharacter,
    pub camera: &'static ControlsCamera,
}
