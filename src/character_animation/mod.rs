//! 快递员视觉动画读取真实运动状态，不驱动业务根运动。

mod binding;
#[cfg(test)]
mod binding_tests;
mod grounding;
#[cfg(test)]
mod grounding_tests;
#[cfg(test)]
mod jump_tests;
mod state;
#[cfg(test)]
mod state_tests;
#[cfg(test)]
mod test_support;

use bevy::{app::AnimationSystems, prelude::*};

use crate::game_flow::gameplay_running;

#[cfg(test)]
use binding::CourierAnimationPending;
use binding::{initialize_ready_couriers, mark_courier_animation_ready};
use grounding::*;
use state::*;

/// 挂在 Character 直属视觉根上的 glTF 引用；只有标记的快递员接入玩法动画。
#[derive(Component, Clone, Default, FromTemplate)]
#[require(Transform)]
pub struct CourierVisual(pub Handle<Gltf>);

/// 注册场景就绪后的动画绑定，以及固定模拟和同帧呈现朝向同步后的动作混合。
pub(crate) struct CharacterAnimationPlugin;

impl Plugin for CharacterAnimationPlugin {
    fn build(&self, app: &mut App) {
        app.add_observer(mark_courier_animation_ready)
            .add_systems(
                Update,
                // RunFixedMainLoop 已同步本帧角色朝向；链保证新绑定对混合系统立即可见。
                (initialize_ready_couriers, sync_courier_animation)
                    .chain()
                    .run_if(gameplay_running),
            )
            .add_systems(
                PostUpdate,
                // 必须读取本帧已求值的骨骼局部姿态，并在最终变换传播前写回视觉补偿。
                compensate_courier_sole_penetration
                    .after(AnimationSystems)
                    .before(TransformSystems::Propagate)
                    .run_if(gameplay_running),
            );
    }
}
