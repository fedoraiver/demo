//! BSN 组合业务实体和视觉层级；地图实例化并完成静态碰撞后才生成动态玩家。

use crate::character::character_body;
use crate::character::character_collider;
use crate::item_interaction::item_body;
use std::collections::BTreeMap;

use avian3d::prelude::{Collider, RigidBody, TrimeshFlags};
use bevy::{prelude::*, world_serialization::WorldInstanceReady};
use serde::Deserialize;

use crate::{
    bounds_recovery::SpawnPoint,
    character::{Character, CharacterIntent, CharacterMotion},
    character_animation::CourierVisual,
    first_person::PlayerId,
    first_person::spawn_keyboard_controller,
    first_person::{CharacterVisual, ControlsCamera, FirstPersonCamera, MouseLookState},
    game_flow::{AppState, gameplay_running},
    item_interaction::{CarryGrip, Item, Pickable},
    physics::world_collision_layers,
    settings::PrototypeConfig,
};

mod actors;
mod assets;
mod collision;
mod loading;

use actors::*;
use assets::poll_art_assets;
pub(crate) use assets::{ArtAssets, ArtLoadState};
use collision::*;
use loading::*;

#[derive(Component, Default, Clone)]
struct IslandMap;
#[derive(Component)]
struct IslandPending;
#[derive(Component)]
struct ActorsSpawned;

/// 展示 NPC 保留在地图内，不挂玩家运动和输入组件。
#[derive(Component)]
pub(crate) struct DisplayNpc;

/// 静态碰撞独立于美术网格，随原始实例层级清理，不改动其视觉姿态。
#[derive(Component, Default, Clone)]
pub(crate) struct IslandCollider;

#[derive(Clone)]
struct ItemPlacement {
    item: Item,
    pose: Transform,
}

#[derive(Component)]
struct IslandReady {
    player: Transform,
    items: Vec<ItemPlacement>,
}

/// source_asset 仅在导入边界转换为业务组件，玩法系统不依赖模型名称。
#[derive(Deserialize)]
struct MapAsset {
    source_asset: String,
    category: String,
}

/// 加载当前场景资源并装配地图、碰撞与业务实体。
pub(crate) struct SceneAssemblyPlugin;

impl Plugin for SceneAssemblyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ArtAssets>()
            .init_resource::<ArtLoadState>()
            .add_systems(Update, poll_art_assets)
            .insert_resource(ClearColor(Color::srgb(0.72, 0.84, 0.94)))
            .insert_resource(GlobalAmbientLight {
                color: Color::WHITE,
                brightness: 250.0,
                ..default()
            })
            .add_systems(
                Startup,
                spawn_lighting.run_if(not(resource_exists::<State<AppState>>)),
            )
            // 会话只在离开主菜单时创建，暂停恢复不能重复生成灯光或加载相机。
            .add_systems(OnExit(AppState::MainMenu), spawn_lighting)
            .add_observer(mark_island_ready)
            // 每步提交延迟标记和碰撞，之后才允许动态实体生成。
            .add_systems(
                Update,
                (begin_island, prepare_island, spawn_actors)
                    .chain()
                    .run_if(gameplay_running),
            );
    }
}

#[cfg(test)]
mod tests;
