//! 按各业务根出生点恢复越界角色与物品，并隔离瞬移前的插值端点。

mod recovery;
#[cfg(test)]
mod tests;

use crate::game_flow::{FixedGameplaySystems, gameplay_running};
use avian3d::interpolation::TransformEasingSystems;
use bevy::prelude::*;
use recovery::{recover_from_water, resume_interpolation};

/// 业务根实体的出生姿态；角色与物品分别保存自己的恢复位置。
#[derive(Component, Clone, Default, Reflect)]
#[reflect(Component)]
pub(crate) struct SpawnPoint(pub Transform);

/// 无窗口回归记录真实恢复系统的处理顺序，避免用另一查询推断原查询缓存顺序。
#[cfg(test)]
#[derive(Resource, Default)]
pub(crate) struct WaterRecoveryOrder(pub(crate) Vec<Entity>);

/// 注册越界恢复和插值重置，不创建窗口或额外推进模拟。
pub(crate) struct BoundsRecoveryPlugin;

impl Plugin for BoundsRecoveryPlugin {
    fn build(&self, app: &mut App) {
        #[cfg(test)]
        app.init_resource::<WaterRecoveryOrder>();
        app.register_type::<SpawnPoint>()
            .add_systems(
                FixedFirst,
                resume_interpolation
                    .after(TransformEasingSystems::Reset)
                    .before(TransformEasingSystems::UpdateStart)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedUpdate,
                // 公共阶段图先应用恢复命令，再同步本步视角和消费玩法意图。
                recover_from_water
                    .in_set(FixedGameplaySystems::Recover)
                    .run_if(gameplay_running),
            );
    }
}
