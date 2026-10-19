//! 在骨骼求值之后、最终变换传播之前补偿鞋底高度。

use bevy::prelude::*;

use super::state::{BLEND_TIME_CONSTANT, CourierAnimation};

pub(super) const SOLE_CLEARANCE: f32 = 0.003;
pub(super) const SOLE_MARKER_NAMES: [&str; 8] = [
    "Courier_Sole_L_0",
    "Courier_Sole_L_1",
    "Courier_Sole_L_2",
    "Courier_Sole_L_3",
    "Courier_Sole_R_0",
    "Courier_Sole_R_1",
    "Courier_Sole_R_2",
    "Courier_Sole_R_3",
];

/// 导出鞋底四角作为骨骼子节点；接地补偿只抬视觉根，不改物理或持握来源。
#[derive(Component, Clone, Copy)]
pub(super) struct CourierFootGrounding {
    pub(super) character: Entity,
    pub(super) animation_player: Entity,
    pub(super) sole_markers: [Entity; 8],
    pub(super) base_translation: Vec3,
    pub(super) offset: f32,
}
/// 方向混合可能把弯腿插值成更直的腿；逐帧按真实鞋底边界修正最终视觉高度。
pub(super) fn compensate_courier_sole_penetration(
    mut commands: Commands,
    time: Res<Time>,
    roots: Query<Entity, With<CourierFootGrounding>>,
    animations: Query<&CourierAnimation>,
    mut transforms: ParamSet<(
        TransformHelper,
        Query<(&mut Transform, &mut CourierFootGrounding)>,
    )>,
) {
    let release_blend = 1.0 - (-time.delta_secs() / BLEND_TIME_CONSTANT).exp();
    for visual_root in &roots {
        let grounding = {
            let mut visual_transforms = transforms.p1();
            let Ok((_, grounding)) = visual_transforms.get_mut(visual_root) else {
                continue;
            };
            *grounding
        };
        let desired = if let Ok(animation) = animations.get(grounding.animation_player) {
            // 与动作路由复用同一个过滤后的接地状态，台阶短暂丢失探测不撤销鞋底约束。
            if animation.grounded {
                let helper = transforms.p0();
                let character_transform = helper.compute_global_transform(grounding.character).ok();
                let marker_min: Option<f32> = grounding
                    .sole_markers
                    .iter()
                    .map(|entity| {
                        helper
                            .compute_global_transform(*entity)
                            .ok()
                            .map(|transform| transform.translation().y)
                    })
                    .try_fold(f32::INFINITY, |minimum, height| {
                        height.map(|height| minimum.min(height))
                    });
                match (character_transform, marker_min) {
                    (Some(character_transform), Some(marker_min)) => {
                        // 角色只有水平转向，父链的尺度仍需换算到局部 Y；扣掉旧补偿防止累积。
                        let world_y_per_local_y =
                            character_transform.affine().transform_vector3(Vec3::Y).y;
                        let uncorrected_min = marker_min - grounding.offset * world_y_per_local_y;
                        Some(
                            ((character_transform.translation().y + SOLE_CLEARANCE
                                - uncorrected_min)
                                / world_y_per_local_y)
                                .max(0.0),
                        )
                    }
                    _ => None,
                }
            } else {
                Some(0.0)
            }
        } else {
            None
        };
        let Some(desired) = desired else {
            commands
                .entity(visual_root)
                .remove::<CourierFootGrounding>();
            warn!(target: "demo::character_animation", ?visual_root,
                character = ?grounding.character, reason = "grounding_hierarchy_missing",
                "Courier foot grounding detached");
            continue;
        };
        let offset = if desired > grounding.offset {
            desired
        } else {
            grounding.offset + (desired - grounding.offset) * release_blend
        };
        let mut visual_transforms = transforms.p1();
        if let Ok((mut transform, mut grounding)) = visual_transforms.get_mut(visual_root) {
            grounding.offset = offset;
            transform.translation = grounding.base_translation + Vec3::Y * offset;
        }
    }
}
