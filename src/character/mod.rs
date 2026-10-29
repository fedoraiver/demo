//! 注册角色运动与物理状态观察；物理和物品交互由应用显式安装。

mod body;
mod components;
mod lifecycle;
mod motion;
#[cfg(test)]
mod tests;

pub(crate) use body::{character_body, character_collider};
pub(crate) use components::{Character, CharacterIntent, CharacterMotion};

use avian3d::prelude::PhysicsSystems;
use bevy::prelude::*;

use crate::{
    game_flow::{AppState, FixedGameplaySystems, gameplay_running},
    settings::PrototypeConfig,
};
use lifecycle::clear_character_intents;
use motion::{jump_characters, log_character_velocity, move_characters, update_grounded};

/// 注册角色运动与反射元数据，不加载窗口、场景或其他项目插件。
pub(crate) struct CharacterPlugin;

impl Plugin for CharacterPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<Character>()
            .register_type::<CharacterIntent>()
            .register_type::<CharacterMotion>()
            .register_type::<PrototypeConfig>()
            .init_resource::<PrototypeConfig>()
            .add_systems(Startup, log_configuration)
            .add_systems(OnEnter(AppState::MainMenu), clear_character_intents)
            .add_systems(OnEnter(AppState::Paused), clear_character_intents)
            .add_systems(
                FixedUpdate,
                (update_grounded, move_characters, jump_characters)
                    .chain()
                    .in_set(FixedGameplaySystems::Motion)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedPostUpdate,
                (update_grounded, log_character_velocity)
                    .chain()
                    .after(PhysicsSystems::Writeback)
                    .run_if(gameplay_running),
            );
    }
}

/// 记录实际玩法配置；显式保留日志分类，兼容现有过滤设置。
fn log_configuration(config: Res<PrototypeConfig>) {
    // 刚体与持握方式属于玩法配置，合并到同一记录便于沿用日志筛选。
    info!(target: "demo::gameplay", ?config,
        physics_engine = "avian3d", physics_version = "0.7.0",
        character_body = "dynamic", parcel_body = "dynamic_free_shared_held",
        grip_mode = "shared_body", release_mode = "preserve_velocity",
        "Prototype gameplay initialized");
}
